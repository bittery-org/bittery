# ============================================================
# Stage 1: Rust WASM builder — compile crypto to WebAssembly
# ============================================================
FROM rust:1-bookworm AS wasm-builder

RUN rustup target add wasm32-unknown-unknown
RUN cargo install wasm-pack

WORKDIR /build

# Copy Rust workspace for WASM build
COPY packages/crypto/core/Cargo.toml packages/crypto/core/Cargo.toml
COPY packages/crypto/core/Cargo.lock packages/crypto/core/Cargo.lock
COPY packages/crypto/core/crates packages/crypto/core/crates

# Build WASM package
RUN cd packages/crypto/core && \
    wasm-pack build crates/bittery-crypto-wasm \
      --target web \
      --out-dir ../../../wasm \
      --out-name bittery_crypto

# Write the correct package.json for the WASM package
RUN echo '{"name":"@bittery/crypto-wasm","type":"module","version":"0.1.0","main":"bittery_crypto.js","types":"bittery_crypto.d.ts","exports":{".":{"types":"./bittery_crypto.d.ts","import":"./bittery_crypto.js"}},"sideEffects":["./bittery_crypto.js"]}' > packages/crypto/wasm/package.json

# ============================================================
# Stage 2: JS builder — install deps and build Vite SPA
# ============================================================
FROM node:22-bookworm-slim AS js-builder

RUN corepack enable && corepack prepare pnpm@10.18.3 --activate

WORKDIR /app

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Copy all package.json files (needed for pnpm install)
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/jobs/package.json packages/jobs/package.json
COPY packages/pubsub/package.json packages/pubsub/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/sync/package.json packages/sync/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/crypto/napi/package.json packages/crypto/napi/package.json

# Stub workspace packages excluded by .dockerignore or not in git
# crypto-wasm is built in stage 1 and copied later (line 69), stub is only for pnpm install
RUN mkdir -p apps/desktop && echo '{"name":"desktop","version":"0.0.0","private":true}' > apps/desktop/package.json \
 && mkdir -p apps/extension && echo '{"name":"extension","version":"0.0.0","private":true}' > apps/extension/package.json \
 && mkdir -p apps/mobile && echo '{"name":"mobile","version":"0.0.0","private":true}' > apps/mobile/package.json \
 && mkdir -p packages/crypto/wasm && echo '{"name":"@bittery/crypto-wasm","version":"0.1.0","private":true}' > packages/crypto/wasm/package.json \
 && mkdir -p packages/crypto/core && echo '{"name":"@bittery/crypto-core","version":"0.0.0","private":true}' > packages/crypto/core/package.json \
 && mkdir -p packages/crypto/expo-module && echo '{"name":"@bittery/crypto-nitro","version":"0.0.0","private":true}' > packages/crypto/expo-module/package.json

RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy WASM build output from stage 1
COPY --from=wasm-builder /build/packages/crypto/wasm packages/crypto/wasm

# Copy source code for web and all its transitive workspace dependencies
COPY apps/web apps/web
COPY packages/api packages/api
COPY packages/auth packages/auth
COPY packages/config packages/config
COPY packages/core packages/core
COPY packages/db packages/db
COPY packages/shared packages/shared
COPY packages/storage packages/storage
COPY packages/sync packages/sync
COPY packages/types packages/types
COPY packages/ui packages/ui

# Build the web app (Vite SPA — no VITE_SERVER_URL needed, defaults to same origin)
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
