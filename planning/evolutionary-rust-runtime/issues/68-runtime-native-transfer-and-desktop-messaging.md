# Runtime transfer and Desktop native messaging

Type: task
Status: resolved
Blocked by: 64, 67, 79, 94
Spec: ../desktop-extension/native-transfer.md

## Contract

Implement ticket 64 export/import once in shared Core using existing transfer cryptography and typed Account/incarnation/connection/lock-epoch guards. Replace Desktop native cache decryption and storage-derived snapshots with Runtime projections. Keep the native binary as authenticated transport and preserve ADR 0004 entry refusal plus Core refusal.

## Acceptance

Use actual native binary/socket and Runtime projections for lock/unlock, disconnect, revocation, Account switching, late callbacks and replacement owner. Extension-local accepted Operations never move or replay during transfer. Remove obsolete Desktop native-host crypto once callers migrate; preserve Extension legacy protocol until its cutover. Seal generated binding fields before readiness.

## Comments

2026-09-08: dependency-ordered delivery scope recorded. No implementation or acceptance is claimed.

2026-09-09: [closed control specification](../desktop-extension/native-transfer.md) sealed after
independent Core/native review. It fixes source/destination generation values, authenticated browser
origin rather than payload identity, nonsecret authority projections, guarded final delivery,
challenge/event retirement, and existing independent Session preservation. Borrowed Session material
remains transient in its Core grant; it does not overwrite standalone CurrentSession/QuickUnlock
records or add a login secret. The legacy challenge `signature` is accurately described as correlation,
not authentication. Existing native IPC validation remains required.

Broker recycle preserves its Worker. Actual connected native-port loss additionally retires borrowed
authority under ticket 41's Desktop rule, and missing delivery of an old port event cannot authorize
reattachment. This is tested separately from standalone broker recycle and actual Runtime-owner loss.
The Chromium feature inventory confirms native messaging stays in the service-worker broker.
Ready for implementation only after prerequisite 67 is complete; no integration acceptance is claimed.

2026-09-09: prerequisite 67 is resolved as a capability. The first implementation slice is two
separate Core owners and an existing destination Account: independent Session S1 and accepted local
work survive attachment to borrowed Desktop Session S2, channel retirement and explicit standalone
unlock. Private generated authority control binds both owners/channels and Account generations;
replay and delayed delivery lose to retirement. This precedes import-only Account admission and
actual socket/caller cutover, and does not claim their acceptance.

Normal authenticated network work will use one Core effective-Session selector with explicit
transient grant provenance. Provenance survives ordinary clones but is not persisted or trusted from
serialized input; storage rejects borrowed Session documents. Refresh updates the transient grant
instead of overwriting independent S1. Explicit local unlock/biometric checks and Desktop's independent
Account-validation loop retain the independent stored Session path. Shared installation/publication
helpers will be reused below the password-authenticated constructor, which necessarily creates a
QuickUnlock document and therefore cannot be called unchanged for import-only Accounts.


2026-09-09: existing-Account Core transfer matrix passes 10/10 with two independent real SQLite
Replicas (targeted run 72375, 23.19 seconds). Independent platform-storage and HTTP test capabilities
supply credentials/offline responses; this is Core persistence/lifecycle evidence, not OS keychain,
native socket, browser, or application acceptance. It covers independent S1 byte preservation,
borrowed S2 renewal without storage writes, accepted Operation preservation and SQLite reopen,
disconnect/explicit standalone local release, replay, stale generations, source/destination Lock,
source channel replacement, concurrent attachment serialization, Account isolation, and Travel guards.

Review frontiers resolved as ordinary preservation work: a fresh Travel response changes only the
latest metadata document under the Account execution fence (held HTTP/preferences regression), and
Session expiry is checked again at publication (held HTTP/clock regression). Source verified Travel
evidence travels separately from unchanged encrypted transfer material. Offline disagreement with the
destination's cached policy refuses import; a stale destination cache cannot restore authority the
source already knows is hidden. This reuses the local-access verification/predicate, and does not
claim ticket 71's physical hidden-Vault purge. Each finding was reproduced before its correction.

Source final encoding reuses the same Account delivery lease as DeviceSetup. The normal Session
selector rejects stale caller incarnations and suspends independent S1 while an import is pending
or a reachable Desktop is locked. Concurrent source-channel replacements serialize inside Core.
The private Rust-derived native-authority contract is separate from renderer RuntimeRequest; its
thin Worker binding performs no authentication or key policy. Generated contract checks and shared
local-access regression checks are underway. Teardown intent retirement, delegated source biometric
entry, import-only installation/restart, and actual native socket/caller acceptance remain open;
this ticket is not resolved by the existing-Account matrix.


2026-09-09: independent review exposed a dropped-caller retirement gap (reproduced in run 74106):
channel invalidation preceded the awaited Account fence, leaving borrowed Session material until
that wait completed. The correction reuses the existing synchronous Lock key/delivery/desired-epoch
fence at native intent and retains one pending generation per Account. The existing Runtime dispatch
owner drives scoped durable/file retirement, with the existing bounded backoff; caller loss only
abandons its wait. No host retirement task or second lock policy is introduced. The regression also
requires live keys gone after the actual future is dropped and durable completion by the surviving
Core driver. This correction is underway; earlier 11-case evidence does not cover it.

### Same-channel ordering and independent retirement progress

The existing owner/channel/generation binding also needs ordering within a surviving native channel:
Core assigns a monotonically increasing decimal-u64 sequence to source authority snapshots, captured
under its publication fence. Destination Core rejects older sequences (and conflicting content for an
equal sequence), and rechecks current authority before admitting any derived retirement. This is the
sealed stale-delivery rule applied within one connection; the broker has no authority-ordering policy.

The native retirement driver retains in-flight Account drains while admitting later queued Accounts.
A held Account execution fence must not delay another Account's cleanup after its caller disappears.
The SQLite regression reproduced that starvation (12918), then passed with retained driver futures
(88702). Immediate borrowed-material/key retirement and the existing shared durable Lock fence remain
unchanged. These are Core capability checks, not native-socket or Extension acceptance.

The same-channel replay regression failed before sequencing (79021); the complete existing-destination
Core matrix passed afterward (93783, 14 tests). A follow-up full 14-test run (82072) also exercises the
shared guarded borrowed-Session replacement seam: cross-Account/incarnation/provenance replacements
are refused, pruning leaves independent persisted S1 byte-identical, and an old S2 refresh cannot
restore pruned wrapped Vault keys (`Cancelled`). Private contract generation succeeded (80870), all
three generator/closed-contract/decimal-u64 tests passed (70603), Core all-target Clippy passed (78764),
and the actual wasm32 bindings target typechecked (20665). The preceding failed wasm command requested
a nonexistent `wasm-bindings` feature and was corrected to the package's ordinary target check; it is
not acceptance evidence. Independent review found no further issue in per-Account retirement claims,
cancellation release, bounded retry or later-Account admission. Core source-biometric delegation,
import-only Account installation, native sockets and application acceptance are still outstanding.

The broad Core snapshot run (10157) finished with 819 passing tests and two then-intentional ticket87
regressions: complete-bootstrap Vault authority removal and independent Session refresh after key
pruning. All 14 native authority cases and the RSA-member installation path passed in that snapshot.
This is not a final full-Core or phase-CI pass. The next smallest biometric export path reproduced its
missing locked-source preparation/ceremony behavior (93572); its implementation delegates the existing
Core `BiometricUnlock` and returns the existing closed `BiometricFailure` on refusal. Ordinary export
still cannot unlock a locked Desktop. Native pending-ceremony cancellation now records source versus
destination direction: source channel loss cancels its prompt without locking or removing the source
Account; destination loss retains its existing borrowed-access retirement obligations.

The source biometric vertical and its cancellation matrix passed with the existing-destination cases
(65506: 16 tests). The controlled prompt covers source channel loss, another Lock on the source
Account, source Runtime close and caller cancellation; none publishes a key or destination grant.
The explicit gesture returns the existing typed `NotEnabled` refusal, and success keeps the same
stored independent Session. These tests use a controlled BiometricPort and do not replace macOS or
Windows prompt acceptance. Private contract generation passed again (15981), and Core all-target
Clippy passed (63666) after the direction-tagged ceremony change.

Ticket [87](87-durable-vault-authority-retirement.md) records the next native frontier: a source-only
key-authorization generation is separate from Account lock epoch and channel snapshot sequence.
Retirement and later fresh-authority publication advance that value under the existing Account fence.
Source export/final encoding also reject the existing durable pending-Vault cleanup journal, including
the interval before the generation notification runs. Destination challenges/grants require the exact
source value, so a new source generation retires borrowed S2 without falling back to independent S1.
No additional native cleanup journal, availability Boolean, crypto field, or host retry owner is
introduced. Already-delivered material is fenced at destination once newer authority is applied;
transport delivery delay is not an instantaneous distributed revocation guarantee.

Source generation invalidation reproduced the stale-final-encoding bug (89222) and passed after the
new binding (75144). The complete native suite then passed (92455: 18 tests). It also verifies a real
SQLite `RetireVaults` journal fences both fresh export and retained final encoding before the source
generation hook, while Desktop remains `unlocked` and derived `keyAuthorizationAvailable` is false.
The initial journal test accidentally read an unpublished `execute_recomputing` cache result; it was
corrected to `execute_exact`. Subsequent compile attempts encountered sibling in-progress fixture
changes, so those attempts are not claimed as a behavioral red for the journal guard. Both journal
and generation guards are included in the final 18-test result. `advance_native_source_authority`
is ready for ticket87's shared runtime cleanup integration; import-only installation is next.

### Import-only Account installation seam

An explicit new-destination preparation reserves Account/incarnation identities in Core after checking
normalized Server/User identity against the catalog and other pending preparations. It creates no
Account until a valid reply is completed; existing destinations keep their current separate command.
The separate nonsecret reply profile carries the source Account presentation, KDF pin and exact
verified Travel evidence. Existing encrypted transfer material keeps its shape. Destination Core
rebuilds its own metadata and does not inherit Desktop's HTTP consent or an independent login secret.

Both independent Sign-in and native-only import use one private physical installation transaction:
stage the existing catalog journal, write generation metadata, optionally write independent QuickUnlock
material, install Replica, promote catalog, and optionally persist the independent Session. Native-only
mode writes neither credential document and does not create a Device key. Pre-Replica failures reuse
existing rollback; uncertain/post-Replica failures retain the existing fenced reconciliation evidence.
Only the caller's final guarded publication exposes keys. The shared installation publication also
supports initially Locked metadata so native completion can use the existing guarded borrowed-grant
publication without cancelling its own ceremony or copying key publication policy.

A serde-default, omitted-when-false native-only metadata origin distinguishes these retained Accounts
from independently SignedOut Accounts. After actual Runtime owner loss they reopen Locked, with no
borrowed Session or live key, and require a fresh valid source grant. Existing metadata bytes and
cryptographic persisted documents remain unchanged. The native-only marker is cleared by ordinary
full Sign-in through normal metadata construction. Concurrent identity installation, source revocation,
crash reconciliation and account-scoped teardown must be tested before this capability is complete.

2026-09-09: import-only physical installation now uses the same staged-catalog / metadata /
Replica / promoted-catalog transaction as independent Sign-in. Its optional credential pair is absent:
no Device key, QuickUnlock document or CurrentSession document is written. Existing independent
installation order, pre-Replica rollback, uncertain-outcome fencing, stable identity replacement and
concurrent identity admission tests passed after extraction (92318, 98638, 17624, 78473).
The shared seam additionally rejects mismatched Account/incarnation credential documents before
writes (valid behavioral red85524, green within native matrix67315).

The private `PrepareImportForSource` action replaces explicit-destination wire selection. Under Core
catalog admission it resolves normalized Server/User identity, or reserves one new Core Account and
incarnation for an explicit ceremony. Concurrent reservations and pending physical catalog installs
refuse; merely receiving a Desktop snapshot never creates an Account. Completion rechecks durable
catalog identity under catalog-then-Account admission. Separate nonsecret profile and exact verified
Travel timestamps accompany the unchanged cryptographic transfer material. The existing Crypto
KdfProfile gains optional schema derivation only; its serde fields and cryptographic policy are
unchanged (schema feature check97132 passed). Native-only metadata defaults false and omits that
value from existing documents; a retained imported Account reopens Locked without borrowed keys.

Actual SQLite import/reopen test44301 passed (4.70 seconds), then the expanded matrix67315 passed
22 cases including duplicate preparation, existing imported identity resolution after reopen,
pre-Replica rollback, post-Replica journal reconciliation and source loss during a held promoted
catalog write. No OS keychain, Server, socket, browser or renderer acceptance is inferred from these
controlled capability tests. The remaining case used localhost for an insecure-transport refusal;
that was an invalid expectation because shared HTTP policy permits loopback. The corrected
non-loopback refusal and explicit destination-consent success test3630 passed (4.84 seconds).
Desktop's transport consent is removed from source profile data; new-destination consent is an
explicit default-false private command input bound into the Core challenge. Matched Accounts retain
their own metadata consent. The localhost failure is not counted as a valid security regression red.

Independent review also found that full Sign-in could bypass connected Desktop authority. Valid
behavioral reds24195 and91893 cover already-connected Desktop and attachment while an independent
installation's promoted-catalog write is held. Early identity admission and final native-to-biometric-
to-publication guarding now refuse the first case before writes; the latter retains committed
independent credentials and a discoverable Locked Account without publishing live keys (targeted
mid-install green26394). Final QuickUnlock/biometric publication, delayed unlock receipts, old-generation
cleanup, public unlock-choice projection and the final accumulated checks are still being completed;
this ticket remains claimed, not accepted or resolved.

2026-09-09: final local publication review findings were reproduced and corrected. A connected
Desktop arriving after QuickUnlock preflight could previously win without advancing the destination
lock epoch (red67055), and a delayed independent unlock receipt could remove newer borrowed S2
(red21309). QuickUnlock and biometric release now hold the same native identity authorization guard
through publication, using native → biometric → publication order; native grant publication uses its
existing held grant guard. A receipt only retires old standalone blocking when current live authority
is still independent, and never deletes a newer grant. Existing post-replacement credential cleanup
runs for both Unlocked and committed-Locked outcomes. Parent independent review found no further
issue in these guards, lock order or cleanup. Native matrix48243 passed27/27 in75.81 seconds;
existing biometric/local-access matrix82247 passed28/28 in21.43 seconds. Private generated authority
contract69899 and its five generator/closed-wire/lossless-timestamp tests66986 passed.

The next small slice exposes `AccountStatus.unlockCapabilities` as nonexclusive password / Desktop /
full Sign-in capabilities, retaining the dedicated biometric eligibility projection and Core command
checks. The existing Account presentation cache carries identity plus the native-only installation
marker; there is no separate host policy or connection mirror. Projection entry points acquire the
existing native registry before publication and release both guards before host callbacks. A private
wire command still owns actual Desktop ceremony admission. The projection's behavioral red7527 was
established against closed default-false capability values; generation and final checks follow its
implementation. None of these tests establishes production native sockets, Extension broker lifetime,
Desktop UI or supported-platform OS prompt acceptance.


2026-09-09: the final public projection implementation passes native matrix76840 (29/29,
72.12 seconds), including nonexclusive unlock choices for standalone, connected and import-only
Accounts, plus a reentrant initial observation callback that calls the private source snapshot.
Both native and publication guards are released before foreign delivery. Runtime protocol generation
21348 and native Swift/Kotlin generation15300 passed. The affected shared client/session and React
tests45778 passed28/28. Type checking found stale AccountStatus test fixtures; only their closed
capability defaults were added. Core Clippy90417 found an export-placement issue corrected immediately
and sibling89 obsolete-authority helpers still being removed; that run is not a final Clippy pass.
The accumulated full checks remain the parent phase gate.

### Remaining actual transport and caller boundary

The Core matrix does not complete this ticket's actual socket acceptance. The current native assembly
(`apps/desktop/src-tauri/src/runtime_host/native.rs`) exposes renderer attachment and shutdown, but
no trusted socket-scoped authority attachment. `desktop_ipc.rs` still defines only legacy v1 actions;
`lib.rs::handle_desktop_ipc_message` and `handle_desktop_ipc_connection` still dispatch legacy Account,
Auth-token, Vault-key, Item-snapshot and biometric operations and broadcast legacy Desktop events.
`native_host.rs::send_ipc_request` opens a new local IPC connection for each ordinary request, while
`start_event_subscription` owns a separate persistent stream. Neither represents one new Core native
authority channel for the browser port's lifetime.

The next bounded capability path must connect the existing Core facade to a trusted source-side
socket adapter, without exposing the general destination control actions to a browser caller. A
validated native-host launch origin supplies Extension identity; request payload identity may only
match it. Currently `native_host.rs::main` never examines that launch argument, and the allowlist
helpers in `native_messaging_installer.rs` explicitly document their unused trailing-slash mismatch.
Reuse the existing native manifest allowlist and IPC peer/path/permission checks; correct the origin
normalization as transport authentication, not a new Account rule. Establish one persistent source
channel per authenticated native connection; EOF, cancellation and replacement retire that exact
channel. Request correlation IDs cannot substitute for owner/channel identity.

The adapter forwards source-only typed controls to Core, receives Core source snapshots, and invokes
Core's guarded final reply encoding immediately before transport delivery. A Runtime status
observation can trigger a new Core source snapshot; the host must not reconstruct lock, Session,
Travel or key-generation policy. Bound length-prefixed frames before allocating and retain read
progress across event delivery/cancellation: the existing native-stdio and local-socket codecs both
trust a raw u32 length, and the legacy subscribed handler re-creates a read future inside select.
Bounded queues, disconnect cancellation and secret-buffer disposal belong to this transport slice;
they must not become a second Runtime retry or key owner. Late encoded replies still require the
existing destination generation/sequence checks; queued bytes are not instantaneous distributed
revocation.

The temporary legacy caller graph is concrete. Extension `desktop-client.ts` requests Accounts,
Auth tokens, Vault keys and Item snapshots. `desktop-sync.ts` consumes Accounts; `api-client.ts`,
`desktop-key-material.ts` and `services/sync-cache-service.ts` still request Desktop tokens/keys.
`vault-utils.ts` consumes Desktop Item snapshots for connected reads. `native-messaging.ts` and
`biometric-transfer.ts` still parse/decrypt legacy transfer responses and install TypeScript key/Session
authority. Their removal belongs to the Desktop-then-Extension sequence, not this controlled Core
fixture. Any temporary Desktop legacy response adapter must derive its results from the sole Core
owner; it cannot retain or recreate native-cache decryptors, an independent MUK, or a shadow Session.
Ticket79's final model has no native Item snapshots, and their deletion follows the verified zero-caller
graph after ticket76.

Acceptance order remains explicit: first actual Unix socket/native-host binary with NativeRuntime
and a real Core capability client (Windows named-pipe and supported-platform checks separately),
including origin mismatch, disconnect during export, Desktop Lock, replacement channel, delayed
reply and independent caller isolation. Desktop ticket73 may use that real Core client to prove its
native path before the Extension migrates. It cannot claim production Extension acceptance before
tickets76/77 verify the actual Chrome116+ broker/offscreen Worker, broker reattachment versus real
native-port loss, and actual Runtime-owner loss. Production routing remains tickets72/76. The new
capability can remain inactive in legacy Tauri setup until exclusive ownership is ready; opening a
second production Runtime merely to exercise the socket is not allowed. No additional product choice
is needed for this transport implementation boundary.


2026-09-09: final projection checks passed: affected type graph21236 (13/13), public protocol
generator matrix76201 (14/14), earlier private generator matrix66986 (5/5), native binding
generation15300 and shared client/React tests45778 (28/28). The first public generator recheck
53453 caught one stale revision-test AccountStatus fixture plus a sibling89 intermediate compile
error; neither is hidden by the final pass. Fixture defaults and Biome formatting are complete.

The next source transport implementation is authorized under this ticket. Its first vertical path
is a closed, generated source-only envelope with snapshot, explicit export and explicit biometric
export requests, request cancellation, correlated response and authority update frames. It cannot
carry renderer requests or destination attach/import/state actions. A trusted attachment binds the
Core source channel once to the validated browser origin and a fresh transport identity; scoped
source invocation rejects a challenge naming another connection even if it belongs to the same
allowlisted Extension. Core remains responsible for source identity, live access, key generation,
Session expiry, Travel eligibility, prompt policy and final encoding. The adapter supplies transport
identity and lifetime only.

Implement and verify in this order: (1) real framing/origin refusal and a source-only socket
attachment with one Core source snapshot; (2) actual socket/NativeRuntime with two independently
scoped ports and Accounts, EOF and Lock updates; (3) export and late encoding with the destination
Core consuming the unchanged material, then explicit biometric cancellation; (4) actual native
binary proxy over stdio and its authenticated Desktop socket. Keep the old v1 handler available for
its current callers, but the new source path never consults legacy storage or native-cache crypto.
No production owner activation accompanies the foundation. The remaining browser and supported-OS
acceptance gates stay visible even after Unix transport tests pass.


Transport framing/origin evidence: valid manifest-origin refusal reproduced in83110 and corrected
(98182 green); a length-only oversized frame reproduced payload reading before length rejection
(47607, UnexpectedEof), then passed12986 after preallocation bounds. Shared local frames retain
64MiB maximum, native-host output checks Chrome's1MiB maximum, and transient serialized buffers
zeroize on release. Native host validates its actual browser launch origin before reading input and
requires biometric payload identity to match it. The native binary's52 existing/affected unit tests
passed83428; actual process/socket evidence follows. These limits and the launch argument are
specified by [Chrome's native messaging protocol](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).
No frame carries an added login secret or changes persisted/cryptographic formats.


The actual built `bittery-native-host` process passed three origin cases: missing and wrong origins
exit1 before stdout; the allowlisted Chrome origin returns the exact correlated PONG. Evidence is
`/tmp/bittery-native-source-origin-process.json`; build75894 completed. This probe opens no Desktop
profile and proves only the real executable's origin/framing boundary, not Core/socket/browser
integration. Parent full JavaScript CI additionally found one unintended unlock-capability field in
an untyped Attachment Upload expectation; it was removed, and every remaining Web fixture occurrence
was audited to be an AccountStatus field. Type checking alone did not cover that assertion.
Final Core Clippy44582 found only sibling89's Copy fingerprint clone, now reported for correction;
no source-transfer warning remained in that run.

For transport lifetime, the trusted NativeRuntime exposes a restricted Core source attachment, not
a raw Runtime getter or the general authority dispatcher. The attachment stores its existing source
channel identity; it owns no new Account/key/Session map. Snapshot/export/explicit biometric export
and final encoding require that exact attachment. Its synchronous close/Drop shares the existing
channel retirement implementation, cancels source ceremonies immediately and cannot retire a
destination grant or unrelated source connection. Existing RuntimeStatus observation supplies
change triggers to Core source snapshots. Pending native requests use transport cancellation/RAII;
EOF retires the source attachment before awaiting any reader/writer task drain.


The scoped source facet now has two reproduced regressions: dropping an attachment previously left
its channel registered (32777), and one socket facet could forward a sibling channel's valid challenge
(22729). Both pass after the correction (42386,2/2). Close/Drop and ordinary async channel retirement
share one native-registry mutation; source Drop cancels only its source ceremonies synchronously,
without publication locking or async retirement. Export and explicit biometric export bind the
attachment's exact channel before delegating all Account/key/Session checks. Core's response encoder
is shared with the original private control entrypoint, retaining its final disclosure guard.
The earlier Desktop all-target Clippy22519 passed for the origin/framing changes. An independent
review found no additional issue there, while explicitly preserving the known legacy unbounded
outbound queue and writer-failure/stdin lifetime limitations for the upcoming socket proxy.
The source-only transport wire file is presently an unregistered scaffold; these facet tests are
not actual socket, broker, biometric hardware or application acceptance.

2026-09-09 source-facet review found explicit close still allowed encoding retained nonsecret Source
responses and creating a wake subscription. Both reproduced in66690;99591 passed9 relevant Core tests
after active-channel encoding guards and pre/post-observation checks. The added reentrant initial
callback closes the facet and proves no new observer handle escapes. Foreign callbacks never execute
under native state. Returned observations are explicitly wake-only, owned/closed by the trusted port.

The new inactive source-only stream adapter uses the existing NativeRuntime factory and Core facet,
shared frame codec, canonical manifest origin allowlist, bounded queues/calls and late Core response
encoding. NativeRuntime remains the owner: the transport releases its factory Arc and retains only
its scoped Core attachment. One persistent read task preserves partial framing across authority wakes.
Port Drop/EOF/overload/writer failure retires the Core channel and observation before task drainage.

First empty-catalog SQLite/framed-stream regression85964 failed with EOF from the unimplemented
adapter, then passed49077. Actual Unix socket-pair tests42836 passed origin/header bounds and independent
ports but exposed silent Runtime observation closure leaving the stream alive. The adapter now selects
the existing Core close-completion notification, pre-registering before checking close_complete;
no mirrored lifecycle state or polling loop was added. Final3229 passed4 Unix/real SQLite tests:
independent port EOF, exact origin/oversized-header refusal, recycled correlation refusal, explicit
shutdown and dropped NativeRuntime owner while the transport survives.

Closed wire test28097 exposed serde's internally tagged unit variants accepting extra fields despite
deny_unknown_fields. Empty struct variants preserve the generated wire shape and refuse those inputs.
Final41653 passed the closed-wire test and3 ts-rs export tests; generated
`apps/desktop/src/generated/native-runtime-ipc.ts` is current. Parent independently reviewed source
ownership, bounded transport and Drop paths; no new blocker found in this empty-Account boundary.

These tests do not prove populated Account export, delayed socket writes after Lock, explicit Cancel,
biometric prompt cancellation, actual native binary proxy/peer checks or production browser routing.
Core encoding before an async write does not retract already-written bytes; destination generation
and sequence checks remain mandatory for delayed delivery. The actual native binary still runs the
legacy handler; source protocol2 proxy and populated two-Account acceptance are next. Both full phase
checks are running under the parent; their result is not inferred from these targeted passes.

Independent bounded transport review after the four Unix tests found no additional ownership defect:
cancelled export waiters drop the Core ceremony lease; queued replies retain the invocation flag;
Core final encoding checks source scope; exact port retirement precedes task abort/drain. The review
explicitly leaves populated export, held biometric/queued reply, Lock and saturated writer scenarios
for the next vertical widening. Cancelled cannot promise that a frame already being written was
retracted. No additional key-policy abstraction or host cache was recommended.

Desktop supporting checks completed: all-target Clippy31635 passed after95255 identified the two
large internal response variants (boxed payloads only, unchanged wire/policy). Full Desktop cargo
test1157 passed189 library tests with4 intentionally ignored actual environment probes, plus52 native
host tests. Generated Desktop drift was zero against a disposable Git-index snapshot of the reviewed
current generated directory; the main index was untouched. These supporting passes do not replace
the still-required literal full CI gates or pending populated native binary acceptance.

- Native/70 retirement integration: the source guarded encoder now validates its exact channel,
  source key generation and fresh Replica inside the shared publication callback before acquiring
  the delivery lease. The derived key-authorization projection rejects transient foreground
  `Retiring` and durable pending cleanup while preserving actual Desktop lock state; an acknowledged
  permanent Vault fence does not indefinitely disable unrelated source authority. Private startup
  generation advancement uses the existing not-closed guard plus exact cached Account incarnation,
  User and lock epoch, without opening public source admission before initialization.
  `cargo test -p bittery-client-core native_` passed 40 Core cases and the one selected native-artifact
  integration case (`/tmp/bittery-native-authority-retirement-integration.log`). New cases cover the
  pre-journal retirement boundary and private startup. This is supporting Core evidence; ticket70's
  actual purge/drain/restart tests and this ticket's populated socket/native-binary gates remain separate.

- Actual Linux native executable capability evidence: the opt-in
  `runtime_host::native_source_transport::process_tests::real_native_binary_source_ports` runs a
  real SQLite-backed NativeRuntime helper and two actual built native-host processes in an isolated
  temporary installation using the unchanged required OS peer/path checks. It refuses a foreign
  browser origin, proves distinct Core channels under one owner, preserves the second port after
  the first native process EOF, and ends the second native process on Desktop Core shutdown while
  browser stdin remains open. The final run observed helper PID570099 and native PIDs570112/570123;
  the combined source suite passed5 cases (`/tmp/bittery-native-source-real-process-final.log`).
  This is an empty-catalog native composition/socket/executable proof, not Tauri UI, populated key
  export, browser registration or OS biometric acceptance.
- The bounded opaque source proxy passed4 actual Unix-stream tests, covering header refusal before
  payload allocation, partial browser-frame preservation on Desktop EOF and browser loss during
  output backpressure (`/tmp/bittery-native-proxy-lifetime-final.log`). The first implementation
  tracer failed with absent relay/early EOF before passing; a later closure assertion was corrected
  to accept Linux's documented transport outcomes EOF or connection reset when unread bytes remain.
  Desktop all-target Clippy passed (`/tmp/bittery-native-proxy-clippy.log`). The source stream and
  proxy reuse one bounded frame writer and shared Rust limits; no Account/key policy was added.
  Independent proxy review is pending; populated export/cancellation and production host routing
  remain open acceptance gates.

- Independent proxy review completed without a new finding: the retained paired frame loops
  preserve partial reads; either EOF/error drops both Desktop halves; frame bounds precede
  allocation; output buffers zeroize; no detached source tasks or queues survive the relay.
  The protocol2 first frame cannot fall back to the legacy route, and launcher-derived origin plus
  existing peer verification remain authoritative. The latest empty-process rerun passed after
  the fixture gained framed control and failure cleanup, observing helper633882 and native
  processes633895/633906 (`/tmp/bittery-native-source-current-process-2.log`). An earlier invocation
  omitted the required binary environment input and failed before launching any
  process; it provides no acceptance evidence.
- The next opt-in real-Server fixture uses two separately provisioned Accounts and the same
  protected credentials reader/ordinary Core SignIn path as the foundation acceptance. It will
  drive actual encrypted exports through the native executable and socket, consume them with a
  real Core+SQLite destination, verify own-Replica reads, selective Desktop Lock and held-reply
  refusal, then exercise explicit standalone unlock after port loss. The destination is a test
  composition, not production Chrome. The helper attempts scoped Server deletion and local
  teardown on normal shutdown and parent EOF; missing cleanup proof retains the isolated profile
  and protected provisioning evidence. This path is implemented and compiling; the real run is
  pending, so it is not yet acceptance evidence.

- Populated native acceptance is still open. The first run failed before helper readiness and
  retained its isolated profile because exact Server cleanup was incomplete; the fixture now
  records the original phase separately from cleanup and attempts all process drains before
  deciding whether evidence may be deleted. Cleanup's authentication step no longer waits for
  the expected Item, so a failed read cannot itself prevent scoped User deletion. Independent
  fixture review identified an OS kill/reap early-return that could drop incomplete evidence;
  those failures now accumulate before the retention decision.
- Two subsequent diagnostic runs tried retained credentials, but the normal E2E launcher runs
  `migrate --fresh` against its isolated E2E database on each new run. A read-only identity count
  confirmed the old test Users were absent, and the actual proxy observed201 login start then401
  finish. Those refusals are not a Runtime regression or scoped-cleanup proof. Cross-run reuse was
  removed; fresh provisioning is being rerun with fixed-label, bounded HTTP status diagnostics.
  The standalone source fixture's changed Web code passed11 dependent type tasks and Biome.

- The fresh populated run's readiness failure was the Linux Unix socket SUN_LEN limit under the
  long E2E TMPDIR. The fixture now uses a short private `/tmp` installation with unchanged required
  OS peer/path checks. A separate real Server500 on personal Account deletion is reproduced against
  the isolated development test database and specified in [94](94-populated-account-deletion.md).
  The native test remains unaccepted; its original parent phase is now recorded separately so a
  cleanup failure cannot hide a transfer-path failure. No production Server policy was patched
  before recording that corrective contract.

2026-09-09 source fixture recheck while the Server acceptance window was reserved: the current
four source socket/lifetime cases passed (66980, `/tmp/bittery-native-source-transport-current-check.log`).
The actual native executable empty-profile proof also passed with the shortened private `/tmp`
socket directory and unconditional cleanup evidence handling (45276,
`/tmp/bittery-native-source-actual-empty-current.log`): NativeRuntime helper PID 731103 and native-host
PIDs 731116/731127, independent port EOF and Desktop owner shutdown observed. This proves the
current process fixture remains runnable; it does not replace the pending populated two-Account
export/Server cleanup rerun or production Tauri/Chrome acceptance. Scoped source helper formatting
and `git diff --check` passed. Server correction 94's real PostgreSQL matrix passed 16 tests separately.

2026-09-09 populated native transport acceptance passed: fresh run7
(`/tmp/bittery-native-source-real-accounts-e2e-7.log`, one selected E2E case, 3.7 minutes;
4.2 minutes including stack startup) provisioned two independent real Server Accounts and exercised
the actual native binary, peer-checked Unix socket, native source Runtime and separate native
Core/SQLite consumer. Helper PID794971 and native-host PIDs795779/795790 were observed.
Both Accounts exported through the actual socket, read their own consumer Replica, survived consumer
Runtime shutdown/reopen as Locked, rejected a held previous-owner reply, and accepted fresh source
grants. Selective actual Desktop Lock kept the other Account Unlocked and rejected a held reply;
native port loss permitted explicit standalone Quick Unlock with retained independent material.
Independent native-process EOF preserved its sibling port; actual source shutdown ended that sibling
while browser stdin remained open. Both populated `DELETE /api/v1/users/me` requests returned200,
and the fixture required scoped Server deletion, local teardown and process drainage before removing
its private profile and protected credentials.

Run6 already observed both Server deletions200 but failed an incorrect fixture expectation that
attaching an unlocked Desktop immediately locks already-unlocked independent Accounts. Run7 corrects
only that expectation under the existing contract, explicitly verifies import preparation retires
the destination, and preserves exact selective Desktop Lock assertions. Failure diagnostics now name
the phase, expected/actual access and presence of failure without logging Account identities or secrets;
consumer phase errors survive cleanup errors. The consumer owner replacement is a real Runtime close
and SQLite reopen within the test process, not a Chrome Worker/process restart. This native composition
evidence does not claim production Tauri routing, Chrome registration, supported-OS biometric prompts
or application acceptance. Independent final fixture review and parent phase CI remain separate gates.

Parent independent review of the populated fixture passed without a policy or ownership finding.
Self-review then added a separate consumer-local-cleanup completion marker: successful source/helper
cleanup alone cannot authorize removing a consumer profile whose teardown failed. The final actual
rerun includes that evidence-retention correction. Supporting current source socket checks pass4/4
(`/tmp/bittery-native-source-after-populated-2.log`); the preceding command encountered an in-progress
sibling protected-image compile mismatch and ran no tests. Scoped formatting, Markdown link targets
and `git diff --check` pass. Parent phase CI remains required.

Final current-worktree run8 passed the populated native executable case again
(`/tmp/bittery-native-source-real-accounts-e2e-8.log`, 3.3 minutes; 3.8 minutes with stack startup),
including both cleanup completion markers and current protected-image installation helpers.
Actual helper PID817617 and native-host PIDs818722/818733 exited; both Server deletions returned200.
The complete isolated source/consumer profile and protected provisioning file were removed only
after their required scoped cleanup proof. Parent fixture review, supporting source4/4 and this
final actual rerun establish the native composition gate; production application and parent full
phase CI gates remain distinct.

### Bounded closure audit

2026-09-09: current source and retained run8 evidence confirm the populated Linux native composition
gate: two real Server Accounts, actual peer-checked native processes/socket, consumer Core/SQLite
Item projections, selective source Lock, stale held-reply refusal, fresh grants after consumer close/
reopen, explicit standalone QuickUnlock after channel loss, sibling-port isolation and clean source
helper shutdown. The consumer restart is a new Runtime over the same SQLite in the test process;
source loss is observed clean shutdown/process exit. Neither is an abrupt Chrome Worker kill or
unannounced OS process crash. Separate Core/SQLite tests provide accepted-local-Operation preservation,
same-channel ordering, import-only restart, source key-generation retirement and controlled biometric
ceremony cancellation; the populated process fixture does not independently repeat every such variant.

One bounded capability acceptance gap remains beyond literal full phase CI: the four framed source
tests and populated process fixture do not send the generated `Cancel` or `ExportWithBiometric`
commands. The controlled Core prompt/caller-loss matrix and opaque-proxy backpressure tests do not
by themselves establish that socket request cancellation retires a held ceremony or suppresses its
queued response while an independent port remains usable. Complete that existing transport-spec
slice through real framing and the same Core source owner with a controlled prompt/delivery boundary;
do not infer supported-OS prompt acceptance or add a host prompt/retirement policy. This is an
acceptance mapping finding, not a reproduced production defect, and no heavy checks ran in this audit.

Projection claims are deliberately narrower than autofill acceptance. `wait_for_acceptance_item`
reads the consumer's actual `ObservationRequest::Items` and requires the populated Login title with
Authoritative status. It does not exercise browser matching, fill delivery or any production autofill
handler. Source authority/unlock-capability projections are covered by the Core/native matrices.
Ticket79's final model reads Items from the Extension's own Runtime; no new native Item-snapshot or
autofill authority is introduced. Production Tauri routing and replacing legacy native decryptors
with the sole Core owner belong to72/73; production Chrome registration, broker versus Worker loss,
autofill callers and final legacy protocol/caller removal belong to76/77. Windows named-pipe/macOS
packaging and real supported-OS prompt acceptance remain their stated platform gates.

Ticket94's targeted deletion and actual native cleanup gates are complete, with its literal full
phase CI outstanding. Ticket68 remains claimed until the bounded framed cancellation gate and parent
full `pnpm check:ci`/`pnpm check:ci:rust` pass. No later production application acceptance is claimed or
waived by capability closure. Documentation links and `git diff --check` are this audit's checks.

2026-09-09 the bounded framed cancellation gap is now covered by
`runtime_host::native::source_cancellation_tests::framed_biometric_retirement_suppresses_late_os_success_and_preserves_sibling`.
The targeted green `/tmp/bittery-native-framed-cancellation-third.log` passes one matrix containing
actual framed `ExportWithBiometric` followed by Cancel, connection EOF or selective Account Lock.
Each request reaches a confirmed held OS callback through the existing native `run_prompt`, over
Unix sockets and the unchanged source adapter, using the existing NativeRuntime/Core owner and real
SQLite. Cancellation is observed before releasing a deliberately late successful callback; the
native prompt permit remains held until callback completion. No stale reply or consumer Account
installation occurs, both source Accounts remain Locked and the sibling source channel stays usable.
A fresh explicit prompt then exports through that sibling socket, and real destination Core import
publishes an Unlocked Account while the other source Account remains Locked.

The source starts with two Locked Accounts; this test does not claim an unrelated already-Unlocked
grant survives the held prompt. Populated run8 separately establishes selective Account isolation.
Platform/HTTP fixtures and the held OS callback are synthetic primitives with no real credential or
hardware prompt; the test does not establish OS enrollment/dismissal, actual browser registration or
production Tauri routing. The only production change is internal visibility of the existing prompt
runner for this test composition; no prompt, key, retirement or transport policy was duplicated.

Initial fixture compilation exposed a JSON macro expression and moving fields from a zeroizing
request; those were corrected before execution and are not behavioral regressions. The first
behavioral run reached cancellation and fresh transfer but its final close assertion expected only
EOF. Linux returned connection reset with unread authority events; final assertions accept reset or
broken pipe while still requiring both tasks to finish and refusing protocol/task failures. The
three retirement variants and positive transfer all pass in the final run. Scoped Rust formatting
and diff checks pass, and root source review accepted the bounded composition. Native sources were
then frozen for the coordinated acceptance lane. This closes the additional capability coverage
finding; the parent reports literal host CI9 green, with full Rust CI still required before68 closes.

2026-09-09: independent review by protected_images and final root review accepted the framed
Cancel/EOF/Lock matrix, fresh successful import, prompt-permit lifetime, reply correlation and
fixture cleanup. The review found no duplicated authority or prompt policy. Targeted acceptance
is complete; literal full Rust phase CI remains the capability closure gate. This does not replace
the later production Tauri/Chrome and supported-OS acceptance recorded above.

2026-09-09 capability phase completed: literal `pnpm check:ci` passed in
`/tmp/bittery-desktop-extension-progress-check-ci-10.log`, and literal `pnpm check:ci:rust`
attempt7 passed in `/tmp/bittery-desktop-extension-progress-check-ci-rust-7.log`.
[The phase record](93-protected-vault-image-artifact-storage.md) details full-suite counts,
opt-in test limits and generated-binding verification without modifying the real Git index.
Together with this ticket's recorded actual Server/native histories and independent review,
these checks resolve its capability scope. Production Desktop/Chrome/supported-OS acceptance
remains in the application tickets; this closure does not claim a production caller cutover.
