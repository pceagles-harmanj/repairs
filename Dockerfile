FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# better-sqlite3 ships prebuilt binaries; build tools are only a fallback.
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 8080
CMD ["node", "src/server.js"]
