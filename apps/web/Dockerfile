# ============================================================
# Stage 1: Rust WASM builder — compile crypto to WebAssembly
# ============================================================
FROM rust:1-bookworm AS wasm-builder

RUN rustup target add wasm32-unknown-unknown \
 && cargo install wasm-pack --version 0.13.1 --locked

WORKDIR /build

# Copy Rust workspace and build script
COPY packages/crypto/core packages/crypto/core
COPY packages/crypto/kdf-policy.json packages/crypto/kdf-policy.json
RUN mkdir -p packages/crypto/wasm

# Use the existing build script (installs wasm-pack + writes package.json)
RUN packages/crypto/core/build-wasm.sh

# ============================================================
# Stage 2: JS builder — install deps and build Vite SPA
# ============================================================
FROM node:22-bookworm-slim AS js-builder

RUN corepack enable && corepack prepare pnpm@10.18.3 --activate

WORKDIR /app

# Copy entire repo (filtered by .dockerignore)
COPY . .

# Stub workspace packages whose package.json is generated (not in git)
RUN mkdir -p packages/crypto/wasm && echo '{"name":"@bittery/crypto-wasm","version":"0.1.0","private":true}' > packages/crypto/wasm/package.json \
 && mkdir -p packages/crypto/core && echo '{"name":"@bittery/crypto-core","version":"0.0.0","private":true}' > packages/crypto/core/package.json

RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy WASM build output from stage 1 (overwrites stub)
COPY --from=wasm-builder /build/packages/crypto/wasm packages/crypto/wasm

# Fail fast if translation keys drift across locales.
RUN pnpm run i18n:check

RUN pnpm run i18n:generate

# Accept VITE_SERVER_URL from Railway build-time variables
ARG VITE_SERVER_URL
ENV VITE_SERVER_URL=$VITE_SERVER_URL

# Build the web app (Vite inlines VITE_* env vars at build time)
RUN cd apps/web && pnpm run build

# Render nginx config with CSP hashes for inline bootstrap scripts.
RUN node apps/web/scripts/render-nginx-config.mjs

# ============================================================
# Stage 3: Runtime — nginx to serve static files
# ============================================================
FROM nginxinc/nginx-unprivileged:1.27-alpine

# Remove default nginx config
USER root
RUN rm /etc/nginx/conf.d/default.conf

COPY --from=js-builder --chown=101:101 /app/apps/web/.generated/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=js-builder --chown=101:101 /app/apps/web/dist/client /usr/share/nginx/html
USER 101:101

# Probe 127.0.0.1, never `localhost`. This image ships busybox wget, which only
# tries the *first* address getaddrinfo returns — for `localhost` that is [::1].
# nginx listens on IPv4 only here: replacing the packaged default.conf makes
# /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh skip its patch ("config
# differs from the packaged version"), so no `listen [::]:8080` is ever added.
# The result was a container stuck `unhealthy` forever. Adding an IPv6 listener
# instead would turn a bad health flag into a failed startup wherever the
# container has no IPv6 stack, so the probe is pinned to IPv4 instead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/nginx-health || exit 1

EXPOSE 8080
