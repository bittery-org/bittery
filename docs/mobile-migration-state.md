# Mobile migration — state

One file, rewritten each checkpoint. Not a log.

**Last updated:** 2026-08-16, after M2.
**Branch:** `t3code/tauri-mobile-spike-app`

---

## Where this stands

**M1 and M2 are complete and verified on a device.**

The new app is `apps/mobile-tauri`. It signs in against a real Bittery server with the real KDF,
lists vaults and items, opens an item, copies its password, locks and unlocks. Secrets are held
in the Android Keystore. It is enabled as a system credential provider, and **Chrome has
autofilled a real password from it and completed a passkey ceremony against it.**

M3 is partly done: the sync and lifecycle rewiring landed as part of M2, and idle auto-lock is
fixed. What remains of M3 is the peripheral APIs, the remaining screens, CI and release, and the
Expo cleanup.

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

### 1. Browser password autofill may depend on a setting the official picker does not write

The one genuinely open question from M2. Chrome reaches password providers through the **Autofill
framework**, not Credential Manager, so `autofill_service` has to point at
`BitteryAutofillService`. The end-to-end test set that by hand. Nobody has confirmed what
Android's own "Additional providers" picker writes — if it writes
`com.android.credentialmanager/...CredentialAutofillService` instead, browser password autofill
would be dead in real use while passkeys kept working.

**Next step:** open `android.settings.CREDENTIAL_PROVIDER`, enable Bittery through the real UI,
and read `settings get secure autofill_service`. Fifteen minutes, and it decides whether autofill
ships.

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

### 6. No CI job

`ci.yml` still only tests the Expo module. Nothing builds, type-checks or lints
`apps/mobile-tauri` on a push, and no release job produces a signed APK.

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

**Settle gap 1.** Enable Bittery through Android's own credential-provider settings UI and read
back `settings get secure autofill_service`. It is fifteen minutes and it decides whether browser
password autofill works for a real user, which is the difference between M2 being done and M2
being demoed.

Then, in order: CI (gap 6), the remaining screens (gap 5), peripherals (gap 7), and finally the
Expo cleanup and the rename of `apps/mobile-tauri` to `apps/mobile`.

**Do not delete** the Kotlin UniFFI bindings or the Rust mobile targets during that cleanup.
Tauri needs them.

---

## Milestone status

| Milestone | Status |
| --- | --- |
| **M1 — the app works** | **Done, verified on device** |
| **M2 — autofill** | **Done, verified on device.** Password fill and passkey create/get both proven with Chrome as an external caller. Peripherals beyond clipboard are not ported. |
| M3 — the rest | Partly done. Sync, lifecycle and auto-lock rewiring landed in M2. Remaining: screens, peripherals, CI and release, Expo cleanup, rename. |
