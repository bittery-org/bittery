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

## D4 — Secure storage. Superseded by D4a. Kept for the reasoning.

**Original choice.** Back the `secret` tier with the biometry plugin's `setData`/`getData`,
because that plugin is already a desktop dependency and already an optional peer of
`@bittery/storage`, so it adds no new supply-chain surface, and on Android it stores through
the Android Keystore.

**Why it was wrong.** Implementing it (chunk M1-C3) turned up three facts by reading the
plugin's own Kotlin and Swift, at
`~/.cargo/registry/src/*/tauri-plugin-biometry-0.2.8/android/src/main/java/BiometryPlugin.kt`
and `.../ios/Sources/BiometryPlugin.swift`:

1. **`getData` raises a biometric prompt on every read.** Android builds a `BiometricPrompt`
   with a `CryptoObject`; iOS uses a `.userPresence` access control. `AccountStore` reads
   secret-tier values on ordinary paths — `jwt_token` is read on **every API request** through
   `getAccountSnapshot`. That is a fingerprint prompt per HTTP call. Not a rough edge; the app
   would be unusable.
2. **`setData` deletes every sibling under the same `domain`** — it calls
   `keyStore.deleteEntry(args.domain)` and regenerates a 4096-bit RSA key pair on every write.
   Workable (give each key its own domain) but it means a write is expensive.
3. **`setData` throws on a device with no secure lock screen**, because key generation sets
   `setUserAuthenticationRequired(true)`. Such a device could not use the app at all.

Point 1 alone kills it.

**Why not `impierce/tauri-plugin-keystore` instead.** Checked directly against crates.io: one
published version, `2.1.0-alpha.1`, dated 2025-02-20, 2 626 downloads all-time, and **no
companion package on npm** (`tauri-plugin-keystore-api` is a 404). Adopting it means vendoring
its guest-JS from GitHub and betting M1 on an 18-month-stale alpha. That is worse supply chain
than the incumbent, not better, and it is a build risk under this run's clock.

---

## D4a — The `secret` tier on mobile is `store.json`, and this is a recorded security downgrade

**Choice.** `secretGet`/`secretSet`/`secretDelete` are backed by `@tauri-apps/plugin-store`, in
a store file separate from the `kv` one, under its own namespace. `BiometricPort` keeps using
`@choochmeque/tauri-plugin-biometry-api` for `checkStatus`/`authenticate` — prompting is the
entire point there, so none of the above applies.

`PlatformPort.secretBacking` must say so plainly, in the shape the web adapter already uses:
no at-rest separation from the plain tier on this platform.

**THIS IS THE MIGRATION'S NUMBER ONE SECURITY GAP. Read this before any release.**

What it costs, precisely. Android app-private storage is sandboxed from other apps and is
covered by file-based encryption at rest, so this is not "plaintext on the SD card". But the
secret tier holds `device_key`, which is raw key material, and it sits beside the master unlock
key that `device_key` wraps. Anything that can read the app's private directory — root, a
device-owner backup, a physical extraction — gets quick-unlock material that the Android
Keystore would have kept in the TEE. **The Expo app used `expo-secure-store`, which is
Keystore-backed, so this is a regression against the app being replaced.** It is not a
regression against desktop, which uses the OS keychain and is unaffected.

Full sign-in material is not exposed by this: the master password and Secret Key are never
persisted, and the stored master unlock key is wrapped. The exposure is quick unlock.

**Why ship it anyway.** There is no third option. Every hardware-backed store reachable from
Tauri on Android today either prompts on read (D4, unusable) or is an unmaintained alpha with
no JS binding (rejected above). The migration brief anticipated exactly this and called it "a
security-review question for later, not a reason to stop now". Shipping M1 behind this gap,
loudly recorded, beats not shipping M1.

**Revisit — and this one genuinely must be revisited.** The fix is a first-party Tauri command
in `apps/mobile-tauri/src-tauri` that calls the Android Keystore directly without
`setUserAuthenticationRequired`, mirroring what `apps/desktop/src-tauri/src/keychain.rs` does
with the `keyring` crate. That is the right answer and it is maybe half a day of Rust and
Kotlin. It was not attempted here only because this run has hours, not days.

The seam makes the swap cheap by construction: it is three functions in one adapter file,
behind the `TauriMobileDeps` loader interface, with a conformance suite that already proves the
contract. Nothing above `PlatformPort` changes.

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
