# Desktop startup and caller cutover mapping

This is the implementation/test boundary for [66](../issues/66-desktop-first-runtime-path.md) and
[72](../issues/72-desktop-complete-production-caller-cutover.md), inspected on 2026-09-09 against the
[production inventory](desktop-inventory.md). It specifies preparation and acceptance; no Tauri
startup or renderer caller is migrated by this document. Ticket73 retains real production and
supported-OS acceptance. Ticket66's first end-to-end trace does not authorize an application with
reachable legacy owners beside the native Runtime.

## Actual entry and mounted caller closure

| Entry or reachable caller | Current execution and required replacement |
| --- | --- |
| Module evaluation: [crypto.ts](../../../apps/desktop/src/lib/crypto.ts), [storage.ts](../../../apps/desktop/src/lib/storage.ts), [vault-runtime.ts](../../../apps/desktop/src/lib/vault-runtime.ts) | Importing crypto constructs the standalone WASM Worker port and starts initialization in the renderer before `initializeApp` or React mount. Storage constructs AccountStore/ItemCache singletons; Vault composition eagerly constructs VaultCrypto/repository. `initializeStorage` then installs the unlock broadcaster before any unlock. Remove these reachable owner-producing imports and the pre-unlock broadcaster at cutover; removing a provider alone cannot prevent a second Worker or storage owner from starting. |
| [main.tsx](../../../apps/desktop/src/main.tsx), [providers.tsx](../../../apps/desktop/src/lib/providers.tsx) | Before render, initialize Tauri AccountStore, construct a Session-refreshing API client and transitional TypeScript ClientRuntime, then initialize its Account manager. Replace this Account startup with attachment to the existing native Runtime and its catalog observation. Query/UI providers may remain, but their callbacks must not refresh credentials or invalidate Sessions independently. |
| [AccountProvider](../../../apps/desktop/src/contexts/account-context.tsx) | React mount starts/disposes the transitional Runtime, starts the local timeout policy, subscribes lock/native events and exposes AccountSessionManager/VaultRuntime. Replace with RuntimeClient observations plus UI selection/departure state; a component cleanup detaches callers and never closes the native process owner. |
| [SyncProvider](../../../apps/desktop/src/providers/sync-provider.tsx), [useDesktopSync](../../../apps/desktop/src/hooks/use-desktop-sync.ts), [PlatformProvider](../../../apps/desktop/src/providers/platform-provider.tsx) | Root mount installs legacy Sync scheduling and gives every shared hook AccountStore, crypto, VaultCrypto, repository and queue authority. Remove these owner dependencies from the production root together. Observation-derived status and presentation invalidation do not require a compatibility PlatformProvider or AccountStore. |
| [index](../../../apps/desktop/src/routes/index.tsx), [login](../../../apps/desktop/src/routes/login.tsx), [unlock](../../../apps/desktop/src/routes/unlock.tsx), [Vault guard](../../../apps/desktop/src/lib/vault-route-access.ts) | Guards read Session validity and can restore keys from storage; Login also reads a retained Secret Key for prefill. Derive navigation from current Runtime catalog/access projections and use existing closed SignIn/QuickUnlock/local-access requests. Retained identity can prefill nonsecret fields; no general credential read restores the old login dependency. Preserve explicit unlock-all, one biometric prompt and per-Account partial outcomes. |
| [Vault shell](../../../apps/desktop/src/routes/vault/route.tsx), [DnD provider](../../../apps/desktop/src/providers/dnd-provider.tsx) | Mount immediately calls Vault/Item reads, Create/Update/Delete mutation hooks, Move and a periodic metadata-refresh hook. These must all be Runtime-backed when the shell first becomes reachable. Replace metadata polling with ticket84's Core owner; derive tags/counts/search from observations. Closed dialogs do not make their containing hooks inactive. |
| [Account switcher](../../../apps/desktop/src/components/account-switcher.tsx) and its dialogs | Switching/removal still consult Session storage. Settings queries are enabled only while open; device setup mounts its secret-reading content only while open. They remain reachable product actions and require current Runtime selection, teardown, local-security and scoped DeviceSetup paths before the startup switch. Preserve UI-only theme/language preferences. |
| [Item detail](../../../apps/desktop/src/components/vault/item-detail-page.tsx) | Viewing any Item instantiates update/delete/favorite/create and Attachment hooks. Share list transport is enabled only when its history dialog opens, while revoke/log callbacks also use the direct API. Migrate every reachable handler; simply replacing the Item read leaves active hooks and ordinary gestures coupled to old owners. |
| [macOS reset menu](../../../apps/desktop/src/lib/macos-reset-menu.ts), [advanced settings](../../../apps/desktop/src/components/settings/settings-advanced-panel.tsx) | Menu registration happens during startup; its action later performs legacy Wipe and storage deletion. Settings clear queue/cache/Sync state. Bind the existing actions to Core Wipe and the accepted guarded recovery flow, including incomplete cleanup, rather than keeping a second destructive storage path. |
| [Tauri setup and native handlers](../../../apps/desktop/src-tauri/src/lib.rs) | Setup starts the legacy socket server; native handlers independently unwrap keys and decrypt ItemCache. Native capability modules now exist, but this production entry still uses the legacy owner. Activate the configured native Runtime and route all native authority requests to that same owner at the coordinated startup boundary. Host installation, framing and UI intents remain host plumbing. |

An import graph is necessary but insufficient: record module initialization, mounted hooks, enabled
queries and gesture callbacks separately. A disabled query is not an active network request, and a
reachable legacy callback is not safe to leave behind merely because the first Login trace never
opens its dialog. Conversely, pure shared formatters/components may retain their existing packages;
package-name removal is not the ownership criterion. The executable graph must also reject owner
creation at module evaluation even when no component ever mounts its provider.

## Atomic activation and routine placement

Prepare renderer controllers against the existing generated RuntimeClient and
[Desktop transport](../../../apps/desktop/src/lib/runtime-transport.ts), reusing
[ticket80 presentation](../../../packages/ui/src/runtime-presentation/index.ts). Keep the native
factory, SQLite, network/file executors, prompt owner and source adapter already accepted by their
capability tickets. There is no new startup service, host mutation scheduler, storage facade or key
owner. Preparation may leave modules unreachable from production; it must not activate a second
owner or a feature flag that mixes old and new Account state.

The activation sequence is constrained by [profile admission](profile-handoff.md): acquire the live
exclusive native profile scope, inspect/reconcile its existing admission/reset lifecycle, and admit
the complete profile before normal Account publication or legacy writer access. A blocked admission
stays visibly blocked, with its existing recovery/Wipe route available. It must not fall through to
an apparently fresh Sign-in screen. Core's existing native startup then owns the sole catalog,
Replica, key access, dispatch and Sync lifetime. Ordinary renderer requests and native source
disclosures wait for their startup gates. A renderer may still attach to the same failed-open owner
for its existing maintenance-only status, Inspect/Export/Repair/Rebootstrap/Wipe controls; attachment
does not grant ordinary access. No legacy socket owner starts alongside it.

In the same production cutover, replace main/router/provider ownership and the complete reachable
caller closure above. A renderer's selected Account remains UI state validated against current
catalog observations; every request carries the actual selected Account identity. Reuse shared
departure/selection helpers to clear stale detail, dialog and mutation presentation when selection
or authority changes. Host activity/window events report observations through ticket67's existing
activity capability; they do not retain timeout/re-entry policy or synthesize native lock authority.
Existing native create/view UI intents stay nonauthorizing: Create's URL is form prefill, and a bare
Vault/Item target is resolved only under the current active Account through its normal route guard.
Do not search other Accounts or select one by email to satisfy an intent. Pending navigation and
listener callbacks belong to the renderer generation; departure clears them before a successor can
consume them. An intent received while locked may survive to that same renderer's explicit unlock,
as today, without bypassing the Account guard or transferring a stale detail result.

Ticket66 first develops the smallest Runtime/Tauri application trace, then prepares every remaining
reachable controller and native handler before delivering the single production activation. This
ordering uses the existing application and capability tests; it does not require a second test-only
Tauri application or a mixed-owner feature mode. Ticket72 completes exhaustive
category/gesture/variant acceptance and removes obsolete Desktop-only modules after the executable
caller graph proves them unreachable. Ticket72 cannot defer migration of a still-reachable owner
past ticket66 by calling it later coverage. Shared Mobile and remaining Web owners keep their own
modules until their callers migrate.

The [shared private/public Item prerequisite](../issues/95-private-credentials-and-public-item-commands.md)
is needed before this activation: native placement keeps private keys outside ordinary renderer
projections, while existing Login edits, credential removal and same-Vault Duplicate remain lossless.
Its explicit Import/Export preservation also covers current Web callers. It is independent of
Extension placement and passkey ceremonies; neither74 nor75 becomes a Desktop dependency.
Ticket95 records the reviewed prerequisite, with its incomplete capabilities still gating delivery.
The unmigrated Extension still consumes protocol1 private Item and biometric payloads. Reviewed
[legacy compatibility97](native-legacy-compatibility.md), under resolved96, replaces those Desktop
handlers inside the same Core native source before66 activates. It reuses95's private read owner,
is unavailable to renderer requests, and is removed at76. Keeping the old Tauri cache decryption
handlers alongside the Runtime would violate this activation closure.
Independent and coordinating review sealed66/72's complete activation contract. Both tickets are
ready with incomplete prerequisites; this mapping is not delivery or permission to start early.

## Stateless Item helpers and the remaining TOTP seam

The 2026-09-09 caller audit found no remaining mounted Desktop helper that directly calls
`CryptoPort` after the Account/authentication/storage owners above are removed. Removing the
standalone Worker therefore does not mechanically remove these helpers. It also does not establish
that their current computation placement satisfies the accepted native architecture.

| Reachable helper and caller | Current implementation and cutover boundary |
| --- | --- |
| TOTP display and code copy: Desktop [Item detail](../../../apps/desktop/src/components/vault/item-detail-page.tsx) → shared [Login detail](../../../packages/ui/src/components/vault/item-detail/login-detail.tsx) / [TOTP detail](../../../packages/ui/src/components/vault/item-detail/totp-detail.tsx) → [InlineTotpDisplay](../../../packages/ui/src/components/inline-totp-display.tsx) | Calls `shared/totp.generateTotp` immediately and every second. The helper implements HMAC through WebCrypto; code copy uses the displayed cached result. Desktop list and tag rows only show a clock badge. Reuse the existing Rust algorithm through the sealed native capability described below, preserving all hash/digit/period choices, countdown and copy behavior. |
| Password generation: shared [Login form](../../../packages/ui/src/components/vault/item-categories/login-form.tsx) → [PasswordGenerator](../../../packages/ui/src/components/password-generator.tsx) | Calls [shared/password.generatePassword](../../../packages/shared/src/password.ts), using ambient `crypto.getRandomValues`, with no Worker or Account dependency. Its displayed strength is local length/character-set scoring. No existing Rust password-generator export was found; retaining this stateless UI helper does not retain the removed key owner. Changing its algorithm is outside this cutover inventory. |
| OTP input and display formatting | [TotpForm](../../../packages/ui/src/components/vault/item-categories/totp-form.tsx) and [TotpInput](../../../packages/ui/src/components/vault/item-categories/shared/totp-input.tsx) parse pasted `otpauth:` URIs and validate Base32 through [shared/totp](../../../packages/shared/src/totp.ts); Login form also validates Base32, and TOTP detail formats the secret. These are pure parsing/formatting helpers. No mounted QR-image decoder was found. Preserve secret display, copy and editing; code generation does not replace those existing Item fields. |
| QR rendering and clipboard | [DeviceSetupDialog](../../../apps/desktop/src/components/device-setup-dialog.tsx) renders the existing scoped `setupPreview.qrUri` with `QRCodeSVG`; it does not need a primitive key export. Shared [clipboard](../../../packages/ui/src/components/clipboard.ts) delegates to the existing browser clipboard and auto-clear helper, without CryptoPort. Selection/departure cleanup must still retire stale UI disclosures. |

`usePasswordSecurity`/`analyzePassword` use zxcvbn, but this audit found no Desktop or shared UI
caller. Likewise `generateTotpSecret`, `generateTotpAt` and `verifyTotp` have no mounted Desktop/UI
caller. Their presence in a shared package does not establish an additional activation dependency.

The TOTP algorithm already exists in [Rust Crypto Core](../../../packages/crypto/core/crates/bittery-crypto-core/src/totp.rs),
including `generate_totp` and deterministic `generate_totp_at`, with RFC 6238 vectors. The shared
[crypto API](../../../packages/crypto/core/crates/bittery-crypto-api/src/lib.rs) exports both;
[CryptoPort](../../../packages/crypto/port/src/crypto-port.ts) exposes the stateless supplied-secret
`generateTotp` primitive, and its conformance suite covers hash, digit, clock/progress and input
errors. Desktop already links that Rust core. However, the generated Runtime protocol and native
renderer commands have no closed TOTP computation request or projection today.

The [accepted specification](spec.md#native-foundation) excludes primitive crypto invokes. On
2026-09-09 the coordinating review accepted the following closed Item capability as routine66
assembly, using the existing Runtime and linked Rust algorithm. No supplied-secret Tauri primitive,
whole CryptoPort bridge, second Worker, key store or policy owner is introduced.

### Closed Item TOTP contract

Add a generated `ItemTotp` Runtime request with exact Account/Item identity and the stateless readable
source guard already specified for95's Duplicate. That guard binds owner/incarnation/lock epoch,
Vault/Item, current Replica revision and selected authoritative version or accepted local overlay
identity. It is stale-input evidence, not a registered key capability. The caller supplies no secret,
algorithm, digits, period, counter or timestamp. This is a read: an otherwise readable read-only Vault
or accepted local Item overlay does not need mutation eligibility or a fabricated confirmed version.

Under existing Account execution and foreground read/delivery fencing, Core revalidates that exact
source and current Vault access, reads Login's optional TOTP fields or Authenticator's TOTP fields,
and calls the existing `generate_totp_at` with Core's clock. Preserve generated SHA1/SHA256/SHA512,
6/7/8-digit and positive-period choices and existing absent-option defaults. Invalid or absent secret
material returns the existing typed failure path; a previous displayed code is not a fallback.

The closed result contains the same source guard, `code`, `periodSeconds`, `sampledAtUnixSeconds`
and `validUntilUnixSeconds`. Use existing generated integer conventions and checked period/time
arithmetic. The two timestamps identify the sampled interval, not caller-controlled clock authority;
the UI derives countdown/progress and uses local elapsed time only for presentation. This result is
ephemeral, with no durable Operation, replay capsule or cached native key handle. Revalidate the
foreground scope before release; caller cancellation, Account retirement, hidden Vault or changed
source makes a held result ineligible.

Shared Login/TOTP detail accepts an explicit presentation slot for this Runtime-backed display,
provided by the Desktop Item controller through the existing RuntimeClient/transport. The controller
owns request cancellation and the selected Item presentation generation; shared UI owns formatting,
countdown and clipboard gesture. Omitted injection preserves the current other-host implementation
until those callers migrate, while Desktop supplies it for every mounted Login/Authenticator detail
path and never falls back to renderer HMAC when native computation fails. No host singleton belongs
in the shared component.

The Desktop controller clears code/copy eligibility on Account or Item departure, source-guard
replacement, expiry or failure. It rejects late responses from an older request/presentation
generation, even if the user returns to the same Account or Item. Refresh through the bounded read
request for the displayed Item; no background TOTP owner or independent policy timer is needed.
At copy, require the still-current presentation and interval; an expired code is unavailable until
a fresh guarded result arrives. Existing visible secret, secret copy, editable fields and URI parsing
remain available under the ordinary Item display/edit contract; code generation does not redact them.

66 implements the native/controller/shared-display composition;72 exercises both actual category
paths, period rollover, invalid inputs, readable local overlays/read-only Vaults, Account switch,
Item/secret replacement and held replies across Lock/hiding. Existing RFC vectors and deterministic
Core clock tests prove the reused computation; real mounted Tauri display/copy and supported-host
retirement remain72/73 acceptance. Contract readiness claims no implementation.

## Acceptance mapping

These are required future cases, not new passing test claims. Extend the existing bridge,
[architecture checks](../../../scripts/check-architecture.test.mjs), shared presentation and
capability suites; use actual Tauri gestures for application evidence. A test title or headless
native helper alone does not satisfy a row's real-host column.

| Path group | Test boundary and observable result | Gate |
| --- | --- | --- |
| Entry ownership and startup | Traverse main, generated route tree, all mounted providers, native setup/invoke/socket handlers and menu callbacks; reject reachable AccountStore/ItemCache/crypto/queue/Session-refresh owners. Exercise React remount, two renderer attachments and detach/reconnect: one native owner, old callers retired, same accepted work continues. Test pending/failed profile admission and reset before any normal catalog publication, following91's crash matrix. | 66 activation; 72 final graph; 73 real launch/restart |
| First Account and Login trace | Actual Tauri Sign-in/add Account, retained catalog after process restart, locked state, password Quick Unlock and offline Login read/create. Hold the accepted create reply, close/reconnect renderer, then terminate/restart the app and reconnect Server; resolve the original durable identity to exactly one Server Item, never resubmit a UI Create. Preserve Account display identity and per-Account Server URL/transport confirmation. | 66 |
| Local security and Account isolation | Mount unlock-all, Account switcher and settings; exercise partial password unlock, one-prompt biometric unlock, cancellation/late completion, preference/re-entry boundaries, Core inactivity and native Lock. Switch between equal-email Accounts on different Servers with a held response; stale detail/dialog/QR/secret disclosure cannot appear under the successor. Selective Lock/removal preserves unrelated unlocked access and accepted work. Real supported-OS prompts remain73. | 66 closure; 72 variants; 73 hardware/OS |
| Full Item surface | Create/read/edit all five categories with every inventory field; search/tags/counts/favorites; trash/restore/permanent delete; password history/restore and TOTP. Include null/optional fields, stale edit refusal, offline accepted overlays and restart convergence. Login edit preserves real stored passkeys; exact removal preserves siblings; Duplicate preserves the current supported source data, including readable local overlays, through Core. | 72, using shared prerequisite vectors |
| Vault shell and authority | Open the shell before any dialog and verify only Core observations/dispatch/refresh run. Update/delete Vault, change/remove image with held file/upload and late reply, then reopen. Exercise writable shared Vault Item creation and permission changes; incoming/local Travel hiding erases protected material and retires old readers while preserving unrelated Vaults/Accounts. | 66 reachable wiring; 72 full70/71/84/85 integration |
| Move and Attachments | Same-Account and cross-Account Move from both dialog and DnD, with existing Attachment behavior. Hold each binary exchange across cancellation, Lock, removal and restart; accepted artifacts remain recoverable and unauthorized late delivery fails. Cross-Account destination retirement uses90 and explicit83 reauthorization with preserved request identity, including supported admitted legacy work. | 72, consuming69/83/90 |
| Share history and user handoffs | Open real history, revoke and access logs through Core, with Account switch/Lock while pending. Preserve existing Extension create/view Item intents through the new authority boundary. Import/account-recovery remain existing Web handoffs where Desktop has no local UI; do not invent Desktop CreateShare, Import or credential-change routes to claim coverage. | 72; actual browser/native handoff73 |
| Recovery and teardown | Guarded Replica recovery preserves accepted work; interrupted file recovery and cleanup expose existing outcomes. Remove one Account, then Wipe from both ordinary UI and failed-open/reset paths; no stale observations, native grants, source files, credentials or staged artifacts survive successful completion. Failure remains incomplete and recoverable. Test91's tombstone/reset preservation across later Account lifecycle changes. | 72; actual OS store/file/menu evidence73 |

For each completed row record its exact existing/new test name, command, revision, actual process/OS
and limitations. Keep real application launch separate from controlled primitive fixtures. Required
full `pnpm check:ci` and `pnpm check:ci:rust`, independent review and supported-OS/native-browser
evidence remain the phase gates already defined in [the host specification](spec.md).
