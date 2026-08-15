# Mobile migration — decisions

Every entry: the choice, what it was chosen over, why, and what would make us revisit it.
Written as the migration runs. Nothing here is a one-way door.

Run start: 2026-08-15 20:42 CEST. Hard stop: 2026-08-16 02:00 CEST.

---

## D1 — Shared feature components live in `@bittery/ui`, and nothing is extracted for M1

**Choice.** Mobile screens import presentation from `@bittery/ui` and wire it with
`@bittery/core/hooks`. No new shared package. No component moves out of `apps/desktop`
before M1 is done.

**Why.** `@bittery/ui` is not primitives-only, which the migration brief assumed. It already
exports feature-level vault components — `components/vault/item-detail`,
`item-list-row`, `item-form`, `create-item-sheet`, `edit-item-sheet`, `item-list-controls`,
`sidebar-section`, `item-categories`, `password-history-dialog`. `scripts/check-architecture.mjs`
forbids `ui -> core | storage | sync`, so these components already take props rather than
reaching for hooks. That is exactly the layout-free seam the brief asked us to create, and it
exists.

What is left in `apps/desktop/src/components/vault/` is the desktop-shaped wrapper layer:
`vault-sidebar.tsx` (442 lines, resizable rail), `item-detail-page.tsx` (598 lines, a
three-pane page), `search-combobox.tsx`, `move-item-dialog.tsx`. These carry desktop layout
by design. Extracting them would mean splitting each at a new seam, under the
"desktop must not regress" guardrail, which costs an Opus implementer plus an Opus adversarial
reviewer per component.

**Over.** Creating `packages/features` and moving desktop's vault wrappers into it.

**Consequence.** M1 touches zero desktop files, so no desktop regression is possible and no
chunk in M1 needs the guarded review tier. That is the whole reason for the choice: it converts
the most expensive part of the plan into nothing.

**Revisit when.** A third surface needs the same wrapper, or a mobile screen finds itself
duplicating more than ~80 lines of desktop logic that is not layout. Then extract that one
wrapper into `@bittery/ui/components/vault/`, headless-first, one at a time.

---

## D2 — The new app is `apps/mobile-tauri`, its own Tauri project

**Choice.** A new workspace app. `apps/mobile` (Expo) stays until the new app works.

**Why.** As the brief states: `apps/desktop/src-tauri` builds a second `bittery-native-host`
binary for Chrome native messaging and pulls per-OS `keyring`, neither of which has a mobile
backend. Adding an Android target there would drag both into the mobile build.

**Revisit when.** Never for this migration. Rename `apps/mobile-tauri` -> `apps/mobile` at the
very end, after the Expo app is deleted.

---

## D3 — Each app keeps its own route tree; mobile uses a flat stack, not desktop's nesting

**Choice.** TanStack Router in `apps/mobile-tauri`, with its own `routes/` and its own
generated `routeTree.gen.ts`. Route map:

| Desktop | Mobile |
| --- | --- |
| `/` (boot redirect) | `/` — same job |
| `/login` | `/login` — full-screen, no auth-doors reveal animation |
| `/unlock` | `/unlock` — full-screen |
| `/vault` (sidebar + list + detail, three panes) | `/vault` — vault picker list, one pane |
| `/vault/$id` | `/vault/$id` — item list for one vault |
| `/vault/$id/$itemId` | `/vault/$id/$itemId` — full-screen item detail, back-navigates |
| `/vault/trash`, `/vault/favorites`, `/vault/all-items`, `/vault/tag/*` | not in M1 |

Desktop shows list and detail side by side and treats `$itemId` as a pane. Mobile pushes
`$itemId` as a full screen. That is the shell seam: same hooks, same `@bittery/ui` item
components, different route composition.

**Revisit when.** Never — this is the point of the two-shell strategy.

---

## D4 — Secure storage: `@choochmeque/tauri-plugin-biometry-api` `setData`/`getData`

**Choice.** The `secret` tier of `PlatformPort` on mobile is backed by the biometry plugin's
`setData`/`getData`, not by `impierce/tauri-plugin-keystore`.

**Why.** The biometry plugin is *already a desktop dependency of this repo* and already a
declared optional peer of `@bittery/storage`. Using it for both biometrics and secret storage
adds zero new supply-chain surface, where `tauri-plugin-keystore` would add a whole new
single-maintainer crate. On Android it stores through the Android Keystore /
`EncryptedSharedPreferences`, which is the hardware-backed answer `PlatformPort.secretBacking`
has to give.

**SUPPLY-CHAIN RISK, recorded deliberately.** `@choochmeque/tauri-plugin-biometry-api` is
community code with a single maintainer, and under this decision it holds `vault_keys` and the
wrapped master unlock key. That is a genuine security-review question before any release. It is
not a reason to stop the migration, and it is not worse than the alternative — the alternative
is a *different* single-maintainer crate with the same exposure and no existing footprint in
this repo. Desktop's `keyring` crate has no mobile backend, so there is no first-party option.

**Revisit when.** A security review runs, or Tauri ships an official keychain plugin. The seam
is `PlatformPort.secretGet/secretSet/secretDelete` in one adapter file — swapping the backing
store is a one-file change by construction.

---

## D5 — Local cache DB: `tauri-plugin-sql` with the SQLite backend

**Choice.** `RecordPort` on mobile is a SQLite table via `tauri-plugin-sql`, not desktop's
`store.json`.

**Why.** Settled in the brief. Desktop's record port exists to let the Rust native-messaging
host read the same file; mobile has no such reader, and a JSON blob rewritten on every item
write is the wrong shape for a 2 000-item vault on flash storage.

**Schema.** One table, `records(key TEXT PRIMARY KEY, value TEXT NOT NULL)`. `RecordPort` is a
string key/value contract, so nothing richer is warranted — and `ItemCache` above the port owns
all the structure.

**Revisit when.** Never for M1.

---

## D6 — No Tauri `crypto_*` invoke commands; crypto is `wasm-worker`, exactly as desktop

**Choice.** `apps/mobile-tauri/src/lib/crypto.ts` is a copy of
`apps/desktop/src/lib/crypto.ts` — `createWasmWorkerCryptoPort()` with default deps.

**Why.** ADR 0010 deliberately deleted renderer-to-Rust crypto commands. The spike proved WASM
PBKDF2 in an Android WebView is ~700ms at 1.2M iterations, so ~350ms at the 600k policy
default. Nothing forces a native path.

**Requires.** `worker: { format: "es" }` in `vite.config.ts`, and
`packages/crypto/wasm/generated/wasm-bindgen/index_bg.wasm` present at build time — it is
gitignored, produced by `pnpm build:crypto-wasm`, and CI must run that before building mobile.

---

## D7 — Vite `build.target: "chrome87"`, set in `vite.config.ts`, not `tsconfig.json`

**Choice and why.** Straight from the spike. `noEmit: true` means tsc emits nothing and its
`target` only types-checks; Vite 8 otherwise defaults to `baseline-widely-available`
(~Chrome 111), well above the `minSdk = 24` WebView floor.

---

## D8 — Kotlin 2.1.20 in `gen/android/build.gradle.kts`, recorded because `android init` undoes it

**Choice.** After `pnpm tauri android init`, hand-edit `gen/android/build.gradle.kts` to
Kotlin `2.1.20`.

**Why.** Tauri 2.11.5 writes Kotlin 1.9.25, which cannot read `androidx.credentials:1.6.0-rc01`
Kotlin 2.1 metadata; the transitive `kotlin-stdlib:2.1.20` then poisons the classpath down to
`kotlin.Unit`. Spike finding, reproduced and documented in
`spikes/tauri-mobile/README.md`.

**Durability.** `gen/android` is committed, and `pnpm tauri android init` must never be re-run
once the credential-provider plugin exists. Both facts are repeated in
`apps/mobile-tauri/README.md` and `docs/mobile-migration-state.md`.

---

## D9 — Milestone order under a 5-hour clock: build pipeline first, features second

**Choice.** Prove the Android build end to end (skeleton -> `android init` -> APK installs and
boots) before writing a single feature screen.

**Why.** Rust cross-compilation and Gradle are the highest-variance part of this work and the
only part that can fail in a way no amount of TypeScript fixes. Discovering that at 01:00 with
five screens written would waste the whole run. Discovering it at 21:30 leaves time to route
around it.

**Consequence.** The app boots to a placeholder before it boots to anything useful. That is
intended.
