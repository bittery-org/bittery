# Extension production ownership inventory

Inspected 2026-09-08. This is source evidence, not production acceptance. No application changes or
browser runs were performed for this inventory. Paths below are relative to the repository root.

## Actual composition

`apps/extension/src/background/index.ts` constructs a TypeScript `ClientRuntime` from
`@bittery/core/services/client-runtime`, a legacy `createCoreContext`, and `DesktopSyncService`.
It does not instantiate `@bittery/client-runtime`. The misleading shared name does not establish
Rust ownership. The popup constructs a second TypeScript Runtime in
`src/lib/popup-account-vault-runtime.ts`; `src/popup.tsx` starts it and disposes it on page hide.

`src/lib/crypto.ts` creates a static WASM CryptoPort in each JavaScript context. `src/lib/storage.ts`
creates an AccountStore over Chrome local/session storage and an ItemCache over IndexedDB
`bittery_records`, also independently per context. Despite that file's comment that the popup only
reads, `src/routes/__root.tsx` restores every Account's Master unlock key without a prompt during
popup startup. Background startup independently restores keys in `src/background/services/session-restore.ts`.
Neither context uses the guarded Rust Replica or its durable Operations.

The completed Web composition in `apps/web/src/lib/runtime.worker.ts` uses
`serveWebRuntimeWorker`, `loadCombinedWebWasm`, and the combined Runtime/Crypto Worker.
That is reusable infrastructure, not evidence that Extension has migrated.

## Production paths and remaining owners

| Path | Current production callers and owner | Migration obligation |
| --- | --- | --- |
| Full sign-in, Quick unlock, unlock all | `src/pages/login.tsx`, `src/pages/unlock.tsx` → router → `src/background/auth-handlers.ts`; shared TS auth-service and unlock functions own authentication, then AccountStore persists Session/key material | Route supported ceremonies to Rust; preserve per-Account results, server URL/insecure-transport confirmation and Desktop handoff |
| Account catalog and active selection | `src/components/account-switcher.tsx`, `src/pages/settings.tsx`, popup AccountSessionManager, background `ensureActiveAccountSet`, Desktop account mirroring in `src/background/desktop-sync.ts` | Runtime owns catalog and lifecycle; host may retain active Account pointer and render projections |
| Restart | `src/background/services/service-worker-lifecycle.ts` initializes crypto/storage, restores sessions, starts Desktop and Sync services; popup separately restores keys | Delete transparent cold-owner restoration under ticket 41; broker reattachment must preserve a surviving owner's state |
| Lock and auto-lock | `src/background/session-manager.ts`, `src/background/vault-session/{machine,transitions}.ts`, Chrome alarm/session/settings/lifecycle adapters | Runtime owns live-key retirement and lock policy; broker supplies browser events/alarms. Reducer currently stores a MUK reference and owns keepalive and teardown effects |
| Sign out | `LOGOUT` → `src/background/auth-handlers.ts` → TS `signOutAccount`, plus router Sync cleanup | Rust owns Session retirement, accepted-work retirement and cache/quick-unlock teardown |
| Remove, Wipe, Server delete | No dedicated router commands or popup gestures found in `router/contract.ts`, routes, pages or account switcher | Preserve current narrow popup surface; Runtime lifecycle capabilities must cover Desktop and future host callers. Do not infer migration from absent Extension UI |
| Vault list and Item reads | `GET_VAULT_ITEMS`, `GET_VAULT_ITEM`, `GET_WRITABLE_VAULTS` → `src/background/vault-handlers.ts`, `vault-utils.ts`, TS VaultRepository; Desktop mode can obtain Desktop snapshots | Rust Account-scoped Replica/projections must own authoritative state, decryption and access filtering |
| Login Item creation/update | Capture/save overlays → `src/background/credential-handlers.ts` → `extension-item-mutations.ts` → TS `ItemCommands` | Existing durable Rust all-category Item commands can replace legacy queue composition after equivalent projections and account guards |
| TOTP update | Popup QR scan → `CAPTURE_TAB_SCREENSHOT`/`UPDATE_ITEM_TOTP` → `src/background/qr-scan-handlers.ts` → legacy ItemCommands | Screenshot/QR parsing remain browser/UI capabilities; Item validation/encryption/acceptance belongs to Rust |
| All five Item categories | Vault lists consume `DecryptedItemWithContext`; `src/components/item-detail-panel.tsx` has Login and Secure Note details, Credit Card and Identity placeholder details, and no separate Authenticator detail branch | Preserve all stored categories and existing display behavior. The popup's limited editor/details are not evidence that categories may be dropped |
| General Item editor, create, Vault operations | `src/pages/vault.tsx` sends `OPEN_DESKTOP_APP` with create/view intent in Desktop mode; standalone opens the Web vault; popup has no general create/edit/Vault mutation UI | Preserve handoff/deep links. Desktop/Web own these existing full product gestures; migrating Extension does not justify dropping destination capabilities |
| Attachments | No attachment CRUD/download routes or dedicated popup UI found; Item details/general editing hand off to Desktop/Web | Account/Item snapshots must retain compatible data; Desktop acceptance must exercise actual attachment paths |
| Sharing and Import | No share/Import popup routes found | Preserve existing destination applications; absence of Extension UI does not prove shared Runtime capability coverage |
| Travel mode | `src/background/services/sync-cache-service.ts` invokes TS `handleTravelModeSyncEvent`; `src/background/native-messaging.ts` runs TS TravelModeEnforcer before installing transferred keys | Rust must own policy, hidden-Vault erasure and stale-key protection for standalone and Desktop unlock; rendering-only filtering is insufficient |
| Account Recovery and Replica recovery | No Recovery or Replica recovery routes/pages found | No existing popup recovery flow to claim migrated. Shared Runtime recovery remains needed for complete device/application acceptance |
| SSE and catch-up | `src/background/sync-manager.ts` owns fetch stream parsing, reconnect scheduling, cursor persistence in Chrome local storage; `services/sync-cache-service.ts` owns delta sync, Vault keys, travel mode, account/token resolution | Delete after Runtime supplies live Sync; broker forwards capability/network events without retry/cursor policy |
| Durable writes and retry | `src/background/outbound-drain.ts` constructs TS ItemSyncEngine/CrossAccountItemCommandExecutor; `src/lib/worker-owned-outbound-queue.ts` and router implement popup claims, staging, activation and draining | Replace with Rust acceptance and outcomes; caller closure/lost reply cannot cancel accepted work or cause UI command replay |
| Popup HTTP authentication | `src/popup.tsx` uses `GET_AUTH_TOKEN` and builds authenticated API requests; PlatformProvider supplies TS crypto/storage/Sync capabilities | Remove competing authenticated behavior when consumers migrate; projections should not require exporting Sessions to popup |
| Login autofill | Content scripts/iframe → `GET_AUTOFILL_ITEMS` → `src/background/autofill-handlers.ts`, matching/ranking helpers; popup also calls `src/lib/autofill-active-tab.ts` | Browser form detection/ranking/rendering can remain; Account access and plaintext projection lifetime must follow Runtime lock state |
| Credit Card and Identity autofill | Separate credit-card/identity iframe pages and corresponding background routes filter all accessible Items | Verify real forms and lock propagation for both categories, not just Login capture |
| Passkey creation | Main-world `src/page-script/passkey.ts` → content bridge → picker/save-target overlays → `src/background/passkey-handlers.ts`; static CryptoPort generates credential/keypair and attestation, TS ItemCommands persists Login payload | Preserve origin/RP checks and user selection; Runtime owns credential key lifetime and durable creation. Avoid sending private key material into broker/popup |
| Passkey assertion | Same bridge → passkey-handlers → CryptoPort signing → TS Item update for counter, with cancellation checks | Preserve ES256 (`algorithm: -7`), credential format, sign count and matching/account checks; test real WebAuthn interception and stored counter convergence |
| Native messaging | `src/background/native-messaging-client.ts` calls `chrome.runtime.connectNative`, correlates versioned requests/events, reconnects transport; `desktop-protocol.ts` imports Rust-generated types | Keep browser/native transport in broker. Generation remains under ADR 0012 |
| Desktop connected reads/unlock | `src/background/desktop-client.ts` caches Account/Vault-key/token/Item snapshots; `desktop-sync.ts`, `desktop-key-material.ts`, `desktop-recovery.ts` and `native-messaging.ts` hydrate legacy local state | Replace policy/cache authority with Runtime bridge capabilities; preserve Desktop lock authority and explicit disconnect locking |
| Biometric transfer | `biometric-transfer.ts` verifies response shape/challenge; `native-messaging.ts` decrypts transferred encrypted MUK with transferred Device key, imports it into host CryptoPort, stores tokens/Vault keys | Move retained/live key handling to Runtime; keep local biometric authorization under ADR 0015 and existing crypto/persistence formats; do not replace with password sign-in |
| Travel policy and hidden data | `src/background/native-messaging.ts` invokes the shared Travel enforcer before installing transferred authority; `vault-utils.ts` filters extension-local Items, while connected reads trust Desktop's filtered snapshots; `services/sync-cache-service.ts` applies incoming `travel_mode_updated` through shared TS enforcement. `src/pages/unlock.tsx` renders the unverified-policy refusal. No Extension foreground Travel settings caller was found. | Replace these host policy owners with71's Core verified-policy/erasure path in both connected and standalone modes. Connected reads follow79's own Runtime Replica, so Desktop snapshot filtering cannot remain their protection. Test hidden Items across autofill/passkey projections, native grants, pending writes, broker reattachment and real owner loss. Foreground Desktop settings retain resolved81's separate command lifetime. |
| Settings/theme | Chrome storage settings, `src/providers/theme-provider.tsx`, Desktop theme events, auto-lock settings | Host retains presentation/platform preferences, but cannot become a second lock-policy owner |

All Extension paths above are under `apps/extension/` unless qualified otherwise.
`src/background/router/contract.ts` and `registry.ts` provide the exhaustive public background route
inventory; `src/routeTree.ts`, `src/routes`, `src/pages` and the manifest identify UI entrypoints.

## Desktop authority and native boundary

The native protocol's source is `apps/desktop/src-tauri/src/desktop_ipc.rs`; the Extension consumes
`apps/desktop/src/generated/desktop-ipc.ts` through its local facade. The current protocol pin is 1.
`NativeMessagingClient` maintains a browser-launched native port, uses correlated request IDs, checks
protocol versions, and subscribes to lock, unlock, desktop-close, active-account and theme events.
Transport reconnect is a platform concern; replaying accepted Domain commands would not be.

Legacy vault-session state distinguishes standalone and Desktop ownership and refuses local lock
when connected. `requireDesktopUnlock()` redirects an unlock gesture to a locked Desktop;
`PENDING_DESKTOP_UNLOCK` prevents falsely reporting an open Vault. `desktop-key-material.ts`
can hydrate tokens, wrapped Vault keys and local key material for writes while Desktop is unlocked.
`native-messaging.ts` can install transferred key material and separately verifies travel mode.
These paths are significant competing behavioral owners, not merely message plumbing.

Runtime/native acceptance needs actual Desktop lock, unlock, disconnect, revocation, Account changes,
and a replacement Extension owner. A cached Desktop-unlocked projection must not unlock a replacement
owner. Late biometric/native replies must lose to lock, removal or revocation. The approved choice of
how Desktop's Runtime exports/imports its authorized transfer must be specified before replacing these
owners; no host plaintext-key cache should be retained accidentally.

## Browser scope and placement

[Ticket 41](../issues/41-extension-runtime-placement-decision.md) already accepts Chrome 116+, one
combined dedicated Worker in one offscreen document per profile, IndexedDB, and a service-worker
broker. It explicitly calls Firefox and Safari unimplemented roadmap document hosts pending their
own manifest/version decision and real-host acceptance.

The actual `manifest.config.js` is Chrome MV3 with a module service worker. It has neither
`minimum_chrome_version` nor `offscreen` permission nor an offscreen HTML entrypoint. `vite.config.ts`
uses CRXJS and derives Extension pages from this manifest; Worker/offscreen packaging needs a real
release-build check. `README.md` calls the product a Chrome Extension. There are no Firefox/Safari
manifests, build targets or Extension acceptance projects. Desktop's native messaging installer
supports Chrome/Edge/Brave locations; that does not demonstrate real acceptance on either additional
Chromium brand and does not provide Firefox/Safari packaging.

The production cutover must create/discover using `chrome.runtime.getContexts()`, serialize concurrent
creation, correlate owner generations and reject stale replies. The offscreen document supplies
Worker construction/message routing, not authentication/Sync/retry policy. Remove the legacy
session-restore and synthetic keepalive paths after callers migrate. Broker recycle with the owner
alive differs from actual Worker/document loss: the latter reopens the Replica locked and resumes
accepted work only after supported unlock. Chrome 116 compatibility must be checked against every
API used (the existing `chrome.action.openPopup()` path already catches unsupported/rejected calls).

## Existing evidence and acceptance gaps

`apps/extension/scripts/run-tests.mjs` runs Bun test files separately. Existing suites cover handlers,
vault-session transitions, mocked Desktop/native transfer, passkey matching/signing/persistence,
outbound queue, Sync events and popup reconciliation. They are useful regression specifications, but
their stubs do not exercise an offscreen document, actual service-worker suspension, actual owner
loss, an unpacked Extension/native binary, or Rust Replica durability.

There is one existing Playwright file, `tests/e2e/save-login-prompt.spec.ts`, with six declared cases
for capture/update/Vault selection/lock/encryption/form submission/cancellation. Its setup uses
`browser.newContext()` rather than an explicit persistent Extension profile, relies on generic Web
signup selectors, and waits for a service worker. `playwright.config.ts` supplies Extension launch
flags to the browser project, starts Server and Web, and requires a prebuilt `dist`. This is an
existing harness to inspect and repair, not current evidence that the cases pass. No run was made
during this inventory. It has no owner-loss, browser restart, offline mutation, multi-Account,
native messaging or real passkey scenarios.

Root `pnpm check:ci` runs package unit tests and shared Runtime Chromium tests, not this Extension
Playwright suite. The separate Extension job in `.github/workflows/ci.yml` builds and invokes its
E2E suite; neither a root check nor Web/Runtime browser acceptance substitutes for it.

Required Extension production evidence after Desktop acceptance:

1. Release build loaded as an unpacked Extension into a persistent Chromium profile; real Server
   Account creation/sign-in, offline Replica reads/writes, reconnect convergence, and persisted restart.
2. Popup/content-script concurrent wakes create one offscreen owner; broker termination/restart
   reattaches without locking; independently terminate Worker/document and prove a locked replacement.
3. Kill the actual owner with accepted work pending, reopen the same encrypted Replica, unlock and
   prove exactly one Server effect without replaying the original UI command.
4. Multi-Account reads/writes, selection, per-Account locks and teardown cannot cross Account scope.
5. Real Login/Card/Identity autofill and capture, TOTP update, passkey creation/assertion/cancellation,
   including lock during a pending prompt and persisted counter/outcome reconciliation.
6. Browser `connectNative` to the actual native messaging binary and running Desktop composition;
   prove Desktop lock authority, unlock, disconnect, owner replacement and revocation races.
7. Record real OS biometric acceptance separately. Linux/mocks alone cannot establish macOS/Windows
   biometric authorization or real Firefox/Safari Extension acceptance.

Recommended implementation order remains Desktop first, then shared missing Core bridge/passkey
capabilities, offscreen composition, production caller cutover, obsolete-owner deletion and full
Extension acceptance. Root-owned Wayfinder decisions/specifications/tickets determine actual readiness.
