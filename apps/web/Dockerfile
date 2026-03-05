# ============================================================
# Stage 1: Rust WASM builder — compile crypto to WebAssembly
# ============================================================
FROM rust:1-bookworm AS wasm-builder

RUN rustup target add wasm32-unknown-unknown

WORKDIR /build

# Copy Rust workspace and build script
COPY packages/crypto/core packages/crypto/core
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

# Accept VITE_SERVER_URL from Railway build-time variables
ARG VITE_SERVER_URL
ENV VITE_SERVER_URL=$VITE_SERVER_URL

# Build the web app (Vite inlines VITE_* env vars at build time)
RUN cd apps/web && pnpm run build

# ============================================================
# Stage 3: Runtime — nginx to serve static files
# ============================================================
FROM nginx:alpine

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=js-builder /app/apps/web/dist/client /usr/share/nginx/html

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q --spider http://localhost:8080/nginx-health || exit 1

EXPOSE 8080
