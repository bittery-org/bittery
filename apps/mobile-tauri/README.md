# mobile-tauri

Tauri 2 + Vite + React 19 + TanStack Router shell for Bittery mobile. This chunk (M1-C1) is the
desktop-target app skeleton only — no Android/iOS targets, no crypto, storage, API, sync, or i18n
wiring. Those land in later chunks.

- App identifier is `com.bittery.mobile`, deliberately different from the Expo app's
  `io.bittery.app` so both can be installed side by side during the migration.
- Vite serves on port 3040 (desktop owns 3002).
- `src-tauri/tauri.conf.json` sets `security.csp` to `null`. JSON has no comments, so the reason
  lives here: a real CSP will need `wasm-unsafe-eval` for the crypto worker once that lands, and
  turning CSP on before then would just break the app for no benefit.
- Once `pnpm tauri android init` has been run and `src-tauri/gen/android` is committed (next
  chunk), do **not** re-run it. It rewrites `AndroidManifest.xml`, `app/build.gradle.kts`, and
  `tauri.settings.gradle`, and resets the Kotlin version.
