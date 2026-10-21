# Melissa Downloader API

A small Python HTTP service that uses local yt-dlp to extract direct media URLs. It does not download or proxy media files.

## Endpoints

- `GET /health`: health check.
- `POST /extract`: extract a supported public media URL.

Example:

```sh
python -c 'import json,urllib.request; req=urllib.request.Request("http://localhost:10000/extract", data=json.dumps({"url":"https://www.youtube.com/watch?v=BaW_jenozKc"}).encode(), headers={"Content-Type":"application/json","X-API-Key":"YOUR_KEY"}); print(urllib.request.urlopen(req, timeout=120).read().decode())'
```

Success response contains `ok`, `url` (direct media URL), `title`, `extractor`, and `request_id`. Errors use JSON and an appropriate HTTP status.

## Authorization and priority

Set two different environment variables:

- `OWNER_API_KEY`: strict priority queue.
- `FRIEND_API_KEY`: normal queue.

Pass the key in the `X-API-Key` header. Owner requests are selected before normal requests that have not started. An active extraction is never interrupted. The queue is in memory and is lost on restart.

## Limits and safety

- One yt-dlp extraction subprocess at a time.
- `curl_cffi` is installed and yt-dlp impersonation is enabled by default with `YTDLP_IMPERSONATE=chrome`; set another supported target in the environment to override it.
- `MAX_QUEUE` limits waiting/active jobs; full queue returns HTTP 429.
- `EXTRACT_TIMEOUT` bounds each extraction.
- Request body is capped and initial URLs must use HTTPS and an allowed platform hostname.
- Do not expose keys in URLs, chat messages, logs, or public source code.
- Direct media URLs can expire and may require headers/cookies. This API does not guarantee every platform or link will work.

## Public deployment (Render)

Base URL: `https://melissa-downloader-api.onrender.com`

- `GET https://melissa-downloader-api.onrender.com/`: service status and endpoint overview.
- `GET https://melissa-downloader-api.onrender.com/health`: Render health check.
- `POST https://melissa-downloader-api.onrender.com/extract`: submit an extraction request with the `X-API-Key` header and JSON body `{"url":"https://..." }`.

The service binds to `0.0.0.0` and uses the port supplied by Render through `PORT`. Clients outside Render should call the public base URL above, not `localhost`. `localhost` is only for requests made from the same machine where the service is running.

## Run locally

```sh
python -m venv .venv
. .venv/bin/activate
pip install --no-cache-dir -r requirements.txt
export OWNER_API_KEY='change-me-owner'
export FRIEND_API_KEY='change-me-friend'
python app.py
```

On Render, set the two secrets in the service environment. `render.yaml` contains the service blueprint.

## Tests

The GitHub Actions workflow runs unit/API tests without downloading real media. Platform integration and actual Render memory use must be tested separately.
