"""Minimal URL extraction API for the Render free instance.

The service returns direct media URLs; it does not download media files.
"""
from __future__ import annotations

import json
import logging
import os
import queue
import re
import subprocess
import threading
import time
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


def extract_direct_url(url: str) -> dict:
    """Ask yt-dlp for metadata only; no media bytes are downloaded."""
    command = [
        os.getenv("PYTHON", "python"),
        "-m", "yt_dlp",
        "--no-warnings",
        "--no-playlist",
        "--skip-download",
        "--dump-single-json",
        "--socket-timeout", "15",
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
    )
    if completed.returncode != 0:
        LOG.warning("yt-dlp failed (exit=%s): %s", completed.returncode, completed.stderr[-500:])
        raise RuntimeError("Não foi possível extrair este link.")
    try:
        data = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("O extrator devolveu uma resposta inválida.") from exc

    direct_url = data.get("url")
    if not direct_url:
        formats = data.get("requested_formats") or data.get("formats") or []
        direct_url = next((item.get("url") for item in formats if item.get("url")), None)
    if not direct_url:
        raise RuntimeError("Nenhuma URL direta foi encontrada.")

    return {
        "url": direct_url,
        "title": str(data.get("title") or "")[:200],
        "extractor": str(data.get("extractor_key") or data.get("extractor") or "unknown")[:80],
        "expires": data.get("release_timestamp"),
    }


def worker() -> None:
    global pending_count
    while True:
        # Strict priority: drain owner work before normal work.
        try:
            item = priority_queue.get_nowait()
            source = priority_queue
        except queue.Empty:
            item = normal_queue.get()
            source = normal_queue

        try:
            try:
                item["result"] = extract_direct_url(item["url"])
            except subprocess.TimeoutExpired:
                item["error"] = "A extração excedeu o tempo limite."
            except Exception as exc:
                item["error"] = str(exc)[:300] or "Falha na extração."
            finally:
                item["event"].set()
        finally:
            source.task_done()
            with pending_lock:
                pending_count = max(0, pending_count - 1)


def start_worker() -> None:
    global worker_started
    if not worker_started:
        thread = threading.Thread(target=worker, name="extractor-worker", daemon=True)
        thread.start()
        worker_started = True


class Handler(BaseHTTPRequestHandler):
    server_version = "MelissaExtractor/1.0"

    def log_message(self, fmt: str, *args) -> None:
        # Avoid logging URLs or credentials.
        LOG.info("%s - %s", self.client_address[0], fmt % args)

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path.rstrip("/") == "/health":
            self.send_json(200, {"ok": True, "service": "melissa-downloader-api"})
        else:
            self.send_json(404, {"error": "not_found"})

    def do_POST(self) -> None:
        global pending_count
        if self.path.rstrip("/") != "/extract":
            self.send_json(404, {"error": "not_found"})
            return

        supplied = self.headers.get("X-API-Key", "")
        if not supplied or not (
            (OWNER_API_KEY and supplied == OWNER_API_KEY)
            or (FRIEND_API_KEY and supplied == FRIEND_API_KEY)
        ):
            self.send_json(401, {"error": "unauthorized"})
            return
        is_owner = bool(OWNER_API_KEY and supplied == OWNER_API_KEY)

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
        self.send_json(200, {"ok": True, "request_id": item["id"], **item["result"]})


if __name__ == "__main__":
    start_worker()
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
