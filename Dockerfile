# Tapocalypse team hub: the same app in read-only hub mode. Build: `docker build -t tapocalypse-hub .`
# Bun >= 1.3.14 because laptops encode screenshots with Bun.Image and the hub shares their package.json engines range.
FROM oven/bun:1.3.14-slim

WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json components.json ./
# bun-plugin-tailwind is a runtime dependency (bunfig.toml [serve.static]), so --production keeps it.
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY web ./web
COPY scripts ./scripts
COPY personas ./personas
COPY templates ./templates

ENV NODE_ENV=production \
    TAPOCALYPSE_MODE=hub \
    TAPOCALYPSE_HOST=0.0.0.0 \
    TAPOCALYPSE_PORT=4310 \
    TAPOCALYPSE_DATA_DIR=/data \
    TAPOCALYPSE_CONFIG=/data/config.json

# The official image ships a non-root `bun` user (uid 1000); /data is the only place the hub writes.
RUN mkdir -p /data && chown bun:bun /data
USER bun
VOLUME /data
EXPOSE 4310

# `127.0.0.1:<port>` is always an allowed Host, whatever TAPOCALYPSE_HUB_HOSTS says.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.TAPOCALYPSE_PORT||4310)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["bun", "src/server.ts"]
