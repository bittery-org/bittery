# Bittery

## Checks

`pnpm exec turbo -F <pkg> check-types` while working (`-F '...<pkg>'` to include dependents,
`pnpm check:server` for Rust). `pnpm check:ci` when done, plus `pnpm check:ci:rust` if you
touched Rust.

Not `pnpm --filter <app> check-types` — skips Paraglide, fakes missing-module errors.
Not root `pnpm test` — drags `cargo test` into the sandbox and fails there.

## Tests

Prefer test-first: write the failing test, then the code. Always for bugfixes — a bug without a
reproducing test isn't fixed. Prototypes and spikes are exempt; say which you're doing.

| most packages, and `web` | `pnpm --filter <name> exec bun test src/x.test.ts -t "name"` |
| --- | --- |
| `apps/extension` | `bun test tests/background/x.test.ts` — one file per process, `mock.module` leaks |
| root `scripts/`, `desktop` | `node --test scripts/release-version.test.mjs` |
| server | `cargo test --manifest-path apps/server/Cargo.toml services::auth::tests::name` |
| crypto | `cargo test --manifest-path packages/crypto/core/Cargo.toml -p bittery-crypto-core <name>` |
| e2e | `pnpm --filter web exec playwright test --project=cloud tests/e2e/x.spec.ts -g "name"` |

Server tests need a running database, in dev one is always running and attach via `#[cfg(test)] #[path = "auth_tests.rs"] mod
tests;` at the bottom of the parent file. E2E rebuilds the server and boots Vite every run — save
it for `tests/e2e` changes.

## Bites

- i18n keys go in `en.json` and `de.json`, then `pnpm i18n:generate`.
- `pnpm exec biome check --write <changed files>`; `check:fix` is repo-wide `--unsafe`.
- Clippy only runs in CI, so local `cargo check` proves little.
- New server route: `write-openapi`, `@bittery/api-contract generate`, bump the `assert_eq!` counts.
- Migrations: `pnpm run db:create -- <name>`, and frozen once merged.
- `react`, `zod`, `hono`, `@types/react*` come from the `catalog:`.

## Style

`DESIGN.md` for UI (tokens, the `@bittery/ui/icons` barrel, semantic colours). `CONTEXT.md` for
vocabulary. `docs/adr/` for settled decisions — ADR 0002: server services own their SQL.

Avoid `useEffect`. Comments say *why*, briefly. A dev server is always running; skip builds unless
asked. `RELEASING.md` for versions, `packages/crypto/core/DEVELOPMENT.md` for crypto.
