# Contributing to Bittery

Thanks for helping improve Bittery. This repository is free software: `apps/server` is licensed under the [GNU AGPLv3](LICENSE), and the clients, crypto, and packages under the [GNU GPLv3](LICENSE-GPL). See the [license section of the README](README.md#license) for the full component map.

## Contributor License Agreement

**Before we can merge your first pull request, you must sign our [Contributor License Agreement](CLA.md).** The CLA Assistant bot will comment on your PR with a link; signing takes one click and covers all your future contributions.

The CLA grants us the right to relicense your contribution. We need it for one specific reason: GPLv3 conflicts with Apple's App Store terms, so without it we could not ship our mobile clients. [CLA.md](CLA.md) explains this in full, and includes our commitment that every accepted contribution stays published under the AGPLv3/GPLv3.

Please don't send substantial work before signing — we'd hate to have to turn away a good patch.

## Before You Start

- Search existing issues and discussions before opening a new one.
- For security issues, do not open a public issue. Email `security@bittery.com` and see [SECURITY.md](SECURITY.md).
- Keep changes focused. Avoid unrelated refactors in feature or bugfix pull requests.

## Local Setup

```bash
pnpm install
pnpm run db:start
pnpm run db:migrate
```

The app expects a dev server to be started separately when needed:

```bash
pnpm run dev:web
pnpm run dev:server
pnpm run dev:marketing
```

## Database Migrations

Server migrations live in `apps/server/migrations`.

```bash
pnpm run db:create -- descriptive_migration_name
pnpm run db:migrate
```

## Checks

Use focused checks for the area you changed:

```bash
pnpm --filter server test
pnpm --filter web check-types
pnpm i18n:check
```

If you change translation files in `packages/i18n/messages/*.json`, run:

```bash
pnpm i18n:generate
```

## Pull Requests

- Explain the user-facing change and why it is needed.
- Include tests for bug fixes when practical.
- Keep user-facing text in the i18n message files for every supported language.
- Do not commit secrets, local database files, or generated build outputs.
