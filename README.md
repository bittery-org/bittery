# Bittery

A zero-knowledge password manager with end-to-end encryption. Sensitive data is encrypted client-side before reaching the server, so passwords never leave your device unencrypted.

## Public Beta Status

Bittery Cloud is preparing for an invite-only hosted beta. Public cloud signup can be disabled with `BITTERY_CLOUD_PUBLIC_SIGNUP=false`, and paid hosted billing can be disabled with `BITTERY_CLOUD_BILLING_ENABLED=false`.

Self-hosting is supported under the Functional Source License. Self-hosted deployments run in `BITTERY_MODE=self-hosted` and do not require Stripe or a hosted subscription.

## Platforms

- **Web** — React app with TanStack Router + Vite
- **Marketing** — Public website and documentation
- **Server** — Rust API server with Axum + Qubit
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
- **Rust crypto core** — shared implementation compiled to WASM, NAPI, Tauri commands, and native mobile bindings

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, TanStack Router + Query, Tailwind CSS 4, Radix UI + shadcn/ui |
| Backend | Rust API server with Axum + Qubit |
| Database | PostgreSQL + SQLx migrations |
| Desktop | Tauri 2 (Rust) |
| Mobile | React Native + Expo |
| Extension | Chrome MV3 service worker |
| Crypto | Rust core with WASM, NAPI, and native bindings |
| Monorepo | pnpm + Turborepo |
| Code Quality | Biome, TypeScript, Cargo |

## Project Structure

```text
bittery/
├── apps/
│   ├── web/              # React web app
│   ├── marketing/        # Public marketing site and docs
│   ├── server/           # Rust API server
│   ├── desktop/          # Tauri 2 desktop app
│   ├── extension/        # Browser extension
│   └── mobile/           # React Native (Expo) app
├── packages/
│   ├── core/             # Shared business logic and React hooks
│   ├── db/               # Shared database package
│   ├── device/           # Device identity helpers
│   ├── i18n/             # Paraglide messages and generated i18n output
│   ├── rust-rpc/         # Generated Rust/Qubit TypeScript bindings
│   ├── shared/           # Shared utilities, billing metadata, and RPC helpers
│   ├── storage/          # Platform-specific storage adapters
│   ├── sync/             # Multi-device sync + offline support
│   ├── types/            # Shared TypeScript types
│   ├── ui/               # Shared UI component library
│   └── config/           # Shared TypeScript configuration
└── deploy/
    └── docker/           # Self-hosted Docker Compose deployment
```

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/) 10+
- [Rust](https://www.rust-lang.org/tools/install)
- [Bun](https://bun.sh/) (used by the existing test tooling)
- [Docker](https://www.docker.com/) (for PostgreSQL)

### Setup

```bash
pnpm install
pnpm run db:start
pnpm run db:migrate
pnpm run dev
```

For the Rust API auto-restart in `pnpm run dev` / `pnpm run dev:server`, install `cargo-watch` once with `cargo install cargo-watch`.

The web app runs at [http://localhost:3001](http://localhost:3001), the API server at [http://localhost:3000](http://localhost:3000), and the marketing site at [http://localhost:3003](http://localhost:3003).

### Development Commands

```bash
# Run individual apps
pnpm run dev:web
pnpm run dev:server
pnpm run dev:server:once
pnpm run dev:desktop
pnpm run dev:extension
pnpm run dev:mobile
pnpm run dev:marketing

# Code quality
pnpm run check
pnpm run check-types
pnpm run test

# Database
pnpm run db:create -- add_users_index
pnpm run db:migrate
```

## Environment Variables

Create `.env` in the repository root:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bittery
JWT_SECRET=<random-secret>
CORS_ORIGIN=http://localhost:3000,http://localhost:3001
TRUST_PROXY_MODE=none
BITTERY_MODE=cloud
BITTERY_CLOUD_PUBLIC_SIGNUP=true
BITTERY_CLOUD_BILLING_ENABLED=true

# Optional S3-compatible storage
BITTERY_STORAGE_ENDPOINT=
BITTERY_STORAGE_BUCKET=
BITTERY_STORAGE_ACCESS_KEY_ID=
BITTERY_STORAGE_SECRET_ACCESS_KEY=
BITTERY_STORAGE_REGION=auto
BITTERY_STORAGE_CDN_URL=
MINIO_ROOT_PASSWORD=

# Optional rate limiting and pub/sub
RATE_LIMIT_ADAPTER=auto
RATE_LIMIT_REDIS_URL=
REDIS_URL=
SHARE_LINK_DAILY_LIMIT=50
```

Marketing builds also support:

```env
VITE_WEBAPP_URL=https://app.bittery.com
VITE_SERVER_URL=https://api.bittery.com
VITE_BILLING_MARKETING_ENABLED=false
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, issue reporting, and pull request expectations.

## License

This project is source-available under the [Functional Source License 1.1 (FSL-1.1-ALv2)](LICENSE). This is not an OSI-approved open-source license. After two years, each release converts to the Apache License 2.0.
