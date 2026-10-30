# syntax=docker/dockerfile:1
# Build off the droplet (it has 4 GB RAM); deploy/deploy.sh ships the image over SSH.

FROM node:24-bookworm-slim AS build
# better-sqlite3 compiles from source when no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.25.0
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm -r build
# Self-contained server: dist + production node_modules only.
RUN pnpm --filter @ipsengpt/server deploy --prod --legacy /out

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    HOST=127.0.0.1 \
    PORT=3000 \
    WEB_DIST=/app/web \
    PERSONAS_DIR=/data/personas \
    PERSONAS_SEED_DIR=/app/personas-default \
    DB_PATH=/data/db/ipsengpt.sqlite \
    PEOPLE_DIR=/data/people \
    GATES_PATH=/app/content/gates.json \
    PHOTOS_DIR=/data/photos
WORKDIR /app
COPY --from=build /out ./server
COPY --from=build /src/apps/web/dist ./web
# Default gates; production mounts ./content over them so edits need no rebuild.
COPY content/gates.json ./content/
# The shipped personas, outside the ./content mount: copied into /data/personas on first start
# (personas are edited in admin and live with the party data) and restorable from admin.
COPY content/personas ./personas-default
USER node
WORKDIR /app/server
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/index.js"]
