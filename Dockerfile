FROM node:22-slim

ENV NODE_ENV=production \
    PORT=8000

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates wget ffmpeg \
    && wget -q https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -O /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY server.js ./
EXPOSE 8000
CMD ["npm", "start"]
