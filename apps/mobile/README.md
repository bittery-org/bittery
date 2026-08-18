# mobile

Tauri 2 + Vite + React 19 + TanStack Router shell for Bittery mobile. M1-C1 built the desktop-target
app skeleton. M1-C2 added the Android target, a committed `src-tauri/gen/android` Gradle project,
and a proven debug APK. No crypto, storage, API, sync, or i18n wiring yet — those land in later
chunks.

- App identifier is `com.bittery.mobile`, deliberately different from the Expo app's
  `io.bittery.app` so both can be installed side by side during the migration.
- Vite serves on port 3040 (desktop owns 3002).
- `src-tauri/tauri.conf.json` sets `security.csp` to `null`. JSON has no comments, so the reason
  lives here: a real CSP will need `wasm-unsafe-eval` for the crypto worker once that lands, and
  turning CSP on before then would just break the app for no benefit.

## Android

Every Tauri Android command needs this environment:

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$(ls -d "$HOME/Library/Android/sdk/ndk/"* | sort -V | tail -1)"
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
```

and the Rust Android targets:

```sh
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

Build a debug APK:

```sh
pnpm android:build   # tauri android build --debug --target aarch64 --apk
```

Output lands at `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`.
Install and launch it on the `Pixel_9` AVD (API 36, arm64, `google_apis_playstore` — the only AVD on
this machine set up for the mobile work):

```sh
"$ANDROID_HOME/emulator/emulator" -avd Pixel_9 -no-snapshot-save &
"$ANDROID_HOME/platform-tools/adb" wait-for-device
"$ANDROID_HOME/platform-tools/adb" install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
"$ANDROID_HOME/platform-tools/adb" shell monkey -p com.bittery.mobile -c android.intent.category.LAUNCHER 1
```

`pnpm dev` (alias `pnpm android:dev`) runs `tauri android dev` against a running emulator or a
USB-attached device. It is also what the workspace's `pnpm dev:all` and `pnpm dev:mobile` start —
plain `pnpm dev` at the root leaves the phone app out. For UI-only work without a handset,
`pnpm dev:desktop` runs the same frontend in a desktop Tauri window.

**Four things to not get wrong:**

- **Never re-run `pnpm tauri android init`.** It rewrites `AndroidManifest.xml`,
  `app/build.gradle.kts`, and `tauri.settings.gradle`, and resets the Kotlin version bump below.
- **`AndroidManifest.xml` must keep `android:allowBackup="false"`.** It is hand-added, and
  `android init` drops it. Without it `shared_prefs/bittery_keystore_secrets.xml` — the secret
  tier's ciphertext — goes to Google cloud backup. The bytes are useless without the Keystore
  key, which never leaves the device, so the visible symptom on a restored device is a silent
  sign-out; the reason to keep it is that a password manager's data does not belong in a cloud
  backup at all.
- **`gen/android/build.gradle.kts` must stay on Kotlin 2.1.20.** Tauri 2.11.5 generates 1.9.25,
  which cannot read the Kotlin 2.1 metadata that `androidx.credentials` (needed for the
  credential-provider plugin) ships. See the comment above the `classpath(...)` line in that file.
- **Before any size-sensitive build, delete `gen/android/app/build/outputs` and
  `gen/android/app/build/intermediates`.** AGP repacks APKs incrementally and orphans old library
  bytes otherwise — a 30 MB APK measured 249 MB in the spike that found this.

**`AndroidManifest.xml` gets a real diff on every build, and that's expected.** `tauri-plugin-deep-link`'s
`build.rs` rewrites the `<activity>` block on every `cargo build`/`tauri android build` (not just
`android init`) to keep the `bittery://` `<intent-filter>` in sync with `tauri.conf.json`'s
`plugins.deep-link.mobile` config, wrapped in `<!-- DEEP LINK PLUGIN. AUTO-GENERATED. DO NOT REMOVE. -->`
markers. It is idempotent and leaves `android:allowBackup="false"` and everything else alone — this is
the same "config in `tauri.conf.json`, generated file in `gen/android` survives without `android init`"
pattern as the Kotlin version pin above, just plugin-driven instead of hand-driven. The `bittery`
scheme's `CAMERA`/`VIBRATE` permissions for `tauri-plugin-barcode-scanner` need no such generation at
all: they come from that plugin's own Gradle module manifest via ordinary manifest merging, the same
way the credential-provider plugin's `<service>` entries do — nothing to hand-patch there either.
Verified by dumping the built APK's merged manifest (`aapt dump xmltree`/`aapt dump permissions`)
rather than trusting either plugin's docs.

## iOS

`pnpm tauri ios init` has been run and `src-tauri/gen/apple` is committed so the project exists and
builds, per the M1 scope — shipping an iOS build is not required yet.

```sh
pnpm ios:dev   # tauri ios dev
```
