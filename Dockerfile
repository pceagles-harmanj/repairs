# Two stages: compile native modules where the toolchain lives, ship a slim image.
#
# better-sqlite3 is a native addon. It normally downloads a prebuilt binary, but
# when that download fails (a firewall, a proxy, a new Node version) npm falls
# back to `node-gyp rebuild`, which needs Python and a C++ compiler. Rather than
# depend on the download working, the builder stage always has the toolchain and
# the runtime image gets only the finished node_modules.

# ---------- builder ----------
FROM node:22-bookworm-slim AS build
ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Only the manifests, so this layer caches until dependencies actually change.
COPY package.json package-lock.json* ./

# `npm ci` when the lockfile matches, `npm install` when it does not (a lockfile
# written before a dependency was added would otherwise abort the whole build).
RUN npm ci --omit=dev --no-audit --no-fund \
 || npm install --omit=dev --no-audit --no-fund

# Prove the native module actually loads before we build an image around it.
RUN node -e "new (require('better-sqlite3'))(':memory:').exec('create table t(a)'); console.log('better-sqlite3 ok')"

# ---------- runtime ----------
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

# Stamped at build time so the footer can name the running build:
#   docker compose build --build-arg GIT_COMMIT=$(git rev-parse HEAD) \
#                        --build-arg BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ARG GIT_COMMIT=""
ARG BUILD_DATE=""
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_DATE=$BUILD_DATE

# Compiled dependencies from the builder; application code from the repo.
# .dockerignore keeps the host's node_modules, database and .env out of here.
COPY --from=build /app/node_modules ./node_modules
COPY . .

RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 8080 8081
CMD ["node", "src/server.js"]
