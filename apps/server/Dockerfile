# ============================================================
# Stage 1: Rust NAPI builder — compile native crypto bindings
# ============================================================
FROM rust:1-bookworm AS rust-builder

WORKDIR /build

# Copy the Rust workspace (needed for workspace inheritance in Cargo.toml)
COPY packages/crypto/core packages/crypto/core

# Copy NAPI crate
COPY packages/crypto/napi/Cargo.toml packages/crypto/napi/Cargo.lock packages/crypto/napi/
COPY packages/crypto/napi/build.rs packages/crypto/napi/
COPY packages/crypto/napi/src packages/crypto/napi/src

RUN cd packages/crypto/napi && cargo build --release

# ============================================================
# Stage 2: JS builder — install deps and bundle with tsdown
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

# Copy NAPI .node binary from Rust builder stage
COPY --from=rust-builder /build/packages/crypto/napi/target/release/libbittery_crypto_napi.so packages/crypto/napi/bittery-crypto.linux-x64-gnu.node

# Build server bundle
RUN cd apps/server && pnpm exec tsdown

# ============================================================
# Stage 3: Runtime — minimal Bun image
# ============================================================
FROM oven/bun:1-slim

WORKDIR /app

# Copy node_modules from builder
COPY --from=js-builder /app/node_modules ./node_modules

# Copy built server bundle (includes chunks produced by tsdown)
COPY --from=js-builder /app/apps/server/dist ./dist

# Set up @bittery/crypto-napi module for runtime resolution
COPY --from=rust-builder /build/packages/crypto/napi/target/release/libbittery_crypto_napi.so ./node_modules/@bittery/crypto-napi/bittery-crypto.node
COPY --from=js-builder /app/packages/crypto/napi/index.js ./node_modules/@bittery/crypto-napi/index.js
COPY --from=js-builder /app/packages/crypto/napi/index.d.ts ./node_modules/@bittery/crypto-napi/index.d.ts
COPY --from=js-builder /app/packages/crypto/napi/package.json ./node_modules/@bittery/crypto-napi/package.json

# Copy database migrations
COPY packages/db/src/migrations ./migrations

ENV MIGRATIONS_FOLDER=/app/migrations
ENV NAPI_RS_NATIVE_LIBRARY_PATH=/app/node_modules/@bittery/crypto-napi/bittery-crypto.node
ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://localhost:3000/healthz || exit 1

EXPOSE 3000

CMD ["bun", "run", "dist/index.mjs"]
