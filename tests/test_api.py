import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from unittest.mock import patch

import app


class FakeUpstream:
    def __init__(self, data=b"test-video-data"):
        self.data = data
        self.offset = 0
        self.headers = {"Content-Type": "video/mp4", "Content-Length": str(len(data))}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, size=-1):
        if size < 0:
            size = len(self.data)
        result = self.data[self.offset:self.offset + size]
        self.offset += len(result)
        return result


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app.OWNER_API_KEY = "test-owner-key"
        app.FRIEND_API_KEY = "test-friend-key"
        app.MAX_QUEUE = 10
        app.EXTRACT_TIMEOUT = 10
        app.start_worker()
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def request(self, path, payload=None, key=None):
        data = None if payload is None else json.dumps(payload).encode()
        headers = {}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if key is not None:
            headers["X-API-Key"] = key
        req = Request(self.base + path, data=data, headers=headers)
        try:
            with urlopen(req, timeout=5) as response:
                body = response.read()
                return response.status, response.headers, body
        except HTTPError as exc:
            return exc.code, exc.headers, exc.read()

    def test_health(self):
        status, _, raw = self.request("/health")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(raw)["ok"])

    def test_head_health(self):
        req = Request(self.base + "/health", method="HEAD")
        with urlopen(req, timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(), b"")

    def test_rejects_missing_key(self):
        status, _, raw = self.request("/extract", {"url": "https://www.youtube.com/watch?v=abc"})
        self.assertEqual(status, 401)
        self.assertEqual(json.loads(raw)["error"], "unauthorized")

    def test_rejects_unsupported_host(self):
        status, _, raw = self.request("/download", {"url": "https://example.com/video"}, "test-friend-key")
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(raw)["error"], "unsupported_or_invalid_url")

    def test_extract_returns_metadata(self):
        expected = {"url": "https://cdn.example.test/direct.mp4", "title": "sample"}
        with patch.object(app, "extract_media_url", return_value=expected):
            status, _, raw = self.request(
                "/extract", {"url": "https://www.youtube.com/watch?v=abc"}, "test-friend-key"
            )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw), expected)

    def test_download_streams_binary_in_chunks(self):
        expected = {
            "url": "https://cdn.example.test/direct.mp4",
            "title": "sample video",
            "ext": "mp4",
            "http_headers": {},
        }
        with patch.object(app, "extract_media_url", return_value=expected), patch(
            "app.urlopen", return_value=FakeUpstream(b"x" * (app.CHUNK_SIZE + 9))
        ):
            status, headers, raw = self.request(
                "/download", {"url": "https://www.youtube.com/watch?v=abc"}, "test-friend-key"
            )
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("X-Stream-Chunk-Size"), str(64 * 1024))
        self.assertEqual(len(raw), app.CHUNK_SIZE + 9)
        self.assertEqual(raw, b"x" * (app.CHUNK_SIZE + 9))

    def test_url_validation(self):
        self.assertTrue(app.allowed_url("https://youtu.be/abc"))
        self.assertTrue(app.allowed_url("https://www.pinterest.com/pin/123/"))
        self.assertFalse(app.allowed_url("http://www.youtube.com/watch?v=abc"))
        self.assertFalse(app.allowed_url("https://youtube.com.example.org/watch?v=abc"))
        self.assertFalse(app.allowed_url("https://user:pass@youtube.com/watch?v=abc"))


if __name__ == "__main__":
    unittest.main()
