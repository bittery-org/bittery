# Working in Bittery

Read `CONTEXT.md`, `docs/adr/README.md`, and `planning/evolutionary-rust-runtime/map.md` before
changing authentication, storage, Sync, client architecture, or application ownership.

For product vocabulary or ADRs, read `docs/agents/domain.md`. For UI work, read `DESIGN.md`; for
versions, `RELEASING.md`; for crypto-core work, `packages/crypto/core/DEVELOPMENT.md`.

## Planning

For Wayfinder maps, decision tickets, specs, implementation tickets, or tracker status, read
`docs/agents/issue-tracker.md`. Before specifying or implementing a new architectural slice, resolve its
frontier through Wayfinder/grilling and record the answer.

Start a slice only when its ticket is `ready-for-agent` and its dependencies are complete. Make the
smallest end-to-end path pass before widening its variants.

Prefer test-first implementation. A bug fix includes a reproducing test. Explicit throwaway binding
spikes are exempt and must record the question and verdict before their code is removed.

## Checks

Use `pnpm exec turbo -F <pkg> check-types` while working; add `-F '...<pkg>'` for dependents. The
package-filter form skips Paraglide and can report false missing-module errors. Use `pnpm check:server`
for Rust server work. Run `pnpm check:ci` before a phase completes and `pnpm check:ci:rust` when Rust
changed. Documentation-only changes require valid links and `git diff --check`.

Run Extension test files in separate Bun processes. Server tests require the development database.
End-to-end tests rebuild the Server and boot Vite, so reserve them for acceptance paths.
Run `pnpm exec biome check --write <changed files>` on changed
TypeScript. A new Server route also regenerates OpenAPI and `@bittery/api-contract` and updates route
count assertions. Generate Rust-defined cross-language types under ADR 0012. Create migrations with
`pnpm run db:create -- <name>`; merged migrations are frozen.
