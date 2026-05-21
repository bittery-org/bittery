# Bittery

A zero-knowledge password manager with end-to-end encryption. All sensitive data is encrypted client-side before reaching the server — your passwords never leave your device unencrypted.

## Platforms

- **Web** — React app with TanStack Router + Vite
- **Desktop** — Tauri 2 (macOS, Windows, Linux)
- **Browser Extension** — Chrome Manifest V3
- **Mobile** — React Native with Expo (iOS, Android)

## Security

- **Zero-knowledge architecture** — the server never sees plaintext passwords or encryption keys
- **Dual-key model** — account password + Secret Key (A3-XXXXXX format)
- **AES-256-GCM + context binding (`AES-GCM-AAD-V1`)** — vault data encrypted client-side with random IVs and entity-bound integrity checks
- **SRP-6a authentication** — password never transmitted, not even as a hash
- **RSA-4096** — asymmetric key pairs for secure vault sharing between users
- **PBKDF2 (310k iterations) + HKDF** — key derivation from master password
- **Login KDF policy + pinning** — server KDF parameters are validated and pinned locally to block downgrade/tamper attempts
- **All crypto in Rust** — single Rust implementation compiled to WASM, NAPI, Tauri commands, and native mobile bindings

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, TanStack Router + Query, Tailwind CSS 4, Radix UI + shadcn/ui |
| Backend | Rust API server with Axum + Qubit, legacy Hono + tRPC server retained during migration |
| Database | PostgreSQL + Drizzle ORM |
| Desktop | Tauri 2 (Rust) |
| Mobile | React Native + Expo |
| Extension | Chrome MV3 service worker |
| Crypto | Rust core with WASM, NAPI, and native bindings |
| Monorepo | pnpm + Turborepo |
| Code Quality | Biome (linting + formatting), TypeScript |

## Project Structure

```
bittery/
├── apps/
│   ├── web/              # React web app
│   ├── server-rust/      # Primary Rust API server
│   ├── server/           # Legacy Hono + tRPC server kept during migration
│   ├── desktop/          # Tauri 2 desktop app
│   ├── extension/        # Chrome extension
│   └── mobile/           # React Native (Expo) app
├── packages/
│   ├── api/              # Legacy tRPC router definitions
│   ├── auth/             # Server-side SRP-6a auth + JWT sessions
│   ├── crypto/           # Rust crypto core + platform bindings
│   ├── core/             # Shared business logic and React hooks
│   ├── db/               # Drizzle ORM schema + migrations
│   ├── jobs/             # Background job queue (pg-boss)
│   ├── pubsub/           # Pub/sub messaging
│   ├── rust-rpc/         # Generated Rust/Qubit TypeScript bindings
│   ├── storage/          # Platform-specific storage adapters
│   ├── sync/             # Multi-device sync + offline support
│   ├── shared/           # Shared utilities + RPC client helpers
│   ├── types/            # Shared TypeScript types
│   ├── ui/               # Shared UI component library
│   └── config/           # Shared TypeScript configuration
```

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/) 10+
- [Rust](https://www.rust-lang.org/tools/install) (primary API server and native crypto bindings)
- [Bun](https://bun.sh/) (used by the existing test tooling)
- [Docker](https://www.docker.com/) (for PostgreSQL)

### Setup

```bash
# Install dependencies
pnpm install

# Start PostgreSQL
pnpm run db:start

# Apply database migrations
pnpm run db:migrate

# Start all apps in development mode
pnpm run dev
```

For the Rust API auto-restart in `pnpm run dev` / `pnpm run dev:server`, install `cargo-watch` once with `cargo install cargo-watch`.

The web app runs at [http://localhost:3001](http://localhost:3001) and the API server at [http://localhost:3000](http://localhost:3000).

### Development Commands

```bash
# Run individual apps
pnpm run dev:web          # Web app only
pnpm run dev:server       # API server only, with auto-restart via cargo-watch
pnpm run dev:server:once  # API server only, without file watching
pnpm run dev:desktop      # Desktop app (Tauri)
pnpm run dev:extension    # Browser extension
pnpm run dev:mobile       # Mobile app (Expo)

# Code quality
pnpm run check            # Biome linting + formatting
pnpm run check-types      # TypeScript type checking
pnpm run test             # Run tests

# Database
pnpm run db:create -- add_users_index   # Create a new Rust SQL migration file
pnpm run db:migrate                     # Apply migrations with the Rust server migrator

# Existing local databases from the old Drizzle flow are baselined automatically
# on the first Rust migration run by copying `drizzle.__drizzle_migrations`
# into SQLx's `_sqlx_migrations` history. No local reset should be needed.

# Build
pnpm run build            # Build everything
pnpm run build:desktop    # Tauri desktop binary
pnpm run build:extension  # Chrome extension
pnpm run build:mobile     # EAS production build
pnpm run build:crypto-wasm   # Rebuild WASM bindings
pnpm run build:crypto-napi   # Rebuild NAPI bindings
```

### Environment Variables

Create `.env` in the repository root:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bittery
JWT_SECRET=<random-secret>
CORS_ORIGIN=http://localhost:3000,http://localhost:3001
TRUST_PROXY_MODE=none          # none | cloudflare | forwarded
BITTERY_STORAGE_ENDPOINT=       # S3-compatible storage
BITTERY_STORAGE_BUCKET=
BITTERY_STORAGE_ACCESS_KEY_ID=
BITTERY_STORAGE_SECRET_ACCESS_KEY=
BITTERY_STORAGE_REGION=auto
BITTERY_STORAGE_CDN_URL=        # or BITTERY_STORAGE_PUBLIC_URL
MINIO_ROOT_PASSWORD=            # Required before enabling docker compose --profile storage

# Optional: rate limiting backend
RATE_LIMIT_ADAPTER=auto         # auto | postgres | redis | valkey
RATE_LIMIT_REDIS_URL=           # Redis/Valkey URL for rate limits (falls back to REDIS_URL)
REDIS_URL=                      # Shared Redis URL (also used by pubsub)
SHARE_LINK_DAILY_LIMIT=50
```

## License

This project is licensed under the [Functional Source License 1.1 (FSL-1.1-ALv2)](LICENSE). After two years, each release converts to the Apache License 2.0.
