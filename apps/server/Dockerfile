FROM rust:1-bookworm AS builder

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		build-essential \
		ca-certificates \
		clang \
		cmake \
		libssl-dev \
		pkg-config \
		perl \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app/apps/server

COPY apps/server/Cargo.toml apps/server/Cargo.lock ./
COPY apps/server/src ./src
COPY packages/crypto/core/Cargo.toml /app/packages/crypto/core/Cargo.toml
COPY packages/crypto/core/crates/bittery-crypto-core /app/packages/crypto/core/crates/bittery-crypto-core

RUN cargo build --release

FROM debian:bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates wget \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN groupadd --system --gid 10001 bittery \
	&& useradd --system --uid 10001 --gid 10001 --home-dir /home/bittery --create-home bittery \
	&& mkdir -p /app/migrations \
	&& chown -R 10001:10001 /app /home/bittery

COPY --from=builder --chown=10001:10001 /app/apps/server/target/release/bittery-server ./bittery-server
COPY --chown=10001:10001 apps/server/migrations ./migrations

ENV MIGRATIONS_FOLDER=/app/migrations
ENV PORT=3000

USER 10001:10001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD wget -q --spider http://localhost:3000/healthz || exit 1

EXPOSE 3000

CMD ["./bittery-server"]