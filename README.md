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
| Backend | Hono + tRPC on Bun |
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
│   ├── server/           # Hono + tRPC API server
│   ├── desktop/          # Tauri 2 desktop app
│   ├── extension/        # Chrome extension
│   └── mobile/           # React Native (Expo) app
├── packages/
│   ├── api/              # tRPC router definitions
│   ├── auth/             # Server-side SRP-6a auth + JWT sessions
│   ├── crypto/           # Rust crypto core + platform bindings
│   ├── core/             # Shared business logic and React hooks
│   ├── db/               # Drizzle ORM schema + migrations
│   ├── jobs/             # Background job queue (pg-boss)
│   ├── pubsub/           # Pub/sub messaging
│   ├── storage/          # Platform-specific storage adapters
│   ├── sync/             # Multi-device sync + offline support
│   ├── shared/           # Shared utilities + tRPC client helpers
│   ├── types/            # Shared TypeScript types
│   ├── ui/               # Shared UI component library
│   └── config/           # Shared TypeScript configuration
```

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/) 10+
- [Bun](https://bun.sh/) (server runtime)
- [Docker](https://www.docker.com/) (for PostgreSQL)
- [Rust](https://rustup.rs/) (for building crypto bindings)

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

The web app runs at [http://localhost:3001](http://localhost:3001) and the API server at [http://localhost:3000](http://localhost:3000).

### Development Commands

```bash
# Run individual apps
pnpm run dev:web          # Web app only
pnpm run dev:server       # API server only
pnpm run dev:desktop      # Desktop app (Tauri)
pnpm run dev:extension    # Browser extension
pnpm run dev:mobile       # Mobile app (Expo)

# Code quality
pnpm run check            # Biome linting + formatting
pnpm run check-types      # TypeScript type checking
pnpm run test             # Run tests

# Database
pnpm run db:studio        # Open Drizzle Studio
pnpm run db:generate      # Generate migrations from schema changes
pnpm run db:migrate       # Apply migrations

# Build
pnpm run build            # Build everything
pnpm run build:desktop    # Tauri desktop binary
pnpm run build:extension  # Chrome extension
pnpm run build:mobile     # EAS production build
pnpm run build:crypto-wasm   # Rebuild WASM bindings
pnpm run build:crypto-napi   # Rebuild NAPI bindings
```

### Environment Variables

Create `apps/server/.env`:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bittery
JWT_SECRET=<random-secret>
BITTERY_STORAGE_ENDPOINT=       # S3-compatible storage
BITTERY_STORAGE_BUCKET=
BITTERY_STORAGE_ACCESS_KEY_ID=
BITTERY_STORAGE_SECRET_ACCESS_KEY=
BITTERY_STORAGE_REGION=auto
BITTERY_STORAGE_CDN_URL=        # or BITTERY_STORAGE_PUBLIC_URL

# Optional: rate limiting backend
RATE_LIMIT_ADAPTER=auto         # auto | postgres | redis | valkey
RATE_LIMIT_REDIS_URL=           # Redis/Valkey URL for rate limits (falls back to REDIS_URL)
REDIS_URL=                      # Shared Redis URL (also used by pubsub)
SHARE_LINK_DAILY_LIMIT=50
```

## License

This project is licensed under the [Functional Source License 1.1 (FSL-1.1-ALv2)](LICENSE). After two years, each release converts to the Apache License 2.0.
