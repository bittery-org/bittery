# ============================================================
# Stage 1: Rust NAPI builder — compile native crypto bindings
# ============================================================
FROM rust:1-bookworm AS rust-builder

WORKDIR /build

# Copy NAPI crate and its core dependency (preserve relative paths)
COPY packages/crypto/napi/Cargo.toml packages/crypto/napi/Cargo.lock packages/crypto/napi/
COPY packages/crypto/napi/build.rs packages/crypto/napi/
COPY packages/crypto/napi/src packages/crypto/napi/src
COPY packages/crypto/core/crates/bittery-crypto-core packages/crypto/core/crates/bittery-crypto-core

RUN cd packages/crypto/napi && cargo build --release

# ============================================================
# Stage 2: JS builder — install deps and bundle with tsdown
# ============================================================
FROM node:22-bookworm-slim AS js-builder

RUN corepack enable && corepack prepare pnpm@10.18.3 --activate

WORKDIR /app

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Copy all real package.json files (needed for pnpm install --frozen-lockfile)
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/extension/package.json apps/extension/package.json
COPY apps/mobile/package.json apps/mobile/package.json
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
COPY packages/crypto/wasm/package.json packages/crypto/wasm/package.json

# Stub packages that aren't present in the repo but are in the workspace
RUN mkdir -p packages/crypto/core && echo '{"name":"@bittery/crypto-core","version":"0.0.0","private":true}' > packages/crypto/core/package.json
RUN mkdir -p packages/crypto/expo-module && echo '{"name":"@bittery/crypto-nitro","version":"0.0.0","private":true}' > packages/crypto/expo-module/package.json

RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy source code for server and all its transitive workspace dependencies
COPY apps/server apps/server
COPY packages/api packages/api
COPY packages/auth packages/auth
COPY packages/config packages/config
COPY packages/db packages/db
COPY packages/jobs packages/jobs
COPY packages/pubsub packages/pubsub
COPY packages/shared packages/shared
COPY packages/types packages/types

# Copy NAPI .node binary from Rust builder stage
COPY --from=rust-builder /build/packages/crypto/napi/target/release/libbittery_crypto_napi.so packages/crypto/napi/bittery-crypto.linux-x64-gnu.node

# Build server bundle
RUN cd apps/server && pnpm exec tsdown

# Prepare production node_modules via pnpm deploy
RUN pnpm --filter server deploy --prod /deploy

# ============================================================
# Stage 3: Runtime — minimal Bun image
# ============================================================
FROM oven/bun:1-slim

WORKDIR /app

# Copy production node_modules from deploy
COPY --from=js-builder /deploy/node_modules ./node_modules

# Copy built server bundle
COPY --from=js-builder /app/apps/server/dist/index.mjs ./dist/index.mjs

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
