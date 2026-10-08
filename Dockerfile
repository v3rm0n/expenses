# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY next.config.ts tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOST=0.0.0.0 \
    PORT=4317 \
    DATA_DIR=/app/.data \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
RUN npx --no-install playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX /opt/playwright

COPY --from=build --chown=node:node /app/.next ./.next
COPY next.config.ts ./
COPY src ./src
COPY migrations ./migrations
COPY scripts/run.ts scripts/worker.ts scripts/docker.ts scripts/setup.ts scripts/migrate.ts ./scripts/
COPY LICENSE ./
RUN mkdir -p /app/.data && chown node:node /app/.data

USER node
EXPOSE 4317
CMD ["node", "--import", "tsx", "scripts/run.ts", "--container"]
