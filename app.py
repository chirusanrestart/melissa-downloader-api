"""Melissa Downloader API using FastAPI with queued extraction and streamed downloads."""
from __future__ import annotations

import asyncio
import gc
import json
import logging
import os
import queue
import subprocess
import threading
import uuid
from contextlib import asynccontextmanager
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request as UrlRequest, urlopen

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field
from starlette.responses import JSONResponse, StreamingResponse

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
LOG = logging.getLogger("melissa-downloader-api")

HOST = "0.0.0.0"
PORT = int(os.getenv("PORT", "7860"))
OWNER_API_KEY = os.getenv("OWNER_API_KEY", "")
FRIEND_API_KEY = os.getenv("FRIEND_API_KEY", "")
MAX_QUEUE = max(1, int(os.getenv("MAX_QUEUE", "30")))
EXTRACT_TIMEOUT = max(10, int(os.getenv("EXTRACT_TIMEOUT", "90")))
MAX_BODY_BYTES = 16_384
CHUNK_SIZE = 64 * 1024
MAX_MEDIA_BYTES = 1024 * 1024 * 1024
MEDIA_TIMEOUT = max(15, int(os.getenv("MEDIA_TIMEOUT", "120")))

normal_queue: queue.Queue = queue.Queue(maxsize=MAX_QUEUE)
priority_queue: queue.Queue = queue.Queue(maxsize=MAX_QUEUE)
pending_lock = threading.Lock()
pending_count = 0
worker_started = False


def allowed_url(value: str) -> bool:
    """Validate URL shape and reject obvious local/private targets."""
    if not isinstance(value, str) or len(value) > 4096:
        return False
    try:
        parsed = urlparse(value)
        host = (parsed.hostname or "").lower().rstrip(".")
        if parsed.scheme != "https" or not host or parsed.username or parsed.password:
            return False
        if host == "localhost" or host.endswith((".localhost", ".local")):
            return False
        try:
            import ipaddress
            if not ipaddress.ip_address(host).is_global:
                return False
        except ValueError:
            # DNS host: yt-dlp determines whether the URL is supported.
            pass
        return True
    except (ValueError, UnicodeError):
        return False


def extract_media_url(url: str) -> dict:
    """Extract a direct media URL and metadata without downloading the media."""
    command = [
        os.getenv("PYTHON", "python"), "-m", "yt_dlp",
        "--no-warnings", "--no-playlist", "--no-cache-dir",
        "--socket-timeout", "15",
        "--js-runtimes", "deno",
        "--remote-components", "ejs:github",
        "--format", "best[acodec!=none]/best",
        "--get-url", "--dump-single-json", url,
    ]
    impersonate = os.getenv("YTDLP_IMPERSONATE", "").strip()
    if impersonate:
        command[3:3] = ["--impersonate", impersonate]

    completed = subprocess.run(
        command, capture_output=True, text=True, timeout=EXTRACT_TIMEOUT,
        check=False,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1"},
    )
    if completed.returncode != 0:
        LOG.warning("yt-dlp extraction failed (exit=%s): %s",
                    completed.returncode, completed.stderr[-1200:])
        raise RuntimeError("Não foi possível extrair o link da mídia. Consulte os logs do servidor.")

    lines = completed.stdout.splitlines()
    direct_urls = [line.strip() for line in lines if line.strip().startswith("https://")]
    if not direct_urls:
        raise RuntimeError("O yt-dlp não retornou um link direto de mídia.")
    direct_url = direct_urls[-1]

    metadata = {}
    for line in lines:
        if line.startswith("{") and line.endswith("}"):
            try:
                metadata = json.loads(line)
                break
            except json.JSONDecodeError:
                continue

    selected_format_id = metadata.get("format_id")
    formats = metadata.get("formats") or []
    selected_format = next(
        (fmt for fmt in formats if fmt.get("format_id") == selected_format_id), {}
    )
    source_headers = selected_format.get("http_headers") or metadata.get("http_headers") or {}
    safe_names = {"user-agent", "referer", "accept", "accept-language"}
    media_headers = {
        str(name): str(value) for name, value in source_headers.items()
        if str(name).lower() in safe_names and isinstance(value, (str, int, float))
    }

    source_host = (urlparse(url).hostname or "").lower()
    if source_host.endswith(("tiktok.com", "tiktokv.com")):
        media_headers["Referer"] = "https://www.tiktok.com/"
    elif source_host.endswith(("instagram.com", "instagr.am")):
        media_headers["Referer"] = "https://www.instagram.com/"

    selected_ext = selected_format.get("ext") or metadata.get("ext")
    selected_acodec = selected_format.get("acodec", metadata.get("acodec"))
    return {
        "url": direct_url,
        "title": metadata.get("title"),
        "ext": selected_ext,
        "format_id": selected_format_id,
        "has_audio": selected_acodec not in (None, "none"),
        "expires_in": selected_format.get("url_expire") or metadata.get("url_expire") or None,
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


@asynccontextmanager
async def lifespan(_: FastAPI):
    start_worker()
    yield


app = FastAPI(
    title="Melissa Downloader API",
    description="Extrai links de mídia e transmite arquivos em blocos de 64 KiB.",
    version="2.0.0",
    lifespan=lifespan,
)


class URLRequest(BaseModel):
    url: str = Field(min_length=1, max_length=4096)


@app.middleware("http")
async def enforce_body_limit(request: Request, call_next):
    length = request.headers.get("content-length")
    if length:
        try:
            size = int(length)
        except ValueError:
            return JSONResponse(status_code=400, content={"error": "invalid_content_length"})
        if size > MAX_BODY_BYTES:
            return JSONResponse(status_code=413, content={"error": "invalid_body_size"})
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-store")
    return response


@app.get("/")
async def index():
    return {
        "ok": True,
        "service": "melissa-downloader-api",
        "message": "API online. Extrai links e transmite arquivos em blocos de 64 KiB.",
        "endpoints": {
            "health": "/health",
            "extract": {"method": "POST", "path": "/extract", "authentication": "X-API-Key",
                        "body": {"url": "https://..."}},
            "download": {"method": "POST", "path": "/download", "authentication": "X-API-Key",
                         "body": {"url": "https://..."}, "stream_chunk_bytes": CHUNK_SIZE},
        },
    }


@app.get("/health")
async def health():
    return {
        "ok": True,
        "service": "melissa-downloader-api",
        "auth_configured": bool(OWNER_API_KEY and FRIEND_API_KEY),
        "pending": pending_count,
    }


async def enqueue_extraction(url: str, supplied_key: str) -> dict:
    global pending_count
    if not OWNER_API_KEY or not FRIEND_API_KEY:
        raise HTTPException(
            status_code=503,
            detail={"error": "server_misconfigured",
                    "message": "Configure OWNER_API_KEY and FRIEND_API_KEY in the server environment."},
        )
    if not supplied_key or supplied_key not in (OWNER_API_KEY, FRIEND_API_KEY):
        raise HTTPException(status_code=401, detail={"error": "unauthorized"})
    if not allowed_url(url):
        raise HTTPException(status_code=400, detail={"error": "unsupported_or_invalid_url"})

    item = {"id": uuid.uuid4().hex, "url": url, "event": threading.Event()}
    is_owner = supplied_key == OWNER_API_KEY
    with pending_lock:
        if pending_count >= MAX_QUEUE:
            raise HTTPException(status_code=429, detail={"error": "queue_full", "retry_after": 10})
        pending_count += 1
        target = priority_queue if is_owner else normal_queue
        try:
            target.put_nowait(item)
        except queue.Full:
            pending_count -= 1
            raise HTTPException(status_code=429, detail={"error": "queue_full", "retry_after": 10})

    completed = await asyncio.to_thread(item["event"].wait, EXTRACT_TIMEOUT + 5)
    if not completed:
        raise HTTPException(status_code=504, detail={"error": "request_timeout", "request_id": item["id"]})
    if "error" in item:
        raise HTTPException(status_code=422, detail={
            "error": "extraction_failed", "message": item["error"], "request_id": item["id"]
        })
    return item["result"]


@app.post("/extract")
async def extract(payload: URLRequest, x_api_key: str = Header(default="", alias="X-API-Key")):
    return await enqueue_extraction(payload.url, x_api_key)


def open_media_stream(media: dict):
    """Open upstream and read the first chunk before sending HTTP 200."""
    media_url = media.get("url")
    if not isinstance(media_url, str) or urlparse(media_url).scheme != "https":
        raise HTTPException(status_code=502, detail={"error": "invalid_media_url"})

    headers = {
        "User-Agent": "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36",
        "Accept": "video/*,audio/*,application/octet-stream;q=0.9,*/*;q=0.8",
    }
    allowed_headers = {"user-agent", "referer", "accept", "accept-language"}
    for name, value in (media.get("http_headers") or {}).items():
        if str(name).lower() in allowed_headers and isinstance(value, str) and value.strip():
            headers[name] = value

    try:
        upstream = urlopen(UrlRequest(media_url, headers=headers), timeout=MEDIA_TIMEOUT)
        content_type = (upstream.headers.get("Content-Type") or "application/octet-stream").lower()
        if "text/html" in content_type or "application/json" in content_type:
            upstream.close()
            raise HTTPException(status_code=502, detail={"error": "upstream_not_media"})
        length_header = upstream.headers.get("Content-Length")
        try:
            declared_size = int(length_header) if length_header else None
        except ValueError:
            declared_size = None
        if declared_size is not None and (declared_size < 1 or declared_size > MAX_MEDIA_BYTES):
            upstream.close()
            raise HTTPException(status_code=413 if declared_size > MAX_MEDIA_BYTES else 502,
                                detail={"error": "invalid_media_size"})
        first_chunk = upstream.read(CHUNK_SIZE)
        if not first_chunk:
            upstream.close()
            raise HTTPException(status_code=502, detail={"error": "empty_media"})
        return upstream, content_type, declared_size, first_chunk
    except HTTPException:
        raise
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        reason = (str(exc) or type(exc).__name__)[:240]
        if isinstance(exc, HTTPError):
            code = "upstream_http_" + str(exc.code)
        elif isinstance(exc, URLError):
            code = "upstream_connection_failed"
        elif isinstance(exc, TimeoutError):
            code = "upstream_timeout"
        else:
            code = "stream_io_error"
        LOG.warning("Media stream failed (%s): %s", code, reason)
        raise HTTPException(status_code=502, detail={
            "error": "media_stream_failed", "reason": code + ": " + reason
        }) from exc


@app.post("/download")
async def download(payload: URLRequest, x_api_key: str = Header(default="", alias="X-API-Key")):
    media = await enqueue_extraction(payload.url, x_api_key)
    upstream, content_type, declared_size, first_chunk = await asyncio.to_thread(open_media_stream, media)

    ext = str(media.get("ext") or "bin").lower()
    if not ext.isalnum() or len(ext) > 8:
        ext = "bin"
    title = str(media.get("title") or "video")[:180]
    safe_title = "".join(ch if ch.isalnum() or ch in " ._-" else "_" for ch in title).strip(" .") or "video"
    headers = {
        "X-Media-Ext": ext,
        "X-Media-Title": safe_title.encode("ascii", "ignore").decode("ascii") or "video",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
        "X-Stream-Chunk-Size": str(CHUNK_SIZE),
    }
    if declared_size is not None:
        headers["Content-Length"] = str(declared_size)

    def stream():
        received = 0
        try:
            received += len(first_chunk)
            if received > MAX_MEDIA_BYTES:
                return
            yield first_chunk
            while True:
                chunk = upstream.read(CHUNK_SIZE)
                if not chunk:
                    break
                received += len(chunk)
                if received > MAX_MEDIA_BYTES:
                    LOG.warning("Media stream exceeded %s bytes; terminating", MAX_MEDIA_BYTES)
                    break
                yield chunk
            if declared_size is not None and received != declared_size:
                LOG.warning("Stream ended early (expected=%s, received=%s)", declared_size, received)
            LOG.info("Media streamed in 64 KiB blocks (%s bytes)", received)
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            LOG.warning("Media stream interrupted: %s", str(exc)[:240])
        finally:
            upstream.close()

    return StreamingResponse(stream(), media_type=content_type, headers=headers)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=HOST, port=PORT, log_level=os.getenv("LOG_LEVEL", "info").lower())
