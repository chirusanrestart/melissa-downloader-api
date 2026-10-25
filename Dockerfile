FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8000

RUN apk add --no-cache ca-certificates wget \
    && wget -q https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -O /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json ./
COPY server.js ./
EXPOSE 8000
CMD ["npm", "start"]
