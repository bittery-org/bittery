# Core-owned Desktop authorization transfer

This closes the binding refinement for [64](../issues/64-runtime-native-transfer-contract.md),
[68](../issues/68-runtime-native-transfer-and-desktop-messaging.md) and the connected read decision
[79](../issues/79-connected-extension-item-read-authority.md). Desktop remains the lock authority;
Extension Operations and Item reads stay in the Extension Runtime.

## One private Core boundary

Use a dedicated Rust-defined native-authority control interface, separate from renderer
`RuntimeRequest`. Native authenticated socket handlers and the combined Extension Worker binding
may call it. Popup/content-script requests cannot export material, impersonate a Desktop event, or
install a key. Generate its transport types under ADR 0012. The service worker and offscreen document
forward the opaque serialized material; neither parses credentials, decrypts it, persists it, or
chooses Account installation/retry policy.

The interface has these closed actions:

- Attach a native authority channel: trusted host supplies the authenticated Extension identity
  and a fresh transport identity. Derive the browser origin from the native-host launch argument,
  validate it against the existing allowlist, and reject payload identity mismatches; an allowlisted
  request string alone does not identify the connecting Extension. Core generates its owner identity
  and tracks the channel's lifetime. Attach/apply-state supplies a nonsecret Core projection of source
  Account/incarnation/lock epoch so the destination can bind source generations without a host catalog.
  A reachable locked Desktop retires preexisting independent Extension live access too, not only
  imported grants; preserved local credentials cannot bypass ADR 0004.
- Prepare import: destination Core captures its owner, channel and explicitly requested local
  Accounts, including each current incarnation and lock epoch, and creates a single-use challenge.
  New imported Accounts name Desktop's source identity; Core matches existing local identities by
  normalized Server URL and Server User ID, never by email alone.
- Export: source Core receives that challenge and the explicit requested source Accounts. It checks
  its own owner, channel, Account incarnation, lock epoch, unlocked state and current usable Session.
  It returns only the authorized targets, with bounded per-Account failure codes. Export from a
  locked Desktop cannot unlock behind the Desktop UI. An explicitly requested biometric gesture
  delegates to the existing Core local-access ceremony before export; it does not introduce a second
  native prompt or release policy.
- Complete import: destination Core consumes the pending challenge once, validates the exact source
  and destination identities/generations and imports through shared Account installation. Recheck
  all guards after asynchronous storage/travel work and before publishing or waking work.
- Apply authority state or retire channel: Core applies Desktop lock/removal/revocation and transport
  loss, invalidates pending challenges and installed grants, and drains plaintext deliveries. A later
  channel or unlocked snapshot alone cannot revive a retired grant.

Every challenge and reply binds protocol version, Extension identity, source owner/channel,
destination owner/channel, source Account/incarnation/lock epoch, destination Account/incarnation/
lock epoch where present, normalized Server URL and Server User ID. A reply includes its challenge
and the existing encrypted transfer material. Optional new-Account destinations are explicit, never
an instruction to install every Account the Desktop happens to contain. The final native response
encoding uses Core's existing delivery guard, as transient device-setup disclosure does.

Reuse existing Core key wrapping/decryption and encrypted key/Session representations. The existing
legacy `signature` is Base64 of a challenge concatenation; it is a correlation value, not a MAC or
authenticated encryption. Do not silently change cryptographic algorithms or claim that this field
authenticates a peer. Existing native IPC peer validation and browser native-host allowlisting remain
the transport authentication boundary. The new generation binding is validated within Core; legacy
responses remain available only for the still-unmigrated Extension until ticket 76 removes them.

## Local provenance and retirement

An imported grant authorizes the destination Runtime's own Replica and accepted Operations; it
contains no Item snapshot and never copies, renumbers, moves or replays an Operation. Core reuses
its normal authenticated transport, Bootstrap/Sync, encrypted projections and retry scheduler.
Desktop mutations become visible through Server convergence, as accepted in ticket 79.

Keep independently established local Quick Unlock material when attaching an existing standalone
Account. Transfer does not fabricate a Secret Key, password proof, Auth key, or Quick Unlock document
for an import-only Account. Imported access starts locked after actual owner loss and requires a
fresh Desktop grant. Disconnect retires transferred live keys and borrowed Session authority;
retained standalone material permits only the existing explicit standalone unlock after Desktop is
unreachable. A reachable locked Desktop still causes both the UI entry refusal and independent Core
refusal required by ADR 0004.

Track Session provenance for each credential, rather than overwriting it with one Account-level
flag. A borrowed Session belongs to the live Core grant and remains transient; preserve the existing
independent CurrentSessionDocument and QuickUnlockDocument unchanged. After disconnect, an explicit
standalone unlock uses its retained independent Session with the existing expiry, biometric/re-entry
and travel rules. Missing/expired independent material follows the existing password requirement;
transfer must not extend that Session's lifetime. An import-only Account has no independent Session.
This preserves existing secrets and formats without a new persisted login secret or restoration capsule.

Removing an Extension Account deletes its local ownership; it must not revoke the Desktop's borrowed
Server Session as if the Extension had created it. Independently created Sessions retain the actual
existing local-forget/teardown behavior; this migration does not add a Server revocation promise. Desktop Account removal/revocation retires corresponding imported
access but does not silently delete accepted Extension work; explicit local teardown remains the
separate destructive action.

Travel verification and hidden-Vault key filtering use the same Core installation path as local
unlock, including decision 65's inaccessible encrypted accepted-work exception. No transfer may
restore hidden keys or use retained encrypted artifacts as permission for reads/new work.

## Broker and owner lifetimes

Retain ticket 41's service-worker native-message broker. Chromium's API feature declarations allow
`runtime.connect` in `offscreen_extension` but restrict `runtime.connectNative` to
`privileged_extension`; moving the native port into the offscreen document is not a valid shortcut.
[Chromium API features](https://github.com/chromium/chromium/blob/main/extensions/common/api/_api_features.json)
This source inspection is not a browser acceptance result.

Broker recycle alone reattaches the same Worker, preserves its Account generations and accepted
work, and does not require another unlock. Actual loss of a connected native port is additionally
an authority-disconnect event under ticket 41's Desktop rule: retire the transferred access even if
its Worker survives. A replacement broker can obtain a fresh grant from a still-unlocked Desktop;
it cannot restore the old grant from a cache. Standalone broker restart and connected native-port
loss therefore need separate assertions. The test must distinguish this authority retirement from
actual Worker/document loss, which creates a new locked Runtime owner. Authority events and retirement
carry the same source owner/channel/Account generation binding as transfer replies. Delayed old-port
events cannot mutate a replacement channel. Reattachment must establish whether the previous native
port survived; missing delivery of its `onDisconnect` during service-worker death is not evidence of
continued authorization.

## Acceptance order

First test two real Core instances with separate persistent stores through the private control
interface: pending destination writes remain visible after import, late reply loses to either lock
or incarnation change, challenges are single-use, Account identities cannot cross, borrowed Session
teardown preserves its source, standalone Session S1 survives attachment to borrowed Session S2 and
subsequent disconnect/explicit local unlock, and import-only restart requires a fresh grant. Compare existing crypto
vectors and encrypted transfer decoding; do not introduce a second transfer implementation in tests.

Next drive the actual Desktop socket/native binary with the native Runtime, retaining the existing
legacy Extension response adapter until its cutover. Verify independent caller loss, Desktop lock,
biometric cancellation, channel revocation and active Account changes without deriving Item data
from legacy storage. Remove Desktop native cache crypto when its last caller migrates.

After Desktop acceptance, run the production Chromium Extension with two Runtimes, real Server and
actual native port: pending local writes and reconnect convergence, native disconnect/reconnect,
broker reattachment with the owner surviving, actual Worker loss, browser restart, Desktop lock and
revocation while a transfer is delayed, and import-only versus standalone Account teardown. Real
native socket/browser evidence remains mandatory; unit generations and compilation are supporting
checks only.

## Source transport lifetime and bounded wire

Ticket68 adds a source-only protocol2 envelope beside the still-used legacy protocol1. Rust generates
Connect, Snapshot, Export, ExportWithBiometric and Cancel request shapes, correlated replies and Core
authority events. Browser input cannot supply native origin, Core channel identity or destination
control actions. The native binary constructs a separate local handshake from its validated launch
origin; the Desktop adapter uses the same manifest allowlist parser. Existing OS peer/path checks
remain mandatory before entering the trusted stream adapter.

Each stream owns one Core NativeSourceAttachment, one existing Runtime wake subscription and bounded
reader/writer queues. Wake projections are discarded; a fresh Core snapshot and guarded encoding are
the only authority output. Close refuses new snapshots, encodings and observations. Observation setup
checks before and after synchronous callbacks without holding the native mutex across foreign code.
The adapter closes the returned observation handle when its port retires; a wake handle itself is not
source authority. Source close synchronously retires the exact Core channel and pending source prompt
ceremonies before awaiting I/O/task drainage.

The reader retains a single length-prefixed read until it completes, so concurrent events never drop
partial frame progress. Apply input bounds before allocation, bound queued frames and in-flight calls,
and retire the port on overload or malformed controls. Responses keep Core response objects until
writer delivery invokes the existing Core encoding guard. Reused correlation IDs cannot replace a
pending call. Cancel retires that invocation; EOF/writer failure retires the entire source attachment.
No host timer, reconnect policy, Account registry or secret cache is added. Already-written bytes are
still subject to the destination Core's generation/sequence checks, not claimed to be retractable.

Tests begin with actual framed streams and NativeRuntime SQLite/Core assembly, wrong-origin refusal,
independent ports and EOF. Then widen to populated two-Account source and destination Core, Lock updates,
export/cancellation and delayed encoding, and the actual peer-checked native binary's stdio proxy.
Direct stream/Unix tests do not prove browser registration or supported-OS biometric prompt behavior.
Production Tauri and Extension routing remain later tickets; this capability must not start a second
owner in the legacy application.

The native executable chooses its transport from the first browser frame. Protocol2 must start with
Connect and retains one peer-checked Desktop socket for that browser port; protocol1 keeps its existing
callers until their cutover. The source proxy forwards only generated source controls and opaque Core
reply payloads, with no Account or key inspection. Two retained bounded frame loops terminate together
on either EOF/error, so a partial browser frame cannot prevent Desktop loss from closing the process.
Actual stdio uses Tokio's OS-backed streams: once the scoped proxy ends, the dedicated native executable
exits instead of waiting for an uncancellable background stdin read. This terminates only that browser
port's process; it does not stop Desktop or another native port. Tests first exercise framed Unix peers
and blocked input/output loss, then launch the actual native binary through its normal peer checks.
