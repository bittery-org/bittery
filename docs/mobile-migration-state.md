# Mobile migration — state

One file, rewritten each checkpoint. Not a log.

**Last updated:** 2026-08-16, after M3-C1 (autofill settled, CI landed).
**Branch:** `t3code/tauri-mobile-spike-app`

---

## Where this stands

**M1 and M2 are complete and verified on a device.**

The new app is `apps/mobile-tauri`. It signs in against a real Bittery server with the real KDF,
lists vaults and items, opens an item, copies its password, locks and unlocks. Secrets are held
in the Android Keystore. It is enabled as a system credential provider, and **Chrome has
autofilled a real password from it and completed a passkey ceremony against it.**

M3 is partly done: the sync and lifecycle rewiring landed as part of M2, idle auto-lock is fixed,
and `apps/mobile-tauri` now type-checks, lints and builds in CI on every push, with a gated
Android build for changes that can plausibly break it. What remains of M3 is the peripheral APIs,
the remaining screens, release signing, and the Expo cleanup.

`apps/mobile` (Expo) is untouched and still in the tree and in CI.

---

## What works, and how to run it

### Prerequisites

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$(ls -d "$HOME/Library/Android/sdk/ndk/"* | sort -V | tail -1)"
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
```

Rust Android targets: `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`.

**Two generated artefacts are gitignored and must exist before a build:**

| Missing | Symptom | Fix |
| --- | --- | --- |
| `packages/crypto/wasm/generated/wasm-bindgen/index_bg.wasm` | `vite build` cannot resolve the asset | `pnpm build:crypto-wasm` |
| `packages/crypto/react-native/android/src/main/jniLibs/` | builds fine, then `NativeCrypto.isAvailable` is false and autofill silently decrypts nothing | `pnpm build:crypto-android` |

The second one is the trap: it fails at runtime, not at build time. CI must run both.

### Build and install

```sh
cd apps/mobile-tauri
pnpm tauri android build --debug --target aarch64 --apk
"$ANDROID_HOME/platform-tools/adb" install -r \
  src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

Debug APK is about 60 MB. The emulator is `Pixel_9` (API 36, arm64, `google_apis_playstore`).

### Reaching a local server from the emulator

```sh
"$ANDROID_HOME/platform-tools/adb" reverse tcp:3000 tcp:3000
```

Does not survive an emulator restart. `CORS_ORIGIN` must contain `http://tauri.localhost` — the
server change for that is committed; see D10 in the decisions file.

### Debugging

The Android WebView logs `console` under the tag **`Tauri/Console`**, not `chromium`. Kotlin logs
under `CredentialProviderPlugin`, `VaultStateManager`, `BitteryAutofill`, `BitteryCredProvider`.

There is a temporary self-test at the `/debug` route that runs on mount and prints a JSON report:
storage ports, the Keystore probe, and the credential provider's read-only surface. **Delete it
before release.** Reaching it over adb needs the WebView devtools socket — `adb forward` to
`localabstract:...devtools_remote`, then a CDP `Runtime.evaluate` setting `location.href`.

Set `VITE_CREDENTIAL_SYNC_DEBUG=true` at build time for the sync layer's own logging.

### Verified on device

**M1, against a live server and an account created on `apps/web`:** sign in with the real
PBKDF2 in a WASM worker, vault list, item list, item detail, copy password (Android's clipboard
preview showed the literal password), Android back, lock, unlock. **Unlock takes roughly
1.3–1.7 s** end to end on the emulator — the first real measurement of the production unlock
path, consistent with the spike's ~350 ms KDF projection plus app work.

**Storage ports:** an 8 KB multi-byte secret round-trip, device vs session scope isolation, 500
records through `recordPutMany` against real SQLite, and secrets landing in the Keystore prefs as
`v1:<iv>:<ct>` rather than in `secrets.json`.

**M2 autofill, the acceptance test:**

| Step | Evidence |
| --- | --- |
| Enabled as system credential provider | `is_supported` → `enabled: true`, via the platform's own `isEnabledCredentialProviderService` |
| MUK reaches the provider on unlock | `isVaultUnlocked` → `true`; `SET MUK ... mukSize=32` |
| Vault data syncs into Room | `{vaultKeys: 2, items: 1, domains: 1}`, confirmed by pulling `bittery_credentials.db` and querying it |
| Chrome offered a Bittery entry | Keyboard suggestion strip rendered `m1smoke-user / M1 Smoke Logi…` |
| **Password actually filled** | Read back out of the live DOM over CDP: `M1ItemPass!82cfce27` — the item's real password, byte for byte |
| Passkey created | System sheet "Save passkey to Bittery"; `navigator.credentials.create()` resolved with a real credential id |
| Passkey used | System sheet listed the Bittery entry; `navigator.credentials.get()` resolved and **Chrome accepted the assertion Bittery signed** |
| Rust crypto ran in the provider path | `NativeCrypto.passkeyGenerateKeypair` / `passkeySignAssertion` through UniFFI, JNA loaded, no `UnsatisfiedLinkError` |
| Lock clears the MUK | `CLEAR ALL MUKs`, `IN-MEMORY MUK CACHE EMPTY` |

The spike's failure table has a row for every way this can break. **We landed in none of them.**

---

## Known gaps

Ordered by how much they matter.

### 1. ~~Browser password autofill may depend on a setting the official picker does not write~~ — settled, it works

**Resolved.** On the `Pixel_9` AVD (API 36), the real picker is **Settings → Security & privacy →
Passwords, passkeys & accounts → "Preferred service" → Change**, titled *"Preferred service for
passwords, passkeys & autofill"* — reached in-app via `android.settings.SYNC_SETTINGS` or by
searching Settings for "passwords". (`android.settings.CREDENTIAL_PROVIDER` does not resolve on
this image — `Activity not started, unable to resolve Intent`. `android.settings.MANAGE_DEFAULT_APPS_SETTINGS`
has no autofill entry either; autofill selection is unified into this one credential-provider
screen on API 34+.)

Selecting **Bittery** there (`adb shell settings get secure credential_service` confirmed it was
`com.bittery.mobile/...BitteryCredentialProviderService`) and tapping "Change" on the confirmation
dialog set **all three** secure settings to Bittery in one step, with no separate autofill toggle
needed:

```
credential_service:         com.bittery.mobile/com.bittery.mobile.credentialprovider.service.BitteryCredentialProviderService
credential_service_primary: com.bittery.mobile/com.bittery.mobile.credentialprovider.service.BitteryCredentialProviderService
autofill_service:           com.bittery.mobile/com.bittery.mobile.credentialprovider.service.BitteryAutofillService
```

`autofill_service` points straight at `BitteryAutofillService` — not at
`com.android.credentialmanager/...CredentialAutofillService`. The earlier manual-`adb`-only
concern does not hold on this Android version: picking Bittery as the one "preferred service" is
sufficient, and it also flips `autofill_service`.

Verified empirically, not just by reading settings back: with a login form injected into Chrome at
`https://example.com` over CDP and the username field given a real touch focus (a JS `.focus()`
call alone does **not** trigger Android's autofill focus path — a real `input tap` is required), a
Chrome autofill dropdown appeared showing **"Unlock Bittery"**. Logcat confirms the framework
routed the request to the app: `BitteryAutofill: onFillRequest called`, `✓ Password field detected
by type=password`, `Field detection: username=true, password=true`,
`Autofill domain: example.com`. It offered "Unlock" rather than filling directly because the vault
key had expired from idle (`CLEAR MUK ... reason=expired`) — correct behavior, not a bug in this
path.

**One real finding from this pass, worth a follow-up:** the picker listed **three** entries
labeled "Bittery" or close to it — `com.bittery.mobile` ("Bittery"), `com.bittery.spike` ("Bittery
spike", from `spikes/`, credential-provider only, no autofill service), and a third, unrelated
`io.bittery.app` (an Expo-based prototype, also registers both an autofill and a credential-provider
service, also just labeled "Bittery"). Two entries sharing the exact label "Bittery" with different
icons is a real user-facing ambiguity once `apps/mobile` (Expo) and `spikes/` stop shipping
side-by-side debug builds with the production app — worth cleaning up before release, not before
M3.

### 2. `secretBacking` has only ever reported software backing

The Keystore plugin reports the observed `KeyInfo` security level rather than an assumed one,
which is right — but the only device it has run on is an emulator with a software keymaster.
Nobody has seen it print `hardware-backed (TEE)`. StrongBox is deliberately never requested.

### 3. No physical device, and iOS is unbuilt

Everything is an arm64 emulator. The iOS target is initialised and `gen/apple` is committed, but
`pod install` and `xcodebuild` have never run. The credential provider answers "unsupported" on
iOS by construction; the iOS autofill extension is explicitly out of scope.

### 4. Untested paths in the credential provider

`BeginGetPasswordOption` from an external CredMan caller (Chrome never sends it — see gap 1).
Biometric escrow: `MukEscrowManager` has never run, because the AVD has no escrow and
`unlockAllWithBiometric` fails inside the storage biometry layer before any prompt appears.
The passkey writeback loop's non-empty path. Multi-account.

### 5. Missing screens

Trash, favorites, all-items, tags, search, settings, and item create/edit/delete/move. M1
scoped to browse-and-copy deliberately. Everything needed is already in `@bittery/ui` and
`@bittery/core/hooks`, so these are shell work, not plumbing.

### 6. ~~No CI job~~ — settled, `apps/mobile-tauri` is in `ci.yml`; the release job is not

**Resolved (frontend).** `ci.yml` has a `mobile-tauri` job — install, `pnpm build:crypto-wasm`
(the `crypto-bindings` artifact, reused like `js-types`), `pnpm exec turbo -F mobile-tauri
check-types` (covers `lint:promises` too), `pnpm --filter mobile-tauri exec vite build`, `pnpm
exec biome check apps/mobile-tauri`. Runs on every push and PR. Each step was run locally against
this repo and passes.

**Resolved (Android build, gated).** A second job, `mobile-tauri-android`, runs the full `pnpm
tauri android build --debug --target aarch64 --apk` — Android SDK/NDK (preinstalled on
`ubuntu-latest`), JDK 17, four Rust Android targets, `pnpm build:crypto-android`, Gradle — but
only when `apps/mobile-tauri/**` or `packages/crypto/**` changed, plus on the weekly schedule,
`workflow_dispatch`, and `release/v*` PRs. See D11 in `docs/mobile-migration-decisions.md` for the
alternatives considered and what this trades away (an Android break introduced by something
*outside* those paths — a Tauri CLI or Gradle/AGP bump — is only caught by the weekly cron, not
the next PR). **Not run against a real GitHub Actions runner** — no way to do that from this
environment; verified only by local YAML parsing and by running each frontend step for real.

**Still open: no release job produces a signed APK**, and none was added — Android signing needs
a keystore and secrets that do not exist yet, so a real signing/release workflow would be
guesswork. What it would need, concretely, so the next person does not have to rediscover this:

1. **A keystore.** `keytool -genkeypair -v -keystore bittery-release.keystore -alias bittery
   -keyalg RSA -keysize 2048 -validity 10000` (or reuse an existing organizational key if one
   exists outside this repo). This is a one-way door — losing it means every future release is a
   new app identity to the Play Store — so it should be generated once, offline, and never
   regenerated by CI.
2. **Gradle signing config**, in `apps/mobile-tauri/src-tauri/gen/android/app/build.gradle.kts` —
   a `signingConfigs { release { ... } }` block reading the keystore path, alias and both
   passwords from Gradle properties (`gradle.properties` or environment), wired into
   `buildTypes.release.signingConfig`. `gen/android` is committed (D8), so this file is
   hand-maintained like the Kotlin version pin already is, and needs the same "`tauri android
   init` will undo this" landmine note.
3. **GitHub secrets**, base64-encoded where binary: `ANDROID_KEYSTORE_BASE64`,
   `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. A release job would
   decode the keystore into `$RUNNER_TEMP`, export the three secrets as the Gradle properties the
   signing config reads, run `pnpm tauri android build --target aarch64 --apk` (release, not
   `--debug`), then delete the decoded keystore file before the job ends regardless of outcome.
   Exactly the "guard so a missing secret cannot fail the whole workflow" rule already recorded
   for `mobile-tauri-android` in D11 applies here too, more so — the whole job should no-op with a
   clear message if any of the four secrets is unset, not fail red on every push before anyone
   has decided to cut a release.

### 7. Peripherals not ported

QR scan (`tauri-plugin-barcode-scanner`), share, file picking, deep links, notifications.
Clipboard is done. `opener`/`dialog`/`fs` are partial on mobile — verify each rather than
trusting the support table.

### 8. Self-hosting server picker has no mobile UI

`src/lib/auth-server.ts` was ported whole so the logic is intact, but the login screen exposes no
way to change the server URL. A self-hosted user cannot sign in on mobile.

### 9. `/debug` route still ships

Temporary migration scaffolding, marked as such. Delete before release.

### 10. Smaller things

`noMisusedPromises` is enforced only for `apps/mobile-tauri`, because six pre-existing violations
elsewhere block enabling it repo-wide (`apps/extension` ×2, `apps/mobile`, `packages/core` ×2,
`packages/storage`). A memoised loader rejection in the storage adapters is permanent — shared
with `tauri.ts`, so not new. `Wrapped<T>` in the credential-provider Rust derives `Debug` and
`get_master_unlock_key_base64` returns the MUK inside it; no formatter reaches it today.

---

## Landmines — read before touching the Android project

- **Never re-run `pnpm tauri android init`.** It rewrites `AndroidManifest.xml`,
  `app/build.gradle.kts` and `tauri.settings.gradle`, resets Kotlin to 1.9.25, and drops the
  hand-set `android:allowBackup="false"`.
- **`gen/android/build.gradle.kts` must stay on Kotlin 2.1.20.** Tauri 2.11.5 writes 1.9.25,
  which cannot read `androidx.credentials` 1.6.0-rc01's Kotlin 2.1 metadata; the transitive
  `kotlin-stdlib:2.1.20` then poisons the classpath down to `kotlin.Unit`.
- **`gen/android/tauri.settings.gradle` is gitignored** — the CLI rewrites it with machine-local
  absolute paths every build, and that rewrite is also how a plugin's Gradle module gets
  included. Read it *after* a build, never before.
- **`sql:default` does not grant `execute`.** `sql:allow-execute` is listed separately. A missing
  permission fails at runtime, not at build time.
- **The UniFFI bindings are reached by an extra `srcDir`, not copied.** It points at the `uniffi`
  directory alone — its parent also holds `CryptoReactNativeModule.kt`, which would drag React
  Native onto the classpath.
- Before any size-sensitive build, delete `gen/android/app/build/outputs` and
  `.../intermediates`. AGP repacks APKs incrementally and orphans old library bytes; a 30 MB APK
  measured 249 MB during the spike.

---

## The exact next step

Gaps 1 and 6 are settled. Next, in order: the remaining screens (gap 5), peripherals (gap 7), the
self-hosting server picker (gap 8), then the release job described in gap 6 (needs a keystore and
secrets that do not exist yet — not blocking, but real work), and finally the Expo cleanup and the
rename of `apps/mobile-tauri` to `apps/mobile`.

**Do not delete** the Kotlin UniFFI bindings or the Rust mobile targets during that cleanup.
Tauri needs them.

---

## Milestone status

| Milestone | Status |
| --- | --- |
| **M1 — the app works** | **Done, verified on device** |
| **M2 — autofill** | **Done, verified on device — including the real settings UI, not just the manual `adb` path.** Password fill and passkey create/get both proven with Chrome as an external caller. Peripherals beyond clipboard are not ported. |
| M3 — the rest | Partly done. Sync, lifecycle and auto-lock rewiring landed in M2. CI (type-check/lint/build, gated Android build) landed in this pass. Remaining: screens, peripherals, release signing, Expo cleanup, rename. |
