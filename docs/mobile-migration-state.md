# Mobile migration — state

One file, rewritten each checkpoint. Not a log.

**Last updated:** 2026-08-15, during the first migration run.
**Branch:** `t3code/tauri-mobile-spike-app`

---

## Where this stands

**M1 is complete and verified end to end on a device.**

The new app is `apps/mobile-tauri`. It builds a debug APK, installs on the `Pixel_9` AVD,
signs in against a real Bittery server with the real KDF, lists vaults and items, opens an
item, copies its password to the Android clipboard, locks, and unlocks again.

M2 (Android credential provider) and M3 (sync/lifecycle rewiring, remaining screens, CI,
release, Expo cleanup) are **not started**. The run had roughly three hours left when M1
closed — not enough to finish M2, and a half-built credential provider is worse than none.

`apps/mobile` (Expo) is untouched and still in the tree and in CI, as planned.

---

## What works, and how to run it

### Prerequisites

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$(ls -d "$HOME/Library/Android/sdk/ndk/"* | sort -V | tail -1)"
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
```

Rust Android targets: `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`.

The crypto WASM binary is **gitignored**. If
`packages/crypto/wasm/generated/wasm-bindgen/index_bg.wasm` is missing, run
`pnpm build:crypto-wasm` from the repo root first. CI must do the same before building
mobile.

### Build and install

```sh
cd apps/mobile-tauri
pnpm tauri android build --debug --target aarch64 --apk
"$ANDROID_HOME/platform-tools/adb" install -r \
  src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
"$ANDROID_HOME/platform-tools/adb" shell monkey -p com.bittery.mobile -c android.intent.category.LAUNCHER 1
```

Debug APK is about 60 MB. The emulator is `Pixel_9` (API 36, arm64, `google_apis_playstore`).

### Reaching a local server from the emulator

```sh
"$ANDROID_HOME/platform-tools/adb" reverse tcp:3000 tcp:3000
```

This does not survive an emulator restart. `CORS_ORIGIN` must contain
`http://tauri.localhost` — see decision D10.

### Debugging

The Android WebView logs `console` under the tag **`Tauri/Console`**, not `chromium`:

```sh
"$ANDROID_HOME/platform-tools/adb" logcat -d | grep -iE "Tauri/Console|AndroidRuntime|FATAL" | tail -60
```

There is a temporary storage self-test at the `/debug` route. It exercises the ports
directly — secret round-trip, both kv scopes, 500 records through SQLite, biometric probe —
and prints a JSON result to the console. **Delete it before release.**

### Verified on device, 2026-08-15

Against a live `pnpm dev:server` and an account created on `apps/web`:

| Step | Result |
| --- | --- |
| Sign in — email + Secret Key + master password, real PBKDF2 in a WASM worker | pass |
| Vault list, with item counts | pass |
| Item list for a vault | pass |
| Item detail renders website, username, masked password | pass |
| Copy password | pass — Android's clipboard preview showed the literal password, and `clipboard-bridge` logged `writeText via web-api` |
| Android back from detail returns to the list | pass |
| Lock navigates to `/unlock` | pass |
| Unlock with the master password returns to the vault | pass |

**Unlock takes roughly 1.3–1.7 s** end to end on the emulator, measured by screenshot
polling. That is the first real measurement of the production unlock path and it is
consistent with the spike's projection of ~350 ms for the KDF alone plus app work.

Storage ports were separately proven on device: an 8 KB multi-byte secret round-trip,
device vs session scope isolation, and 500 records through `recordPutMany` against real
SQLite.

---

## Known gaps

Ordered by how much they matter.

### 1. The `secret` tier is not hardware-backed — SECURITY

`vault_keys`, the wrapped master unlock key and `device_key` live in a plain
`secrets.json` store file, not the Android Keystore. **This is a regression against the
Expo app**, which used `expo-secure-store`. Full decision, rejected alternatives and the
recommended fix are in `docs/mobile-migration-decisions.md` **D4a** — read it before any
release. The seam is three functions in one adapter file, so the fix is cheap once someone
writes the Keystore command.

### 2. Idle auto-lock does not fire

`packages/core/src/services/autolock-mobile.ts` hooks Android background/foreground through
`globalThis.require("react-native")`, which does not exist in a Tauri WebView. It fails
silently into a `catch` and logs a warning. Manual Lock works; the timer does not.

The fix belongs in `packages/core` — give the service an injected app-state source instead
of reaching for React Native, and have `apps/mobile-tauri` pass a `visibilitychange` /
Tauri window-event implementation. It was left alone because it is shared code and would
need its own chunk plus a review.

### 3. Nothing has run on a physical device or on iOS

Everything above is an arm64 emulator. The iOS target is initialised (`gen/apple` is
committed and `tauri ios init` succeeded) but `pod install` and `xcodebuild` have never
run, so whether the Xcode project compiles is unknown.

### 4. `/debug` route still ships

Temporary migration scaffolding. Marked as such in the file. Delete before release.

### 5. Unexercised paths

Biometric unlock (`authenticate()` was deliberately never called — the emulator has
enrolled biometrics and the port reports available, but the unlock flow through it is
untested). Sync under real conditions. Error paths: wrong password, wrong Secret Key,
network loss. The `de` locale. Keyboard-avoidance when the IME covers a submit button.

### 6. Self-hosting server picker has no mobile UI

`src/lib/auth-server.ts` was ported whole, so the logic is intact, but the login screen
exposes no way to change the server URL. A self-hosted user cannot sign in on mobile yet.

### 7. Memoised loader rejections are permanent

If a Tauri plugin's dynamic `import()` fails once, the port's memoised loader caches the
rejection forever. `packages/storage/src/adapters/tauri.ts` has the same flaw, so this is
not new — but `react-native.ts` retries once, and both Tauri adapters should.

### 8. APK is about 60 MB

Debug build, unstripped Rust for one architecture. Not investigated. Before any size
work, delete `gen/android/app/build/outputs` and `.../intermediates` — AGP repacks APKs
incrementally and orphans old library bytes, which made a 30 MB APK measure 249 MB during
the spike.

---

## Landmines — read before touching the Android project

- **Never re-run `pnpm tauri android init`.** It rewrites `AndroidManifest.xml`,
  `app/build.gradle.kts` and `tauri.settings.gradle`, and resets the Kotlin version.
- **`gen/android/build.gradle.kts` must stay on Kotlin 2.1.20.** Tauri 2.11.5 writes
  1.9.25, which cannot read `androidx.credentials` 1.6.0-rc01's Kotlin 2.1 metadata. The
  transitive `kotlin-stdlib:2.1.20` then poisons the classpath down to `kotlin.Unit`. M2
  cannot build without this.
- **`gen/android/tauri.settings.gradle` is gitignored** because the CLI rewrites it with
  machine-local absolute paths on every build. It is also how a Tauri plugin's Gradle
  module gets included, so read it *after* a build, never before.
- **`sql:default` does not grant `execute`.** `sql:allow-execute` is listed separately in
  `capabilities/default.json`. A missing permission fails at runtime, not at build time.

---

## The exact next step

**Fix gap 1, the secret tier.** It is the only gap that blocks a release rather than
merely limiting the app.

Write a Tauri command in `apps/mobile-tauri/src-tauri` that stores and retrieves a string
through the Android Keystore **without** `setUserAuthenticationRequired`, mirroring what
`apps/desktop/src-tauri/src/keychain.rs` does with the `keyring` crate. Then point
`secretGet`/`secretSet`/`secretDelete` in
`packages/storage/src/adapters/tauri-mobile.ts` at it and update `secretBacking` to state
the new truth. The conformance suite already pins the contract, so the change is verified
the moment it compiles and the tests stay green.

After that, in order: gap 2 (auto-lock), then M2.

---

## Milestone status

| Milestone | Status |
| --- | --- |
| **M1 — the app works** | **Done, verified on device** |
| M2 — autofill: Android credential provider plugin, peripherals | Not started |
| M3 — sync/lifecycle rewiring, remaining screens, CI and release, Expo cleanup | Not started |

### What M2 needs, for whoever picks it up

The spike settled the hard part: a Tauri Android plugin **can** host a system
`CredentialProviderService`, its `<service>` reaches the APK through Gradle manifest
merging, and its `PendingIntent` activity launches and returns a credential.
`spikes/tauri-mobile/plugins/credential-provider/` is the working reference — copy its
shape.

27 of the 28 Kotlin files in `apps/mobile/modules/credential-provider/android/` have zero
Expo coupling and move essentially unchanged: the service, the activities, the Room
database, domain matching, MUK escrow, passkeys, test vectors. **Only
`CredentialProviderModule.kt` (915 lines) is rewritten**, as a `@TauriPlugin` with
`@Command` methods mirroring `src/CredentialProviderModule.ts`. Keep the Kotlin UniFFI
bindings — `crypto/NativeCrypto.kt` calls the Rust core directly and must keep doing so
(ADR 0001). Manifest wiring moves out of `app.plugin.js` and into the plugin module's own
`AndroidManifest.xml`.

Do **not** delete the Kotlin UniFFI bindings or the Rust mobile targets during M3 cleanup.
Tauri needs them.
