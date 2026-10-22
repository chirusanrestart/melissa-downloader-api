"""Queued media downloader API for Render.

Downloads media on the server and exposes a short-lived URL. This avoids
returning YouTube's IP-bound signed media URLs to a client on another network.
"""
from __future__ import annotations

import gc
import json
import logging
import mimetypes
import os
import queue
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
LOG = logging.getLogger("melissa-downloader-api")

HOST = "0.0.0.0"
PORT = int(os.getenv("PORT", "10000"))
OWNER_API_KEY = os.getenv("OWNER_API_KEY", "")
FRIEND_API_KEY = os.getenv("FRIEND_API_KEY", "")
MAX_QUEUE = max(1, int(os.getenv("MAX_QUEUE", "30")))
EXTRACT_TIMEOUT = max(10, int(os.getenv("EXTRACT_TIMEOUT", "90")))
MEDIA_TTL = max(60, int(os.getenv("MEDIA_TTL", "600")))
MAX_MEDIA_MB = max(10, int(os.getenv("MAX_MEDIA_MB", "100")))
MAX_BODY_BYTES = 16_384
DOWNLOAD_DIR = Path(tempfile.gettempdir()) / "melissa-downloader-media"
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_DOMAINS = tuple(
    d.strip().lower()
    for d in os.getenv(
        "ALLOWED_DOMAINS",
        "youtube.com,youtu.be,tiktok.com,instagram.com,instagr.am,facebook.com,fb.watch,pinterest.com,pin.it,x.com,twitter.com,reddit.com,redd.it"
    ).split(",")
    if d.strip()
)

normal_queue: queue.Queue = queue.Queue(maxsize=MAX_QUEUE)
priority_queue: queue.Queue = queue.Queue(maxsize=MAX_QUEUE)
pending_lock = threading.Lock()
pending_count = 0
worker_started = False
media_lock = threading.Lock()
media_files: dict[str, dict] = {}


def allowed_url(value: str) -> bool:
    if not isinstance(value, str) or len(value) > 4096:
        return False
    try:
        parsed = urlparse(value)
        host = (parsed.hostname or "").lower().rstrip(".")
        if parsed.scheme != "https" or not host or parsed.username or parsed.password:
            return False
        return any(host == domain or host.endswith("." + domain) for domain in ALLOWED_DOMAINS)
    except (ValueError, UnicodeError):
        return False


def cleanup_media() -> None:
    now = time.time()
    with media_lock:
        expired = [token for token, entry in media_files.items() if entry["expires_at"] <= now]
        for token in expired:
            entry = media_files.pop(token, None)
            if entry:
                try:
                    entry["path"].unlink(missing_ok=True)
                except OSError:
                    LOG.warning("Could not remove expired media file")


def download_media(url: str) -> dict:
    """Download a single WhatsApp-friendly stream and return a temporary URL."""
    cleanup_media()
    token = uuid.uuid4().hex
    output_template = str(DOWNLOAD_DIR / f"{token}.%(ext)s")
    command = [
        os.getenv("PYTHON", "python"), "-m", "yt_dlp",
        "--no-warnings",
        "--no-playlist",
        "--no-cache-dir",
        "--no-write-info-json",
        "--no-write-playlist-metafiles",
        "--no-write-thumbnail",
        "--socket-timeout", "15",
        "--max-filesize", f"{MAX_MEDIA_MB}M",
        # Match the bot's yt-dlp approach: download the media, not just a
        # signed source URL. One-file formats avoid needing FFmpeg to merge.
        "-f", "best[acodec!=none]/best",
        # YouTube's current JS challenge solving support.
        "--js-runtimes", "deno",
        "--remote-components", "ejs:github",
        "--print", "after_move:filepath",
        "-o", output_template,
    ]
    impersonate = os.getenv("YTDLP_IMPERSONATE", "").strip()
    if impersonate:
        command.extend(["--impersonate", impersonate])
    command.append(url)

    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=EXTRACT_TIMEOUT,
        check=False,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1"},
    )
    if completed.returncode != 0:
        LOG.warning("yt-dlp failed (exit=%s): %s", completed.returncode, completed.stderr[-1200:])
        raise RuntimeError("Não foi possível baixar a mídia. Consulte os logs do servidor.")
    candidates = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
    path = Path(candidates[-1]) if candidates else None
    if not path or not path.is_file() or not path.is_relative_to(DOWNLOAD_DIR):
        raise RuntimeError("O yt-dlp não encontrou o arquivo baixado.")
    size = path.stat().st_size
    if size <= 0:
        path.unlink(missing_ok=True)
        raise RuntimeError("O arquivo baixado está vazio.")
    if size > MAX_MEDIA_MB * 1024 * 1024:
        path.unlink(missing_ok=True)
        raise RuntimeError(f"A mídia ultrapassou o limite de {MAX_MEDIA_MB} MB.")

    expires_at = time.time() + MEDIA_TTL
    with media_lock:
        media_files[token] = {"path": path, "expires_at": expires_at}
    base_url = (os.getenv("PUBLIC_BASE_URL") or os.getenv("RENDER_EXTERNAL_URL") or "").rstrip("/")
    if not base_url:
        with media_lock:
            media_files.pop(token, None)
        path.unlink(missing_ok=True)
        raise RuntimeError("Configure PUBLIC_BASE_URL com a URL pública do serviço Render.")
    media_url = f"{base_url}/media/{token}"
    return {
        "url": media_url,
        "filename": path.name,
        "content_type": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
        "size_bytes": size,
        "expires_in": MEDIA_TTL,
    }


def worker() -> None:
    global pending_count
    while True:
        item = None
        source = None
        while item is None:
            try:
                item = priority_queue.get_nowait()
                source = priority_queue
            except queue.Empty:
                try:
                    item = normal_queue.get(timeout=0.2)
                    source = normal_queue
                except queue.Empty:
                    continue
        try:
            try:
                item["result"] = download_media(item["url"])
            except subprocess.TimeoutExpired:
                item["error"] = "O download excedeu o tempo limite."
            except Exception as exc:
                item["error"] = str(exc)[:300] or "Falha no download."
            finally:
                item["event"].set()
        finally:
            source.task_done()
            gc.collect()
            with pending_lock:
                pending_count = max(0, pending_count - 1)


def start_worker() -> None:
    global worker_started
    if not worker_started:
        threading.Thread(target=worker, name="downloader-worker", daemon=True).start()
        worker_started = True


class Handler(BaseHTTPRequestHandler):
    server_version = "MelissaDownloader/1.0"

    def log_message(self, fmt: str, *args) -> None:
        LOG.info("%s - %s", self.client_address[0], fmt % args)

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self) -> None:
        self.do_GET()

    def do_GET(self) -> None:
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path.startswith("/media/"):
            token = path.removeprefix("/media/")
            if not token.isalnum() or len(token) != 32:
                self.send_json(404, {"error": "media_not_found"})
                return
            cleanup_media()
            with media_lock:
                entry = media_files.get(token)
            if not entry or not entry["path"].is_file():
                self.send_json(404, {"error": "media_expired_or_not_found"})
                return
            media_path = entry["path"]
            size = media_path.stat().st_size
            content_type = mimetypes.guess_type(media_path.name)[0] or "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition", f'attachment; filename="{media_path.name}"')
            self.send_header("Cache-Control", "private, no-store")
            self.end_headers()
            if self.command != "HEAD":
                try:
                    with media_path.open("rb") as media:
                        while True:
                            chunk = media.read(256 * 1024)
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            return
        if path == "/":
            self.send_json(200, {
                "ok": True,
                "service": "melissa-downloader-api",
                "message": "Melissa Downloader API está online.",
                "endpoints": {
                    "health": "/health",
                    "extract": {"method": "POST", "path": "/extract", "authentication": "X-API-Key", "body": {"url": "https://..."}},
                    "media": "/media/{token} (temporary URL returned by /extract)"
                }
            })
        elif path == "/health":
            self.send_json(200, {
                "ok": True,
                "service": "melissa-downloader-api",
                "auth_configured": bool(OWNER_API_KEY and FRIEND_API_KEY),
                "media_cached": len(media_files),
            })
        else:
            self.send_json(404, {"error": "not_found"})

    def do_POST(self) -> None:
        global pending_count
        if urlparse(self.path).path.rstrip("/") != "/extract":
            self.send_json(404, {"error": "not_found"})
            return
        if not OWNER_API_KEY or not FRIEND_API_KEY:
            self.send_json(503, {
                "error": "server_misconfigured",
                "message": "Configure OWNER_API_KEY and FRIEND_API_KEY in the server environment.",
            })
            return
        supplied = self.headers.get("X-API-Key", "")
        if not supplied or not (
            supplied == OWNER_API_KEY or supplied == FRIEND_API_KEY
        ):
            self.send_json(401, {"error": "unauthorized"})
            return
        is_owner = supplied == OWNER_API_KEY

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"error": "invalid_content_length"})
            return
        if length < 1 or length > MAX_BODY_BYTES:
            self.send_json(413 if length > MAX_BODY_BYTES else 400, {"error": "invalid_body_size"})
            return
        try:
            body = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_json(400, {"error": "invalid_json"})
            return
        url = body.get("url") if isinstance(body, dict) else None
        if not allowed_url(url):
            self.send_json(400, {"error": "unsupported_or_invalid_url"})
            return

        item = {"id": uuid.uuid4().hex, "url": url, "event": threading.Event()}
        with pending_lock:
            if pending_count >= MAX_QUEUE:
                self.send_json(429, {"error": "queue_full", "retry_after": 10})
                return
            pending_count += 1
            target = priority_queue if is_owner else normal_queue
            try:
                target.put_nowait(item)
            except queue.Full:
                pending_count -= 1
                self.send_json(429, {"error": "queue_full", "retry_after": 10})
                return

        if not item["event"].wait(EXTRACT_TIMEOUT + 5):
            self.send_json(504, {"error": "request_timeout", "request_id": item["id"]})
            return
        if "error" in item:
            self.send_json(422, {"error": "download_failed", "message": item["error"], "request_id": item["id"]})
            return
        self.send_json(200, item["result"])


if __name__ == "__main__":
    start_worker()
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
