# Native local access and files

This refines the [host specification](spec.md) for [67](../issues/67-runtime-local-biometric-and-device-setup.md)
and [69](../issues/69-desktop-native-binary-and-recovery-capabilities.md). Placement is already settled
by [61](../issues/61-desktop-runtime-placement.md); these contracts preserve existing product policy
and use existing Core capability boundaries. They introduce no new authentication algorithm or
persisted login secret.

## Local access frontier resolution

Question: which module may authorize local biometric release and decide password re-entry,
multi-Account results and inactivity lock after native placement?

Answer: shared Core owns all these decisions under [ADR 0015](../../../docs/adr/0015-keep-biometric-unlock-local.md).
The native adapter reports hardware/enrollment/type and executes a cancellable OS prompt carrying
translated display text. A successful prompt is a capability result for the pending Core request,
never a reusable renderer authorization token. Renderer activity/focus and OS lifecycle events are
inputs; Core records their receipt time, evaluates policy and publishes resulting access state.
No host timer may independently decide whether an Account remains unlocked.

Evidence: `packages/storage/src/account-store.ts` owns the existing re-entry/grace/enrollment logic;
`packages/core/src/services/unlock.ts` enforces usable stored Session and travel verification;
`apps/desktop/src/routes/unlock.tsx` requests one prompt for unlock-all and displays partial results;
`apps/desktop/src/services/autolock-service.ts` currently locks all Accounts based on the active
Account's setting. These callers move, rather than being reproduced in native and renderer code.

## Local access contract

- Add closed Rust-defined commands/projections for biometric availability, enable/disable,
  explicit single/multiple-Account unlock, local security settings and activity/lifecycle inputs.
  Commands name Accounts explicitly; active-Account selection stays presentation state. The
  active Account identity used by Desktop inactivity policy is supplied as a scoped input; Core
  resolves that Account's persisted timeout. Re-entry period is Device-global, while inactivity
  timeout is per Account. Neither comes from a second Account catalog. Return per-Account success
  or bounded failure codes; host supplies
  localized text. Account removal/incarnation change invalidates every pending result.
- Reuse Core's existing Device key, encrypted MUK, QuickUnlock document, stored Session wrapped
  keys/RSA material and last-password timestamp. Native OS secret storage already preserves these
  across process restart. Core unwraps through existing crypto functions and installs keys through
  its existing Account access transition. No key leaves Core, except the separately authorized
  scoped device-setup disclosure below and ticket 64's dedicated transfer contract.
- Enrollment requires available hardware and existing retained material; unavailable hardware is
  the existing no-op. Disabling remains possible without hardware. Preserve the existing
  `biometricEnabled` fields consistently; do not add an independent adapter-owned flag.
- Usable Session, enabled biometrics and password re-entry eligibility are checked before release
  and again before installation after the OS reply. Do not perform SRP, create a Session, or
  persist an Auth key to make biometric release work. Missing/expired Session returns password
  unlock required. Existing authenticated transport may refresh a usable Session for later work;
  the biometric ceremony itself cannot do so.
- Re-entry defaults to 30 days; existing Desktop UI offers 14/30/60/90 days. Use last password
  entry, falling back to stored creation time. The boundary is `elapsed >= period`; a negative
  existing policy disables re-entry, and zero requires it immediately. Biometrics disabled means
  this additional re-entry restriction does not apply. A successful password ceremony updates the
  existing timestamp; biometric success never does.
- Preserve the ten-minute single-Account grace boundary (`elapsed > grace` requires a new prompt).
  Explicit unlock-all prompts once when an eligible target exists, even during grace; no targets or
  no eligible targets produces no prompt. Lock, owner loss and Account teardown
  retire grace. An unlock-all request snapshots only its explicit target Accounts; never restore
  additional Accounts and then rely on renderer cleanup. Each eligible Account has independent
  travel/Session/key installation and a partial result.
- Travel verification uses the existing Core verified policy and offline rules before publishing
  readable projections. Ticket 71 supplies stronger hidden-Vault erasure under decision 65; neither
  biometric success nor native transfer may resurrect hidden keys or authorize new hidden work.
- Default inactivity timeout remains ten minutes; existing options are 1/5/10/15/30/60 minutes or
  never. Evaluate `elapsed >= timeout`, with never disabling only inactivity lock. All Accounts
  lock together on the existing Desktop inactivity gesture. Core scheduling survives renderer
  reattachment; activity does not grant access, alter password timestamps or unlock Accounts.
- Core's device-setup request returns the existing normalized Account setup payload for the
  explicitly unlocked Account. It is a transient disclosure for the existing QR dialog, not an
  observable credential cache. Continue using shared `packages/shared/src/device-setup.ts` URL
  formatting: `bittery://login`, `setup=1`, `v=1`, email/server/team; QR includes Secret Key, copied
  link does not. UI clears disclosure on close, lock, removal or Account switch. No general
  credential read command is added.

## Local access acceptance

Write vertical tests through real Core requests with a controlled OS-prompt capability. Test
re-entry/grace exact boundaries, missing/expired Session, one prompt with partial Account results,
cancel/lock/removal while prompt is pending, restart rejecting stale replies, offline allowed/hidden
Vault reads, native lock retirement of connected access, and settings persistence. Assert no
authentication HTTP from biometric release and no new durable secret record. Existing crypto
vectors must stay unchanged. These capability tests support but cannot replace actual supported
OS biometric prompt/cancel/restart testing in the Tauri application. Linux unsupported-hardware
behavior does not establish macOS Touch ID or Windows Hello acceptance.

## Native files frontier resolution

Question: do Desktop files require a second artifact format or scheduler?

Answer: no. Core already exports `SqliteAttachmentArtifactStore`, implementing both encrypted
artifact storage traits, `SqliteVaultImageArtifactStore`, the attachment/image facades, and their
closed primitive transfer/source/sink/lease contracts. Compose them exactly as the existing Web
binding composes its IndexedDB stores. Native adapts only filesystem, SQLite, OS file selection,
locking and exact HTTP execution. No new Domain or cryptographic implementation is justified.

## Native files contract

- Open existing shared SQLite artifact stores in the Runtime's private application directory. Pass
  the same attachment store as durable and provisional storage to the existing preparation facade.
  Start Core's attachment preparation runner once alongside dispatch and live Sync; shutdown
  retires and joins all three through the native owner.
- Implement existing attachment move/upload transfer ports with bounded exact signed HTTP and
  streamed ciphertext. Reuse native HTTP configuration: no host retries, redirects, decompression
  or authentication policy. Core owns grants, refresh, cancellation semantics and publication.
- Sources and download sinks are opaque capabilities scoped to Account incarnation and caller
  generation. OS file selection grants them; a renderer string cannot read arbitrary native paths.
  Source reads and sink writes honor Core bounds and offsets. Sink completion commits only after
  Core verification; failure/cancel discards incomplete output. Do not materialize a whole large
  attachment or put binary contents into the JSON renderer bridge.
- Account leases must exclude competing actual processes using OS-backed locking. Lock loss and
  owner shutdown fence subsequent writes. Core decides when to acquire, recover, sweep and release;
  the adapter merely implements the lease primitive.
- Implement `TeardownHostCleanup` against actual Account-scoped temporary ciphertext/files and
  output capability retirement. Exact Account cleanup preserves other Accounts, while explicit
  Wipe clears only the adapter-owned spool/output capability subtree. Core owns artifact, Replica
  and platform deletion order; host cleanup must not delete their SQLite files. Failures remain visible in Core teardown
  results. Do not install a success-returning placeholder to silence incomplete teardown.
- Reuse Vault-image ingress and existing ciphertext store/format. Recovery export, inspect,
  maintenance and re-Bootstrap use Core's existing recovery protocol and native stream/file
  primitives. Locked export includes required encrypted accepted work and artifacts but no
  credentials; repair never resets data or discards unknown work automatically.
- Travel cleanup follows decision 65: only encrypted accepted evidence and indispensable encrypted
  artifacts survive while hidden, inaccessible to read/new-work commands. Storage existence does
  not confer authority. Account teardown is the separately explicit end of local ownership.

## Native files acceptance

### SQLite recovery refinement

The native physical recovery adapter belongs beside Core's existing SQLite stores. The Web
executor is not reusable as a native database adapter: SQLite has no raw recovery reader or repair
staging implementation yet. Reuse the existing closed Rust recovery vocabulary and archive policy;
do not reconstruct that vocabulary or interpret accepted work in Desktop.

Recovery opens existing database files without `CREATE` and validates their known physical schemas
without running migrations. Unknown layouts and unreadable or oversized records remain explicit
failures, and their files remain untouched. Enumerate Account identities independently of the
Account catalog and stream one bounded raw row or binary chunk at a time, including durable,
provisional and Vault-image artifacts. Preserve malformed logical rows for Core diagnosis.

Physical maintenance must exclude ordinary native owners, including competing processes. Core
first retires its normal owner; native composition must then acquire exclusive device storage
access before opening the physical recovery adapter. Ordinary native startup holds the matching
shared device lease. Account attachment-preparation leases alone do not establish this exclusion.
Recovery source/sink handles remain caller-scoped platform capabilities. Core retains selection,
archive encryption, validation, accepted-work coverage and the decision to repair or re-Bootstrap.

Implement and verify capture/maintenance first, then artifact restoration and atomic guarded repair.
Ticket 69 requires actual native/Core/Server recovery and file-capability acceptance. Renderer
activation and native file-dialog routing belong to dependent ticket 66; actual Tauri application
acceptance belongs to tickets 72/73. Requiring that already-activated UI to close 69 would create a
cycle with 66's capability prerequisites. This separation does not waive either acceptance layer.

Existing native provisional storage keeps one current metadata row per Operation/Attachment, while
published artifact mappings can still reference older physical generations. Recovery must reconstruct
those historical metadata entries from their durable published mappings and chunk statistics; they
retain `current: false`. They are representable without changing the SQLite layout. Restoration must
preserve those mappings and bytes, never silently turn historical metadata into current metadata.
Foreign physical archive records which cannot be represented by these existing tables receive an
explicit unsupported result. Cross-engine repair interoperability remains an acceptance frontier;
passing same-native export/repair does not establish portable archive repair.

The read-only schema barrier also applies before ordinary artifact-store startup creates or alters
tables in an existing file. Permit a pristine new database, the exact historical B1 layout and its
existing append-only evolution, and the existing known generation-column migration; refuse future
or unknown layouts before mutation. Preserve historical B1 constraints rather than reconstructing
accepted ciphertext into a newly constrained table. This is a validation change, not a new schema
generation or a repair fallback.

Begin with real SQLite artifact reopen and a loopback signed upload/download crossing the existing
Core facades. Then test two-process lease exclusion/release, bounded/cancelled transfers, failed
sink verification, exact scoped deletion, restart during accepted Move, and recovery preserving
accepted work. Those are ticket 69 capability gates. After ticket 66 activates the existing renderer,
tickets 72/73 drive actual Desktop attachment select/upload/download/rename/delete/Move,
offline/reconnect and RemoveAccount/Wipe. Record real OS file dialogs and filesystem results
separately from capability tests. No passing mock cleanup or compilation establishes acceptance.
