# Extension production caller cutover

Sealed contract under [research98](../issues/98-extension-page-feature-and-caller-boundary.md) and
[delivery76](../issues/76-extension-production-caller-cutover.md). Research98 is resolved and76
is ready with incomplete dependencies after independent review. This specifies the existing product paths from the
[Extension inventory](extension-inventory.md), using sealed [74 composition](extension-composition.md),
[75 passkeys](passkeys.md), [79 own-Replica reads](../issues/79-connected-extension-item-read-authority.md),
[95 private Item commands](../issues/95-private-credentials-and-public-item-commands.md), and
[97 temporary native compatibility](native-legacy-compatibility.md). No implementation or production
acceptance is claimed. Desktop acceptance still precedes Extension implementation.

## Atomic entry and caller closure

Prepare every reachable caller before selecting74's production broker/offscreen assets in the
ordinary manifest and popup HTML. The release has one Core Worker and no legacy fallback.74's
bounded manifest/popup-bootstrap fixture does not establish this full caller closure;77 loads the
unmodified release package with all genuine UI, content and iframe entries.

| Actual entry or import | Required replacement/removal |
| --- | --- |
| `apps/extension/manifest.config.js`, `src/background/index.ts` | Activate74's exact packaged broker/offscreen assembly, Chrome116 minimum and existing approved permissions. Remove module-evaluation `createBackgroundCore`, `backgroundClientRuntime`, DesktopSync service construction and old worker lifecycle initialization.91 admission completes before ordinary Ready; failed-open maintenance remains reachable through the same owner. |
| `src/lib/crypto.ts`, `storage.ts`, `vault-runtime.ts` | Remove reachable static WASM CryptoPort, AccountStore, ItemCache and VaultCrypto/repository construction in every realm. Importing a route/provider must not instantiate an owner even before React mounting. Chrome storage/IndexedDB executors remain private74 primitives. |
| `src/popup.tsx`, `routes/__root.tsx` | One RuntimeClient; remove popup AccountVaultRuntime start, background-event storage reconciliation, `initializeStorage` and every `tryRestoreSessionWithoutPrompt`. Remove `GET_AUTH_TOKEN`-backed ApiClient and authenticated request rewriting. |
| PlatformProvider, ExtensionSyncProvider, account switcher, login/unlock/Vault/detail/settings routes | Consume80-style shared Runtime UI/session derivation and the closed controls below. No TS Account manager, outgoing queue, native/local unlocked union, five-second authority polling or raw credential restoration. UI active Account remains a pointer. |
| `src/content.ts` and `content-script/init.ts` | Preserve existing top-document Login/Card/Identity detection, form/AJAX capture, keyboard/field behavior and popup Fill. Replace message authority and plaintext Item delivery; no new all-frame ordinary autofill feature is implied. |
| `page-script/passkey.ts`, isolated passkey bridge, all-frame manifest entries | Preserve75's supported frame gestures and exact challenge semantics; use74's authenticated isolated-document connection and75's Core ceremony controls. Main-world options cannot register browser facts or invoke arbitrary Runtime requests. |
| Six web-accessible iframe entries | Autofill, Card, Identity, save prompt, passkey picker and save target retain their actual presentation/keyboard/resize behavior. Use74 EmbeddedPrompt scope and opaque choices; a directly opened/forged iframe is not FullUi or an Account authority. |
| Native DesktopClient/Sync/key-material/biometric/snapshot modules | Replace with68's Core consumer over74's native broker, own-Replica reads under79. Remove all13 protocol1 private/snapshot/biometric requests and97's temporary source encoding after the last old consumer is removed. Keep required closed nonsecret Desktop open/create/view handoffs and version/launch plumbing; do not delete the native transport indiscriminately. |

Startup, imports, route loaders, event listeners and stale callbacks count as callers. Delete obsolete
Extension modules after proving no reachable imports; shared transitional packages remain for actual
remaining hosts. No hidden token-export ApiProvider may remain merely because its current route looks
read-only. Preserve limited category detail and existing Desktop/Web editing, attachment, Share and
Import handoffs; do not add absent Extension product pages.

## Complete existing route disposition

`apps/extension/src/background/router/contract.ts` has47 routes. These groups are exhaustive. The
names below identify old callers, not a requirement to keep the legacy message registry. Generate
new cross-language controls from Rust under ADR0012;74 permits only each caller class's closed set.

| Existing routes | Destination behavior |
| --- | --- |
| `LOGIN`, `QUICK_UNLOCK`, `QUICK_UNLOCK_ALL` | Core Sign-in/password Quick unlock with explicit captured Account IDs, original Server/insecure-transport input, partial multi-Account results and68 Desktop handoff. No host SRP or new login secret. |
| `CHECK_AUTH`, `CAN_QUICK_UNLOCK`, `GET_SESSION_DATA`, `GET_SESSION_STATUS` | Runtime catalog/access/unlock availability and existing shared session derivation. Preserve the actual popup activity gesture described below. No Session/token/key projection or restoration. |
| `GET_AUTH_TOKEN` | Remove with authenticated popup clients; authenticated operations originate in Core. |
| `LOGOUT`, `LOCK` | Captured Account Sign-out and explicit existing lock-all gesture using Core lifecycle decisions. Do not turn Sign-out into Remove or Server deletion. Desktop ownership/refusal comes from68, not host availability heuristics. |
| `SYNC_CONNECT`, `SYNC_DISCONNECT`, `RECONCILE_ACCOUNT_SCOPE` | Remove host lifecycle orchestration; existing Core driver/Session eligibility owns connection and scope. Genuine user Sync controls, where present, use existing closed Core controls. |
| `GET_SYNC_STATUS`, `GET_SYNC_CLIENT_ID`, `GET_SYNC_COMMAND_SUMMARY` | Existing Runtime status/Operation projections and actual presentation identity where still consumed. No client ID/token escape merely to reconstruct a host queue or HTTP client. |
| `CLAIM_STAGED_ITEM_COMMANDS`, `ENQUEUE_ITEM_COMMAND`, `CANCEL_STAGED_ITEM_COMMAND`, `DRAIN_OUTBOUND_QUEUE` | Remove popup/worker queue handoff. Save/update accepts one Core Operation and returns its durable ID. Caller loss stops foreground waiting without cancelling already accepted work. |
| `GET_VAULT_ITEMS`, `GET_VAULT_ITEM` | Account-scoped own-Replica public Item projections, including readable pending/failed overlays,95 private-key exclusion and89 retained-result guards. Current detail/favorite/TOTP/copy/fill callers are included. |
| `GET_WRITABLE_VAULTS` | Existing Core writable catalog, scoped to the captured active Account for capture, with opaque target choices. No host authenticated Vault GET or role policy. |
| `CHECK_EXISTING_CREDENTIALS`, `SAVE_NEW_CREDENTIAL`, `UPDATE_EXISTING_CREDENTIAL` | Closed capture intent, candidate/target handles and accepted Create or95 private-preserving Update as defined below. |
| `SET_PENDING_SAVE_PROMPT`, `GET_PENDING_SAVE_PROMPT`, `CLEAR_PENDING_SAVE_PROMPT` | Replace global Chrome plaintext storage with the Core capture/handoff lifetime below. They do not survive as general storage or unscoped restoration controls. |
| `CHECK_AUTOFILL_AUTH`, `UPDATE_AUTOFILL_TIMESTAMP` | Core page-feature admission/activity result; five-minute confirmation uses the existing activity owner. A page cannot refresh arbitrary Account activity or impersonate popup confirmation. |
| `GET_AUTOFILL_ITEMS`, `GET_AUTOFILL_CREDIT_CARDS`, `GET_AUTOFILL_IDENTITIES` | Closed autofill candidates and guarded selected fill result below. No full Item transfer to content/iframe. |
| `PASSKEY_CREATE`, `PASSKEY_GET`, `PASSKEY_CANCEL` |75's closed Begin/Continue/Cancel and exact authenticated context; private signing, counters and outcomes stay in Core. |
| `CHECK_NATIVE_BIOMETRIC`, `NATIVE_BIOMETRIC_UNLOCK`, `NATIVE_BIOMETRIC_UNLOCK_ALL` |68 source biometric export/import controls using67's local ceremony, current Account selection and partial outcomes. Broker relays frames/cancellation; no MUK, Device-key, token or Vault-key host installation. |
| `OPEN_DESKTOP_APP`, `CHECK_DESKTOP_STATUS`, `TRIGGER_DESKTOP_UNLOCK` | Closed nonsecret Desktop application intent and68 source availability/Account projections. Preserve create/view and unlock handoffs; no v1 snapshot fallback. |
| `CAPTURE_TAB_SCREENSHOT`, `UPDATE_ITEM_TOTP` | Exact user-selected tab/window screenshot primitive and host QR decoding; Core validates/accepts the selected current Item TOTP patch through95. No screenshot API accessible as an arbitrary PageFeature request. |
| `OPEN_POPUP`, `SETTINGS_CHANGED` | Browser popup primitive with current unsupported/rejected fallback to toolbar; replace settings notification with the existing Core setting command and observer. |

`FILL_ITEM` is an additional popup-to-content route outside this registry:
`lib/autofill-active-tab.ts` sends a full Item to whichever tab is active after an await;
`content-script/init.ts` checks only Extension ID. Replace it with the same guarded autofill delivery
as overlay selection. Popup chooses an Item and an authenticated target document; it does not forward
its retained projection as fresh filling authority. Tab switch/navigation during preparation cannot
retarget the result.

## Closed autofill controls and presentation

Use74's existing private attachment, caller capability and authenticated document/activation facts;
there is no second context registry. Ordinary autofill remains top-document as in the current
manifest. Do not apply WebAuthn RP rules to password matching or broaden ordinary autofill into
iframes merely because75 supports them.

A generated BeginAutofill input identifies category (Login, CreditCard or Identity), initiating
field/popup selection mode and74 context. Its active Account comes from the trusted UI selection
binding below, not a page-supplied Account ID. Core captures the current Account incarnation and
creates one foreground intent with bounded opaque choices. It refuses Locked, retired, hidden or
pending-verification reads through the existing guard.

Use one Core autofill matcher for category inclusion, hostname relevance, usefulness and typed-query
matching. It reads the current private Item through95 and emits already filtered, ordered display
candidates. The browser keeps field detection, form grouping, keyboard navigation, localized display
formatting and DOM placement; it does not keep another matcher or receive private search fields to
reconstruct one. QueryAutofill carries the existing intent/revision and query; responses identify the
current query revision so a late result cannot replace a newer list or authorize an old selection.
Empty query uses the same matcher and initial ordering. The existing
[filters](../../../apps/extension/src/lib/item-filter.ts),
[ranking](../../../apps/extension/src/lib/autofill-ranking.ts) and
[category handlers](../../../apps/extension/src/background/autofill-handlers.ts) fix this mapping:

| Category | Core candidate inclusion and query fields | Display fields, alongside intent/revision and opaque choice |
| --- | --- | --- |
| Login | Category `login`; positive hostname score across primary `url` and secondary `urls`. Query weights: username60, email55, title50, primary URL30. Password is never searched; secondary URLs affect hostname relevance, not typed-query matching. | Title, optional username, public favicon URL/domain/fallback data required by the existing Favicon renderer. No password or TOTP seed. |
| CreditCard | Category `credit-card` with a nonempty card number. Query weights: title60, cardholder name50, full card number40. The old filter's comment says last four digits, but its actual expression searches the full value; preserve that matching inside Core. | Title, masked number, optional expiry date, existing closed brand enum (`visa`, `mastercard`, `amex`, `discover`, `diners`, `jcb`, `unionpay`, `unknown`). Strip whitespace before masking; show `•••• ` plus the last four characters, or `••••` for fewer than four. No full number, cardholder name or CVV is required for this picker. |
| Identity | Category `identity`. Query weights: first name60, last name60, email55, title50, middle name40, and each address's nonempty street/city/state/zip/country joined with spaces20. | Display name from nonempty first/middle/last name joined with spaces, falling back to title; optional email and the first address's city/state preview. No full address or phone collection is required for this picker. |

The three existing iframe renderers remain the presentation reference:
[Login](../../../apps/extension/src/autofill-iframe.tsx),
[Card](../../../apps/extension/src/credit-card-autofill-iframe.tsx) and
[Identity](../../../apps/extension/src/identity-autofill-iframe.tsx). Favicon data derives from the
Item's public URL and its actual Account Server, preserving the existing renderer's fallback; the
page cannot supply another Server for that projection. Identity's address preview joins nonempty
city/state with `, `; its subtitle joins email and that preview with ` · `. Neither card nor identity
query adds Vault-name or Account-email matching merely because the old comments mention them.

Preserve the existing hostname normalization and password-manager domain matching, including its
current suffix handling. The best score across nonempty primary/secondary URLs wins: exact host100,
item parent80, item child70, sibling registrable domain40; zero is excluded. Equal hostname scores
use favorite first, newest `updatedAt` next (missing/invalid timestamp is zero), then the existing
title ordering. Card/Identity start with that usefulness order without a hostname dimension. Query
matching lowercases and trims query and field values, takes the best field score with exact-match
bonus20, prefix bonus10 or substring bonus0, excludes zero scores, and sorts descending while
preserving the initial order for ties. Empty query preserves initial order. Carry the existing
normalization, ordering and masking vectors into the shared Core matcher; do not replace this with
WebAuthn RP policy or expose the private inputs to share the algorithm with TypeScript.

SelectAutofill carries intent/revision and opaque choice, never a caller-supplied Item. Core rereads
the selected current readable Item under95's guard and emits only these category-specific fields:

| Category | Guarded final fill result |
| --- | --- |
| Login | Optional username and password, plus a freshly generated TOTP code and its validity when the current Item has TOTP. No raw TOTP seed. Existing username/email field placement uses the username value. |
| CreditCard | Card number, expiry date, CVV and cardholder name, preserving each field's absence. |
| Identity | First name, last name, email, date of birth, the first phone number, and only the first address's street/city/state/zip/country. Preserve absence; the current fill algorithm does not use middle name or additional phone/address entries. |

The field algorithms in
[credential](../../../apps/extension/src/content-script/autofill/credential.ts),
[credit-card](../../../apps/extension/src/content-script/autofill/credit-card.ts) and
[identity](../../../apps/extension/src/content-script/autofill/identity.ts) remain DOM mechanics.
An explicit popup Fill may choose an eligible Item that is not the top suggestion, but is not an
arbitrary-site override: current `fillCredentialItem` checks `hostnameMatches` against the primary
Item URL immediately before filling. Preserve this mode-specific primary-URL check in Core's final
admission against the authenticated target document, even though overlay candidate ranking includes
secondary URLs. CreditCard and Identity retain their current field/form scopes without inventing
Login hostname restrictions for those categories.

Freeze the Account, Item identity/readable source and exact document/activation for final
disclosure.74 performs
live correlation checks at each hop; content checks its current field/popup action generation and
connected document immediately before DOM writes. Cancel on replaced selection, departed field,
pagehide/BFCache activation retirement, Account/Item retirement or connection loss. Already delivered
plaintext cannot be recalled; do not claim erasure of values already filled into the page.

Reuse66's closed Item TOTP request/algorithm for both the actual popup `InlineTotpRow` and content
OTP filling. No caller supplies raw secret or clock to a primitive crypto invocation. Preserve
single-input and4–8 segmented OTP behavior, supported algorithms/digits/period and expiry checks.
Current visible secret/copy/detail behavior remains separate authorized presentation, not a reason
to implement HMAC in content. QR scanning binds the selected Item and screenshot target before async
capture/decode; late results cannot update a replacement Item or discard its private passkeys.

### Trusted UI selection binding

The active Account remains a UI pointer, using the existing
[ActiveAccountStorage and RuntimeSession derivation](../../../packages/client-runtime/src/client/session.ts)
and91's admitted preference. Extend74's existing private caller admission with one closed UI
selection update admitted only from the authenticated compiled Full UI. Its storage adapter writes
through this route, so multiple UI connections do not maintain competing selections. Offscreen
routing retains only the nonsecret Account ID or null, selection revision and owner generation;
it reconciles the pointer against RuntimeStatus with the existing shared derivation. This is not
another Account/Session snapshot or a Core policy that chooses which Account the UI should show.
Neither PageFeature nor EmbeddedPrompt can submit this control or choose an Account for a page
feature.

The trusted Full-UI/broker route passes a minted selection binding to the generated feature
admission; Core captures its exact current Account incarnation with the foreground scope. Changing
selection synchronously fences the old page/prompt routes and cancels their unaccepted feature
intents before admitting the new binding. A continuation carries the captured binding rather than
reading the current pointer again. Accepted Operations remain owned by Core. Broker reattachment
can obtain the surviving owner's current selection binding but cannot rebind an old caller or
intent. Actual owner loss reconstructs only the existing nonsecret preference under a new owner
generation; no old foreground work returns. Apply the same binding to BeginCapture below, retaining
its original Account through an allowed document handoff.

## Capture scope and navigation handoff

Source evidence fixes the Account selector: `AccountVaultRuntime.reconcile` hydrates all unlocked
Accounts but installs only the active unlocked Account into `setLocalActiveAccounts`;
`VaultRepository.getAll()` reads that active scope. Desktop snapshots also target the active Account;
`GET_WRITABLE_VAULTS` uses that Account. Therefore BeginCapture captures ONE active Account and its
incarnation, not all unlocked Accounts. Resolver fallbacks scanning other Accounts by bare Vault/Item
ID are not a broader target-selection feature. No active/unlocked Account yields the existing
unavailable state, not a search across other Accounts.

BeginCapture takes the current74 top-document binding and actual user-entered username/password,
original URL/hostname and capture trigger. Existing form-submit and successful AJAX detection stay
host mechanics; they are not trusted evidence of Server authentication or a reason to persist a
Session. Core owns a zeroizing unaccepted intent and returns capture ID, prompt revision, duplicate
metadata and opaque current-Account Vault/Item choices. Compare credentials using the existing
hostname/username/password semantics; comparison against the private current Item happens in Core.
Do not return the existing stored password merely to show `hasChanges`.

Capture's input is allowed to exist in the live source page and the genuine bounded save UI. It must
not be serialized into the global `bittery_pending_save_prompt` Chrome record. The current record
contains no Account, tab, timestamp or expiry; every new document restores it. That accidental global
replay is not behavior to preserve. Broker recycle preserves the intent in its surviving offscreen
owner; actual Core owner loss retires it and does not restore it from Chrome session/local storage.
It is not an accepted Operation or recoverable plaintext archive.

Core sets `expiresAt = BeginCapture admission time + 30 seconds` before preparation can await.
This deliberately moves the existing30-second duration from the old post-preparation/display timer
to one total intent budget covering preparation, pre-presentation navigation, redirects and display.
There is no existing total preparation deadline to retain: `lib/messaging.ts` directly returns the
Chrome message promise, and the router awaits startup/handler completion without a timeout. Native
per-call timeouts do not bound the full capture path. Do not add a second duration or let first
presentation, a host acknowledgement, failed mounting or navigation postpone/reset this deadline.

The same-tab intent may continue preparing after its original document departs, within that original
budget; limiting handoff to an already-presentable prompt would drop actual form-submit navigation.
Expiry cancels outstanding preparation, retires the zeroizing intent and rejects late candidates,
claims and Save/Update acceptance. Explicit dismissal and replacement do the same. A fresh
independent capture gesture creates its own intent; replay does not. Successful Save retains the
current two-second success display, but the accepted Operation already belongs to Core and its draft
is no longer a resumable intent. The deadline does not cancel an Operation already durably accepted.

A form submission may navigate before or after the prompt appears. The registered capture records
a same-tab top-document handoff eligible for its original capture, not an arbitrary page feature
rebind. On old document departure, discard old route/prompt references and preserve only that Core
intent for the same browser profile/tab.74's newly authenticated top-document connection can claim
the successor; Core atomically replaces the one live binding and prompt revision. Further login
redirects repeat this replacement under the original deadline. A delayed old claimant, old iframe
choice, another tab/profile, or replay cannot read/accept/clear the successor. Preserve the original
captured URL and Account even when a login redirects across origins; do not reinterpret the new
page's origin as the credential's URL. Never disclose the capture through the new page's main-world
bridge. Tab closure, explicit cancel, Account selection departure/Lock/replacement/removal, owner
loss and expiry retire the pending intent. Fresh Account selection requires a new capture gesture.

SaveCapture/UpdateCapture carries only current capture/prompt revision, selected opaque target and
actual user edits made in the authenticated save UI. Core validates the final document/Account,
current Vault authority and selected readable Item source, then uses existing Create or95's guarded
private-preserving Update admission. Duplicate submit returns the same acceptance outcome/Operation
identity while the live result is retained; it cannot create another Operation. A changed target or
stale source requires a fresh displayed selection. No automatic fallback from failed Update to
Create, cross-Account destination, or password equality to permission. Offline acceptance follows
the same existing Core capability as online acceptance.

## Activity, the five-minute prompt and inactivity selector

The name `needsReauth` does not describe a password ceremony. Current
`CHECK_AUTOFILL_AUTH` checks `now - lastActivityAt > 5 minutes`; its overlay opens the popup through
`OPEN_POPUP`, whose handler only calls `chrome.action.openPopup()` and reports failure. The toolbar
is the fallback. Popup `CHECK_AUTH` stamps activity if authenticated and unlocked; Vault list/detail
reads do too. Successful candidate fetch and autofill selection also stamp activity. Preserve this
observable confirmation without requiring a new password, Session or Core unlock.

Use the existing Core `InactivityState::Activity { account_id, incarnation, received_at_ms, revision }`
and Core clock/receipt ordering in `runtime/inactivity.rs`. Extend this owner with the closed page
admission result and internal reuse of an authenticated gesture receipt; no host timestamp or second
activity state. A passive stale-autofill status check does not renew its own five-minute grace. Existing GET_AUTOFILL handlers stamp activity before checking policy; the closed Core feature must evaluate the five-minute eligibility before recording a content-originated candidate request. Otherwise a caller could bypass the existing confirmation by invoking the read directly.
A trusted popup's actual active-Account access/focus supplies the existing confirmation; a background
poll/observer update or page payload claiming to be popup cannot. An admitted candidate request,
selection, capture or other migrated existing activity trigger records its captured current Account
through that same owner. Locked/unavailable requests cannot create authority. A late receipt for an
old Account incarnation cannot overwrite the successor; mere confirmation never unlocks another
Account or bypasses68/71 guards.

The apparent single Device preference is actually per-Account persistence: AccountStore
`storeAutoLockTimeout(ms)` calls `requireAccountId()` and writes `account:<ID>:auto_lock_timeout`;
its getter resolves the active Account likewise. Fresh Accounts use the existing ten-minute default,
not the previously selected Account's value. The settings UI shows one selector, writes the captured
actual active Account ID and is disabled while Desktop manages the lock. Preserve this behavior and91
preference admission; do not introduce a new global persistent timeout or a new per-Account UI.

The timer's effect is Device-wide. Core already holds one activity receipt, selects the referenced
Account's stored timeout, and at expiry retires the admitted unlocked Account set; a disappeared
selector falls back to ten minutes. Reuse this algorithm, including Never and unreadable-policy
failure, and activate it for the migrated Extension once its actual activity inputs are wired. The
browser performs timer scheduling only through the existing Runtime driver; remove Chrome-alarm
policy and the old vault-session timer. Selection/focus uses an explicit captured Account receipt,
so a later implicit active-pointer read cannot change which preference was written or evaluated.

Desktop-managed availability and lock admission must derive from68's existing Core native-state
owner. This integration is required delivery work in76: current `runtime/inactivity.rs` has no native
ownership check, and67/68 do not establish automatic Extension inactivity suppression. Add the closed
predicate to the existing owner/algorithm rather than a host `desktopMode`, second state cache or
an Account-grant-only timer rule.

Preserve the actual distinct selectors: the old automatic countdown is suppressed while its Device
access owner is Desktop (`vault-session/transitions.ts` ownershipEffects); popup manual Lock is
refused whenever `desktopConnected`, even if local state remains (`LOCK_REQUESTED`, source `popup`).
`auth-handlers.ts` propagates `desktop_owns_lock`; the Vault footer hides the action and the Account
switcher handles the same refusal. Sign-out uses source `logout` and is not refused by that predicate.
Apply popup refusal at the future Core user-request admission, not the shared lock/retirement engine;
internal selective retirement, Sign-out, Remove and Wipe remain unaffected. Map these observable
decisions to current authenticated Core native ownership/connection facts under
the [native transfer contract](native-transfer.md). This is neither a blanket teardown ban nor a
claim that protocol1 locks are selective. Channel/source transitions wake and revalidate the same
inactivity owner; no stale timer can act on the prior predicate. Test mixed independent/borrowed
Accounts, popup Lock and Sign-out separately in76's acceptance.

## Browser primitives, preferences and lifecycle

Keep screenshot, popup opening, clipboard, Desktop/Web launch, native port, document registration,
field detection and pure presentation in the existing host adapters. Bind asynchronous primitives to
the initiating UI/document scope. A caller may not request arbitrary Chrome storage keys or promote
its own browser role.74's local/session `TRUSTED_CONTEXTS` restriction is whole-area: preserve the
existing iframe theme preference/applied cache in Extension-origin `localStorage`, media/storage
events, and narrowly relay actual nonsecret preferences if an import audit discovers a content
consumer. There is no observed direct content-script Chrome-storage preference read to retain.

Sign-in/default Server URL and active Account display remain explicit nonsecret UI input/projection.
Sign-out uses Core and preserves its accepted-work contract. There are no existing popup Remove,
Wipe, Server deletion, Recovery, Share, Import or attachment CRUD routes to claim migrated; do not
silently add them.74/91 failed-open admission/cleanup/recovery access still must be reachable without
starting the old owner. Broker reattachment preserves a live standalone owner; native channel loss
retires its grants; actual Worker/offscreen loss reopens Locked. Eligible frozen ciphertext
Operations can dispatch/reconcile while Locked with usable Session; key preparation waits for
supported unlock. Hosts add no universal unlock-before-Sync rule.

## Observable acceptance before76 closure

1. Load the actual release entries and six iframe routes in Chrome116+ and a current supported
   Chromium build. No import, popup navigation, content wake or native event creates a second owner.
   Use77's unchanged package for complete production evidence, not74's assembly substitutions.
2. Exercise every route group above and `FILL_ITEM`, preserving active-Account/all-Account gestures,
   limited detail, existing matching/ranking, Desktop/Web handoffs and toolbar popup fallback.
3. Hold candidate/selection/TOTP/QR/Fill delivery over field/tab navigation, BFCache, lock, selective
   hide, Account replacement and Item update. No stale final delivery; unrelated current Account
   paths remain usable under68's actual selectivity. Forged page/iframe messages cannot obtain roles,
   candidate secrets or arbitrary Core requests.
4. At five minutes, show existing confirmation; open popup without a password while still unlocked,
   then resume autofill. Passive checks cannot renew grace. Record Core clock/receipt ordering and
   old-incarnation rejection. Test selected Account timeout persistence, new Account ten-minute
   default, Never, setting/selection races, global timer effect and Desktop-managed behavior.
5. Capture traditional submit and successful AJAX, unchanged-password suppression, new Save and
   Update, readonly refusal and actual writable target selection. Follow same-tab multi-redirect
   navigation under the original deadline; another tab, old document/iframe or expired capture cannot
   claim/accept/clear it. Preserve dismissal and two-second success UI. Broker recycle survives;
   actual owner loss/lock/tab closure retires unaccepted plaintext without any Chrome draft record.
6. Accept capture/TOTP changes offline, close popup/owner after acceptance, reopen the same Replica,
   and prove exact original Operation IDs/one Server effect through reconnect. Failed/pending local
   Item edits preserve95 private credentials. Frozen work remains governed by Core while Locked.
7. Use actual browser native messaging with the running migrated Desktop. Prove68 source/consumer
   loss and Account isolation,75 real-page ceremonies, and no protocol1 snapshot/secret fallback.
   Record genuine OS biometric evidence separately. Verify old97 code is unreachable after cutover.
8. Repeat whole import/route audit, preference/theme behavior under restricted Chrome storage,
   populated91 profile admission and failed-open maintenance. Run required complete checks and77
   acceptance; earlier Web/native capability tests do not establish these product paths.
