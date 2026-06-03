# Contributing to Bittery

Thanks for helping improve Bittery. This repository is source-available under `FSL-1.1-ALv2`; by contributing, you agree that your contribution is provided under the same license unless a different license is explicitly agreed in writing.

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
