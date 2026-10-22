"""Queued media-link extraction API for Render.

Extracts a direct media URL and returns it to the bot. The bot, not this
server, is responsible for downloading and sending the media.
"""
from __future__ import annotations

import gc
import json
import logging
import os
import queue
import subprocess
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
LOG = logging.getLogger("melissa-downloader-api")

HOST = "0.0.0.0"
PORT = int(os.getenv("PORT", "10000"))
OWNER_API_KEY = os.getenv("OWNER_API_KEY", "")
FRIEND_API_KEY = os.getenv("FRIEND_API_KEY", "")
MAX_QUEUE = max(1, int(os.getenv("MAX_QUEUE", "30")))
EXTRACT_TIMEOUT = max(10, int(os.getenv("EXTRACT_TIMEOUT", "90")))
MAX_BODY_BYTES = 16_384

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


def extract_media_url(url: str) -> dict:
    """Extract one best single-file format URL; never download media here."""
    command = [
        os.getenv("PYTHON", "python"), "-m", "yt_dlp",
        "--no-warnings",
        "--no-playlist",
        "--no-cache-dir",
        "--socket-timeout", "15",
        "--js-runtimes", "deno",
        "--remote-components", "ejs:github",
        "--format", "best[acodec!=none]/best",
        "--get-url",
        "--dump-single-json",
        url,
    ]
    # Keep impersonation optional rather than forcing a browser profile that
    # may not exist in the server's yt-dlp build.
    impersonate = os.getenv("YTDLP_IMPERSONATE", "").strip()
    if impersonate:
        command[3:3] = ["--impersonate", impersonate]

    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=EXTRACT_TIMEOUT,
        check=False,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1"},
    )
    if completed.returncode != 0:
        LOG.warning("yt-dlp extraction failed (exit=%s): %s", completed.returncode, completed.stderr[-1200:])
        raise RuntimeError("Não foi possível extrair o link da mídia. Consulte os logs do servidor.")

    # --dump-single-json provides metadata; --get-url prints the selected
    # direct URL separately. Keep only HTTPS media URLs in the response.
    direct_urls = [
        line.strip()
        for line in completed.stdout.splitlines()
        if line.strip().startswith("https://")
    ]
    if not direct_urls:
        raise RuntimeError("O yt-dlp não retornou um link direto de mídia.")
    direct_url = direct_urls[-1]

    metadata = {}
    for line in completed.stdout.splitlines():
        if line.startswith("{") and line.endswith("}"):
            try:
                metadata = json.loads(line)
                break
            except json.JSONDecodeError:
                continue

    # The direct media host may require the same headers yt-dlp used while
    # extracting the URL. Return only ordinary request headers needed by the bot.
    source_headers = metadata.get("http_headers") or {}
    safe_header_names = {"user-agent", "referer", "accept", "accept-language"}
    media_headers = {
        str(name): str(value)
        for name, value in source_headers.items()
        if str(name).lower() in safe_header_names and isinstance(value, (str, int, float))
    }

    return {
        "url": direct_url,
        "title": metadata.get("title"),
        "ext": metadata.get("ext"),
        "format_id": metadata.get("format_id"),
        "has_audio": metadata.get("acodec") not in (None, "none"),
        "expires_in": metadata.get("url_expire") or None,
        "http_headers": media_headers,
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
                item["result"] = extract_media_url(item["url"])
            except subprocess.TimeoutExpired:
                item["error"] = "A extração excedeu o tempo limite."
            except Exception as exc:
                item["error"] = str(exc)[:300] or "Falha na extração."
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
        threading.Thread(target=worker, name="extractor-worker", daemon=True).start()
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
        if path == "/":
            self.send_json(200, {
                "ok": True,
                "service": "melissa-downloader-api",
                "message": "API online. Extrai links; o bot baixa a mídia.",
                "endpoints": {
                    "health": "/health",
                    "extract": {"method": "POST", "path": "/extract", "authentication": "X-API-Key", "body": {"url": "https://..."}}
                }
            })
        elif path == "/health":
            self.send_json(200, {
                "ok": True,
                "service": "melissa-downloader-api",
                "auth_configured": bool(OWNER_API_KEY and FRIEND_API_KEY),
                "pending": pending_count,
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
        if not supplied or not (supplied == OWNER_API_KEY or supplied == FRIEND_API_KEY):
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
            self.send_json(422, {"error": "extraction_failed", "message": item["error"], "request_id": item["id"]})
            return
        self.send_json(200, item["result"])


if __name__ == "__main__":
    start_worker()
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
