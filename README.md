# Bittery — Zero-Knowledge Password Manager

[![Website](https://img.shields.io/badge/website-bittery.com-2563eb)](https://bittery.com)
[![License](https://img.shields.io/badge/license-AGPL--3.0--only-f97316)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-bittery.com%2Fdocs-64748b)](https://bittery.com/docs)

**Bittery is a source-available password manager with zero-knowledge, end-to-end encryption.** Your passwords, notes, cards, and TOTP secrets are encrypted on your device before they ever reach a server — so no one else can read them, not even us.

> The password manager that can't spy on you — even if it wanted to.

---

## Why Bittery?

- **True zero-knowledge** — Your master password and Secret Key never leave your device. We only store encrypted data.
- **Two-key protection** — Your account password plus a unique Secret Key. Guessing one isn't enough.
- **Everywhere you are** — Web, desktop (macOS, Windows, Linux), mobile (iOS & Android), and a browser extension. Syncs across every device in seconds.
- **Share safely** — Encrypted vault sharing for families and teams, plus expiring secure links.
- **Your choice of hosting** — Use [Bittery Cloud](https://app.bittery.com) or [self-host](https://bittery.com/docs/self-hosting/overview) on your own infrastructure with Docker.
- **Transparent by design** — Source code is public. Anyone can verify how encryption works — or run their own instance.

## Get started

| Option | Best for |
|--------|----------|
| [**Bittery Cloud**](https://app.bittery.com) | Hosted sync with no server setup (invite-only closed beta) |
| [**Self-host**](https://bittery.com/docs/self-hosting/overview) | Full control on your own server — no subscription required |
| [**Download apps**](https://bittery.com/download) | Desktop, mobile, and browser extension |

New to Bittery? Read the [getting started guide](https://bittery.com/docs/getting-started/create-account) or [import from another password manager](https://bittery.com/docs/getting-started/import-passwords) (1Password, Bitwarden, LastPass, and more).

## Security

Bittery is built around a zero-knowledge architecture:

- **Client-side encryption** with AES-256-GCM before data is stored or synced
- **SRP authentication** — your password is never sent to the server, not even as a hash
- **Vault sharing** with RSA-4096 key pairs
- **Strong key derivation** (PBKDF2 + HKDF) from your master password

For the full security model, see the [security documentation](https://bittery.com/docs/security).

Found a vulnerability? Please report it privately — see [SECURITY.md](SECURITY.md).

## Contributing

We welcome bug reports, feature ideas, and pull requests. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and PR guidelines.

<details>
<summary><strong>Development setup</strong> (for contributors)</summary>

### Prerequisites

- [Node.js](https://nodejs.org/) 24+
- [pnpm](https://pnpm.io/) 10+
- [Rust](https://www.rust-lang.org/tools/install)
- [Docker](https://www.docker.com/) (for PostgreSQL)

### Quick start

```bash
pnpm install
pnpm run db:start
pnpm run db:migrate
pnpm run dev
```

Local URLs: web app at [localhost:3001](http://localhost:3001), API at [localhost:3000](http://localhost:3000), marketing site at [localhost:3003](http://localhost:3003).

For Rust API auto-restart, install `cargo-watch` once: `cargo install cargo-watch`.

</details>

<details>
<summary><strong>Tech stack & project structure</strong></summary>

### Platforms

| App | Stack |
|-----|-------|
| Web | React, TanStack Router, Vite |
| Server | Rust, Axum |
| Desktop | Tauri 2 |
| Mobile | React Native, Expo |
| Extension | Chrome Manifest V3 |

### Monorepo layout

```text
bittery/
├── apps/
│   ├── web/              # Web app
│   ├── marketing/        # Website & docs
│   ├── server/           # API server
│   ├── desktop/          # Desktop app
│   ├── extension/        # Browser extension
│   └── mobile/           # Mobile app
├── packages/             # Shared libraries (core, ui, sync, crypto, i18n, …)
└── deploy/docker/        # Self-hosted Docker Compose
```

</details>

<details>
<summary><strong>Environment variables</strong></summary>

Create `.env` in the repository root:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bittery
JWT_SECRET=<random-secret>
CORS_ORIGIN=http://localhost:3000,http://localhost:3001
TRUST_PROXY_MODE=none
BITTERY_MODE=cloud
BITTERY_CLOUD_PUBLIC_SIGNUP=true
BITTERY_CLOUD_BILLING_ENABLED=true
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [self-hosting docs](https://bittery.com/docs/self-hosting/overview) for the full list including optional storage, Redis, and rate limiting settings.

</details>

## License

Copyright (C) 2025-2026 Bittery.

Bittery is free software, licensed under the GNU AGPLv3 and GPLv3. The split follows the component:

| Component | License |
| --- | --- |
| `apps/server` | [AGPL-3.0-only](LICENSE) |
| `apps/web`, `apps/extension`, `apps/desktop`, `apps/mobile`, `apps/marketing` | [GPL-3.0-only](LICENSE-GPL) |
| `packages/*` (including `packages/crypto/*`) | [GPL-3.0-only](LICENSE-GPL) |

Each app and package carries its own `LICENSE` file, so the boundary is unambiguous in any subtree you vendor or redistribute.

The crypto core is GPLv3 rather than AGPLv3 so that it links cleanly into both the AGPL server (via AGPLv3 §13 cross-compatibility) and the GPL clients.

The license covers the code, not the name: Bittery™ is our unregistered trademark, so please rename your fork if you distribute a modified version. See [TRADEMARK.md](TRADEMARK.md) — it's short and friendlier than it sounds.

Contributions require signing our [Contributor License Agreement](https://gist.github.com/bittery-bot/a75c287eccaaaa188b02c3cac1c8472b). See [CONTRIBUTING.md](CONTRIBUTING.md).
