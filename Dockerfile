# syntax=docker/dockerfile:1

# The JavaScript is built once, natively on the build machine – not again for every platform under emulation.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
ARG TARGETARCH
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY . .
# x.yy.zzz, computed by CI (scripts/version.mjs); declared late so it does not invalidate the install layer.
ARG APP_VERSION=dev
RUN APP_VERSION=$APP_VERSION pnpm --filter @trips/web build \
 && pnpm --filter @trips/server build
# Production dependencies for the target platform: native parts (sharp) are picked for its CPU and musl.
RUN printf 'supportedArchitectures:\n  os: [linux]\n  cpu: [%s]\n  libc: [musl]\n' "$([ "$TARGETARCH" = amd64 ] && echo x64 || echo "$TARGETARCH")" >> pnpm-workspace.yaml \
 && pnpm --filter @trips/server deploy --prod --legacy /out

FROM node:22-alpine
WORKDIR /app
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/web/dist ./web
# Fails the build if the image library has no binary for this platform (musl, amd64/arm64).
RUN node -e "require('sharp')" && apk add --no-cache su-exec && mkdir -p /data && chown node:node /data
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ARG APP_VERSION=dev
LABEL org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.source="https://github.com/doenke/trips" \
      org.opencontainers.image.title="Trips"
ENV APP_VERSION=$APP_VERSION \
    NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    PORT=41873 \
    DATA_DIR=/data \
    WEB_DIST=/app/web \
    TZ=Europe/Berlin
# The entrypoint fixes ownership of a bind-mounted /data, then drops to the user "node" – the app never runs as root.
VOLUME /data
EXPOSE 41873
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
