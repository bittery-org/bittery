# Native compatibility for the unmigrated Extension

This reviewed contract answers [research96](../issues/96-legacy-native-compatibility-boundary.md) and
scopes [delivery97](../issues/97-runtime-legacy-native-compatibility.md). It is not an implementation
or acceptance claim. The accepted Desktop-first sequence and
[native transfer68](native-transfer.md) require the existing protocol1 Extension adapter until76.
Ticket66's atomic activation cannot leave its current Desktop storage/decryption owner reachable.

## Existing wire and consumers

The sole Rust wire definition is [desktop_ipc.rs](../../../apps/desktop/src-tauri/src/desktop_ipc.rs),
generated into Desktop TypeScript and imported by the Extension. Preserve protocol version1,
`protocolVersion`/`requestId` envelope optionality, existing mismatch replies, discriminant spelling,
number timestamps, omitted versus null values and the current tolerant optional UI-intent/theme
decoding. No new browser-visible protocol version or parallel handwritten TypeScript schema is needed.

[DesktopClient](../../../apps/extension/src/background/desktop-client.ts),
[DesktopSync](../../../apps/extension/src/background/desktop-sync.ts),
[native messaging](../../../apps/extension/src/background/native-messaging.ts),
[key hydration](../../../apps/extension/src/background/desktop-key-material.ts),
[snapshot validation](../../../apps/extension/src/background/desktop-snapshot.ts) and
[biometric transfer decoding](../../../apps/extension/src/background/biometric-transfer.ts) are actual
consumers. Their current caches and local Account/Operation owner remain until76; this capability
does not copy those policies into Desktop or move their accepted work.

| Request and exact request fields | Existing response and fields | Consumer and source mapping |
| --- | --- | --- |
| `PING` | `PONG {version}` | Native availability/version plumbing; application version remains host data. |
| `GET_DESKTOP_STATUS` | `DESKTOP_STATUS {available, locked, unlockedAccounts, timestamp, autolockTimeoutMs, theme?}` | DesktopClient/DesktopSync; Core supplies current lock/Account eligibility and67 timeout projection. Theme is the existing nonsecret host preference. A live failed-open process is not fabricated unlocked authority. |
| `GET_DESKTOP_ACCOUNTS` | `DESKTOP_ACCOUNTS {accounts, activeAccount, unlockedAccounts}` | DesktopSync installs identity/display metadata into its existing local AccountStore. Use current Core catalog/metadata, never a published legacy key-reference view. `activeAccount` is nullable UI selection, not authority. |
| `GET_DESKTOP_AUTH_TOKEN {accountId}` | `DESKTOP_AUTH_TOKEN {accountId, email, authToken, expiresAt?, userId?}` | DesktopClient/key hydration; source-only privileged current effective Session disclosure for the exact Account, with current usability checked again at encoding. No independent refresh or persistent token copy. |
| `GET_DESKTOP_VAULT_KEYS {accountId}` | `DESKTOP_VAULT_KEYS {accountId, email, vaultKeys}` | DesktopClient/key hydration; `vaultKeys` is a JSON string of existing wrapped-key records selected by current Core visible authority. It is not plaintext Vault keys or a cache-derived list. |
| `GET_DESKTOP_ITEMS_SNAPSHOT {accountIds?}` | `DESKTOP_ITEMS_SNAPSHOT {items, generatedAt}` | DesktopClient/snapshot validation; privileged full private Item payload described below, read through Core and guarded through encoding. Missing/empty target list means the captured currently eligible unlocked Accounts, matching the existing request behavior. Explicit locked Accounts contribute no Items. |
| `SUBSCRIBE_DESKTOP_EVENTS`, `UNSUBSCRIBE_DESKTOP_EVENTS` | `DESKTOP_EVENT_SUBSCRIPTION {subscribed}` and `DESKTOP_EVENT` variants below | Existing native event connection plus Core source observation, closed with that peer. Host observes Core facts; it cannot publish lock/unlock authority from renderer assertions. |
| `CHECK_BIOMETRIC_AVAILABLE` | `BIOMETRIC_STATUS {available, enabled, appRunning}` | Native messaging; reuse67 availability/preference projection. Host only provides OS availability, not Session validity or release policy. |
| `BIOMETRIC_UNLOCK_REQUEST {challenge, extension_id, accountId?}` | `BIOMETRIC_UNLOCK_SUCCESS {accountId, email, encrypted_session, device_key, signature, auth_token?, vault_keys?}` or `BIOMETRIC_UNLOCK_FAILED {error}` | Existing single transfer decoder. Capture explicit Account or current active Account before the ceremony; never retarget after an await. Delegate67's actual local ceremony and reuse Core source transfer construction, with no invented destination. |
| `BIOMETRIC_UNLOCK_ALL_REQUEST {challenge, extension_id}` | `BIOMETRIC_UNLOCK_ALL_SUCCESS {device_key, signature, accounts, unlocked, failed}` or `BIOMETRIC_UNLOCK_ALL_FAILED {error}` | Existing all transfer decoder. Capture the exact eligible catalog target set; one67 prompt, per-Account results. Disabled biometric Accounts are omitted as today, failed eligible Accounts enter `failed`, and no successful Account yields the existing failure variant. |
| `TRIGGER_DESKTOP_UNLOCK` | `TRIGGER_DESKTOP_UNLOCK_RESULT {success, error?}` | Foreground the existing Desktop unlock UI. It grants no access and does not directly execute a host biometric/storage path. |
| `OPEN_DESKTOP_APP {intent?, url?, itemId?, vaultId?}` | `OPEN_DESKTOP_APP_RESULT {success, error?}` | Existing `create_item`/`view_item` UI intents. Keep the compiled Desktop UI target, form prefill and current active-Account navigation; no private data or mutation authority is returned. |

Every request retains existing `ERROR {message}` and protocol mismatch behavior where applicable;
errors contain no secrets. Transport cancellation closes the invocation rather than inventing a new
browser-visible cancellation variant. Preserve the existing native binary's absent-Desktop launch/
status behavior without using it to manufacture a ready Runtime or bypass profile admission.

`DesktopAccountEntry` is exactly `accountId`, `email`, `userId`, `name`, `secretKeyHint`, optional
`teamName`, nullable `teamAvatarUrl`, numeric `addedAt`/`lastActiveAt`, and `biometricEnabled`.
These are already represented by Core Account metadata. It has no `serverUrl` or transport-consent
field: the old DesktopSync consumer supplies its own configured Server URL and false HTTP consent.
Do not silently insert a new transfer guarantee or infer identity from equal emails. Tests preserve
exact Account IDs and exercise the existing configured-Server consumer; protocol2's explicit Server/
User/destination binding remains separate.

`vaultKeys`/`vault_keys` encode the same array shape: `vaultId`, `vaultName`, `vaultType` (`personal`
or `team`), `encryptedVaultKey`, `role` (`owner`, `admin`, `member`, `read-only`), and optional nullable
`vaultIcon`/`vaultImageUrl`. Preserve the existing compatible wrapper bytes and role/type conversion;
never reconstruct a hidden Vault from a retained Operation. `AccountUnlockData` is `accountId`,
`email`, `encrypted_session`, optional `auth_token` and optional `vault_keys`.

Biometric `encrypted_session` remains Base64 of UTF-8 JSON for the existing Device-key wrapped MUK
`EncryptedData {algorithm, ciphertext, iv}`. `device_key` remains the existing Base64 Device key for
that local privileged transfer, not a new secret or persisted compatibility document. Single
`signature` remains Base64 of `challenge + ':' + encrypted_session`; all-Account `signature` binds
`challenge + ':' + accounts.length`. The existing decoder checks this correlation and exact Account
membership. It is not a MAC, signature or proof of destination generation; preserve the algorithm
without repeating misleading authentication claims. Reuse the existing Core wrapping/serialization
owner, with temporary secret buffers disposed after delivery/refusal. Refusing an old reply means
the consumer rejects a reply correlated to a different current request, or the captured source scope
has retired. Do not add an input-challenge replay cache: a new authorized ceremony using the same
correlation string is not forbidden by this wire.

`DESKTOP_EVENT` preserves `lock {reason,timestamp}`, `unlock {accounts,timestamp}`,
`desktop_close {timestamp}`, `active_account_changed {accountId,timestamp}` and
`theme_changed {theme,timestamp}` under the current `event`/`payload` tagging. Core lock/removal/native
authority changes drive the existing lock/unlock invalidation behavior; loss of the subscribed
browser/native relationship and actual application shutdown drive close. Completing or closing one
ordinary per-request socket never publishes global `desktop_close` or retires other requests.
Renderer reload, detachment or window destruction does not claim
the process owner closed. UI active-Account/theme changes remain nonauthorizing, and active IDs must
be current catalog members. Reuse the existing source observation and transport connection state,
not a second host Account registry or poller. Each connection preserves its observed ordering; an
event does not replace Core's final delivery check or establish a global order across sockets.

Protocol1's lock event has no Account ID, and its existing `clear_keys` consumer invokes C1
`lockAllAccounts`. Preserve that coarse consumer behavior during this temporary boundary. Isolation
assertions for held source delivery concern the Core source and unaffected source peers; they do not
invent a selective protocol1 consumer acknowledgement or protocol2 granularity. The migrated76
consumer must satisfy68's actual selective Account authority contract.

## Privileged private Item snapshot

The current [native builder](../../../apps/desktop/src-tauri/src/lib.rs) merges the full decrypted
Item object with `id`, `vaultId`, `category`, `favorite`, `createdAt`, `updatedAt`, `accountId`,
`accountEmail` and `vault {accountId,id,name,type,icon,imageUrl}`. Multi-Account requests additionally
carry `account {email,userId,name}` when the captured requested/default target-list length exceeds
one, matching the current builder. These explicitly inserted source metadata fields overwrite any
same-named decrypted payload fields; all other payload fields remain unchanged. The builder does
not independently add cached `deletedAt`, `version`, optimistic-failure/status or Attachment metadata
to the wire. Preserve existing optionality rather than silently spreading a Core projection's
additional metadata into this format. The current Extension validator deliberately spreads the remaining Item fields: Login
passkeys/private key, password history, TOTP, custom fields and all category-specific data are real
consumed private content. Redacting passkeys through95's ordinary projection is not compatible.

Keep this privilege inside the existing Core native source capability, admitted only for the old
authenticated native peer. Deepen the same private Item read/format owner used by95's explicit
transfers; keep the legacy formatter a closed encoding, not an arbitrary field/key selector or a new
Item repository. Ordinary Item projections, renderer commands, Share and protocol2 source snapshots
retain their own public/no-Item contracts. The native binary cannot decrypt, inspect keys or receive
a reusable private-read handle.

Selection is exact: the legacy builder filters a cache row when its outer `deletedAt` is non-null
before decrypting; the Extension snapshot decoder does not supply a second trash filter. Core's
ordinary Items projection includes trash, so copying that entire list would change native reads.
First reuse Core's existing effective Item selection: current active-generation authority, replaced
by its currently readable local overlay for the same Item, with a permanent-delete overlay
suppressing the authority row. Then include only effective rows whose `deleted_at` is `None`.
A pending Trash therefore removes the Item, a pending Restore exposes its current readable payload,
and a pending permanent delete cannot reveal the older authority row. Pending Create/Update and a
readable Failed local overlay retain the existing Core source precedence and payload; the legacy
format adds no new execution/status field. This does not reconstruct an overlay from held/frozen
Operation ciphertext when the existing read owner has erased or refused it. Reuse that selection
owner rather than writing another native authority/overlay merge. Preserve all five categories.

The current validator normalizes `favorite`, string timestamps and Vault type, and validates Item/
Vault IDs and title; it keeps all other plaintext fields. Current Core authority supplies actual
Vault identity/name/type/icon/image rather than the legacy builder's corrupt-cache `Unknown`
fallback. Tests compare actual compatible payload metadata precedence and null/optional fields.

Capture every actual
Account/Vault/Item source guard and its foreground loan. Recheck identity, current visibility,
usable access, readable revision and source connection at final encoding. Lock, Travel verification
pending, hide, replacement, removed Item, source loss and a replaced local overlay cannot authorize
the stale result. A failed component makes the already prepared aggregate response unavailable;
the next ordinary request can form a fresh permitted aggregate. No hidden key can be unwrapped while
filtering the list. Inaccessible or malformed records use the existing read owner's failure behavior,
without falling back to legacy storage or fabricating an `Unknown` Vault authority row.

Offline access stays distinct from authenticated transport. Item snapshots require existing live
local access, the current readable Vault key and71's verified/offline policy rules; they do not
require a successful network request or add `GET_DESKTOP_AUTH_TOKEN`'s usable-Session gate to the
private read owner. Wrapped Vault-key snapshots likewise use current permitted local authority.
`GET_DESKTOP_AUTH_TOKEN` releases only a locally usable effective Session, never an expired token
because another read succeeded. Biometric release reuses67 exactly: its existing locally usable
stored Session, preference, re-entry and verified/offline policy checks still apply, but there is
no added online Session-validation requirement or `finish_login`. Missing/expired Session keeps67's
password-unlock-required result. Optional auth-token/key fields retain their wire optionality; the
old hydration consumer may use its independently stored usable material when absent. This does not
promise an offline Server write or manufacture credentials when either owner lacks them.

## One source owner and delivery lifetime

Extend the existing private Core native-authority module with a closed legacy source mode and request/
response encoding methods. This is not renderer `RuntimeRequest`, protocol2 `PrepareImport`, or a
second Runtime. It installs no destination grant, challenge registry, Session mirror, MUK store or
new retry policy. Ordinary protocol2 controls remain unchanged; its destination validation cannot be
satisfied using a fabricated owner/channel/incarnation for this older consumer.

Reuse the native binary's validated launch origin and existing required Desktop-side OS peer check.
Carry that origin into the existing internal native handshake with a closed legacy mode before
admitting old secret requests. This internal socket envelope is generated/typed separately from the
unchanged browser protocol1 envelope. The Desktop validates it with the same allowlist parser;
`extension_id` in old biometric input must match that authenticated origin and never establishes it.
No raw browser frame can register itself as a trusted native source. Keep the existing socket/pipe
listener owner and native binary; no second endpoint or executable is required.

The existing source attachment owns its exact peer, invocation cancellation and observations.
For legacy per-request sockets, EOF while a prompt/read is pending cancels that invocation and
retires its source scope; a separate event subscription retains only its own observation.
The actual [legacy native-host loop](../../../apps/desktop/src-tauri/src/native_host.rs) currently
awaits `handle_request` before reading stdin again and uses an unbounded response channel. A held
OS prompt/IPC response therefore hides browser EOF from Desktop; fixing only Desktop's socket EOF
handler is insufficient. Adapt this actual loop through68's existing bounded frame-reader/writer
pattern: browser stdin/port EOF or stdout writer failure cancels outstanding request sockets, closes
the event subscription and disposes queued secret responses while work is pending. Preserve partial
frames and existing reply correlation/order; no new poller, native policy owner or parallel uploader.
Reuse68's dedicated native-process shutdown behavior so an outstanding OS-backed stdin read cannot
keep a retired browser port process alive. Test browser EOF before releasing the held prompt callback.

Core captures Account incarnation/User/epoch, current local access and applicable Vault/Item guards;
Session-disclosing responses additionally bind their effective Session. Recheck after awaits and at
encoding. Use the existing Account execution/publication/foreground owners rather than holding
execution across an unbounded transport wait or adding new cancellation policy.

Biometric one/all calls reuse67's preference, re-entry, availability, prompt serialization and partial
results. Source release requires the current successful local ceremony; late prompt completion
cannot release removed/replaced/locked Accounts. There is no `finish_login`, new Session, password
escrow, or independent native keychain interpretation. Preserve unrelated Accounts and source ports.
Ticket71's pending-policy and verified selective-erasure gates apply to fresh native disclosures;
retained accepted-work ciphertext is never native read authority.

There are two writer boundaries. At Desktop-to-native-binary admission, the existing Core delivery
lease checks the captured source immediately before guarded encoding and releases only that admitted
response. Cancellation/retirement before admission refuses it; bytes already written are released
to that peer and cannot be recalled by Core. The native binary's bounded Chrome-output queue owns
those bytes until its writer/port disposition; it drops them on its known connection retirement or
write failure. An event arriving on another socket does not retroactively establish that those bytes
were never released. No host `String` cache or delayed write is described as a still-valid Core guard.

The actual old consumer also has a transport race to correct within97: `NativeMessagingClient`
resolves any matching pending request after delivering a lock event, `DesktopClient` can repopulate
its cache after that await, and `DesktopSync` currently awaits saved mode state before clearing it.
Add only a delivery generation to these existing transport/cache owners: Core-derived lock/close/
authority invalidation and native-port retirement synchronously invalidate pending old replies and
cached presentation before asynchronous event persistence/handling. Bind callbacks to the actual
current Chrome port; a replaced port cannot dispatch events or results into its successor. Check the
captured delivery generation again after an awaited response and before cache publication or existing
biometric-material installation. Reuse this one transport lifetime guard; do not copy Account, Travel,
Session eligibility, cryptography or retry policy into TypeScript. Later authorized requests capture
the new generation only after the material drain/cleanup gate below permits acquisition. The accepted
Extension Operation owner remains unchanged.

The guard spans actual consumers, not only response decoding: key hydration awaits token/key writes
and `tryRestoreSession`, while biometric one/all awaits key import, Travel verification, AccountStore
writes and final live-key publication. AccountStore setters themselves contain awaits. Deepen the
same NativeMessagingClient delivery lifetime with a bounded material-mutation lease identified by
delivery generation, exact Account and invocation. Serialize material-changing calls for the same
Account through that gate so two nested setters cannot interleave their ownership publication;
this does not serialize unrelated Account work or external preparation. A lease covers the nested
awaits of an already started material-changing AccountStore/restore call; exclude network/Travel waits and read-only
preparation so retirement can fence without waiting for an HTTP request. Check the same generation
after every external wait, before each next write and immediately before live-key/cache/public result
publication; thread its publication check through the existing setter where an internal await would
otherwise permit late installation. This is one transport handoff/drain owner, not a new Account,
credential, retry or durable work registry.

The concrete existing integration seam is
[the lifecycle adapter](../../../apps/extension/src/background/vault-session/adapters/lifecycle-adapter.ts),
where `clear_keys` reaches shared C1 `lockAllAccounts` and revocation reaches its existing invalidation
operation. The current machine sequences effects within one event; it does not already serialize
separate hydration/cleanup calls, so do not claim that it supplies this missing drain. Retire the
captured delivery generation synchronously and close material acquisition for both old and newly
arriving invocations. Drain all its started material calls before invoking the existing C1 operation,
then keep acquisition closed until that operation acknowledges complete cleanup. A new native
response, unlock event or replacement port cannot publish successor material into this interval.
Incomplete cleanup retains the gate and its existing failure result; it is not permission to reopen
or add a retry loop. Reopening permits fresh guarded calls, not the revival of old continuations.

Route every existing `clear_keys`, native-port loss/protocol invalidation, Account teardown and
native one/all biometric/hydration/restore path through this same handoff guard, including paths
without a DesktopSync event subscription. Preserve each C1 operation's actual strength: ordinary
lockAll retains its Session authentication material, whereas sign-out/removal/invalidation keep
their existing stronger cleanup. This is not a new key/Session policy in the transport. No local
replacement or unlock publication may bypass a pending cleanup barrier for its captured Account.

A mutation releases its own lease before invoking teardown, otherwise cleanup would wait for itself.
Dispose an uninstalled private KeyRef directly. The current all-Account catch's unconditional
`lockAccount(accountId)` must not lock a newly authorized successor after stale failure: request-wide
failure cleanup is permitted only while the captured delivery generation and its still-owned material
publication remain current, never by Account ID alone. Validate that ownership inside the same
material gate; a later successful publication in the same transport generation also supersedes an
older invocation's cleanup authority. Stale callers dispose only their uninstalled owned references
and report the existing failure. A drained old write cannot run after cleanup acknowledgement;
independently accepted Operations and their existing lifecycle semantics are untouched.

Reproduce event-before-buffered-reply and reply-before-invalidation-before-cache-publication with
the actual existing consumer classes, then repeat through real native messaging. Once bytes/material
have already been delivered to the old consumer, its existing local lifecycle owns erasure; a
transport generation cannot recall arbitrary earlier copies. Protocol1 still cannot validate a
destination Core generation or acknowledge65/68 retirement like protocol2. Do not claim global
cross-socket ordering, secret-free old Extension code or authenticated challenge signatures.

## Startup, acceptance and removal

During97 preparation, the default packaged native host must still match the current production
Desktop listener's raw protocol1 envelope. Stage the new source handshake behind the explicit,
default-off Cargo feature `native-runtime-legacy-source`; the actual native acceptance binary is
built with that feature and paired with the fixture's Core source listener. A feature-enabled host
connected to an old listener fails closed. There is no runtime owner detection, retry into old
storage, or fallback after failed Core startup.66 switches the production listener and native host
together and removes the temporary preparation switch as that composition becomes the sole owner.
Acceptance records must identify the enabled build feature; they do not establish default
production activation. Both the unchanged default route and the prepared Core route need coverage.

97 may assemble the already accepted native Runtime with populated SQLite fixtures independently of
the renderer.91's complete profile admission remains a prerequisite of66's eventual activation;
legacy source files cannot become a fallback after admission. Failed admission/open permits existing
maintenance status/recovery/Wipe only, with no native secret response or apparently fresh empty catalog.

Start test-first with one real stored Login/passkey, native Runtime and the actual old snapshot/
biometric decoders. Prove matching payload and current source guards, then widen the same fixture:

| History | Required evidence |
| --- | --- |
| Wire and identity | Generated schema matches actual protocol1 consumers, including optional/null fields, numeric timestamps, unknown optional intent behavior, mismatch/error replies and exact Account IDs; equal emails never retarget a request. |
| Private read and writes | All five categories and every supported field, real ES256 signing from the transferred existing credential, TOTP, read-only/offline reads with network unavailable, exact source metadata precedence and null/optional fields. Authority trash, pending Trash/Restore/permanent delete, pending Create/Update and readable Failed overlay obey effective-row filtering. Ordinary renderer projection/commands cannot obtain private keys. Existing Extension-local write keeps its own durable request identity and reaches its Server effect without Desktop replay. |
| Local access | Existing real wrapped MUK/Device-key format decodes and imports in the actual old consumer. One/all uses one Core-owned prompt with preference/re-entry refusal and partial failures; offline permitted local release adds no online validation. Expired/missing Session follows67 and AuthToken independently refuses unusable tokens. No Server login or new durable secret. Supported-OS hardware remains73. |
| Held delivery | Hold source read, prompt and final encoding across Account Lock, selective hide, pending Travel verification, Account replacement/removal, peer EOF and owner shutdown. No stale secret response; unrelated Account/peer stays usable. Test loss before and after writer admission honestly. |
| Events and UI | Actual old DesktopSync/client consumes status, catalog, lock/unlock, active-Account/theme and close. Reproduce both buffered-reply/cache publication races with one transport generation; old port callbacks cannot reach a replacement. Hold actual nested AccountStore write/restore and biometric Travel/key-install awaits across retirement: started writes drain, then C1 cleanup completes before any fresh material acquisition/publication. Hold cleanup itself and attempt a new port/unlock; it cannot publish a successor yet. A failed cleanup keeps the gate closed. After acknowledgement, a fresh authorized successor works and a late old all-Account catch cannot erase it, including a newer publication in the same generation. Test own-lease release before cleanup, immediate retirement while network is held, and all lifecycle/port-loss paths without relying on a DesktopSync subscriber. Ordinary request-socket completion and renderer reconnect do not emit false Desktop close. Existing create/view handoffs preserve current active-Account scope. |
| Real transport/application consumer | Actual native binary through normal peer/origin checks into the new native Runtime, with the existing packaged legacy Extension consumer in Chromium. Show full private Item read and one existing local mutation, disconnect/reconnect, source Lock, the existing decoder's refusal of a reply correlated to a different challenge and no new Desktop native-cache/storage reads. Controlled decoders/Unix streams are preliminary evidence. |
| Failed startup and cleanup | Missing/corrupt/admission-blocked stores never invoke legacy fallback; existing same-owner recovery remains reachable. Actual browser EOF and stdout failure cancel a held Core prompt/request before its callback is released, close subscription/request sockets and dispose bounded response queues. Preserve partial-frame histories. Old Extension accepted work remains its own work. |

97 completion requires this actual new source/old consumer compatibility history plus independent
review and affected generated/crypto/host/full checks.66 then wires the sole production owner and
all reachable native/renderer callers together;73 retains actual Tauri/supported-OS acceptance.
At76's atomic Extension cutover remove every protocol1 secret/snapshot/biometric compatibility caller
and this Core legacy mode/formatter after graph proof; preserve still-used host UI intents/version
plumbing through their closed nonsecret route. There is no permanent compatibility service or
deadline-based background removal. Shared modules with other actual callers remain under78's graph
rule. Contract readiness does not establish implementation or application acceptance.
