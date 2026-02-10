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

# Copy entire repo (filtered by .dockerignore)
COPY . .

# Stub workspace packages whose package.json is generated (not in git)
RUN mkdir -p packages/crypto/wasm && echo '{"name":"@bittery/crypto-wasm","version":"0.1.0","private":true}' > packages/crypto/wasm/package.json \
 && mkdir -p packages/crypto/core && echo '{"name":"@bittery/crypto-core","version":"0.0.0","private":true}' > packages/crypto/core/package.json

RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy WASM build output from stage 1 (overwrites stub)
COPY --from=wasm-builder /build/packages/crypto/wasm packages/crypto/wasm

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
