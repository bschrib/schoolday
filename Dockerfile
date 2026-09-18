FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY src/ ./src/
COPY public/ ./public/

ENV NODE_ENV=production \
    PORT=4180 \
    DATA_DIR=/app/data \
    PROVIDER=demo

EXPOSE 4180
VOLUME ["/app/data"]

CMD ["node", "src/server.js"]
