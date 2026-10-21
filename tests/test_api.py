import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from unittest.mock import patch

import app


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
                return response.status, json.loads(response.read())
        except HTTPError as exc:
            return exc.code, json.loads(exc.read())

    def test_health(self):
        status, body = self.request("/health")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])

    def test_rejects_missing_key(self):
        status, body = self.request("/extract", {"url": "https://www.youtube.com/watch?v=abc"})
        self.assertEqual(status, 401)
        self.assertEqual(body["error"], "unauthorized")

    def test_rejects_unsupported_host(self):
        status, body = self.request(
            "/extract", {"url": "https://example.com/video"}, "test-friend-key"
        )
        self.assertEqual(status, 400)
        self.assertEqual(body["error"], "unsupported_or_invalid_url")

    def test_valid_request_returns_extracted_url(self):
        expected = {
            "url": "https://cdn.example.test/direct.mp4",
            "title": "test video",
            "extractor": "Test",
            "expires": None,
        }
        with patch.object(app, "extract_direct_url", return_value=expected):
            status, body = self.request(
                "/extract",
                {"url": "https://www.youtube.com/watch?v=abc"},
                "test-friend-key",
            )
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["url"], expected["url"])
        self.assertEqual(body["title"], "test video")

    def test_url_validation(self):
        self.assertTrue(app.allowed_url("https://youtu.be/abc"))
        self.assertTrue(app.allowed_url("https://www.pinterest.com/pin/123/"))
        self.assertFalse(app.allowed_url("http://www.youtube.com/watch?v=abc"))
        self.assertFalse(app.allowed_url("https://youtube.com.example.org/watch?v=abc"))
        self.assertFalse(app.allowed_url("https://user:pass@youtube.com/watch?v=abc"))


if __name__ == "__main__":
    unittest.main()
