# Desktop production ownership inventory

Inspected: 2026-09-08. This is baseline source evidence, not application acceptance. Native placement
was subsequently accepted in ticket 61, conditional on no duplicated code. Historical Web and binding tickets do not establish
Desktop integration.

## Ownership actually present

[Desktop package dependencies](../../../apps/desktop/package.json) contain no
`@bittery/client-runtime`; [Desktop Cargo dependencies](../../../apps/desktop/src-tauri/Cargo.toml)
contain no `bittery-client-core` or Runtime bindings dependency.

- [Account context](../../../apps/desktop/src/contexts/account-context.tsx) constructs
  `@bittery/core/services/client-runtime`, the transitional TypeScript owner. It owns Account
  selection, lock broadcasts and the Account session manager, and starts/disposes that object from
  React.
- [Vault composition](../../../apps/desktop/src/lib/vault-runtime.ts) constructs the transitional
  `VaultCrypto` and `vaultRepository` over [storage](../../../apps/desktop/src/lib/storage.ts).
  Storage is `AccountStore` plus `ItemCache`, using the Tauri keychain/store adapters. Records are
  `store.json` records, not the Runtime SQLite Replica.
- [Crypto composition](../../../apps/desktop/src/lib/crypto.ts) creates a standalone crypto WASM
  Worker. No Rust Runtime shares it.
- [Sync hook](../../../apps/desktop/src/hooks/use-desktop-sync.ts) owns `createAccountSync`,
  `AccountSyncLifecycle`, `TauriSyncStorage`, five-minute Session revalidation, and `useSync`'s
  outbound command handling. [API composition](../../../apps/desktop/src/lib/providers.tsx) owns
  Session refresh and unauthorized Session invalidation separately.
- [Native application](../../../apps/desktop/src-tauri/src/lib.rs) reads the published
  `NativeHostView`, independently unwraps persisted MUK in `load_muk_base64`, decrypts Vault keys
  in `load_decrypted_vault_keys`, and decrypts ItemCache records in `get_items_snapshot_internal`.
  These are production native messaging paths, not test helpers.

Web differs materially: [Web composition](../../../apps/web/src/lib/crypto.ts) constructs the
combined Worker and typed Runtime client, [its Worker](../../../apps/web/src/lib/runtime.worker.ts)
serves the shared Rust Runtime, and Item projection mapping (subsequently moved into
[shared presentation](../../../packages/ui/src/runtime-presentation/items.ts) by ticket80) is an
application adapter over Runtime observations. Desktop cannot be marked migrated by sharing
the old `ClientRuntime` class name or the crypto primitive implementation with Web.

## Production feature paths

“Not found” below means no production Desktop route/component caller was found in the inspected
`apps/desktop/src` tree. It does not remove that feature from another application or authorize
silently dropping a discovered caller during implementation.

| Product path | Actual Desktop caller and current owner | Required migration or scope evidence |
| --- | --- | --- |
| Full Sign-in, add Account, server selection | [login route](../../../apps/desktop/src/routes/login.tsx), [add Account dialog](../../../apps/desktop/src/components/add-account-dialog.tsx), shared `useLogin`, AccountStore | Runtime SignIn; preserve per-Account Server URL and explicit insecure-transport confirmation. |
| Restart, password Quick unlock, unlock all | [unlock route](../../../apps/desktop/src/routes/unlock.tsx), shared `useQuickUnlockAll`; login guards read `storage.isSessionValid` | Runtime catalog/projections and QuickUnlock; restart must retain encrypted local work and require appropriate unlock. |
| Biometric unlock and re-entry period | Unlock route calls `getBiometricUnlockAvailability` and `unlockAllWithBiometric`; [security settings](../../../apps/desktop/src/components/settings/settings-security-panel.tsx) and AccountStore retain preferences | Missing Runtime biometric request/capability; local retained MUK must not become a login credential or fresh Server Session. Preserve single-prompt multi-Account behavior. |
| Lock, lock all, inactivity, native lock events | Account context, [autolock service](../../../apps/desktop/src/services/autolock-service.ts), storage unlock broadcast | Runtime owns key retirement and lock policy; host supplies OS/window/idle observations and delivers projections. |
| Account selection and multi-Account reads | [Account switcher](../../../apps/desktop/src/components/account-switcher.tsx), shared hooks and VaultRuntime | Active Account stays UI state; typed requests retain actual Account IDs and account-specific failure/isolation. |
| Login, Secure Note, Credit Card, Identity, Authenticator | [Vault route](../../../apps/desktop/src/routes/vault/route.tsx) uses shared `CreateItemSheet` and `useCreateItem`; [Item detail](../../../apps/desktop/src/components/vault/item-detail-page.tsx) uses category renderers, `EditItemSheet`, `useUpdateItem` | All five drafts are supported by Core; migrate complete create/read/update paths and all category fields. |
| Tags, favorites, search, counts, password history, TOTP, passkey removal | Item detail, [search](../../../apps/desktop/src/components/vault/search-combobox.tsx), Vault route, favorites/tag routes | Derive views from Runtime projections; favorite and content changes are Runtime Operations. Preserve password-history restore and passkey removal as Item updates. |
| Trash, restore, permanent deletion | [trash route](../../../apps/desktop/src/routes/vault/trash.tsx), Item detail | Use Runtime durable Item commands; verify offline and restart behavior. |
| Item Move, drag/drop | [Move dialog](../../../apps/desktop/src/components/vault/move-item-dialog.tsx), [DnD provider](../../../apps/desktop/src/providers/dnd-provider.tsx) | Same-Account Runtime Move plus the missing [cross-Account workflow](../issues/83-runtime-cross-account-item-move.md), including existing Attachment behavior and both Accounts' permissions/lifetimes. |
| Vault metadata and deletion | Vault route uses `useAllVaultKeys`, `useUpdateVault`, `useDeleteVault`, shared EditVaultDialog | Core currently has CreateVault but no UpdateVault/DeleteVault request; extend Runtime and Server semantic outcomes. |
| Vault creation, personal/shared conversion and membership administration | No Desktop production UI caller found; shared hooks/components and Web contain broader product paths | Explicitly record application availability; do not infer that shared library existence makes a Desktop route. Runtime extension still needed for any discovered conversion/administration owner. |
| Attachment list/upload/download/rename/delete | Item detail uses `useItemAttachments` and shared ItemAttachments UI | Core commands exist; native binary source/sink, durable artifact storage, cancellation and lifecycle adapters still need production composition and acceptance. |
| Share history, revoke, access logs | Item detail uses `apiQueries.shares.list`, direct `api.share.remove` and `api.share.accessLogs` | Core has closed list/revoke/log commands; replace direct host transport. No Desktop CreateShare caller found. |
| Import / Item export | No Desktop production caller found | Web has actual migrated Import/export paths. Record the absence explicitly; preserve Runtime Import/category/artifact behavior and add no competing native importer. |
| Travel mode | [travel settings](../../../apps/desktop/src/components/travel-mode-settings.tsx) calls shared `useTravelMode` and Account-specific Vault list | Missing closed Runtime management commands. Preserve password-authenticated disable, actual hidden-Vault key/data erasure and Sync propagation. |
| Remove Account, device reset/Wipe | Account context, remove dialog, [macOS reset menu](../../../apps/desktop/src/lib/macos-reset-menu.ts) and transitional lifecycle | Core removal/Wipe exist; native artifact and OS-keychain cleanup must be complete before success. |
| Account credential changes, Server account deletion, recovery-key flow | No Desktop production settings/recovery route found | Distinguish Web product availability from Desktop. Core Server deletion exists; password/email/Secret Key and recovery ceremonies are broader missing Runtime capabilities when those callers migrate. |
| Setup another device | [device setup dialog](../../../apps/desktop/src/components/device-setup-dialog.tsx) directly reads stored Secret Key and Server URL for QR/copy | Needs an explicit, scoped Runtime presentation capability; avoid exposing the general credential storage port to renderer. |
| Local cache clearing / Replica recovery | [advanced settings](../../../apps/desktop/src/components/settings/settings-advanced-panel.tsx) clears outbound queue, every Account ItemCache, Sync state and repository, then retries | Blind clear conflicts with accepted durable Operations. Resolve gesture to guarded Runtime re-Bootstrap preserving accepted work; expose recovery/export when repair is required. This is a recorded behavior decision, not a mechanical API rename. |
| Native messaging | [native host binary](../../../apps/desktop/src-tauri/src/native_host.rs), native application request handlers, [generated IPC](../../../apps/desktop/src/generated/desktop-ipc.ts) | Preserve authenticated local IPC and reachable Desktop lock authority. Runtime supplies snapshots/account projections; host must stop reconstructing keys/Replica from legacy storage. |

## Placement and key ownership frontier

[ADR 0010](../../../docs/adr/0010-desktop-renderer-crypto-runs-in-a-wasm-worker.md) deliberately moved
ordinary renderer crypto into a WASM Worker, retaining narrow native snapshot decryption because
the old native protocol needed it. [ADR 0004](../../../docs/adr/0004-reachable-desktop-app-owns-lock-state.md)
requires connected Extension lock state to follow Desktop. [ADR 0015](../../../docs/adr/0015-keep-biometric-unlock-local.md)
prohibits replacing local biometric unlock with persisted SRP/auth credentials.

Accepted decision ([ticket 61](../issues/61-desktop-runtime-placement.md)): one native Rust Runtime in the Tauri application
process, using Rust SQLite and native capability executors. The renderer carries closed typed
requests/projections, not key handles or primitive crypto commands. The native messaging host
remains a transport to that owner. Native snapshots come from Runtime observations; it no longer
decrypts a second cache or reconstructs MUK from storage. Amend ADR 0010 explicitly because its
placement and exception cease to describe production, while preserving its aim of keeping ordinary
key material off renderer JavaScript and avoiding a second primitive crypto binding.

The real alternative is retaining one combined Worker and delivering native snapshot requests
back into it. That preserves renderer Worker placement but requires a reliable native-to-renderer
request relay, changes renderer loss into Runtime loss, and does not directly realize the map's
native Rust SQLite/key-ownership direction. It cannot leave the old native snapshot decryptor as
a permanent second owner.

Biometric approval must be an OS capability used by Runtime to reopen the existing Device-bound
wrapping. The Runtime must distinguish local unlock from usable Server Session state, enforce
re-entry/preference checks, and retire live keys on Lock. Never derive a new durable login secret.

## Native capability gaps

[Native binding constructor](../../../packages/client-runtime/crates/bittery-client-bindings/src/lib.rs)
currently documents itself as headless: no configured Server identity, transport, Device storage
or running Operation dispatcher. [Core Runtime](../../../packages/client-runtime/crates/bittery-client-core/src/runtime.rs)
has configured serialized-executor constructors, but those are not a complete production native
composition. Native Kotlin/Swift generated bindings compiling proves neither linked Desktop
behavior nor native capabilities.

Before host cutover, provide real SQLite Replica persistence; Account/device storage backed by the
existing keychain and durable records; native HTTP/SSE with Runtime scheduling; attachment, image,
Import and recovery file capabilities; Runtime biometric retained-material support; native messaging
projection access; and renderer transport/reattachment. Missing commands are visible in the closed
[RuntimeRequest enum](../../../packages/client-runtime/crates/bittery-client-core/src/protocol.rs),
including biometric, Vault update/delete/conversion, travel management and scoped device setup.

## Acceptance environment and gates

The local inspected host is Linux. `Xvfb` exists; `tauri-driver` and `WebKitWebDriver` were not on
PATH, and neither `DISPLAY` nor `WAYLAND_DISPLAY` was set. No Desktop WebDriver acceptance harness
was found in package scripts. These are current tooling gaps, not proof a Linux application cannot
be tested after provisioning tooling. No real Desktop application was launched during this audit.

[Build platform selection](../../../apps/desktop/scripts/build-platform.mjs) supports Linux, macOS
and Windows. The [README](../../../apps/desktop/README.md) advertises macOS and Windows and has
stale storage-path claims; it is not independent support or biometric acceptance evidence. This
Linux environment cannot establish real Touch ID, Windows Hello, Keychain/Credential Manager or
the respective platform native messaging installer behavior.

Required real-host evidence remains: Sign-in; process restart; renderer reconnect; lock/password
and biometric unlock; offline reads and durable writes; reconnect convergence; multi-Account
isolation; account teardown; attachment/file capabilities; travel erasure; and an actual browser
Extension/native host/Desktop connection with locked Desktop refusal and unlock/lock propagation.
Existing unit tests, native IPC tests, bundled host tests and Rust compilation are useful targeted
checks and must remain labeled as such. Full `pnpm check:ci` and `pnpm check:ci:rust` remain required
at phase completion, alongside real application acceptance.
