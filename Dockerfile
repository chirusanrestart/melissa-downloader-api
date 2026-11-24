FROM node:22-slim

ENV NODE_ENV=production \
    PORT=8000 \
    PATH="/opt/venv/bin:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-venv \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir pinterest-dl "yt-dlp[default]" curl-cffi \
    && /opt/venv/bin/python -m pip show yt-dlp yt-dlp-ejs >/dev/null \
    && yt-dlp --version >/dev/null \
    && node --version >/dev/null \
    && ffmpeg -version >/dev/null \
    && ffprobe -version >/dev/null \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js pinterest_search.py videoscale-format.js ./
EXPOSE 8000
CMD ["npm", "start"]
