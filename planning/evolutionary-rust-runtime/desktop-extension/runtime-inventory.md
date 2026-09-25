# Shared Runtime capability and caller inventory

Inspected: 2026-09-08. This is source inspection, not production acceptance. Historical Web
ticket completion does not establish Desktop or Extension integration. References below describe
the inspected baseline; delivery tickets must record changed ownership and actual acceptance evidence.

## Existing shared Runtime

The closed [Core request protocol](../../../packages/client-runtime/crates/bittery-client-core/src/protocol.rs)
and [Runtime dispatcher](../../../packages/client-runtime/crates/bittery-client-core/src/runtime.rs)
are the authoritative capability inventory. Core currently exposes:

- `SignIn`, `QuickUnlock`, `Lock`, `SignOut`, `RemoveAccount`, `DeleteServerAccount`, and `Wipe`.
- `CreateVault`, with personal/team type, icon and bounded image ingress.
- `CreateItem`, `UpdateItem`, favorite, trash, restore, move, and permanent deletion. `ItemDraft`
  includes Login, Secure Note, Credit Card, Identity and Authenticator. Login preserves password
  history, passkeys, TOTP, custom fields, tags and optional values; the old first-slice subset in
  the package CONTEXT is historical, not the current protocol.
- `ImportItems`, one durable Operation per bounded batch.
- Share creation, pending result acknowledgement, Item share history, access logs and revocation.
- Attachment upload, download, rename and deletion, with explicit file capabilities.
- Replica diagnosis, protected export, repair and explicit re-Bootstrap.
- Account catalog, access/failure state, Item/Vault projections, Operations and pending share results.

Rust owns its authenticated installation, Session renewal, durable dispatch and live Sync. Its
[authentication installation](../../../packages/client-runtime/crates/bittery-client-core/src/authentication_installation.rs)
fetches and validates Travel mode and filters hidden Vault keys. This does **not** supply user-facing
Travel mode configuration commands. Its
[Operation outcome decoder](../../../packages/client-runtime/crates/bittery-client-core/src/runtime/outcome.rs)
recognizes the six retained rotation outcome kinds as another ceremony's work; it does not implement
the rotation ceremony.

The [Web composition](../../../apps/web/src/lib/crypto.ts) proves an existing reusable combined
Worker and typed client; [Web Worker entry](../../../apps/web/src/lib/runtime.worker.ts),
[package composition](../../../packages/client-runtime/src/web/composition.ts),
[worker entry](../../../packages/client-runtime/src/web/worker-entry.ts) and
[client transport](../../../packages/client-runtime/src/client/transport.ts) are integration seams.
Native SQLite and UniFFI binding availability are foundations, not evidence that the Tauri app
links a configured production Runtime or supplies all required platform executors.

## Production capability matrix

“No local entry found” means the inspected application's routes and components do not offer the
feature; it does not authorize deletion of another application's feature or invent a new UI requirement.

| Product path | Shared Rust capability | Desktop baseline | Extension baseline / required work |
| --- | --- | --- | --- |
| Sign-in, password Quick Unlock, restart | Commands exist | [Login](../../../apps/desktop/src/routes/login.tsx), [unlock](../../../apps/desktop/src/routes/unlock.tsx) and [account context](../../../apps/desktop/src/contexts/account-context.tsx) use TypeScript auth and AccountSessionManager | [Auth handlers](../../../apps/extension/src/background/auth-handlers.ts) use the same transitional services; move ceremony and installed Account state into the owner |
| Local biometric unlock, password re-entry | Missing public Runtime capability | Unlock UI and [biometric hook](../../../packages/core/src/hooks/auth/use-biometric-unlock.ts) use platform-retained material | [Biometric transfer](../../../apps/extension/src/background/biometric-transfer.ts) and connected Desktop paths must retain local-only semantics; no password-login substitution |
| Lock, auto-lock, active account, multi-account | Lock/account commands exist; active pointer stays UI state | Context, [auto-lock service](../../../apps/desktop/src/services/autolock-service.ts) and native host maintain existing authority | [Vault session machine](../../../apps/extension/src/background/vault-session/machine.ts), [session manager](../../../apps/extension/src/background/session-manager.ts) and popup copies own state today; broker must become capability/message routing only |
| Offline reads, durable writes, retry, reconnect | Replica, Operation dispatch and live Sync exist | [Vault runtime](../../../apps/desktop/src/lib/vault-runtime.ts) creates TypeScript VaultRepository; [Sync hook](../../../apps/desktop/src/hooks/use-desktop-sync.ts) creates AccountSyncLifecycle and TauriSyncStorage | [Background runtime](../../../apps/extension/src/background/vault-runtime.ts), [Sync manager](../../../apps/extension/src/background/sync-manager.ts), [outbound drain](../../../apps/extension/src/background/outbound-drain.ts) and popup staged queue remain separate owners |
| All five Item categories and metadata | Present, including passwords/history, TOTP and stored passkey fields | [Vault route](../../../apps/desktop/src/routes/vault/route.tsx), [Item detail](../../../apps/desktop/src/components/vault/item-detail-page.tsx) use shared transitional hooks | [Vault page](../../../apps/extension/src/pages/vault.tsx), save flow and [Item mutations](../../../apps/extension/src/background/extension-item-mutations.ts) use TypeScript ItemCommands |
| Favorite, trash, restore, permanent delete, move | Present | Item detail, trash route and move dialog use old hooks | Migrate actual supported popup/background callers; keep move Attachment/key-version behavior |
| Vault create and Import | Present | No local Create Vault or Import entry found; existing route creates Items and edits/deletes Vaults | No local Import entry found; preserve existing save-target selection and empty-Vault reads; shared capability must remain available |
| Vault name/icon/image update, deletion, type conversion | Missing request kinds | Vault route calls `useUpdateVault`/`useDeleteVault`; [VaultService](../../../packages/core/src/services/vault-service.ts) validates, uploads images and performs transport in TypeScript | No local conversion editor found; incoming catalog changes must converge without separate key/cache refresh policy |
| Attachments | Present | Item detail calls [useItemAttachments](../../../packages/core/src/hooks/use-item-attachments.ts), which owns crypto, presigned transport and local effects | No local Attachment editor found; preserve embedded Item metadata and any actual reachable view path |
| Share links and history | Present | Item detail lists Share history and calls `api.share.remove`/`accessLogs` directly; no Desktop Share creation caller found | No local Share editor found; retain Item data without copying share policy |
| Shared Vault membership, Team departure/removal, key rotation | Missing Runtime ceremony commands | No local Team/member management entry found; reads of shared Vaults and incoming rotations are production paths | No local Team/member editor found; autofill/passkeys must continue after authority/key changes and must lose removed access |
| Travel mode | Sign-in verification exists; configuration requests absent | [Travel settings](../../../apps/desktop/src/components/travel-mode-settings.tsx) use [useTravelMode](../../../packages/core/src/hooks/use-travel-mode.ts) and TypeScript SRP disable proof | Existing auth/Sync/desktop snapshot paths enforce policy outside Rust; must prove key/Replica erasure, not only hidden UI rows |
| Account remove, sign-out, Wipe, Server deletion | Commands exist | Context remove and [lifecycle adapter](../../../apps/desktop/src/lib/lifecycle.ts) coordinate transitional stores/native mirror; no local Server-deletion editor found | Auth logout and account management coordinate transitional stores; every Account-scoped native material/queue must be included in cleanup |
| Signup, password/email/Secret Key changes, Recovery Key setup and account recovery | Missing Runtime ceremony commands | No local editors found in Desktop routes/settings | No local editors found in Extension pages; Web remains their production surface, as detailed below |
| Replica recovery and “clear cache” | Recovery commands exist | [Advanced settings](../../../apps/desktop/src/components/settings/settings-advanced-panel.tsx) clears outbound queue, Item cache and Sync state directly | Neither application has established Runtime recovery acceptance; destructive cache clearing cannot discard accepted Operations under the new contract |
| Autofill Login/Card/Identity, saved-login matching, password save | Item projections/writes exist; host form interaction remains platform capability | Supplies connected Extension snapshot/write capability | [Autofill handlers](../../../apps/extension/src/background/autofill-handlers.ts) obtain plaintext through current mode/state machinery; switch reads/writes to Runtime projections without changing form behavior |
| Passkey creation/assertion and usage/status updates | Stored passkey shape exists; semantic create/assert commands missing | Native connection must preserve write/lock authority | [Passkey handlers](../../../apps/extension/src/background/passkey-handlers.ts) generate keypair/credential ID, build attestation, sign assertions and mutate passkey counters/status themselves; live keys and ceremony belong in Rust |
| Native messaging | No complete Runtime-backed host path | [Native host](../../../apps/desktop/src-tauri/src/native_host.rs) and [native cache crypto](../../../apps/desktop/src-tauri/src/native_host_crypto.rs) still serve old encrypted cache/key state | [Desktop key material](../../../apps/extension/src/background/desktop-key-material.ts), session state and Desktop recovery reconstruct capabilities from the existing native protocol |
| Device setup export, display metadata, clipboard and Sentinel | Host presentation/capability seams need explicit audit | [Device setup](../../../apps/desktop/src/components/device-setup-dialog.tsx) reads stored Secret Key; settings retain platform/UI preferences | Keep account provenance and lock cancellation for data exports and copies; renderer computation over authorized decrypted projections is distinct from Replica/crypto policy |

## Remaining Web policy owners

The completed Web migration is a reference for migrated paths, not proof that every Web feature is
already Runtime-owned. These still constrain shared cleanup and capability expansion:

- [VaultService](../../../packages/core/src/services/vault-service.ts) performs Vault update/delete/
  conversion and key refresh; Core hooks expose it to Web, Desktop and Mobile.
- [Web rotation hook](../../../apps/web/src/hooks/use-vault-key-rotation.ts) constructs
  [TypeScript rotation ceremony](../../../packages/core/src/services/vault-key-rotation.ts), opens
  keys through `vaultCrypto`, reads the master unlock key, stores Vault keys, removes cached Vaults
  and refreshes authority. The Server's retained rotation outcomes do not transfer these duties to Rust.
- [Password change](../../../apps/web/src/components/settings/change-password-dialog.tsx),
  [email change](../../../apps/web/src/components/settings/change-email-dialog.tsx),
  [Secret Key regeneration](../../../apps/web/src/components/settings/regenerate-secret-key-dialog.tsx),
  [Recovery Key setup](../../../apps/web/src/components/settings/setup-recovery-key-dialog.tsx) and
  [regeneration](../../../apps/web/src/components/settings/regenerate-recovery-key-dialog.tsx)
  read transitional credentials and perform ceremonies/API calls outside the Runtime.
- [Signup](../../../apps/web/src/routes/_auth/signup.tsx) and
  [account recovery](../../../apps/web/src/routes/_auth/recover.tsx) remain separate account-entry
  ceremonies. These are distinct from protected Replica recovery export/repair.
- [Device management](../../../apps/web/src/components/settings/device-management.tsx) calls Session
  rename/revoke APIs. Team/member UI and [Vault member UI](../../../apps/web/src/components/vaults/vault-member-list.tsx)
  still use direct authenticated API paths.
- [Web storage](../../../apps/web/src/lib/storage.ts) still constructs AccountStore/ItemCache and
  explicitly reconciles transitional ceremonies. Its continued existence must not be mistaken for
  proof that its mirrored credentials/keys are a safe long-term Runtime interface.

Migrating shared capabilities should reuse the same implementation for existing Web callers.
Web-only credential/Team administration UIs are an inventory and future shared-cleanup constraint,
not a requirement to add those UIs to Desktop or Extension before their migration can pass. Existing
Desktop/Extension consumers must still handle incoming credential, membership and key changes through
Runtime Session/Sync policy. Features absent from these hosts are not counted as local acceptance
cases and must not disappear from the product's existing Web surface.

## Placement and capability gaps

[ADR 0010](../../../docs/adr/0010-desktop-renderer-crypto-runs-in-a-wasm-worker.md) currently places
Desktop renderer keys in a WASM Worker and explicitly retains a native cache decryptor for native
messaging. The user has approved the native Tauri Runtime placement, conditional on avoiding
duplicated implementations, in [ticket 61](../issues/61-desktop-runtime-placement.md). Its implementation
must account for one live-key owner, native lock authority, process lifetime, SQLite, HTTP/SSE, device
storage, biometric release, files and IPC cancellation. The existing narrow native cache decryptor
cannot become a competing Replica owner.

[ADR 0015](../../../docs/adr/0015-keep-biometric-unlock-local.md) requires local biometric unlock
without a new Session or newly persisted login secret. The Runtime needs a capability for authorized
release of the existing Device-bound wrapped master unlock key, and must distinguish locally
unlocked state from a usable Server Session. Existing QuickUnlock cannot stand in for this feature.

[Ticket 41](../issues/41-extension-runtime-placement-decision.md) already chooses Chrome 116+,
one combined Worker in an offscreen document, IndexedDB and a service-worker broker. The inspected
[manifest](../../../apps/extension/manifest.config.js) has a module service worker, but no `offscreen`
permission or `minimum_chrome_version`; there is no production offscreen composition yet. Service
worker recycle must reattach to the same live owner; destroying that Worker/document must retire live
keys and require unlock. Neither a mock restart nor simply recreating a background object proves this.
The repository manifest is Chrome-oriented; Firefox/Safari have no alternative production manifest
in this directory. Ticket 41 explicitly leaves them roadmap document hosts pending real-host
acceptance. The user approved Chrome 116+ production scope; the explicit scope record is
[ticket 62](../issues/62-extension-browser-acceptance-scope.md), rather than an inference from Web
browser tests.

## Dependency recommendations

1. Apply the accepted Desktop placement and Chrome scope decisions. Define biometric capability and
   connected Extension trust/lock contracts under existing ADRs, and replace destructive cache
   clearing without losing accepted Operations. Ask only when an architectural/product choice is
   still unresolved by those constraints.
2. Prove one Desktop Runtime composition with real persistence/transport and generated IPC. Complete
   sign-in, restart, lock/password unlock, offline Item read/create and reconnect before widening.
3. Complete local biometric release and native messaging against the same Runtime owner. Prove
   locked/removed Accounts cannot serve old plaintext or borrowed write capabilities.
4. Migrate all Desktop Item variants/lifecycle, attachments, shares, Vault operations and Travel mode.
   Introduce missing Rust requests/Operation contracts first; preserve Server outcomes and formats.
5. Finish Desktop multi-account teardown/recovery and production acceptance before Extension cutover.
6. Install the Extension offscreen combined Worker/broker and migrate auth/catalog/projections, then
   durable writes and all existing popup/content-script consumers. Prove real broker reattachment and
   real owner loss independently.
7. Move passkey crypto/usage policy behind Runtime commands; preserve browser validation/UI mediation
   and Desktop-connected authority. Prove actual page autofill/passkey and native-messaging flows.
8. Remove migrated host policy owners and run whole-repository caller graphs before deleting
   transitional implementations. Retain shared code for Web-only or Mobile callers that still need
   it. Update capability inventory per ticket with code and real evidence.

Steps are proposed dependency boundaries, not ready-for-agent tickets or accepted architectural
decisions. Detailed contracts need explicit frontier resolution before implementation.

## Shared cleanup constraints

Mobile is still an active caller of [TypeScript ClientRuntime](../../../apps/mobile/src/contexts/account-context.tsx),
[WASM crypto Worker](../../../apps/mobile/src/lib/crypto.ts),
[VaultRuntime](../../../apps/mobile/src/lib/vault-runtime.ts),
[auth hooks](../../../apps/mobile/src/routes/login.tsx),
[Item hooks](../../../apps/mobile/src/components/vault/item-detail-screen.tsx),
[Vault update](../../../apps/mobile/src/components/vault/vault-form-sheet.tsx),
[Travel mode](../../../apps/mobile/src/components/vault/travel-mode-sheet.tsx),
[legacy Sync](../../../apps/mobile/src/hooks/use-mobile-sync.ts) and
[credential Replica integration](../../../apps/mobile/src/lib/credential-replica.ts).
Desktop/Extension completion does not authorize deleting these shared modules while Mobile uses
them. Delete application-local obsolete implementations after their callers migrate; remove shared
exports only after executable repository-wide reachability proves no remaining host caller.

This inventory ran no acceptance checks. Full CI, Rust CI, real application paths, independent
review and simplification remain delivery gates, with environment limitations recorded honestly.

## Web conversion follow-up, 2026-09-09

The actual shared-Vault Attachment rotation attempt failed in `createSharedVault` before its
Attachment picker: `/tmp/bittery-selective-shared-vault-attachment-acceptance.log` records the missing
Make-Shared success toast. The captured error context leaves the confirmation dialog open but contains
neither the thrown error nor an HTTP trace. It therefore proves no rotation or Attachment acceptance.

Read-only diagnosis identifies a high-confidence pre-existing ownership gap. The
[Vault route](../../../apps/web/src/routes/_app/vaults/$vaultId/index.tsx) reads its Vault and AccountId
from `useRuntimeItems`, then calls transitional
[useConvertVaultType](../../../packages/core/src/hooks/vault/use-convert-vault-type.ts).
[VaultService.convertVaultType](../../../packages/core/src/services/vault-service.ts) obtains its client
through [AccountResolver](../../../packages/core/src/services/account-resolver.ts), whose
[stored-client factory](../../../packages/core/src/services/api-client.ts) requires the old
AccountStore `jwt_token` before sending the conversion request. In contrast, actual
[Web Sign-in](../../../apps/web/src/components/sign-in-form.tsx) calls `runtimeClient.signIn` and does
not mirror its Session into that store. This intentional boundary already exists at repository HEAD;
commit `d9e82992` removed the invalid session sentinel/mirror. The conversion hook, service, resolver,
client factory and Web AccountStore composition are unchanged from HEAD in this migration work.

The [real test](../../../apps/web/tests/e2e/teams.spec.ts) signs up its owner in a separate context,
closes it, then signs in through the actual UI in the test profile. Its sign-in helper seeds no legacy
token. Consequently the predicted first failure is `No authenticated API client for account …`,
before `POST /vaults/{vaultId}/type-conversions`. That exact exception and the absence of a request
still need direct observation; they are not present in the saved failure. A narrower real rerun should
stop at conversion, capture the error toast immediately and record only conversion request count/status
(never credentials). No additional Server E2E was launched during this diagnosis.

Even a profile retaining legacy credentials encounters a second ownership boundary: the hook awaits
legacy `refreshVaultKeys`, which writes the old encrypted-key store/repository, while the route renders
Rust Runtime projections. A bearer/key mirror is not an accepted repair. The existing
[reachability test](../../../apps/web/scripts/transitional-reachability.test.ts) explicitly allows
transitional conversion, and [ticket58](../issues/58-final-web-host-cutover.md) excludes this Vault
operation from its completed Item cutover. Web foreground conversion remains unmigrated. Desktop has
no conversion editor in its actual caller inventory; incoming conversions and their current key/Item
authority still require ticket70 convergence. Neither fact establishes Web conversion acceptance.
