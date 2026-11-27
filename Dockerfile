FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git && rm -rf /var/lib/apt/lists/*
COPY production/dependencies.json production/build-dependencies.sh ./production/
RUN sh production/build-dependencies.sh
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS application
WORKDIR /app
COPY --from=build /app/vendor ./vendor
COPY --from=build /app/node_modules ./node_modules
COPY package.json *.mjs ./
COPY public/ ./public/
COPY production/ ./production/
ENV NODE_ENV=production
USER node

FROM application AS fetcher
USER root
RUN apt-get update && apt-get install -y --no-install-recommends nftables util-linux && rm -rf /var/lib/apt/lists/*
EXPOSE 8791
ENTRYPOINT ["sh", "production/fetch-entrypoint.sh"]

FROM application AS test
COPY test/ ./test/
RUN node --test 'test/*.test.mjs' && node --check production/public/workspace.js && node production/web.mjs --check

FROM application AS runtime
EXPOSE 8790
CMD ["node", "production/web.mjs"]
