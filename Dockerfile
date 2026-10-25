FROM node:22-slim

ENV NODE_ENV=production \
    PORT=8000 \
    PATH="/opt/venv/bin:$PATH" \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 python3-venv ffmpeg \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/python -m pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/python -m pip install --no-cache-dir yt-dlp curl_cffi \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY server.js ./
EXPOSE 8000
CMD ["npm", "start"]
