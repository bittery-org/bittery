# Process model of the credential-provider module

Baseline, recorded in Phase 0. Read this before you move MUK state.

## One process

All credential-provider code runs in the app process. No manifest declares
`android:process` for `BitteryCredentialProviderService`,
`BitteryAutofillService`, `GetCredentialsActivity` or `AutofillAuthActivity`.
This holds in three places:

- the module manifest, `android/src/main/AndroidManifest.xml`;
- the module's merged manifest,
  `android/build/intermediates/merged_manifest/debug/processDebugManifest/AndroidManifest.xml`;
- the packaged app manifest,
  `../../gen/android/app/build/intermediates/packaged_manifests/universalDebug/processUniversalDebugManifestForPackage/AndroidManifest.xml`.

The only matches for `android:process` in the tree are comments that say not to
add one.

## What that gives us

Live MUK state is process-local and shared. `NativeCredentialVaults` holds one
`NativeCredentialVault` for the process. The WebView bridge, the two services and
the two activities all ask that one instance, because they all live in the same
process. An unlock done in `AutofillAuthActivity` is visible to
`BitteryAutofillService` at once, with no IPC.

The share is one-way in practice. The Kotlin singleton does not hold the
TypeScript vault state, and the activities do not call the plugin, so nothing
tells the app that a native unlock happened.

## What escrow is for

`MukEscrowManager` is persistent, biometric-gated escrow. It exists so an
explicit unlock — the user taps "Unlock Bittery" in another app's field — can
unwrap the MUK without the master password. It is not the live state. It
outlives auto-lock on purpose: auto-lock drops the in-memory key, and the
keyboard bar still has to unwrap after that.

## If you add `android:process`

Do not, without a new design. A separate process gets its own vault, empty. It
also gets its own escrow and its own Room connection, so `SharedPreferences`
writes and database writes would race across processes. Crossing that line means a real cross-process protocol —
a bound service, a `ContentProvider`, or a broadcast — plus a decision about
where the authoritative unlock state lives.
