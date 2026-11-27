# The Visual Agent Canvas server: the editor and MCP on one port. Built from the repo root;
# see compose.yaml and README.md in this folder.
FROM node:26-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build && mkdir -p /data && chown node:node /data

ENV CANVAS_HOST=0.0.0.0 \
    CANVAS_PORT=4317 \
    CANVAS_DATA_DIR=/data
EXPOSE 4317
USER node
CMD ["npx", "tsx", "server/index.ts"]
