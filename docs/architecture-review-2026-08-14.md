# Bittery monorepo architecture and simplification review

Date: 2026-08-14 · Commit: `677fbbbe` · Branch: `main`

Method: repository-wide measurement by the orchestrator, plus twelve scoped read-only research
agents (monorepo/tooling, `packages/core`, `apps/web`+`apps/marketing`, `apps/extension`,
`apps/mobile`+native, `apps/desktop`+Tauri, `packages/storage`+`packages/sync`+`packages/device`,
`packages/shared`+`api-contract`+`types`+`i18n`, `packages/ui`, `apps/server`, the crypto stack,
testing and CI). Findings that two agents disagreed on were re-verified by the orchestrator
directly; those checks are marked **verified**.

A previous review exists at `docs/architecture-review-2026-08-02.html` (twelve days earlier).
Several of its headline claims are now **out of date** — see §6. This review does not repeat them.

---

## 1. Executive summary

Bittery is in better architectural shape than a repository of its age and growth rate has any
right to be. It is roughly 310,000 lines old at eight months (682 commits since 2025-12-09), and
the parts that would normally rot first — cryptography, the server contract, storage tiering —
are the parts that are cleanest. Thirteen ADRs record the decisions that got it there, and the
code honours them.

The problems are not in the deep layers. They are in the **seam between the shared packages and
the four frontends**, and in **what CI does not check**.

Five findings dominate:

1. **The per-app bootstrap layer is copy-pasted four ways.** `i18n-provider.tsx` is byte-identical
   across web, desktop and extension. `platform-provider.tsx`, `sync-provider.tsx`,
   `vault-runtime.ts`, `lifecycle.ts`, `crypto.ts`, `storage.ts` and `sync-client-id.ts` are
   near-identical 4-way copies. This is the single most mechanical, lowest-risk duplication in the
   repository.

2. **Three rules the repo believes are enforced are not enforced.** *(all verified)*
   `scripts/check-architecture.mjs` — the package-layering gate ADR 0012 rests on — runs in
   `check:ci` but in **no** GitHub workflow. The `git diff --exit-code apps/desktop/src/generated`
   drift gate lives only in the local `check:ci:rust` script, so ADR 0012's claim that CI diffs the
   ts-rs bindings is false. And only half of `contracts:check` runs in CI: nothing verifies that
   `openapi.v1.json` still matches the live Axum routes.

3. **`packages/shared` is half a web-only import subsystem.** `src/import/**` is 4,102 LOC, 51% of
   the package, consumed by exactly two files in `apps/web`, and it drags `jszip` into the
   dependency graph of desktop, mobile and extension.

4. **Test coverage is absent exactly where the risk is highest.** The repository has 39,327 LOC of
   TypeScript tests and 15,328 of Rust tests, and the distribution is the problem, not the volume:
   `apps/mobile` has zero TypeScript tests and no `test` script, so `turbo run test` skips it
   silently. `apps/desktop` has zero TypeScript tests. `packages/core`'s entire 30-file, ~4,600 LOC
   hook layer has none. `packages/ui` has 89 test LOC for 13,310 source LOC, and **no React
   component test exists anywhere in the repo**. A 531-LOC extension e2e suite covering the
   "not saved while locked" invariant is wired into no workflow at all.

5. **Domain matching is written six times in Kotlin and disagrees with the extension.** This is a
   correctness bug, not a duplication nuisance: the same saved credential can match in the browser
   extension and fail to match on Android.

Roughly **6,000–9,000 LOC** can be removed or relocated without touching behaviour, and about
**1,360 LOC** of that is unambiguously dead. The larger prize is not LOC — it is collapsing four
copies of the app wiring into one, so a change to unlock or sync stops being a four-file edit.

One methodological note: this review challenged its own inputs. A research agent recommended
deleting `packages/shared/src/totp.ts` as duplicate crypto; ADR 0001 names that exact file as a
sanctioned WebCrypto carve-out, so the recommendation is rejected in §25 and replaced with the
finding that actually holds (§7 P11). Two agents disagreed about `packages/device`; the orchestrator
verified it directly. Treat unverified agent claims in this document as leads, and the ones marked
**verified** as findings.

**Security and correctness override every recommendation here.** §25 lists the things that look
like duplication or ceremony and must be left alone.

---

## 2. Current monorepo architecture

```
bittery/
├── apps/
│   ├── server/          Rust · Axum · ~52,600 LOC · owns all SQL (ADR 0002)
│   ├── web/             React · TanStack Router/Query · ~25,800 LOC
│   ├── extension/       React · MV3 · ~24,100 src + ~6,400 test LOC
│   ├── mobile/          Expo/React Native · ~15,300 TS + 7,217 Kotlin + 86 Swift
│   ├── desktop/         React + Tauri 2 · ~9,600 TS + ~6,200 Rust
│   └── marketing/       TanStack Start · MDX · Remotion · ~8,100 LOC
├── packages/
│   ├── core/            ~14,300 LOC · shared vault/unlock/sync logic (ADR 0008)
│   ├── ui/              ~13,300 LOC · React DOM design system
│   ├── shared/          ~8,100 LOC · cross-platform domain helpers
│   ├── storage/         ~6,600 src LOC · tiered ports/adapters
│   ├── api-contract/    15,278 LOC (12,619 generated) · OpenAPI client
│   ├── sync/            ~3,200 src LOC · SSE + outbound queue
│   ├── i18n/            Paraglide · 2,528 keys × 2 locales
│   ├── types/           232 LOC · leaf types shared by sync and storage
│   ├── device/          341 LOC · DEAD (see §11)
│   ├── config/          tsconfig.base.json
│   └── crypto/
│       ├── core/        Rust workspace: bittery-crypto-core (4,789) + -api (1,016)
│       ├── wasm/        generated wasm bindings (~7,000 LOC)
│       ├── react-native/ generated uniffi bindings (~12,700 LOC)
│       └── port/        5,412 LOC · the TS crypto seam (ADR 0009)
└── scripts/, docs/adr/ (13 ADRs), deploy/, .github/workflows/
```

Three **independent Cargo workspaces** with three lockfiles: `apps/server`,
`apps/desktop/src-tauri`, `packages/crypto/core`. There is no root `Cargo.toml`.

### How the parts talk

```
                         ┌──────────────────────────┐
                         │  apps/server (Rust/Axum) │
                         │  owns SQL · owns enums   │
                         └────────────┬─────────────┘
                     openapi.v1.json  │  (write-openapi bin)
                                      ▼
                        packages/api-contract  ── 82.6% generated
                                      │
              ┌───────────────────────┼───────────────────────┐
              ▼                       ▼                       ▼
        packages/shared         packages/sync          packages/types
              │                       │                       │
              └───────────┬───────────┴───────────┬───────────┘
                          ▼                       ▼
                   packages/storage  ◄──  packages/crypto/port
                          │                       │
                          └──────────┬────────────┘
                                     ▼
                             packages/core  (ADR 0008)
                                     │
        ┌────────────┬───────────────┼───────────────┬────────────┐
        ▼            ▼               ▼               ▼            ▼
      web        extension        desktop         mobile      (marketing
       │             │               │               │         shares only
       └─────────────┴──── packages/ui ─────────────┘          tokens.css)
                                     │
                        packages/crypto/core (Rust, ADR 0001)
                     wasm ── web/desktop/extension · uniffi ── mobile
                            direct crate link ── server, native host
```

The layering is enforced downward-only by `scripts/check-architecture.mjs`:
`ui ↛ {core, storage, sync}`, `core ↛ ui`, `sync ↛ {core, storage, ui}`,
`shared ↛ {core, storage, sync, ui}`, `types → api-contract only`, `packages/* ↛ apps/*`.

**Verified:** the rule currently passes with zero violations. Every apparent violation in a naive
grep is a comment or the test that asserts the rule
(`packages/ui/src/__tests__/presentation-contracts.test.ts:35-37`).

---

## 3. Application, package and crate inventory

| Package | Responsibility | Used by | Approx LOC | Complexity | Recommendation |
|---|---|---|---:|---|---|
| `apps/server` | REST API, all SQL, OpenAPI source of truth | all clients | 52,600 (15,637 tests) | high, justified | **keep** |
| `apps/web` | Web SPA | — | 25,800 | high | **keep** |
| `apps/extension` | MV3 extension, autofill, passkeys | — | 24,100 | high, well-structured | **keep** |
| `apps/mobile` | Expo app + Android credential provider | — | 15,300 TS / 7,217 Kt | high | **keep**, add tests |
| `apps/desktop` | Tauri app + native messaging host | — | 9,600 TS / 6,200 Rs | medium | **keep** |
| `apps/marketing` | Public site, MDX docs, Remotion | — | 8,100 | low | **keep**, unfork UI |
| `@bittery/core` | Vault/unlock/sync services + React hooks | 4 apps | 14,300 | high | **keep** |
| `@bittery/ui` | React DOM design system | web, ext, desktop | 13,300 | medium | **keep**, prune |
| `@bittery/shared` | Cross-platform domain helpers | 4 apps + pkgs | 8,100 | medium | **split** (§12) |
| `@bittery/api-contract` | Generated OpenAPI client + facade | 4 apps + pkgs | 15,278 | low (generated) | **keep** |
| `@bittery/storage` | Tiered ports/adapters, AccountStore | core + 4 apps | 6,600 | high, justified | **keep** |
| `@bittery/sync` | SSE, delta sync, outbound queue | core + 4 apps | 3,200 | high, justified | **keep** |
| `@bittery/crypto-port` | TS crypto seam (ADR 0009) | storage, core, apps | 5,412 (60% tests) | high, justified | **keep** |
| `@bittery/crypto-core` | Rust: all algorithms | api crate, server | 4,789 | high, justified | **keep** |
| `@bittery/crypto-api` | Rust: UniFFI surface, KeyHandle | wasm, RN bindings | 1,016 | medium | **keep** |
| `@bittery/crypto-wasm` | Generated wasm bindings | web, desktop, ext | ~7,000 gen | n/a | **keep** |
| `@bittery/crypto-react-native` | Generated uniffi bindings | mobile | ~12,700 gen | n/a | **keep** |
| `@bittery/i18n` | Paraglide messages + React bindings | 4 apps + ui + core | 172 hand-written | low | **keep** |
| `@bittery/types` | Leaf types for sync ↔ storage | 5 packages, 34 files | 232 | low | **keep** |
| `@bittery/config` | Shared `tsconfig.base.json` | ~15 packages | trivial | none | **keep** |
| `@bittery/device` | UA parsing, device labels | **nothing** | 341 | none | **delete** |

Baseline (measured, excludes `node_modules`, `target`, `Pods`):

- TypeScript/TSX: **244,400 LOC** across 3,451 files (includes generated and tests)
- Rust: **66,433 LOC** across 148 files
- Apps: 6 · Workspace packages: 20 · Rust crates: 5 (in 3 independent workspaces)
- Distinct external dependencies: **125**
- Commits: 682 since 2025-12-09

Largest files (see §9 for why):

| LOC | File |
|---:|---|
| 12,619 | `packages/api-contract/src/generated/schema.ts` *(generated)* |
| 4,355 | `packages/crypto/wasm/generated/bittery_crypto_api.ts` *(generated)* |
| 3,722 | `packages/crypto/react-native/src/generated/bittery_crypto_api.ts` *(generated)* |
| 3,237 | `apps/server/src/services/auth_tests.rs` *(test)* |
| 2,983 | `apps/server/src/services/vault_tests.rs` *(test)* |
| 2,727 | `apps/desktop/src-tauri/src/lib.rs` |
| 2,530 | `packages/sync/src/__tests__/sync-engine.test.ts` *(test)* |
| 1,936 | `apps/server/src/http/api/vault.rs` |
| 1,837 | `packages/storage/src/account-store.ts` |
| 1,673 | `packages/core/src/services/vault-crypto.ts` |
| 1,577 | `packages/shared/src/import/providers/1password-1pux.ts` |
| 1,433 | `packages/crypto/port/src/adapters/port-conformance.ts` |
| 1,424 | `packages/api-contract/src/client.ts` |
| 1,388 | `apps/web/src/routes/_app/admin/index.tsx` |
| 1,313 | `apps/web/src/components/import/vault-import-dialog.tsx` |
| 1,291 | `apps/desktop/src-tauri/src/ipc_security.rs` |
| 1,221 | `apps/extension/src/background/passkey-handlers.ts` |
| 1,125 | `packages/sync/src/outbound-queue.ts` |

---

## 4. Dependency map

Internal workspace edges (declared, verified against imports):

```
web, extension, desktop  →  core, storage, sync, shared, types, ui, i18n,
                            crypto-port, crypto-wasm, api-contract
mobile                   →  core, storage, sync, shared, types, i18n,
                            crypto-port, crypto-react-native
marketing                →  shared  (+ tokens.css by relative path)
core                     →  api-contract, crypto-port, i18n, shared, storage, sync, types
storage                  →  crypto-port, shared, types
sync                     →  api-contract, shared, types          (deliberately NOT storage)
shared                   →  api-contract, crypto-port, device, types
ui                       →  i18n, shared                          (deliberately NOT core/storage/sync)
crypto-port              →  crypto-wasm, crypto-react-native      (optional peers)
types                    →  api-contract only
api-contract, i18n, config →  (none)
device                   →  (none, and nothing depends on it)
```

Import weight, measured by occurrence of `from "@bittery/X"` across `apps/` and `packages/`:

| Package | Import sites |
|---|---:|
| `@bittery/shared` | 308 |
| `@bittery/ui` | 237 |
| `@bittery/core` | 190 |
| `@bittery/storage` | 108 |
| `@bittery/i18n` | 77 |
| `@bittery/crypto-port` | 59 |
| `@bittery/api-contract` | 39 |
| `@bittery/types` | 33 |
| `@bittery/sync` | 32 |
| `@bittery/crypto-wasm` | 6 |
| `@bittery/device` | 2 (both dead — see §11) |

There are **no circular workspace dependencies** and no reach-through imports from a package into
an app. One deliberate cross-app relative import exists:
`apps/extension/src/background/desktop-protocol.ts:24` imports type-only from
`../../../desktop/src/generated/desktop-ipc`. It is documented in-code and costs nothing at
runtime, but it is the one place a package boundary would be more conventional.

---

## 5. Current request and data flow

**Read path (any client):**

```
Component
  → apiQueries.*  (packages/shared/src/api-query.ts — the single query-key registry)
    → ApiClient   (packages/shared/src/api.ts → packages/api-contract/src/client.ts)
      → openapi-fetch over the generated schema
        → Axum handler → service (owns its SQL) → Postgres
```

Two to three layers, no dead intermediates. **This path is healthy.**

**Write path:**

```
Component useMutation
  → ApiClient method
  → optimistic projection into ItemCache (packages/storage)
  → ItemSyncEngine.enqueue (packages/sync/src/outbound-queue.ts)
      idempotency key · exponential backoff · 409/412 rebasing
  → server
  → SSE event → SyncManager → query-invalidation.ts → QueryClient.invalidate
```

**Unlock path (the security-critical one):**

```
UI → @bittery/core unlock service
  → AccountStore (packages/storage) — owns lock state, tier routing
    → CryptoPort (packages/crypto/port) — KeyRef, never raw bytes (ADR 0009)
      → wasm worker (web/desktop) | wasm same-context (extension) | uniffi JSI (mobile)
        → bittery-crypto-api (KeyHandle, zeroizing)
          → bittery-crypto-core (the one implementation)
```

**Storage write, traced end to end** (verified as having no pass-through layer):

```
AccountStore.storeVaultKeys        JSON boundary
  → writeAccount(...)              accountId scoping
    → writeValue(name, key, value) tier/scope routing via STORAGE_TIERS
      → PlatformPort.kvSet         the actual primitive
```

**Desktop ↔ extension:** the desktop process publishes a versioned JSON projection
(`NATIVE_VIEW_VERSION = 3`) that Rust reads but never authors; the extension talks to it over a
local socket with peer-identity checks (`ipc_security.rs`). Rust refuses a version mismatch
outright rather than partially interpreting it.

---

## 6. What is already well designed

This section exists so the plan below does not accidentally damage it.

**One crypto implementation, honoured.** ADR 0001 is real. No JavaScript, Kotlin or Swift
implementation of any primitive exists — the Android credential provider marshals base64 through
UniFFI into the same Rust core. Verified across `AesGcmCrypto.kt`, `RsaCrypto.kt`,
`NativeCrypto.kt`.

**The crypto seam earns its keep.** One 1,433-line conformance suite runs against three production
adapters plus an in-memory fake. `adapters/react-native.ts` is 23 lines reusing `wasm.ts` — the
best example of sharing in the repository.

**The server contract pipeline is fail-closed.** `http/api/security.rs` enumerates all ~104
operations as Public or Bearer and panics on an unclassified one.
`assert_eq!(paths.len(), 90); assert_eq!(operation_count, 104);` in `http/api/mod.rs` forces a
conscious decision per route. `openapi_generation_is_deterministic_and_current` fails the build on
a stale spec.

**Closed sets have exactly one home.** `apps/server/src/db/enums.rs` declares Postgres enum, Rust
variants, JSON strings and OpenAPI schema in one `closed_enum!` invocation; TypeScript only ever
aliases the generated union.

**The server has no dead code.** `cargo check` completes with **zero warnings** (verified,
6m46s cold). Every `#[allow(dead_code)]` is load-bearing for OpenAPI generation or sqlx row
decoding.

**The Qubit→REST migration is finished.** `grep -ril qubit` returns two hits, both doc-comment
links to ADR 0011.

**Storage ports are dense, not boilerplate.** No port has exactly one implementation. The one
place duplication would have appeared (IndexedDB for web and chrome) was already factored into
`adapters/indexeddb-records.ts`.

**The extension message router is exemplary.** `background/router/contract.ts` pairs every message
type with its payload and response once; everything else is derived. Popup → background is two
layers with no pass-through.

**`packages/sync` tests are integration-shaped.** Zero `mock()` calls across seven test files;
tests drive the real engine against `MemorySyncStorage`.

**Query keys are centralised.** `packages/shared/src/api-query.ts` is the single registry, and
`QueryInvalidator` from `@bittery/sync` is used consistently — raw `queryClient.invalidateQueries`
appears only 8 times in `apps/web`, mostly justified.

**Corrections to the 2026-08-02 review.** That review predates ADRs and `CONTEXT.md` (it says
neither existed). Three of its headline claims no longer hold:

- *"Crypto has four drifted per-platform adapters with no enforced conformance seam"* — there are
  now two real adapters plus one thin reuse, behind a 1,433-line conformance suite.
- *"Auto-lock rule is copied four times instead of living behind a port"* — auto-lock now lives in
  `packages/core/src/services/autolock-{web,mobile}.ts` with `autolock.ts` as the interface;
  desktop keeps its own Tauri implementation deliberately.
- *"Sync orchestration has no shared home; four apps each built polling loops"* —
  `packages/sync/src/sync-orchestrator.ts` is now that home.

Its claim about **unlock being implemented three times** is still partly true (§8) and its claim
about **import living in an untested large hook** is still true (§9).

---

## 7. Architecture problems

Ranked by consequence, not size.

**P1 — Two enforcement gaps in CI.** *(verified)*
`scripts/check-architecture.mjs` appears in `package.json`'s `check:ci` but in no workflow
(`grep architecture .github/workflows/*.yml` → nothing). The package layering that ADR 0012 rests
on is currently maintained by discipline. Separately,
`git diff --exit-code apps/desktop/src/generated` exists only in the local `check:ci:rust` script;
`ci.yml:144-166` diffs `packages/crypto/{wasm,react-native}` generated output but **not** the
ts-rs desktop/IPC output. The `desktop-rust` job runs `cargo test`, which regenerates those files
as a side effect, and then never diffs the result. A Rust wire-format change can land with a stale
TypeScript mirror and break `apps/extension` at runtime instead of at CI time.

**P2 — The four-way app bootstrap.** Every frontend re-implements the same wiring. It is not just
duplication: it is why "add a platform capability" is a four-file change and why divergence like
the `lifecycle.ts` lazy-getter difference (§10) goes unnoticed.

**P3 — Android and the extension disagree about domain matching.** Six independent
`extractDomain`/`extractParentDomain` implementations in Kotlin, none routed through
`PasskeyUtils.normalizeHost`, none matching `apps/extension/src/lib/hostname.ts`. Android drops
the first label; the extension keeps the last two. Both are wrong for `co.uk`, differently. This
is a user-visible correctness bug.

**P4 — `packages/shared` has no single responsibility.** 51% of it is a web-only import subsystem;
its main barrel has zero consumers; four more modules have exactly one consumer each.

**P5 — Testing is absent at the highest-risk seams.** Mobile: zero TS tests, silently skipped by
turbo. Desktop: zero TS tests, including 189 LOC of untested multi-server logic in
`lib/auth-server.ts` whose simpler web sibling *is* tested. `packages/ui`: 89 test LOC for 13,310
source LOC. No `SyncStorage` conformance suite against real platform implementations.

**P6 — Three unguarded cross-language restatements.** ADR 0012 requires a compile-time drift guard
wherever a package cannot import its generator's output. Three places restate without one:
`packages/api-contract/src/errors.ts:1-16` (`ApiProblem` vs generated `ProblemDetails`),
`packages/shared/src/session-refresh.ts:7-11` (`RefreshResult` vs `RefreshSessionResponse`),
`packages/api-contract/src/facade-types.ts:230-237` (`AuditEventsRequest` vs
`operations["listAuditEvents"]["parameters"]["query"]`). There is no drift-guard file anywhere in
`packages/api-contract`.

**P7 — Mobile's Kotlin layer sits outside all four generator seams.** `ItemEntity.kt`,
`VaultKeyEntity.kt`, `AuthDataEntity.kt`, `ItemDomainEntity.kt` hand-restate server-owned field
lists. `VaultDecryptor.kt:57` hardcodes `"vault-key-wrap"`, the literal that
`packages/core/src/services/vault-crypto.ts:104` exists to own as `VAULT_KEY_WRAP_PURPOSE` —
that module's own comment says it was written because "the envelope format was defined four times
and enforced nowhere." There is now a fifth copy. It fails closed on mismatch, so this is an
interop hazard, not a confidentiality bug.

**P8 — `apps/marketing` maintains a second, drifted shadcn fork.** 634 LOC of independently
vendored primitives sharing `tokens.css` but not `@bittery/ui`. Its `button.tsx` default variant
is flat `bg-primary`; the DESIGN.md-mandated recipe is a gradient with an inset highlight. The
public site is visually off-brand relative to the product.

**P9 — Only two of four apps use the shared `useLogin` hook.** `packages/core/src/hooks/auth/use-login.ts`
(155 LOC) is consumed by desktop and mobile. `apps/web/src/components/sign-in-form.tsx` (510 LOC)
and `apps/extension/src/pages/login.tsx` (364 LOC) each hand-roll session establishment.

**P10 — Mobile ignores a shared filtering hook that already exists, and has drifted.**
`apps/mobile/src/hooks/use-filtered-items.ts` (67 LOC) reimplements
`@bittery/core`'s `use-item-list-filters.ts`. The shared version searches `email`; mobile's does
not. Silent behavioural divergence.

**P11 — TOTP is computed two ways and the platforms are split between them.** *(verified; a
research agent reported this as accidental drift — that framing is wrong, see below)*
ADR 0001 **explicitly sanctions** the WebCrypto implementation at `packages/shared/src/totp.ts`
by name: "WebCrypto is used only where nothing of ours is encrypted — the TOTP HMAC in
`packages/shared/src/totp.ts`". That file is not a violation. But the Rust core *also* implements
TOTP (`bittery-crypto-core/src/totp.rs`, 342 LOC, exported through `bittery-crypto-api`, covered by
SHA1/256/512 vectors in `port-conformance.ts:1324-1411`), and the platforms use different ones:
`packages/ui/src/components/inline-totp-display.tsx:3` and
`apps/extension/src/content-script/autofill/credential.ts:1` take the WebCrypto path (so web,
desktop and extension do), while `apps/mobile/src/components/totp-display.tsx:140` calls
`crypto.generateTotp` — the Rust path. Two live RFC 6238 implementations, no documented policy for
which applies where. A divergence would show as the same item producing different codes on
different devices. **The fix is to write down the rule, not to delete either implementation.**

**P12 — `packages/core` exposes far more than is consumed.** `package.json` declares 29 subpath
exports, 25 of which are `./services/*` entries exposing whole files wholesale. Several
`usePlatform*` and mutation-runtime helpers have zero external consumers but real internal
fan-out — private in spirit, public in practice.

**P13 — Two parallel query-key vocabularies.** `packages/shared/src/api-query.ts` namespaces
everything under `["api","v1",...]`. `packages/core`'s hooks hand-roll bare arrays (`["vaults"]`,
`["items"]`, `["accounts","unlocked"]`). A grep found **no query anywhere** whose key starts with
`["vaults"]` or `["accounts","unlocked"]`, which suggests the invalidation block copy-pasted across
`use-quick-unlock.ts:105-108`, `use-biometric-unlock.ts:170-173` and `use-quick-unlock-all.ts:119-122`
may currently invalidate nothing. **Requires a runtime trace, not a deletion** — being wrong here
produces a stale-cache bug (a locked account still showing vault data), which is worse than the
duplication.

---

## 8. Duplication report

| Duplication | Locations | Approx duplicated LOC | Recommendation |
|---|---|---:|---|
| `i18n-provider.tsx` — **byte-identical** | web, desktop, extension (67 each); mobile diverges legitimately (AsyncStorage) | 134 | Move to `@bittery/i18n/react-provider`; keep mobile's variant |
| `platform-provider.tsx` | 4 apps (75–87 each) | ~180 | Extract shared `createPlatformProvider(deps)`; keep per-app capability wiring |
| `sync-provider.tsx` | 4 apps (66–234) | ~150 | Same; desktop's `isInitialized` and extension's cross-process shape are real |
| `vault-runtime.ts` | 5 files (14–18 each) | ~55 | Collapse to one factory |
| `lifecycle.ts`, `crypto.ts`, `storage.ts`, `i18n-format.ts`, `sync-client-id.ts` | 4 apps each | ~250 | Collapse the identical parts; **investigate `lifecycle.ts` divergence first** (§10) |
| `useClientId` wrapper | web, desktop, mobile `sync-provider.tsx` | ~10 | **Dead in all three** — delete |
| Item detail field kit | `apps/extension/src/components/item-detail-panel.tsx` vs `packages/ui/.../item-detail/field-components.tsx` + `inline-totp-display.tsx` | ~250–300 | Extension adopts `packages/ui`; TOTP ring is near line-for-line |
| `MoveItemDialog` | `apps/web` (323) vs `apps/desktop` (329) | ~320 | Headless split: view in `packages/ui`, hooks stay in app |
| `DeleteVaultDialog` | `apps/web` (71) vs `apps/desktop` (71) | ~65 | Same pattern |
| `Loader` — **byte-identical** | desktop + extension (9 each) | 9 | Move to `packages/ui` |
| `favicon.tsx` | web (9) vs desktop (11) | ~10 | Trivial; fold into the shared component's props |
| `getAccountInitials` | `packages/ui/.../account-switcher.tsx:114` (unexported) + 2 extension copies | ~45 | **Export the existing one**, delete both copies |
| Bespoke account switchers | desktop 506, extension 212, mobile 242, vs `packages/ui` 395 | up to ~600 | Investigate; web already consumes the shared one |
| Confirm/delete `AlertDialog` boilerplate | 10 files across web + desktop | ~150–250 | One `ConfirmDialog` primitive in `packages/ui` |
| `useLogin` not adopted | `apps/web/sign-in-form.tsx` 510, `apps/extension/pages/login.tsx` 364 | ~300–500 | Adopt the existing shared hook |
| `use-filtered-items.ts` | mobile 67 vs `@bittery/core` equivalent | 67 | Adopt shared hook; reconcile the `email` field first |
| Domain matching in Kotlin | 6 sites across credential-provider | ~104 | **Correctness fix**, then dedupe; align with `hostname.ts` |
| `FORWARDED_MEMBERS` array | `wasm.ts:12-52`, `wasm-worker.ts:42-82`, `port-conformance.ts:41-79` | ~80 | One exported constant; keep per-file guard types |
| `request_dto!`/`response_dto!` macros | `http/api/auth.rs:30-47`, `http/api/team.rs:36-59` | ~25 | One shared macro in `dto.rs` |
| Marketing shadcn fork | `apps/marketing/src/components/ui/*` (7 files) | 634 | Adopt `@bittery/ui` or accept and document the fork |
| Exponential backoff formula | `sync-manager.ts` vs `outbound-queue.ts` | ~15 | One helper; different caps stay |
| `role !== "read-only"` UI gate | 3 files in `apps/web` | ~10 | One `canWriteVault(role)` in `vault-mapping.ts` |
| Keystore AES-GCM box | `MukEscrowManager.kt` vs `SecureMukStore.kt` | ~100 | Low-risk Kotlin helper extraction |
| **TOTP (RFC 6238)** | `packages/shared/src/totp.ts` (WebCrypto, ADR-sanctioned) vs `bittery-crypto-core/src/totp.rs` (342) | — | **Document which applies where.** Do not delete either (§7 P11) |
| KDF policy validation | `bittery-crypto-core/src/kdf_policy.rs:48` vs `packages/shared/src/kdf-policy.ts` | ~60 + two full boundary-value test suites | Both read the same `kdf-policy.json`, but each reimplements and independently tests the validation. Investigate whether TS can wrap the port |
| `useAccountMetadataSync` vs `...SyncAll` | `packages/core/src/hooks/auth/use-account-metadata-sync.ts` | ~89 | Singular variant has **zero callers** — delete it |
| `LocalVaultAccount` vs `VaultRepositoryItemAccount` | `packages/core/src/services/vault-repository.ts:24,35` | ~10 | Structurally identical 7-field interfaces — merge |
| Unlock invalidation block | `use-quick-unlock.ts`, `use-biometric-unlock.ts`, `use-quick-unlock-all.ts` | ~12 | Copy-pasted verbatim ×3; **and may target nothing** (§7 P13) |
| **Conceptual: account record shape** | `AccountMetadata` (storage), `ItemAccountContext` (shared), `CachedItemAccountScope` (types), `DesktopAccountEntry` (generated), `AuthDataEntity.kt` | — | Reconcile naming (`email` vs `accountEmail`); only the Kotlin one lacks a seam |

**Highest-value hotspots:** the bootstrap cluster (~650 LOC, near-zero risk), the extension item
detail panel (~250 LOC, low risk, already depends on `@bittery/ui`), and the web/desktop dialog
pairs (~400 LOC, medium risk because they need a headless split).

**Explicitly not duplication:** mobile's `tag-color.ts` (documented — RN cannot load a DOM
package), the extension's `DEFAULT_SETTINGS_TIMEOUT_MS` literal (ADR 0005 — the module must import
nothing), `device-setup-dialog.tsx` web-vs-desktop (desktop is a genuine multi-account superset),
and the six generated OpenAPI schemas that restate the Item field set (a utoipa `allOf` limitation,
already documented at `facade-types.ts:122-131`).

---

## 9. Complexity hotspots

**1. `apps/web/src/routes/_app/admin/index.tsx`** — 1,388 LOC
Responsibility: the entire team admin console. Why complex: ~24 components and functions in one
file (`PeopleTab`, `ActivityTab`, `FilterBar`, `EventDialog`, `InventoryCard`, `MemberRow`,
`EvidencePanel`, …). Dependencies: audit + team + access APIs. Simplification: split per tab.
Impact: no LOC change, removes the single worst navigation obstacle in `apps/web`.

**2. The import subsystem** — `vault-import-dialog.tsx` 1,313 + `use-vault-import.ts` 791 = ~2,100
LOC across two files, plus 4,102 LOC of providers in `packages/shared/src/import/**`.
Why complex: multi-provider parsing, vault mapping UI, batched encrypt/upload (200/batch), and a
6-stage state machine, with no service boundary between the machine and the rendering.
Simplification: relocate providers to `apps/web`, split the stage machine out of the hook.
Impact: `packages/shared` loses 51% of its bulk and its only heavy dependency.

**3. `packages/sync/src/outbound-queue.ts`** — 1,125 LOC
Highest genuine cyclomatic complexity in the shared packages: nested status machine, cross-process
merge-by-`operationId`, ETag/CAS rebasing. **Do not simplify for LOC.** It has 2,530 LOC of
mock-free tests. The correct action is to extend that discipline (a `SyncStorage` conformance
suite), not to thin the module.

**4. `packages/storage/src/account-store.ts`** — 1,837 LOC
A ~60-member interface in one closure. Flat interface, high internal fan-out, low external
complexity per method. Traced: no pass-through layer. **Keep.**

**5. `apps/desktop/src-tauri/src/lib.rs`** — 2,727 LOC
Contains `handle_desktop_ipc_message` (~180 LOC of pure variant translation) plus every
`*_internal` IPC handler. Only 7 of its functions are Tauri commands. Splitting the IPC dispatcher
out is the natural seam.

**6. `apps/extension/src/background/passkey-handlers.ts`** — 1,221 LOC
Two ~180-line WebAuthn ceremony handlers plus ~15 pure helpers. Inherently branchy.
**Security-sensitive — investigate, do not refactor casually.**

**7. `apps/server/src/http/api/vault.rs`** — 1,936 LOC / 31 routes; **`services/session.rs`** 1,616;
**`services/team.rs`** 1,420. The three largest flat modules that lack the sub-directory
decomposition `vault/`, `auth/` and `billing/` already have. Deferred to the backend deep dive.

**8. `apps/mobile/src/hooks/use-credential-provider-sync.ts`** — 829 LOC
Debounced multi-account native sync orchestration. Real complexity, plus a second retry ceiling
(`MAX_PENDING_PASSKEY_ATTEMPTS = 5`, `MAX_PENDING_PASSKEY_AGE_MS = 7 days`) independent of
`ItemSyncEngine.MAX_RETRY_COUNT = 5` governing the same eventual mutation.

**9. `apps/mobile/modules/.../GetCredentialsActivity.kt`** — 1,435 LOC
Mixed Android CredMan glue (justified) with passkey candidate-selection logic paralleling
`passkey-handlers.ts`, plus one of the six domain-matching copies.

**10. `packages/ui/src/components/sidebar.tsx`** — 725 LOC, 24 exports, **one consumer**
(web), of which **10 exports are dead** (~229 LOC). Worst LOC-to-value ratio in `packages/ui`.

**11. `packages/crypto/port/src/adapters/wasm-worker.ts`** type layer — `Wire<T>`,
`SurvivesPostMessage<T>`, `OnlyExportKeyCrossesWithBytes`. Dense, but each is a documented
compile-time proof. **Keep.**

**12. `apps/web/src/routes/_auth/recover.tsx`** — 775 LOC with 13 separate `useState` calls driving
a 5-step wizard. Candidate for a reducer.

**13. `apps/web/src/components/sign-up-form.tsx` (881) + `use-signup-form.ts` (660)** — 1,541 LOC
for signup, not yet diffed against `packages/core`'s equivalents.

**14. `apps/server/src/http/api/security.rs`** — a 120-line hand-maintained operation table.
Complex on purpose. **Do not touch.**

**15. `packages/crypto/core/crates/bittery-crypto-core/src/srp6a/bigint.rs`** — 361 LOC of
hand-rolled bignum. Highest consequence-of-bug density in the repository. Only size-surveyed here;
flagged for the crypto deep dive.

---

## 10. Unnecessary abstraction and pass-through layer report

Genuinely worth removing:

- **`packages/device` → `packages/shared/src/device.ts` → nothing.** A whole package behind an
  unreachable shim. *(verified)*
- **`packages/shared/src/index.ts`** and the `"."` entry in its `exports` map — every one of ~150
  consumers imports a subpath. Zero bare-import consumers repo-wide.
- **`useClientId`** in three `sync-provider.tsx` files — a one-line rename of `useSyncClientId`,
  and both are unused everywhere.
- **`turbo.json`'s `lint`, `tauri:dev`, `tauri:build` tasks** — no package defines a script by
  those names; the pipeline entries are unreachable.
- **`hono` in the workspace catalog** — no `package.json` declares it, it does not appear in
  `pnpm-lock.yaml`. A pre-ADR-0011 leftover. `CLAUDE.md` still tells agents it comes from the
  catalog, which invites someone to add a real dependency on it.
- **The 7 `*ErrorResponses` marker enums** in `apps/server` (~220–280 LOC) — never constructed,
  exist only to feed `utoipa::IntoResponses`. **Keep them**; noted here only so a future reader
  does not mistake them for dead code.

Deliberate indirection that **must not** be removed:

- `apps/extension/src/background/session-manager.ts` — ADR 0007 states plainly that it holds no
  state, every export is a one-liner, and it is retained because a dozen modules import it and six
  test suites mock the path.
- `apps/desktop/src/lib/tauri-commands.ts` (89 LOC) — the single place a Tauri command name string
  is spelled. Thin by design.
- `apps/server/src/services/keychain.rs`'s three 2-4 line `#[tauri::command]` wrappers — documented
  in-code as existing so generated TypeScript and Tauri's binding cannot drift.

**Traced and found clean** (no pass-through): storage read/write to primitive (4 layers, each
adding JSON, scoping, tier routing, or I/O); component → `apiQueries` → `ApiClient` → generated
client (2–3 layers); popup → background in the extension (2 layers).

**One divergence that needs investigation, not deletion:** `apps/web/src/lib/lifecycle.ts` uses
lazy getters with a comment explaining they dodge a TDZ import cycle; `apps/desktop/src/lib/lifecycle.ts`
uses eager values. If desktop has the same cycle exposure, this is a latent bug, not style drift.

---

## 11. Dead code and deletion candidates

### Safe deletion — verified, zero consumers

| Item | Path | LOC |
|---|---|---:|
| `packages/device` (whole package) | `packages/device/` | 341 |
| Its unreachable shim | `packages/shared/src/device.ts` | 8 |
| Unused main barrel | `packages/shared/src/index.ts` + `"."` export | 20 |
| Unused component | `packages/ui/src/components/calendar.tsx` + `react-day-picker` dep | 218 |
| Unused component | `packages/ui/src/components/breadcrumb.tsx` | 108 |
| 10 dead sidebar exports | `packages/ui/src/components/sidebar.tsx` | ~229 |
| Dead component | `apps/web/src/components/teams/create-team-dialog.tsx` | 90 |
| Dead component | `apps/web/src/components/vault/tag-filter.tsx` | 153 |
| `useClientId` wrappers | web + desktop + mobile `sync-provider.tsx` | ~10 |
| Unused RN component | `apps/mobile/src/components/safe-area-view.tsx` | 6 |
| Unreachable turbo tasks | `turbo.json` `lint`, `tauri:dev`, `tauri:build` | ~16 |
| Dead catalog entry | `pnpm-workspace.yaml` `hono` (+ `CLAUDE.md` line) | 1 |
| Dead hook, zero callers | `packages/core/src/hooks/auth/use-check-email.ts` (whole file) | 62 |
| Dead hook variant, zero callers | `useAccountMetadataSync` singular, `use-account-metadata-sync.ts:36-124` | 89 |
| Dead hook, zero callers incl. internal | `usePlatformAutolock`, `context/platform-context.tsx:247` + barrel | ~10 |
| **Subtotal** | | **~1,360** |

`useCheckEmail` is worth a sentence: it is dead *and* duplicated — `apps/web/src/components/sign-in-form.tsx:194`
performs the same check by calling `ceremonyApiClient.auth.checkEmail(...)` directly, bypassing the
hook entirely.

Verified by the orchestrator: `packages/device` (grep + `exports` map inspection),
`calendar`/`breadcrumb`/all 10 sidebar exports (0 external references), `react-day-picker`
(only consumer is `calendar.tsx`).

### Likely deletion — one owner decision away

| Item | Path | LOC | Why it needs a decision |
|---|---|---:|---|
| Legacy native-messaging scripts | `scripts/install-native-messaging.sh`, `update-extension-id.sh`, `build-native-host.sh` | 204 | Reference a `NATIVE_BIOMETRIC_UNLOCK.md` that does not exist; superseded by `apps/desktop/scripts/prepare-native-host.mjs` |
| Dead Kotlin | `.../crypto/KeyDerivation.kt` | 96 | No production call site; only its own test exercises it |
| TODO-stub Kotlin tests | `CryptoTestVectors.kt:181-192,223-234` | 24 | Assert nothing; only `println` |
| Unused deps | `@bittery/crypto-react-native`, `@bittery/types` in `apps/mobile/package.json` | 0 | Declared, never imported |
| Unused dep | `@playwright/test` in `apps/desktop/package.json` | 0 | No config, no tests |
| `packages/ui/src/components/tooltip.tsx` | | 54 | Alive only via web-only `sidebar.tsx` — stop calling it a shared primitive |

### Requires investigation — do not delete on this report's authority

- **Rust crypto surface:** `get_secret_key_hint`, `decrypt_vault_key_with_muk`,
  `is_current_kdf_profile`, `build_attestation_object`, `build_authenticator_data`,
  `sign_assertion`. All appear unreferenced outside their own modules/tests, all are
  crypto-adjacent. `get_secret_key_hint` notably has an independent TypeScript reimplementation at
  `packages/shared/src/crypto.ts:26-36` that says it mirrors the Rust — one of the two is
  redundant, and confirming which is a security review task.
- **i18n key liveness.** A 15-key sample of 2,528 found 2 with zero references
  (`settings_dialog_description`, `mob_empty_state_no_items`). Extrapolation would be
  irresponsible; a `knip`-style pass is needed for a real number.
- **Single-consumer `packages/ui` components:** `InputOTP`, `Progress`, `Tabs` (web-only),
  `AccountAvatarGroup`, `InputGroup` (desktop-only). One consumer today does not mean one
  consumer forever.
- **iOS credential-provider stub.** `modules/credential-provider/ios/` is 86 LOC of Expo template
  implementing none of the 25 declared methods. This is a **P0 product gap already tracked** in
  `docs/research/mobile-gap-corroboration.md`, not cruft. Deleting it removes nothing of value;
  implementing it is the actual backlog item. Only the literal template leftovers (`PI`, `hello()`,
  the demo WebView) are vestigial.

No dead-code sweep was run with `knip`/`ts-prune`. Grep-based results **under-count** re-exported
symbols and **over-count** type-only exports consumed structurally. Treat everything above the
"safe" line as verified and everything below as a lead.

---

## 12. Package boundary problems

**`packages/shared` — split it.** It is the most-imported package (308 sites) and the least
coherent.

| Module | LOC | Consumers | Action |
|---|---:|---|---|
| `import/**` | 4,102 | 2 files, both `apps/web` | **Move to `apps/web`** (or `packages/import` if desktop ever gains import). Removes `jszip` from the desktop/mobile/extension graph |
| `billing.ts` | 72 | 6, all `apps/web` | Move to `apps/web` |
| `export-types.ts` | 56 | 1, `apps/web` | Move to `apps/web` |
| `identity.ts` | 95 | 2, both `packages/ui` | Move to `packages/ui` |
| `password-history.ts` | 92 | 1, `packages/core` | Move to `packages/core` |
| `device.ts` | 8 | 0 | Delete |
| `index.ts` | 20 | 0 | Delete |
| everything else | ~3,700 | 3+ each | **Keep** — genuinely shared |

Result: `packages/shared` drops from ~8,072 to ~3,755 LOC of real shared logic, and stops
pretending to own web features.

**`packages/device` — delete.** No consumer. Its logic already has a live Rust mirror
(`apps/server/src/services/session.rs:1397`, commented as mirroring the TypeScript) and
independently localised copies in `apps/web/src/components/settings/device-management.tsx:73-131`.
Update the Rust comment in the same commit.

**`packages/types` — keep, despite 232 LOC.** It exists precisely because `packages/sync` must not
depend on `packages/storage` (ADR 0012), and it is the lowest package both already depend on. 34
consumer files across 5 distinct groups. Merging saves 232 LOC and costs 34 import rewrites plus
the reason the constraint exists.

**`packages/config` — keep.** Trivial size, but it is the shared tsconfig base for ~15 packages.
That is the intended shape of a config package.

**`packages/ui` — prune, do not restructure.** 26% is vendored shadcn, 74% is Bittery-specific.
Delete the dead 555 LOC (§11); demote or accept the single-consumer components; export
`getAccountInitials`.

**One naming inconsistency worth fixing:** `CachedItemAccountScope` uses `accountEmail` where
`AccountMetadata` and `ItemAccountContext` use `email`, for the same concept.

**`apps/marketing`'s boundary is defensible, its execution is not.** Keeping the public site
decoupled from the product's component library is a reasonable call — different deploy shape,
different audience, no auth. But it currently shares `tokens.css` by relative path while forking
the components, which gives it the maintenance cost of both and the brand consistency of neither.
Either adopt `@bittery/ui` or document the fork as intentional and accept the drift.

---

## 13. Frontend sharing opportunities

### Fully shareable — already shared, keep it that way

Domain logic (`@bittery/core`), validation and mapping (`item-mapping.ts`, `vault-mapping.ts`),
generated API types, query configuration (`api-query.ts`), crypto (`@bittery/crypto-port`),
storage ports, sync engine, TOTP, password generation and analysis, credit-card utilities, billing
plan data.

### Shareable and not yet shared — the actionable list

1. **App bootstrap** (~650 LOC). One `createAppRuntime({ storage, crypto, sync, autolock })` in
   `@bittery/core`, with each app supplying only its platform capabilities.
2. **`useLogin`** — already exists in `@bittery/core`; web and extension should adopt it.
3. **Item detail field kit** — already exists in `packages/ui`; the extension should adopt it.
4. **`use-item-list-filters`** — already exists in `@bittery/core`; mobile should adopt it,
   after deciding whether searching `email` was an intentional mobile omission.
5. **`ConfirmDialog`** — does not exist; 10 hand-rolled copies say it should.
6. **`Loader`/`Spinner`** — byte-identical in two apps, no dependency blocking the move.
7. **`getAccountInitials`** — exists but is not exported.

### Shareable between web-like environments only (web, desktop, extension)

React DOM components, forms, dialogs. The blocker is structural: `packages/ui` may not import
`@bittery/core` (enforced, correctly). `MoveItemDialog` and `DeleteVaultDialog` are duplicated
*because of* that rule. The fix is a **headless split** — `packages/ui` exports a presentational
`MoveItemDialogView` taking data and callbacks as props; each app supplies the hooks. That
respects the boundary and removes ~385 LOC.

### Platform-specific — leave separate

Mobile navigation and all React Native UI, Android autofill and credential provider, Tauri
commands and IPC, extension content scripts and autofill heuristics, biometric and keychain
integration, secure storage.

**Explicit non-recommendation:** do not build a cross-platform component abstraction spanning
React DOM and React Native. Mobile deliberately does not depend on `@bittery/ui`, uses HeroUI
Native + Uniwind, and has a documented token bridge (`apps/mobile/global.css`,
`DESIGN-NATIVE.md`). The interaction models genuinely differ. The one thing that should be shared —
token *values* — already is, and the gap there is a missing parity check, not a missing
abstraction.

---

## 14. React architecture assessment

**Healthy.** The `useEffect` discipline in `CLAUDE.md` is largely honoured: `apps/web` has 8 call
sites across 4 files, the extension has effects in 2 files, mobile has 10, desktop has 23 across 8
files — and the ones inspected are legitimate imperative boundaries (runtime lifecycle,
`AppState`/Tauri event subscription, `IntersectionObserver`). Contexts are few (web 3, extension 2,
mobile 2, desktop 2). No god component with fifteen boolean props exists anywhere, including in
`packages/ui`.

**Concrete violations, all small:**

- `apps/web/src/hooks/use-import-onboarding-state.ts:48-56` — reads two localStorage flags into
  state via an effect; a lazy `useState` initialiser or `useSyncExternalStore` removes both the
  effect and the transient empty-state flash.
- `apps/mobile/src/lib/api.tsx:60` and `use-mobile-sync.ts:202` — one-shot async reads into state
  on mount. The codebase documents the correct pattern against itself at
  `apps/mobile/src/lib/biometric-type.ts:69-80` ("A hook rather than `useEffect`+`useState`…
  exactly what `useQuery` is for") and follows it there.

**Real structural issues:**

- **Mutations are not centralised.** ~83 query/mutation call sites in `apps/web`; 12 files repeat
  the identical `onError: (error: Error) => toast.error(error.message)` shape and 10 use that exact
  body. No `useApiMutation(fn, { successKey, invalidate })` helper exists. Reads go through
  `apiQueries`; writes do not.
- **No shared loading boundary.** 37 files check `isPending`/`isLoading`, 26 hand-roll a skeleton
  or spinner.
- **`recover.tsx`** — 13 `useState` calls for one 5-step wizard.
- **Query key shape is inconsistent inside mobile** — `["mobile","biometric-type"]` vs
  `"mobile-device-settings"` as a single hyphenated string.
- **Design-system drift:** 13 files in `apps/web` use raw Tailwind palette classes
  (`amber-`, `sky-`, `emerald-`) that `DESIGN.md` forbids in favour of semantic tokens. 4 files in
  `apps/desktop` and 1 in `apps/web` import `lucide-react` directly instead of the
  `@bittery/ui/icons` barrel. Nothing lints for either.

**Business logic in components** is mostly avoided — `apps/web/src/lib/{route-guards,team-access,share-access-gate}.ts`
are pure and unit-tested. Exceptions: `apps/mobile`'s `settings-screen.tsx` calls `storage.*` ~18
times inline, and `biometric-auth-context.tsx:184-283` holds a security-sensitive unlock/rollback
sequence in a context rather than a `@bittery/core` service.

---

## 15. Rust and backend architecture-level assessment

Architecture level only, per scope. Detailed handler/SQL/error design is deferred (§28).

**Responsibility is correctly placed.** The server owns all SQL (ADR 0002), owns every closed set
(`db/enums.rs`), and never sees plaintext. It links `bittery-crypto-core` narrowly — only
`normalize_email` and `srp6a` — and does not pull in client encryption primitives.
`services/access.rs:113` deliberately returns an empty access footprint rather than 404 to prevent
user-existence probing: a genuinely server-only responsibility with correctly no client mirror.

**Crate boundaries are proportionate.** One crate for ~35,000 non-test LOC with clear internal
module separation (`http`/`services`/`repo`/`db`/`shapes`/`integrations`). Splitting into
sub-crates would add Cargo ceremony without a real seam. Do not split.

**The `shapes/` macro system (976 LOC) is anti-duplication infrastructure**, not overhead. One
field list emits both the `ToSchema` transport struct and the plain service struct plus the `From`
impl, and its doc comment explains it avoids `#[serde(flatten)]` because utoipa 5.5 renders flatten
as `allOf` refs that would rewrite the committed spec.

**Rust ↔ TypeScript duplication is minimal and mostly sanctioned.** Every DTO checked in
`facade-types.ts` (246 LOC) is a `Schema<...>` alias, an `Omit` narrowing, or a documented `Pick`.
The two restatement-with-guard exceptions ADR 0012 names (`item-mapping.ts`, `vault-mapping.ts`)
are compliant and carry their guards. The gaps are the three unguarded restatements in §7 P6 and
the Kotlin entities in §7 P7.

**Public API surface is fine.** `lib.rs` exposes a small curated `pub use` list; 299 internal `pub`
items sit inside `pub(crate)` modules, capping their real reach at the crate. Only `db` and `error`
are `pub mod` from the root, and both legitimately need it for the binaries.

**Client-side authorization mirroring is UX-only and safe** — but `role !== "read-only"` is written
three times in `apps/web`. The server re-validates on every write
(`services/vault/items.rs:930`), so this is not a security issue; it is a drift risk if a fourth
role appears.

**One cosmetic contract wart:** 18 of ~104 operationIds are snake_case (all in `http/api/auth.rs`:
`check_email`, `start_login`, `finish_login`, …) while the rest are camelCase. This flows straight
into generated TypeScript method names. Fixing it is a breaking change and needs the
`docs/openapi-breaking-changes.md` allowlist mechanism.

---

## 16. Rust crypto/core architecture-level assessment

**The two-crate split is correct.** `bittery-crypto-core` (4,789 LOC) is pure algorithms with no
FFI awareness — which is exactly why the server can link it directly. `bittery-crypto-api`
(1,016 LOC) is the only UniFFI-annotated crate and does real work: it owns `KeyHandle`
(`Mutex<Option<Zeroizing<Vec<u8>>>>` with idempotent `destroy()`), the
`spawn_blocking`-vs-sync split for wasm, base64 boundary placement for `wrap_key`/`unwrap_key`, and
an FFI-derivable `CryptoError` distinct from the core's.

About 55–60% of that crate is mechanical (record restatements to carry `#[derive(uniffi::Record)]`,
and ~28 one-to-three-line forwards). Collapsing it would either pollute the core with UniFFI macros
or force the server to link an instrumented crate. **Keep the split.**

**Every platform has exactly one crypto path.** Five execution paths, two real adapter
implementations:

| Platform | Path | Layers |
|---|---|---:|
| Web, desktop renderer | `wasm-worker.ts` → generated wasm → api → core | 8 (1 thread hop) |
| Extension | `wasm.ts` → generated wasm → api → core | 7 |
| Mobile | `react-native.ts` (23 LOC, reuses `wasm.ts`) → uniffi JSI → api → core | 7–8 |
| Server | direct crate link | 1 |
| Desktop native host | direct crate link, 3 functions | 1 |

No platform is served twice. The two direct-link paths are documented narrow exceptions (ADR 0001,
ADR 0010) doing something the port cannot. **Verified:** no `crypto_*` Tauri invoke commands exist.

**Generated code dominates by volume and that is intentional.** ~21,000 LOC of committed bindings
against ~5,800 hand-written Rust and ~5,400 TS port LOC. `DEVELOPMENT.md` states the reason:
clean checkouts stay type-checkable and binding changes stay reviewable. It is regenerated locally
and diffed, not built in CI. **Not a reduction target.**

**60% of `packages/crypto/port` is test infrastructure** — one 1,433-line suite × 4 subjects. Its
own `CONTEXT.md` is honest about the limit: no production backend loads under `bun:test`, so each
adapter runs over a double and the suite can miss a defect shared by an adapter and its double. It
deliberately does not assert ciphertext bytes; Rust owns algorithms (120 unit tests + 7 format
vectors). **This test placement is correct.** Do not move algorithm assertions into TypeScript.

**One safe cleanup:** the 39-entry `FORWARDED_MEMBERS` array is byte-identical in three files.
One exported constant, per-file `EveryMemberIsForwarded` guards retained. ~80 LOC.

**The uniffi patch is a known, scoped liability.** `patches/uniffi-bindgen-react-native@0.31.0-3.patch`
(42 lines) bumps uniffi 0.31.0→0.31.2 inside the generator and rewrites the generated wasm asset
import to a `new URL(...)` form because Vite cannot do raw WASM ES-module imports. `DEVELOPMENT.md`
already flags the second part as removable once upstream emits a bundler-compatible URL.

**Two documented carve-outs worth knowing about:** the server maintains its own
`ValidatedKdfProfile` (`services/auth/mod.rs:113-119`) rather than calling the core's
`validate_kdf_profile`; `SECURITY.md` says the two "must be changed together." That is a process
rule with no enforcement. And `get_secret_key_hint` exists in both Rust and TypeScript as
independent implementations of the same format.

---

## 17. Native and bridge simplification opportunities

**Desktop bridge is already minimal.** 7 Tauri commands (3 keychain, 3 broadcast, 1 theme), each
genuinely distinct. Two `#[tauri::command]` functions are deliberately *not* registered — they
serve desktop-IPC messages, documented in
`apps/desktop/src/lib/tauri-commands.ts`. ADR 0010 already removed the `crypto_*` commands.
Pure mapping glue across the whole app is ~270 LOC of 15,800 — under 2%.

**The Rust "lock state" is not a second source of truth.** `get_lock_status_internal` derives
`locked` from a versioned JSON projection (`NATIVE_VIEW_VERSION = 3`) that TypeScript authors and
Rust only reads, refusing a version mismatch outright. `packages/storage/src/native-host-view.golden.test.ts`
pins the shape. This is the one cross-language boundary in the repo that *is* properly tested.

**Mobile is where the bridge cost actually lives.** Of 7,217 Kotlin LOC:

- **~5,900–6,100 genuinely platform-required** — Room DB (871), Credential Manager and Autofill
  API glue, `AssistStructure` traversal, Keystore + `BiometricPrompt.CryptoObject` escrow. A
  headless OS extension process cannot reach the JS module; ADR 0009 anticipates exactly this
  exception class. **Do not touch for LOC.**
- **~450–550 duplicated or dead** — `KeyDerivation.kt` (96, dead), `VaultDecryptor.kt` envelope
  policy (235), domain matching (~104), passkey schema mirroring (~50).

The `packages/sync/src/native-command-handoff.ts` seam is well designed: Kotlin hands over an
already-encrypted blob and TypeScript only wraps it into a sync command. The gap is upstream of
that — *what plaintext shape to produce* is decided independently in Kotlin and TypeScript with no
shared fixture.

**Do not introduce a fifth generator seam for the Kotlin entities.** The cost of standing up ts-rs
or a schema generator for four Room entities exceeds the drift it prevents. A cheaper fix: a shared
JSON fixture that both `PasskeyMutationDaoTest.kt` and a TypeScript test assert against, plus
generated constants for `VAULT_KEY_WRAP_PURPOSE` and the AAD field names.

---

## 18. Single-source-of-truth opportunities

Ranked by value.

**1. `ApiProblem` — add the guard.** `packages/api-contract/src/errors.ts:1-16` restates
`ProblemDetails` (`generated/schema.ts:2279`) field-for-field with no drift guard, and
`packages/api-contract` contains no drift-guard file at all. Rename `requestId` server-side and
nothing fails; it silently stops populating. The runtime logic in `normalizeApiError` is
legitimately hand-written — only the type shapes need fixing. ~0 net LOC.

**2. `RefreshResult`** — `packages/shared/src/session-refresh.ts:7-11` matches
`RefreshSessionResponse` exactly, in a package that already depends on `@bittery/api-contract` in
eight sibling files. Derive it. ~0 net LOC.

**3. `AuditEventsRequest`** — `facade-types.ts:230-237` should derive from
`operations["listAuditEvents"]["parameters"]["query"]`. ~−8 LOC.

**4. Vault-key envelope policy.** `VAULT_KEY_WRAP_PURPOSE` and the AAD field names should reach
Kotlin as generated or committed constants rather than the literal at `VaultDecryptor.kt:57`.
**Flag for security review, not a silent refactor** — it fails closed today.

**5. Domain matching.** One canonical algorithm, implemented once in TypeScript and once in Kotlin,
pinned by a shared test-vector fixture. This is the correctness fix from §7 P3.

**6. Account record naming.** Reconcile `email` vs `accountEmail` across `AccountMetadata`,
`ItemAccountContext` and `CachedItemAccountScope`.

**Already single-sourced — do not add machinery:** closed enums (`db/enums.rs`), vault summary
(`packages/types` `VaultSummary`, with four historical copies already collapsed), item payload
(`item-mapping.ts` with its `NoUnhandledField` guards), roles and permissions, billing plan data.

**Explicitly rejected:** a code-generation system for the Kotlin Room entities (§17), and any
scheme that generates React components across DOM and React Native.

---

## 19. Testing architecture assessment

Scale: **133 TypeScript/JS test files (39,327 LOC)**, 85 Rust files carrying tests (`*_tests.rs`
alone: 15,328 LOC), 2 real native test files (Android only). Four runners: `bun test`,
`node --test`, `cargo test`, Playwright — plus Gradle for Android, orchestrated by nothing.

| Area | Test LOC | Ratio to source | Runner | Needs DB / build | Assessment |
|---|---:|---|---|---|---|
| `apps/server` | 15,328 | ~30% | cargo | live Postgres | **Strong.** 235 tests, `#[path]`-attached so they reach private items |
| `packages/core` | 10,090 | ~0.7 | bun | no | **Strong at the service layer, zero at the hook layer** — see below |
| `apps/extension` | 6,358 + 531 e2e | ~0.26 | bespoke per-file runner | e2e only | **Good**, behaviour-level; heavy `mock.module` |
| `apps/web` | 1,596 unit + 6,518 e2e | low unit | bun + Playwright | e2e yes | **Adequate.** No component-render tests |
| `packages/shared` | 5,796 | ~0.7 | bun | no | **Strong** |
| `apps/desktop` (Rust) | 5,047 | — | cargo | no | **Good**, incl. IPC wire-format and peer-identity |
| `packages/crypto/core` | 4,795 | — | cargo | no | **Strong** — 120 unit tests + 7 format vectors |
| `packages/storage` | 3,953 | 0.60 | bun | no | **Strong.** One conformance suite × 4 adapters + fake |
| `packages/sync` | 3,180 | 1.11 | bun | no | **Strong.** Zero `mock()` calls; drives the real engine |
| `packages/api-contract` | 1,051 | — | bun | needs generated schema | Adequate |
| `packages/crypto/port` | 699 (+1,433 shared suite) | — | bun | wasm artifact | **Strong**, correctly layered |
| `packages/ui` | 89 | **0.007** | bun | no | **Gap.** No render or interaction tests at all |
| `apps/desktop` (TS) | **0** | — | — | — | **Gap** |
| `apps/mobile` (TS) | **0** | — | — | — | **Gap**, and silently skipped |
| `apps/mobile` (Kotlin) | 2 files | — | Gradle | emulator for one | **Never runs in CI** |
| `apps/mobile` (iOS) | **0** | — | — | — | No test infrastructure at all |

**Zero React component tests exist anywhere in the repository.** A repo-wide grep for
`@testing-library/react`, `render(<` and `renderHook` returns nothing. Every TypeScript test is
logic-only. That is a defensible choice given the e2e investment, but it means `packages/ui`'s five
400+ LOC forms and `packages/core`'s entire 30-file hook layer are covered only end-to-end, if at
all.

**The gaps that matter:**

1. **Mobile has no `test` script**, so `turbo run test` skips it without failing. The app with the
   most security-sensitive platform surface contributes nothing to CI.
2. **Desktop has zero TypeScript tests.** `apps/desktop/src/lib/auth-server.ts` is 189 LOC of
   multi-server bookkeeping with listeners and persistence; its 29-LOC web sibling *is* tested.
   That inversion is the sharpest single testing finding in this review.
3. **`packages/ui` is effectively untested** — 89 LOC covering an architecture-boundary assertion
   and three toast behaviours, for 13,310 source LOC including five 400+ LOC forms. Compounded by
   `biome.json:27` excluding `packages/ui/src/components` from linting.
4. **The Android tests that exist are good and unreachable.** `PasskeyMutationDaoTest.kt` verifies
   Room transaction atomicity across a simulated process restart. It runs only from Android Studio;
   no workflow invokes Gradle.
5. **`packages/core`'s hook layer — 30 files, ~4,600 LOC — has zero tests.** Its service layer is
   excellent (19 of 27 files have a sibling test; `vault-repository-bootstrap.test.ts` alone is
   1,370 LOC). The React Query wrapper layer consumed by all four apps has none, and neither does
   `context/platform-context.tsx`. `autolock-web.ts` and `autolock-mobile.ts` (435 LOC combined)
   are also untested and gate lock timing, a security property.
6. **`apps/extension/tests/e2e/save-login-prompt.spec.ts` runs nowhere.** 531 LOC of maintained
   Playwright covering the "not saved while locked" security invariant, with `retries: 2` and
   `workers: 1` configured — and no workflow invokes it. `turbo run test` does not reach it either.
   This is worse than having no suite: it looks covered and is not.

**Seams with no test at all:** the Tauri command args pipeline (the desktop-IPC golden test covers
only the native view, and the generated TS IPC client has no consumer-side test), `SyncStorage`'s
"serialize overlapping read-modify-write" contract against real platform implementations, and the
Kotlin↔TypeScript passkey mutation handoff as a combined system. On the native side, `RsaCrypto.kt`,
`NativeCrypto.kt`, `VaultDecryptor.kt`, `MukEscrowManager.kt`, `SecureMukStore.kt`,
`VaultStateManager.kt`, both Android services, both activities and four of five DAOs are untested.
`ipc_security.rs:943-1178` tests peer verification's **rejection** path only — nothing proves a
legitimate peer is accepted.

**A genuinely clean signal:** zero `.skip`, `.only`, `.todo`, `xit`, `xdescribe` in any TypeScript
test and zero `#[ignore]` in any Rust crate, repo-wide. No disabled dead weight. Golden fixtures in
`packages/storage/src/__fixtures__/` are all referenced and deliberate.

**Where the mocking cost concentrates.** 53 `mock.module` calls, 31 of them in four files
(`auth-handlers.test.ts` alone has 11). That concentration is precisely why
`apps/extension/scripts/run-tests.mjs` exists: `bun test`'s `mock.module` replaces a module
process-wide and permanently, with no per-file reset, so `auth-handlers.test.ts` stubbing
`@bittery/core` deletes `createCoreContext` for every file loaded afterwards. This has already
caused a real failure — passing on macOS and failing on Linux CI because directory-walk order
differs. Replacing whole-module stubs with constructor-injected fakes in those four files would let
the bespoke runner be deleted.

**Tests most likely to break on a behaviour-preserving refactor** (call-order and call-count
assertions): `packages/core/src/services/account-session-manager.test.ts` (6),
`vault-repository.test.ts` (4), `auth-service.test.ts` (3), `core-context.test.ts` (2).

**Where behaviour is tested more than once:** very little, and mostly correctly. Vault key rotation
is tested at three layers (core algorithm, web adapter, e2e) and the layers assert genuinely
different things. Crypto algorithms are tested once, in Rust — deliberately. The adapter conformance
suite tests marshalling and lifetimes, not algorithms. **This layering is right; do not consolidate
it.**

**The mocking cost is real but paid openly.** `apps/extension` must run one file per process
because `bun test`'s `mock.module` is process-global; `scripts/run-tests.mjs` documents the exact
failures (`auth-handlers.test.ts` stubbing `@bittery/core` breaks `createCoreContext` downstream;
three files independently stub `session-manager.ts`). That is a documented trap, not a hidden one —
but it is the one place tests would make a refactor expensive.

---

## 20. CI assessment

Workflows: `ci.yml` (14 jobs), `prepare-release.yml`, `tag-release.yml`, `release.yml`.

Jobs: `migrations`, `crypto`, `crypto-bindings`, `desktop-rust`, `desktop-rust-windows`,
`js-static`, `openapi-diff`, `js-types`, `js-tests`, `mobile`, `server`, `web-e2e-run`,
`web-e2e-report`, `web-e2e`, `docker-build`, `docker`, `docker-compose-config`, `cargo-deny`.

**Strengths.** Generated crypto bindings are diffed (`ci.yml:144-166`). OpenAPI breaking changes
are gated by `oasdiff` with an auditable allowlist (`docs/openapi-breaking-changes.md`, currently
12 approved exceptions for the ADR 0013 rotation cutover). Windows-only IPC hardening gets a
compile-only check because it cannot run on Linux, with the reason in a comment. `cargo-deny` runs.

An ordinary push/PR run is **~8–11 minutes** wall clock (measured on run `31800267666`). The
critical path is `docker-build (web)` at ~10 min; `server` and `crypto` are ~4–4.5 min each. The
18-spec web e2e suite is **skipped on ordinary PRs** — it runs only on schedule, manual dispatch,
or PRs from a `release/v*` branch (`ci.yml:587-590`), with `workers: 2` and `retries: 2` and a
60-minute per-shard ceiling. The workflow explains its own reasoning in comments, which is good
practice and made this section much easier to write.

**Four gaps, all verified:**

1. **`scripts/check-architecture.mjs` runs in no workflow.** In `check:ci` only. Add to
   `js-static`. Two lines.
2. **`apps/desktop/src/generated` is never diffed.** `desktop-rust` runs `cargo test`, which
   regenerates the ts-rs output as a side effect, then discards the result. Add a
   `git diff --exit-code` step mirroring `ci.yml:144-166`. Contradicts ADR 0012's own claim.
3. **Only half of `contracts:check` runs in CI.** `contracts:check` is
   `cargo run --bin write-openapi -- --check && pnpm --filter @bittery/api-contract run check:generated`.
   CI runs the second half (`ci.yml:264`). The first half — proving `openapi.v1.json` still matches
   the live Axum routes — runs nowhere. The `openapi-diff` job is **not** a substitute: it compares
   the committed spec against the base branch for breaking changes, which says nothing about
   whether the committed spec matches current server code. A route change with a stale committed
   spec passes CI green.
4. **The extension e2e suite is wired to nothing** (§19). Either add a release/schedule-gated job
   mirroring `web-e2e-run`, or mark it manual-only in a comment.

**Duplicated setup.** Five jobs (`js-static`, `js-types`, `js-tests`, `mobile`, `web-e2e-run`) each
independently run `pnpm install --frozen-lockfile` **and** `pnpm run i18n:generate`. Caching
mitigates this; it does not eliminate it. One upstream setup job publishing an artifact would
remove four repetitions. The aggregate saving is **unmeasured** — per-step timings are written to
`$GITHUB_STEP_SUMMARY` on every run (a genuinely good existing practice) but were not summed across
a representative sample.

Separately, three structurally identical `fmt → clippy → test` sequences plus their sccache and
rust-cache boilerplate are copy-pasted across `desktop-rust`, `crypto` and `server`. They must stay
separate jobs (three workspaces, three caches), but a shared composite action would remove the
boilerplate. `cargo-deny` correctly does the opposite — one job looping over all three manifests
against one `deny.toml`.

**Why the drift happened.** `check:ci` and the CI job list independently re-implement the same step
sequence rather than one calling the other. That is defensible for parallelism and per-step timing,
but it is exactly the mechanism: `db:check` is covered by a direct `node scripts/check-migrations.mjs`
call rather than by script name, and `architecture:check` and the `write-openapi --check` half were
simply never added.

**Cost note.** `apps/marketing` is the only package using `vitest`+`jsdom`+`@testing-library/*`,
and it is the sole reason a second `vite` major (7.3.1) resolves in `pnpm-lock.yaml` alongside the
repo-standard 8.2.1, pulling a duplicate `lightningcss` native-binary tree. Aligning it onto
`bun:test` removes four devDependencies and a whole resolution subtree. This is a real migration
(rewriting assertions), not a deletion — listed as optional.

---

## 21. Dependency cleanup opportunities

125 distinct external dependencies. The graph is healthier than the count suggests: **one** state
library (`@tanstack/react-query` at a consistent `^5.101.4` everywhere), **one** date library
(`date-fns@^4.4.0`, two consumers), **one** HTTP client (`openapi-fetch`, confined to
`packages/api-contract` per ADR 0011), **one** validation library (`zod`, and only 8 files use it,
all for route search params or postMessage payloads — no schema restates a generated type).

| Action | Value |
|---|---|
| Remove `hono` from the catalog + fix the `CLAUDE.md` line | Closes a stale-documentation trap; zero consumers, absent from the lockfile |
| Remove `react-day-picker` with `calendar.tsx` | One fewer dependency, sole consumer is dead code |
| Remove `jszip` from `packages/shared` by relocating `import/**` | Removes a heavy dep from the desktop, mobile and extension graphs |
| Remove `@bittery/crypto-react-native` + `@bittery/types` from `apps/mobile/package.json` | Declared, never imported |
| Remove `@playwright/test` from `apps/desktop` | No config, no tests |
| Add `"zod": "catalog:"` to `apps/web/package.json` | **Correctness fix.** 7 files import zod; it currently resolves only via the root `package.json`'s hoisted copy |
| Optional: migrate `apps/marketing` off `vitest` | Removes 4 devDeps + the duplicate `vite@7`/`lightningcss` subtree |
| Investigate: `typescript` is uncataloged and drifts (`~5.8.3` desktop, `~6.0.3` mobile, `^5.7.2` elsewhere) | Mobile's TS 6 is plausibly Expo-forced; confirm before aligning |

---

## 22. Recommended target architecture

The target is the current architecture with four changes. This is deliberate — the layering is
sound and a redesign would destroy more value than it creates.

**Change 1 — one app runtime instead of four.** Move the identical bootstrap into `@bittery/core`:

```
@bittery/core/runtime
  createAppRuntime({ storage, itemCache, crypto, vaultCrypto,
                     accountManager, sync, autolock, credentialMirror })
     → { PlatformProvider, SyncProvider, useSyncContext, useQueryInvalidator, ... }

apps/*/src/main.tsx
  createAppRuntime({ ...platform capabilities only })   ← the only per-app file
```

Each app keeps exactly what is platform-specific: its `PlatformPort`, its `CryptoPort` factory, its
sync storage, its autolock. Everything currently copy-pasted becomes one implementation.

**Change 2 — `packages/shared` becomes genuinely shared.** Web-only modules move to `apps/web`,
`identity.ts` to `packages/ui`, `password-history.ts` to `packages/core`. ~3,755 LOC of real
cross-platform logic remains.

**Change 3 — `packages/ui` gains a headless layer for core-dependent dialogs.** Presentational
`*View` components live in `packages/ui`; apps supply hooks. This removes the web/desktop dialog
duplication without breaking the `ui ↛ core` rule.

**Change 4 — CI enforces what the ADRs claim.** `architecture:check` and the desktop generated-code
diff become workflow steps.

Everything else stays: the Rust core, the storage ports, the sync engine, the server, the
generation pipeline, `packages/types`, `packages/config`.

---

## 23. Recommended app, package and crate tree

```
apps/
  server/      Why: owns SQL, the OpenAPI contract, and every closed set. Unchanged.
  web/         Why: the authenticated product on the web. Gains the import subsystem.
  extension/   Why: browser-only surface — autofill, passkey interception, MV3 worker.
  mobile/      Why: native surface — Credential Manager, Autofill, biometrics.
  desktop/     Why: OS keychain, native messaging host, lock-state ownership (ADR 0004).
  marketing/   Why: different deploy shape and audience. Should stop forking @bittery/ui.

packages/
  core/        Why: the one implementation of vault logic for four clients (ADR 0008).
               NEW: owns the app runtime factory (Change 1).
  ui/          Why: one React DOM design system. Pruned; gains ConfirmDialog, Spinner,
               exported getAccountInitials, and headless *View components.
  shared/      Why: cross-platform domain helpers used by 3+ consumers. Halved.
  storage/     Why: the storage tier model and its four platform ports.
  sync/        Why: SSE, delta sync, and the outbound queue, independent of storage.
  api-contract/Why: the generated server contract plus a thin typed facade (ADR 0011).
  crypto/
    core/      Why: one implementation of every primitive (ADR 0001).
    port/      Why: the KeyRef seam and its conformance suite (ADR 0009).
    wasm/      Why: generated bindings for web, desktop, extension.
    react-native/ Why: generated bindings for mobile.
  i18n/        Why: one message catalogue for six surfaces.
  types/       Why: the leaf both sync and storage can depend on without a cycle (ADR 0012).
  config/      Why: one tsconfig base for ~15 packages.

  device/      DELETED — no consumer.
```

Net: 20 workspace packages → 19. **No new packages.** The one plausible new package
(`packages/import`) is not recommended: with a single consumer it would recreate the problem being
fixed. Put it in `apps/web` and promote it only if desktop ever gains import.

---

## 24. LOC and complexity reduction opportunities

| Change | LOC | Complexity reduction | Risk | Effort |
|---|---:|---|---|---|
| Delete `packages/device` + shim | −349 | Removes a package | none | XS |
| Delete `calendar`, `breadcrumb`, 10 sidebar exports | −555 | Prunes the design system | none | XS |
| Delete `create-team-dialog`, `tag-filter`, `useClientId`×3, `safe-area-view` | −259 | — | none | XS |
| Delete dead turbo tasks, `hono` catalog entry, 3 legacy shell scripts | −221 | Removes stale docs traps | none | XS |
| Export `getAccountInitials`, delete 2 copies | −30 | Fixes existing drift | none | XS |
| **Add `architecture:check`, `write-openapi --check`, desktop generated diff to CI** | +6 | **Large** — makes three rules real | none | XS |
| Delete `useCheckEmail`, `useAccountMetadataSync`, `usePlatformAutolock` | −161 | Prunes `packages/core` | none | XS |
| Merge `LocalVaultAccount` / `VaultRepositoryItemAccount` | −10 | One type | none | XS |
| Wire or retire the extension e2e suite | +5 or −531 | Ends a false sense of coverage | none | XS |
| Document the TOTP platform split (§7 P11) | 0 | Removes an undocumented fork | none | S |
| Narrow `packages/core`'s 29 subpath exports | 0 | Shrinks a public API 4× wider than consumed | low | M |
| Add `"zod": "catalog:"` to `apps/web` | +1 | Correctness | none | XS |
| Collapse `FORWARDED_MEMBERS` ×3 → ×1 | −80 | Single source | low | S |
| Unify `request_dto!`/`response_dto!` | −25 | Removes a drift vector | low | S |
| Move `i18n-provider` + `i18n-format` into `@bittery/i18n` | −148 | Removes 4-way copy | low | S |
| Extension adopts `packages/ui` item-detail kit | −250 | Removes a parallel component library | low-med | M |
| Move `Loader` to `packages/ui` | ~0 | Removes drift risk | none | XS |
| `ConfirmDialog` primitive, adopt in 10 sites | −150 to −250 | One dialog pattern | low-med | M |
| Relocate `import/**`, `billing`, `export-types`, `identity`, `password-history` | 0 net | **Large** — `shared` halves; `jszip` leaves 3 graphs | low | M |
| Collapse the app bootstrap into `createAppRuntime` | −400 to −650 | **Largest** — 4-file changes become 1 | medium | L |
| Web + extension adopt `useLogin` | −300 to −500 | One auth path | medium | L |
| Headless split for `MoveItemDialog` + `DeleteVaultDialog` | −385 | Removes web/desktop UI fork | medium | L |
| Mobile adopts `use-item-list-filters` | −67 | Fixes silent divergence | medium | M |
| Unify Kotlin domain matching, align with `hostname.ts` | −80 | **Fixes a user-visible bug** | medium | M |
| Split `admin/index.tsx` per tab | ~0 | Removes worst navigation obstacle | low | M |
| Add drift guards for `ApiProblem`, `RefreshResult`, `AuditEventsRequest` | ~−8 | Closes the ADR 0012 gaps | low | S |
| Add `test` script + first tests to `apps/mobile` | +LOC | **Large** — ends a silent CI skip | low | M |
| First TS tests for `apps/desktop/src/lib/auth-server.ts` | +LOC | Covers untested multi-server logic | low | M |
| Optional: marketing adopts `@bittery/ui` | −634 | One design system | medium | M |
| Optional: marketing off `vitest` | −4 deps | Smaller install | medium | M |

**Realistic totals.** Unambiguous deletion: **~1,400 LOC**. Consolidation without behaviour change:
**~1,200–1,800 LOC**. Relocation (LOC moves, does not vanish, but fixes ownership): **~4,300 LOC**.
Larger consolidations behind design decisions: **~1,100–1,600 LOC**.

Do not judge this work by those numbers. The value is that unlock, sync wiring and the item detail
view stop having four owners.

---

## 25. Changes that should explicitly NOT be made

These look like waste and are not. Several are recorded in ADRs precisely because a future reader
would try to "fix" them.

- **`apps/extension/src/background/session-manager.ts`** — ADR 0007. Zero-state facade, every
  export a one-liner, retained deliberately. Deleting it turns a contained refactor into a wide
  mechanical edit across handlers and six suites' `mock.module` targets.
- **The duplicated `DEFAULT_SETTINGS_TIMEOUT_MS` literal** in `vault-session/transitions.ts` —
  ADR 0005. The module imports *nothing* by design; the literal is the price and is marked as such.
- **`apps/server/src/http/api/security.rs`'s 120-line table and the `assert_eq!` route counts** —
  intentional fail-closed brittleness. A route cannot ship unclassified.
- **The 7 `*ErrorResponses` marker enums** — never constructed, required by `utoipa::IntoResponses`.
- **`packages/crypto/port`'s 60% test share and the 4× conformance runs** — the point is that five
  implementations do not get `KeyRef` bookkeeping right independently.
- **The ~21,000 LOC of committed generated bindings** — `DEVELOPMENT.md` explains the trade.
- **Algorithm assertions staying in Rust only** — ADR 0009 is explicit that duplicating them in
  TypeScript would undermine ADR 0001.
- **`AccountStore`'s `route()`/`readValue()`/`writeValue()` triple** — traced, no pass-through; the
  tier routing is the security artifact.
- **`PlatformPort` and `RecordPort` staying separate** — different durability and trust stories.
- **The SecureStore chunking in `adapters/react-native.ts` and the keychain `commit()` fsync in
  `adapters/tauri.ts`** — both are correctness fixes for real platform limits.
- **The ~5,900 LOC of genuinely platform-required Kotlin** — a headless OS extension process cannot
  reach the JS module.
- **`packages/types` (232 LOC)** — small, but it is what keeps `sync` off `storage`.
- **`packages/config`** — trivial, and correct.
- **Any cross-platform React DOM ↔ React Native component abstraction.**
- **`apps/desktop`'s vault UI merged into web's** without first reconciling the data models —
  desktop is genuinely multi-account and multi-server; web is not. That is a product decision.
- **`bittery-crypto-api` collapsed into `bittery-crypto-core`** — it would force the server to link
  a UniFFI-instrumented crate.
- **`packages/sync/src/outbound-queue.ts` simplified for size** — 1,125 LOC of the hardest control
  flow in the repo, backed by 2,530 LOC of mock-free tests.
- **`get_secret_key_hint` deleted casually** — it has a TypeScript twin; deciding which is
  authoritative is a security review, not a cleanup.
- **`VaultDecryptor.kt`'s AAD construction changed silently** — it fails closed today. Any change
  needs both sides validated in lockstep.
- **The iOS credential-provider stub deleted** — it marks a tracked P0 feature, not cruft.
- **`packages/shared/src/totp.ts` deleted as "duplicate crypto."** ADR 0001 names this file as a
  sanctioned WebCrypto carve-out. A research agent in this review recommended deleting it; that
  recommendation is rejected. The finding is the undocumented *platform split* (§7 P11), not the
  file.
- **`packages/core`'s `storeLoginSessionOwned`/`storeUnlockSessionOwned` merged into their
  non-`Owned` siblings** — they add `KeyRef` ownership and cleanup semantics required by ADR 0009
  (destroy the MUK on failure only if the caller still owns it). Security-load-bearing.
- **`packages/core/src/services/vault-crypto.ts` (1,673 LOC) or `account-vault-replica.ts`
  (a 1,280-line class) split mechanically.** Both bundle ceremonies that share internal helpers
  (`reKeyAccount`, `adopt`, `ownerWrapKeyVersion`) with ordering and rollback invariants, and both
  are covered by large existing suites whose assumptions a naive split would break. Splitting is a
  judgement call for the owning team, not a default action.
- **The `["vaults"]` / `["accounts","unlocked"]` invalidation calls removed on static analysis
  alone** — they may be inert, but confirming that needs a runtime trace. Being wrong yields a
  stale-cache bug where a locked account still shows vault data.
- **`packages/storage/src/__fixtures__/*.json`** — golden documents pinning a cross-language seam
  that has no generator. Not stale test data.

---

## 26. Prioritised incremental refactoring plan

Ten independently mergeable phases. Each keeps every app working, avoids unrelated changes, and
carries tests where behaviour moves.

**Phase 0 — Close the enforcement gaps.** *(hours, no LOC)*
Add `pnpm run architecture:check` to the `js-static` job. Add the
`cargo run --bin write-openapi -- --check` half of `contracts:check` to CI. Add
`git diff --exit-code -- apps/desktop/src/generated` to `desktop-rust` after `cargo test`. Add
`"zod": "catalog:"` to `apps/web`. Decide whether the extension e2e suite is wired up or marked
manual-only. **Do this first** — every later phase is safer once the boundary rules are actually
enforced, and every one of these is a few lines.

**Phase 1 — Delete dead code.** *(−1,560 LOC)*
Plus, in `packages/core`: `use-check-email.ts` (whole file), the singular
`useAccountMetadataSync`, `usePlatformAutolock`, and merge the two identical
`vault-repository.ts` account interfaces.
`packages/device` + shim + the `@bittery/device` dependency line, and update the mirror comment at
`apps/server/src/services/session.rs:1397`. `packages/shared/src/index.ts` + its `"."` export.
`calendar.tsx` + `react-day-picker`, `breadcrumb.tsx`, the 10 sidebar exports. `create-team-dialog.tsx`,
`tag-filter.tsx`, the three `useClientId` wrappers, `safe-area-view.tsx`, `KeyDerivation.kt`, the two
TODO-stub Kotlin tests. The three legacy shell scripts. The dead turbo tasks and the `hono` catalog
entry (plus the `CLAUDE.md` line). Unused `package.json` entries in mobile and desktop.

**Phase 2 — Fix the Android/extension domain-matching bug.** *(correctness, −80 LOC)*
Pick one canonical algorithm. Implement it once in Kotlin and once in TypeScript, pinned by a shared
test-vector fixture. Route all six Kotlin sites through it. **This is a bugfix — write the failing
test first**, per `CLAUDE.md`.

**Phase 3 — Remove trivial abstractions and export what exists.** *(−250 LOC)*
Export `getAccountInitials`, delete both extension copies. Move `Loader` into `packages/ui`.
Collapse `FORWARDED_MEMBERS` ×3 → ×1. Unify the two `request_dto!`/`response_dto!` macros. Add the
three drift guards (`ApiProblem`, `RefreshResult`, `AuditEventsRequest`).

**Phase 4 — Fix package ownership.** *(0 net LOC, large boundary win)*
Move `import/**` to `apps/web` (taking `jszip` with it), `billing.ts` and `export-types.ts` to
`apps/web`, `identity.ts` to `packages/ui`, `password-history.ts` to `packages/core`. Reconcile
`accountEmail` → `email`.

**Phase 5 — Collapse the app bootstrap.** *(−400 to −650 LOC, the structural win)*
Land it in slices so each is reviewable: (a) `i18n-provider` and `i18n-format` into `@bittery/i18n`;
(b) `vault-runtime.ts` and `crypto.ts` into one factory; (c) `createAppRuntime` covering
`PlatformProvider` and `SyncProvider`; (d) `lifecycle.ts` — **investigate the web/desktop
lazy-vs-eager divergence before merging**; it may be a latent TDZ bug.

**Phase 6 — Consolidate shared frontend logic.** *(−600 to −800 LOC)*
Extension adopts `packages/ui`'s item-detail kit. Mobile adopts `use-item-list-filters` (decide the
`email` question first). Web and extension adopt `useLogin`. Add `ConfirmDialog` and adopt it in the
10 sites.

**Phase 7 — Headless split for core-dependent dialogs.** *(−385 LOC)*
`MoveItemDialogView` and `DeleteVaultDialogView` in `packages/ui`; apps supply the hooks. Keeps the
`ui ↛ core` rule intact.

**Phase 8 — Simplify frontend state and data flow.** *(~0 LOC, real clarity)*
A `useApiMutation` helper for the repeated toast/invalidate shape. A shared loading boundary. Split
`admin/index.tsx` per tab. Fix the three `useEffect` violations. Fix the 13 raw-palette files and
the 5 direct `lucide-react` imports — and add a lint rule so neither recurs.

**Phase 9 — Close the testing gaps.** *(+LOC, highest risk reduction)*
Add a `test` script and first tests to `apps/mobile` so turbo stops skipping it. First TypeScript
tests for `apps/desktop/src/lib/auth-server.ts`. A `SyncStorage` conformance suite mirroring
`port-conformance.ts`. Render tests for the five large `packages/ui` forms. Wire the Android unit
tests (not the instrumentation tests) into CI.

**Phase 10 — Schedule the deep dives.** See §28.

Sequencing note: Phases 0–4 are independent and can run in parallel. Phase 5 should land before
Phase 6, and Phase 7 after Phase 6. Phase 9 can start at any point and ideally overlaps 5–7, since
tests written before a consolidation are what make the consolidation safe.

---

## 27. Highest-value quick wins

Each is under a day and carries near-zero risk.

1. **Three CI steps** (§26 Phase 0). Turns three documented rules into enforced ones. Highest
   value-to-effort ratio in this document, by a wide margin.
2. **Delete `packages/device`** — −349 LOC, one fewer package, verified zero consumers.
3. **Export `getAccountInitials`** — one keyword removes 30 LOC and fixes existing drift.
4. **Delete `calendar.tsx` + `breadcrumb.tsx` + the 10 sidebar exports** — −555 LOC and one
   dependency.
5. **Delete `packages/shared/src/index.ts`** — an unused barrel on the most-imported package.
6. **Remove `hono` from the catalog and fix the `CLAUDE.md` line** — stops a future contributor
   adding a real dependency because the catalog implied it was in use.
7. **Add `"zod": "catalog:"` to `apps/web`** — 7 files rely on a hoisted root resolution today.
8. **Add a `test` script to `apps/mobile`**, even with one trivial test — ends the silent turbo
   skip immediately.
9. **Move `Loader` into `packages/ui`** — byte-identical in two apps, nothing blocks it.
10. **Delete the three legacy native-messaging shell scripts** — −204 LOC referencing a document
    that does not exist.
11. **Delete `use-check-email.ts`, the singular `useAccountMetadataSync`, `usePlatformAutolock`** —
    −161 LOC of `packages/core` with zero callers anywhere.
12. **Decide the extension e2e suite's fate** — one workflow block or one comment. Right now 531
    LOC covering a security invariant looks covered and runs nowhere.

---

## 28. Follow-up deep dives

**Rust backend (already scheduled).** Decompose `services/session.rs` (1,616), `services/team.rs`
(1,420) and `http/api/vault.rs` (1,936/31 routes), which lack the sub-module structure `vault/`,
`auth/` and `billing/` already have. Resolve the snake_case/camelCase operationId split (18 auth
endpoints) through the breaking-change allowlist. Run `clippy` for style and complexity —
`cargo check` is already clean for dead code. Consider whether a future utoipa can collapse the six
schemas that restate the Item field set.

**Crypto.** Read `srp6a/bigint.rs` (361 LOC of hand-rolled bignum), `srp6a/client.rs` and
`server.rs` in full — highest consequence-of-bug density in the repository, only size-surveyed here.
Decide the authoritative implementation of `get_secret_key_hint`. Confirm whether the server's
independent `ValidatedKdfProfile` has ever drifted from the core's `validate_kdf_profile`, and add
a shared vector test — `SECURITY.md` says they must change together, but nothing enforces it.
Determine intent behind `decrypt_vault_key_with_muk`. Track whether upstream uniffi has obsoleted
the patch.

**Mobile.** iOS credential provider is a tracked P0 and needs a plan, not a review.
`BitteryAutofillService.kt:207-210` always fails `onSaveRequest`, so Android can read saved
credentials but never save new ones from the system dialog. Reconcile the two independent retry
ceilings (`MAX_PENDING_PASSKEY_ATTEMPTS` vs `ItemSyncEngine.MAX_RETRY_COUNT`) — this governs when a
locally-created passkey mutation is silently dropped, and needs product sign-off, not a refactor.

**Dead-code sweep with real tooling.** Every "unused export" finding here is grep-based, which
under-counts re-exports and over-counts structurally-consumed type exports. A `knip`/`ts-prune`
pass plus `cargo machete`/`cargo udeps` would give a number worth acting on. The i18n key audit
belongs in the same pass.

**Design-system compliance.** 13 raw-palette files, 5 direct `lucide-react` imports, marketing's
drifted fork, and no `tokens.css` ↔ `apps/mobile/global.css` parity check. Small individually;
together they mean `DESIGN.md` is advisory rather than enforced.

---

## 29. Open questions and uncertainties

1. **Is `lifecycle.ts`'s web/desktop divergence a latent bug?** Web uses lazy getters with a comment
   citing a TDZ import cycle; desktop uses eager values. If desktop shares the exposure, this is a
   bug, not drift. **Answer before Phase 5(d).**
2. **Was mobile omitting `email` from item search intentional?** `@bittery/core`'s
   `use-item-list-filters.ts:59` searches it; mobile's copy does not. Adopting the shared hook
   changes mobile's search results.
3. **Should the three bespoke account switchers collapse onto `packages/ui`'s?** Web already does.
   Desktop's 506-LOC version folds in four dialogs; how much is genuine platform chrome is
   unmeasured.
4. **Do `apps/desktop` or `apps/mobile` generate an Emergency Kit PDF?** `apps/web/src/lib/recovery-kit.ts`
   is 620 LOC and was not compared against them. If they do, it is a large promotion candidate.
5. **How many i18n keys are actually dead?** A 15-of-2,528 sample found 2. Not extrapolatable.
6. **Is `apps/mobile`'s TypeScript `~6.0.3` forced by Expo 57?** If not, it is uncataloged drift.
7. **Which of `get_secret_key_hint`'s two implementations is authoritative?** Security review.
8. **Do the six generated OpenAPI schemas restating the Item field set matter in practice?**
   Documented as a utoipa limitation; unclear whether it costs anything downstream.
9. **Is `packages/ui`'s exclusion from Biome (`biome.json:27`) still justified?** It was for
   vendored shadcn, but 74% of the package is now Bittery-specific and unlinted.
10. **What is the actual CI wall-clock cost?** Not measured. The `vitest`/`vite@7` duplication and
    the e2e job structure were assessed structurally, not timed.
11. **Should `MoveItemDialog`'s headless split set a repo-wide pattern?** If yes, it likely applies
    to `item-detail-pane`/`item-detail-page` and the sidebar pair too — a larger programme than
    Phase 7 as scoped.
12. **Does the wasm worker boundary earn its complexity?** ADR 0010 calls the main-thread-MUK
    property "a convention, not a guarantee." Whether the worker hop has ever caught a real bug is
    unknown.
13. **Which TOTP implementation should each platform use?** ADR 0001 sanctions the WebCrypto one;
    the Rust core has one too; mobile uses Rust and everything else uses WebCrypto. The rule needs
    writing down, and the two need a shared vector test either way.
14. **Do the `["vaults"]` and `["accounts","unlocked"]` invalidations match any real query?**
    Static analysis says no. Resolve with React Query Devtools, not grep.
15. **Is `packages/core`'s untested 30-file hook layer covered by `apps/web`'s e2e suite in
    practice?** If not, this is the largest test-debt item in the repository and outranks every
    LOC-reduction item in this document.
16. **Can `packages/shared`'s KDF policy validation wrap the crypto port** instead of
    reimplementing bounds checking and downgrade rejection? If it cannot (a sync-call requirement,
    most likely), the duplication is architecturally forced and should be labelled as such rather
    than silently tolerated.
17. **How does `apps/server` isolate its DB tests?** No `#[sqlx::test]` usage exists; the custom
    harness in `test_support.rs` runs against a shared `DATABASE_URL`. Whether isolation comes from
    transactions or from unique-key generation was not traced.
18. **Should `packages/core`'s 25 wholesale `./services/*` subpath exports be narrowed?** It is the
    root cause of the "public surface much wider than consumed surface" gap, but narrowing is a
    design decision with real churn.

---

*No code was modified in producing this review.*
