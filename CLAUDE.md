# Bittery evolutionary Rust runtime

This branch evolves the existing product around one shared Rust Client Runtime. Read `CONTEXT.md`,
`docs/adr/README.md`, and
`planning/evolutionary-rust-runtime/map.md` before changing authentication, storage, Sync, client
architecture, or application ownership.

## Standing architecture

- Preserve the current SRP, KDF, encryption algorithms, key hierarchy, persisted cryptographic
  formats, and compatible `bittery-crypto-core` behavior. Structural crypto changes require unchanged
  vectors and behavior; cryptographic redesign is outside this effort.
- Change Server schemas, OpenAPI, Runtime, and clients together in place. There is no user migration
  window and no parallel v1/v2 client stack.
- Deliver verified vertical slices in this order: Server/Web, Desktop, Extension, native Android
  Compose, native iOS SwiftUI. A later host reuses Runtime behavior; it does not reimplement it.
- Keep each accepted Operation durable until an authoritative semantic outcome. UI lifecycle and a
  finite transport-attempt count do not own or terminate accepted work.
- Treat the `greenfield` branch as decision history and evidence. Reuse a Greenfield decision only
  after reconciling it with ADR 0014 and the current cryptographic model.

## Planning

For Wayfinder maps, decision tickets, specs, implementation tickets, or tracker status, read
`docs/agents/issue-tracker.md`. Conduct unresolved maintainer decisions in German and write repository
artifacts in English. Before specifying or implementing a new architectural slice, resolve its
frontier through Wayfinder/grilling and record the answer.

For product vocabulary, glossary changes, or ADRs, read `docs/agents/domain.md`. Legacy vocabulary is
evidence; `CONTEXT.md` and accepted ADRs govern new names.

## Implementation gates

Start a slice only when its ticket is `ready-for-agent` and its dependencies are complete. Make the
smallest end-to-end path pass before widening its variants. Preserve unrelated work in the tree.

Prefer test-first implementation. A bug fix includes a reproducing test. Explicit throwaway binding
spikes are exempt and must record the question and verdict before their code is removed.

## Checks

Use `pnpm exec turbo -F <pkg> check-types` while working; add `-F '...<pkg>'` for dependents. The
package-filter form skips Paraglide and can report false missing-module errors. Use `pnpm check:server`
for Rust server work. Run `pnpm check:ci` before a phase completes and `pnpm check:ci:rust` when Rust
changed. Documentation-only changes require valid links and `git diff --check`.

Target one test while iterating:

| Area | Command shape |
| --- | --- |
| Most TypeScript packages and Web | `pnpm --filter <name> exec bun test src/x.test.ts -t "name"` |
| Extension | `bun test tests/background/x.test.ts` in a separate process per file |
| Root scripts and Desktop | `node --test scripts/x.test.mjs` |
| Server | `cargo test --manifest-path apps/server/Cargo.toml module::test` |
| Crypto | `cargo test --manifest-path packages/crypto/core/Cargo.toml -p bittery-crypto-core test` |
| End to end | `pnpm --filter web exec playwright test --project=cloud tests/e2e/x.spec.ts -g "name"` |

Server tests require the development database. End-to-end tests rebuild the Server and boot Vite, so
reserve them for acceptance paths. Run `pnpm exec biome check --write <changed files>` on changed
TypeScript. A new Server route also regenerates OpenAPI and `@bittery/api-contract` and updates route
count assertions. Generate Rust-defined cross-language types under ADR 0012. Create migrations with
`pnpm run db:create -- <name>`; merged migrations are frozen.

Use `DESIGN.md` for UI work, `RELEASING.md` for versions, and
`packages/crypto/core/DEVELOPMENT.md` for crypto-core work. Comments explain why, briefly.
