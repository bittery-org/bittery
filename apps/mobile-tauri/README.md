# mobile-tauri

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

`pnpm android:dev` runs `tauri android dev` against a running emulator or a USB-attached device.

**Three things to not get wrong:**

- **Never re-run `pnpm tauri android init`.** It rewrites `AndroidManifest.xml`,
  `app/build.gradle.kts`, and `tauri.settings.gradle`, and resets the Kotlin version bump below.
- **`gen/android/build.gradle.kts` must stay on Kotlin 2.1.20.** Tauri 2.11.5 generates 1.9.25,
  which cannot read the Kotlin 2.1 metadata that `androidx.credentials` (needed for the
  credential-provider plugin) ships. See the comment above the `classpath(...)` line in that file.
- **Before any size-sensitive build, delete `gen/android/app/build/outputs` and
  `gen/android/app/build/intermediates`.** AGP repacks APKs incrementally and orphans old library
  bytes otherwise — a 30 MB APK measured 249 MB in the spike that found this.

## iOS

`pnpm tauri ios init` has been run and `src-tauri/gen/apple` is committed so the project exists and
builds, per the M1 scope — shipping an iOS build is not required yet.

```sh
pnpm ios:dev   # tauri ios dev
```
