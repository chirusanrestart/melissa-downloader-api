FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=7860

WORKDIR /app
COPY package.json ./
COPY server.js ./
EXPOSE 7860
CMD ["npm", "start"]
