# Mobile migration — decisions

Every entry: the choice, what it was chosen over, why, and what would make us revisit it.
Written as the migration runs. Nothing here is a one-way door.

Run start: 2026-08-15 20:42 CEST. Hard stop: 2026-08-16 02:00 CEST.

> **Naming, read this first.** Paths below use the names in force when each decision was made,
> when two mobile apps existed: `apps/mobile` was the Expo app and `apps/mobile-tauri` was the
> Tauri replacement. On 2026-08-18 the Expo app was deleted and the Tauri app took its name, so
> every `apps/mobile-tauri/…` path below is `apps/mobile/…` in the tree today. The text is left
> as written — collapsing the two names would make the decisions unreadable.

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

## D4 — Secure storage. Superseded by D4a, then by D4b. Kept for the reasoning.

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

> **Superseded on Android by D4b.** The gap this entry calls the migration's number one is
> closed there: `secret*` goes through the Android Keystore. Everything below still describes
> **iOS**, and any Android build where the Keystore probe declines, because that is still the
> fallback. Read it as "what the fallback costs", not as the current state on Android.

**Choice.** `secretGet`/`secretSet`/`secretDelete` are backed by `@tauri-apps/plugin-store`, in
a store file separate from the `kv` one, under its own namespace. `BiometricPort` keeps using
`@choochmeque/tauri-plugin-biometry-api` for `checkStatus`/`authenticate` — prompting is the
entire point there, so none of the above applies.

`PlatformPort.secretBacking` must say so plainly, in the shape the web adapter already uses:
no at-rest separation from the plain tier on this platform.

**THIS WAS THE MIGRATION'S NUMBER ONE SECURITY GAP.** Closed on Android by D4b; still open on
iOS. Read this before any release.

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
Kotlin. **Done — see D4b.**

The seam makes the swap cheap by construction: it is three functions in one adapter file,
behind the `TauriMobileDeps` loader interface, with a conformance suite that already proves the
contract. Nothing above `PlatformPort` changed, and that held.

---

## D4b — The `secret` tier on Android is the Android Keystore, through a first-party plugin

**Choice.** `apps/mobile-tauri/src-tauri/plugins/keystore` — `tauri-plugin-bittery-keystore`,
first-party, Rust plus Kotlin. One AES-256-GCM key in the `AndroidKeyStore` provider under alias
`bittery_secret_v1`; values are sealed with it and only the ciphertext lands on disk, in
`shared_prefs/bittery_keystore_secrets.xml` as `v1:<base64 IV>:<base64 ciphertext+tag>`. The
adapter probes once in `initialize()` with a real encrypt/decrypt round trip, drains any existing
`secrets.json` entries into the Keystore write-verify-then-delete, and only then adopts it.

This is D4a's recommended fix, carried out. D4a is superseded on Android.

**What it does guarantee.**

- `vault_keys`, the wrapped master unlock key, `device_key`, `encrypted_private_key`,
  `session_data` and `jwt_token` are no longer readable from the app's private directory alone.
  Anything that reads the file gets ciphertext; the key is not in the file and cannot be
  exported from the provider.
- No prompt on read. `setUserAuthenticationRequired` is deliberately not set and must never be
  added — `jwt_token` is read on every API request, and a prompt per read is what killed D4's
  option. Prompting stays in `BiometricPort`, where the user asked for it.
- A value is deleted only when it is *provably* unreadable forever — a GCM tag mismatch or a
  corrupt envelope. A transient Keystore failure (`BackendBusyException`, a keystore2 restart)
  answers `null` and writes nothing, because the retry can succeed and a wrong deletion here
  costs a full sign-in with master password *and* Secret Key.

**What it does not guarantee.**

- **Not hardware backing.** `AndroidKeyStore` is TEE-backed only where the device provides a
  TEE. `secret_available` reports the level `KeyInfo` actually observed, and
  `PlatformPort.secretBacking` passes that string through verbatim — including
  `NOT hardware-backed (software, KeyInfo.securityLevel)`, which is what the Pixel_9 emulator
  this was built on reports. No code here claims hardware; it reports what it was told.
- **Not StrongBox.** `setIsStrongBoxBacked(true)` throws `StrongBoxUnavailableException` at key
  generation on devices with no secure element, which would lock those users out of their own
  vault. Not requested.
- **Not protection against a compromised running app.** The key is usable without a prompt by
  anything running as this app's UID. The threat this closes is offline access to the private
  directory, not code execution inside it.
- **Not durable against genuine key loss.** If the alias really is gone — factory-reset
  keystore, some restore paths — the ciphertexts are dead, and the plugin rotates the key and
  clears them so the app degrades to a full sign-in rather than wedging.

**The fallback stays.** iOS has no implementation here, and any Android build where the probe
declines keeps using `secrets.json` with D4a's downgrade in force. That path is not dead code:
it is what runs on iOS today, it is what a failed probe lands on, and `secretBacking` says so
plainly in both states.

**Backup.** `android:allowBackup="false"` is set by hand in `gen/android/app/src/main/
AndroidManifest.xml` so the ciphertext file does not go to Google cloud backup. `tauri android
init` regenerates that file and drops the attribute; `apps/mobile-tauri/README.md` records it.

**Revisit when.** iOS work starts — the Keychain equivalent belongs behind the same seam, and
`TauriKeystoreInvoke` is already the shape for it. Also if a `v2` envelope is ever needed: the
version tag is checked, and an unrecognised one is left on disk untouched rather than deleted,
so a rollback onto an older build does not destroy data.

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

---

## D11 — CI type-checks, lints and builds `apps/mobile-tauri` on every push; the full Android
build is paths-gated

> Numbered D11, not D10: `docs/mobile-migration-state.md`'s "Reaching a local server from the
> emulator" section already cites an unwritten "D10" for the `CORS_ORIGIN`/`tauri.localhost`
> server change. That reference predates this entry and is not this decision — left as found,
> not fixed here, to avoid colliding with whatever it was meant to point at.

**Choice.** `.github/workflows/ci.yml` gets a `mobile-tauri` job — install, `pnpm
build:crypto-wasm` (reusing the artifact `crypto-bindings` already produces, exactly like
`js-static`/`js-types`/`js-tests`), `pnpm exec turbo -F mobile-tauri check-types` (which also
runs the app's `lint:promises` scan), `pnpm --filter mobile-tauri exec vite build`, `pnpm exec
biome check apps/mobile-tauri`. Runs on every push and PR, like `js-types`.

The full `pnpm tauri android build` — Android SDK, NDK, JDK, all four Rust Android targets, `pnpm
build:crypto-android` for the UniFFI `.so` files, then Gradle — is a second job,
`mobile-tauri-android`, gated to run only when `apps/mobile-tauri/**` or `packages/crypto/**`
changed (`dorny/paths-filter@v3`, evaluated in its own small job so the boolean exists
unconditionally), plus unconditionally on the weekly schedule, on `workflow_dispatch`, and on
`release/v*` PRs — the same three conditions `web-e2e-run` and `extension-e2e-run` already use for
their own heavy, infrequently-necessary jobs.

**Why not the other two options.**

- **Full Android build on every push.** Rejected. It is the slowest job in the workflow by a wide
  margin — SDK + NDK + JDK + four Rust targets + a cold Gradle build — for a payoff (catching an
  Android-only break) that a paths filter already gets for the pushes that can cause one. Every
  PR that touches only, say, `apps/server` or `apps/web` would pay that cost for zero chance of
  catching anything.
- **Frontend + type-check only, Android build on schedule/release only, dropping the paths
  filter.** Close, and defensible. Rejected only because the paths filter is nearly free (one
  `actions/checkout` plus a diff) and buys something the pure schedule/release gate does not: a
  PR that changes `apps/mobile-tauri/src-tauri` (Rust) or `packages/crypto` gets the Android build
  *before* merge, not a week later on the cron or only on a release branch.

**What this still misses.** A push that changes neither `apps/mobile-tauri/**` nor
`packages/crypto/**` but still breaks the Android build — a Tauri CLI bump, a Gradle plugin
version drift, an AGP/Kotlin update reached through the root lockfile, exactly the class of
"environment moved under an untouched file" break `docker-build`'s own no-schedule-guard comment
calls out — will not be caught until the next scheduled run (weekly) or the next `release/v*` PR.
That is the trade this makes deliberately: those breaks are real but rare, and the weekly cron is
the same answer already accepted for Docker base-image drift and `cargo-deny` advisories elsewhere
in this file.

**No signing secret is read anywhere in `mobile-tauri-android`.** The build is `--debug`,
unsigned — the same command a developer runs locally, per `docs/mobile-migration-state.md`. There
is nothing to guard against a missing secret yet; the workflow comment on that job says so
explicitly and records the rule (`secrets.<NAME> != ''` before any future signing step) for when
one is added.

**Not verified against a real GitHub Actions run.** The frontend `mobile-tauri` job's steps were
each run locally against the real repo (`turbo -F mobile-tauri check-types`, `vite build`, `biome
check apps/mobile-tauri`) and pass. `mobile-tauri-android` could not be — this sandbox has no way
to execute a GitHub-hosted runner. Its risk surface is entirely ordinary CI risk (exact NDK path
under `$ANDROID_HOME/ndk`, whether `ubuntu-latest` still preinstalls the SDK the way `android-unit`
and `crypto-bindings`' android leg already assume, Gradle first-run time inside the 45-minute
timeout) rather than anything specific to this decision.

**Revisit when.** The Android build job's own timing shows up in a run — if it is consistently
much slower than `web-e2e-run`'s 60-minute budget allows for comfortably, or if the paths filter
ever misses a break that should have been caught, tighten or loosen the filter rather than
changing the overall shape.

---

## D12 — Mobile navigation: a five-tab bottom bar, not desktop's sidebar

**Choice.** M3-C2 closes the feature gap (create/edit/delete/move/favorite, trash, all-items,
tags, search) and had to pick mobile's answer to desktop's resizable sidebar
(`apps/desktop/src/components/vault/vault-sidebar.tsx`) first, per the chunk brief. Chose a fixed
bottom tab bar (`apps/mobile-tauri/src/components/vault/bottom-tab-bar.tsx`) with five tabs:
Vaults (`/vault`), All Items (`/vault/all-items`), Tags (`/vault/tags`), Trash (`/vault/trash`),
Search (`/vault/search`).

**Why these five, in this order.** `packages/i18n/messages/en.json` already carries
`mob_tab_vaults`, `mob_tab_all_items`, `mob_tab_tags`, `mob_tab_trash` and `mob_tab_search` —
survivors from the Expo app this migration replaces, and nothing else (there is no
`mob_tab_favorites` or `mob_tab_settings`). That is direct evidence of the IA the predecessor
app shipped and users already know, so reusing it costs nothing new to learn and needed no new
translation keys. Favorites has no tab: it is reached from the "Favorites" section header on the
All Items screen (`mob_items_section_favorites`, also a surviving key, evidently meant for
exactly this split) and from the star toggle on any item row or the item detail screen. Settings
is out of scope for this chunk per the brief, so it is not in the bar yet — see "Revisit when".

**Over.** A filter row pinned to the top of the vault list (the brief's other suggested option).
Rejected because the existing push stack already uses the *top* of the screen for
`MobileScreen`'s sticky back-button header on every pushed screen (`/vault/$id`, every
`$itemId` detail, `/vault/tag/$tagName`) — a filter row there would compete with that header for
the same 44px band and would need to disappear and reappear as the stack pushes and pops. A
bottom bar has no such conflict: it is rendered only by the five tab-root screens
(`TabScreen`, `apps/mobile-tauri/src/components/vault/tab-screen.tsx`) and is simply absent
everywhere else, so the push/back flow the brief requires stays untouched — pushing
`/vault/$id/$itemId` from `/vault/$id` looks exactly like it did in M1.

**Consequence.** Two screens exist only because the bar needs a landing page for them and the
brief did not otherwise ask for one: `/vault/tags` (a searchable list of every cross-vault tag,
landing for the Tags tab) and `/vault/search` (the brief's required full-screen search, given its
own tab rather than a modal launched from elsewhere). Both dead-end into routes the brief did
list — `/vault/tags` pushes `/vault/tag/$tagName`; `/vault/search` navigates to
`/vault/tag/$tagName`, `/vault/$id` or `/vault/all-items/$itemId` depending on what was tapped.

**Revisit when.** Settings (out of scope for M3-C2) lands — decide then whether it earns a sixth
tab, folds into the account row already on the Vaults tab, or gets a `More` tab that absorbs it
alongside Tags (the lowest-traffic of the five, on the evidence of it being the only one with no
count badge anywhere in the surviving copy). If a sixth tab is ever needed, five is already a
tight fit at 44px+ touch targets on a narrow phone in portrait — measure before adding, not
after.

---

## D13 — `apps/mobile` (Expo) stays. The migration stops short of deleting it.

> **Superseded 2026-08-18.** `apps/mobile` is deleted. The four unproven things below were
> weighed and accepted: the Tauri app is good enough to be the only mobile client, and git
> history is the way back if it is not. What changed in the tree: the Expo app, its `mobile` and
> `android-unit` CI jobs, and its version-sync surfaces are gone; `DESIGN-NATIVE.md` moved to
> `apps/mobile-tauri/`; the credential provider's Kotlin `domain` tests now run inside the
> `mobile-tauri-android` job.
>
> **Steps 4 and 5 are done too.** The UniFFI Kotlin and the per-ABI `.so` moved to
> `packages/crypto/android`, generated by `packages/crypto/core/build-android.sh` — `cargo ndk`
> plus `crates/uniffi-bindgen`, a wrapper pinned to the crate's own `uniffi` version. The Kotlin
> it emits is byte-identical to what `uniffi-bindgen-react-native` emitted, so point 4 below cost
> a build script rather than a rewrite. `packages/crypto/react-native`, the React Native adapters
> in `crypto/port` and `storage`, `build:crypto-ios` and the iOS leg of the `crypto-bindings`
> matrix are gone; the iOS bindings had no consumer left once the Expo app went. The ubrn patch
> **stays** — `packages/crypto/wasm` is still generated by that tool.
>
> **Step 6 is done as well.** `apps/mobile-tauri` is now `apps/mobile`: a directory move, the
> `package.json` name, the CI job names (`mobile`, `mobile-android`) and the references around
> them. `productName`, the Cargo crate name, the Android `applicationId` and the Kotlin package
> already read as the real app, so none of them changed. The `/debug` scaffold route went at the
> same time, with the `fs:allow-read-text-file` capability only it used.
>
> **D13 is closed.** What is left of the migration is not code: a physical device, an iOS build,
> and a release-signing job.

**Choice.** `apps/mobile` is not deleted, `apps/mobile-tauri` is not renamed, and none of the
React Native crypto scaffolding is removed. Everything else in the migration brief is done.

**Why.** The brief says the Expo app "stays in the tree and in CI until the new app works". The
new app works on an **arm64 emulator**. That is not the same claim.

Four things are unproven, and each is a reason on its own:

1. **No physical device, ever.** Every measurement, every screenshot and the whole autofill
   acceptance test ran on a `Pixel_9` AVD. The spike said the same thing about its own numbers
   and it is still true: an emulator answers "does it work", not "does it work on a phone".
2. **iOS has never been built.** `tauri ios init` succeeded and `gen/apple` is committed, but
   `pod install` and `xcodebuild` have never run. Whether the Xcode project compiles is unknown.
   Deleting the Expo app would leave the repo with no working iOS client at all.
3. **Biometric unlock has never succeeded.** It is the *primary* unlock affordance on a phone,
   and on this AVD `unlockAllWithBiometric` fails inside the storage biometry layer before any
   OS prompt appears. `MukEscrowManager` has therefore never run.
4. **Deleting `packages/crypto/react-native` would break the new app.** The credential
   provider's `NativeCrypto.kt` reaches the Rust core through the generated UniFFI Kotlin at
   `packages/crypto/react-native/android/src/main/java/uniffi/bittery_crypto_api/`, and the
   `.so` files come from `pnpm build:crypto-android`. The brief anticipates this — "do not
   delete the Kotlin UniFFI bindings or the Rust mobile targets, Tauri needs them" — but those
   bindings currently live *inside* the package the cleanup is supposed to remove. Untangling
   that is its own piece of work, not a deletion.

**Over.** Finishing the brief literally by deleting `apps/mobile` and renaming
`apps/mobile-tauri` to `apps/mobile`.

**The honest framing.** Deleting the only shipping mobile client is irreversible in practice and
is the one step here that cannot be undone by reading a diff. Everything else this run did is
additive. Stopping one step short leaves the decision with a person who can weigh a physical
device against a release calendar, and costs nothing but a rename.

**Revisit when** — the ordered plan, so this is a task and not a vibe:

1. Install the debug APK on a real Android phone. Sign in, unlock, autofill into Chrome, and
   confirm `secretBacking` finally reports `hardware-backed (TEE…)` rather than software.
2. Get biometric unlock working and exercise `MukEscrowManager`.
3. Build the iOS app and decide whether an iOS client without an autofill extension is
   shippable. The extension is explicitly out of scope for this migration.
4. **Move the UniFFI bindings.** Relocate the generated Kotlin and the `jniLibs` output under a
   path Tauri owns, and delete the cross-app `srcDir` reach in
   `apps/mobile-tauri/src-tauri/plugins/credential-provider/android/build.gradle.kts`. Keep it
   generated, never hand-copied (ADR 0012). This is the step that unblocks everything after it.
5. Then, and only then, the brief's cleanup list: `packages/crypto/react-native/`,
   `packages/crypto/port/src/adapters/react-native.ts` and its test, the
   `uniffi-bindgen-react-native@0.31.0-3` patch, the crypto mobile build scripts, the
   `turboModule:` block in `ubrn.config.yaml`, the `android`/`ios` legs of the CI
   `crypto-bindings` matrix, and finally `apps/mobile`.
6. Rename `apps/mobile-tauri` to `apps/mobile`. Its `productName`, Cargo crate name, Android
   `applicationId` (`com.bittery.mobile`) and the Kotlin package all already read as the real
   app rather than as a migration artifact, so this is a directory move and a `package.json`
   name.

**Also delete before any release**, independent of the above: the `/debug` route and its
`beforeLoad` reachability. It is migration scaffolding that exercises the storage ports and
prints `secretBacking` to the console. *(Done — deleted 2026-08-18.)*
