# Browser Replica recovery contract

Accepted for [ticket 42](issues/42-browser-replica-recovery.md), 2026-09-08. Dependencies 38–41
are resolved or explicitly declined. The maintainer approved the reviewed contract: metadata-only
diagnostics; separate password-protected locked export with required artifact bytes and no credentials;
whole-Runtime maintenance; strictly proved same-Account repair; no automatic reset; and unchanged
explicit Remove/Wipe behavior. Independent Standards/Spec and simplification review preceded approval.
The recommended column below is accepted; alternatives are outside this initial scope. Numeric bounds
are private implementation guards to validate with targeted tests, not new Account capacity limits.

## Accepted scope

| Decision | Recommended initial scope | Alternative requiring a different decision |
| --- | --- | --- |
| Diagnostic surface | Account recovery screen available even when normal Runtime opening fails; copy a metadata-only diagnostic report and retry the same storage. Distinguish capability unavailable, quota/write failure, unsupported schema, invalid/corrupt logical state, and missing/unknown state. Counts are `unknown` unless read and validated. No reset button disguised as retry. | A support-only log surface is smaller but leaves the user unable to preserve bytes when normal opening is blocked. |
| Protected export | Separate Account recovery bundle, protected with a separate export password, available while the Account is locked if its scoped bytes remain readable. No Account unlock or Server Session needed to copy opaque stored material. It includes a complete validated snapshot or explicitly labeled partial/quarantined evidence, never silently upgrades a partial export to complete. | Require a usable unlocked Account and protect with its MUK. This reuses an existing key but cannot export quarantined bytes when unlock/normal opening is blocked. It is not the recommendation. |
| Contents | Exact accepted Operations, Attachment Move preparations/recovery/checkpoints, optimistic overlays, retained outcomes/receipts/cleanup obligations, protected Share capabilities, encrypted authority/Bootstrap/Cursor state, and all locally retained bytes required by those accepted records. Include non-secret Account identity and schema/provenance metadata. Explicitly omit all Session and Quick Unlock documents, DeviceKey, raw keys, bearer tokens, live source/sink grants and decrypted Item projections. | An Items-only export is the existing product archive, not recovery; it cannot satisfy ticket42. |
| Restore scope | Only the exact existing local Account ID, normalized Server URL and Server User ID. No remapping, cross-Account merge, cross-Device onboarding or restoration of authentication documents. A valid bundle is evidence, not permission to revive a Session or overwrite newer accepted work. Restore stays locked/signed out until the existing authentication path succeeds. | Portable Account recreation/import is additional identity and key-management scope and is deferred. |
| Quarantine and publication | Retire all local storage owners; quarantine means the original Account is blocked during inspection/staging. Add only missing immutable artifacts, then atomically repair one guarded Account in the existing Replica database. Proved complete repair ends quarantine; no copied archive or second Replica exists. Refuse publication when accepted-work coverage is unknown or any required bytes are missing. A partial bundle remains salvage evidence, never an executable Replica. | Publishing a rebuilt Account while unknown accepted work remains only in quarantine requires an explicit loss/recovery-policy decision. Do not infer that consent from an export, reload, or re-sign-in. |
| Re-Bootstrap | Rebuild Server-derived authority only after every surviving accepted Operation/preparation, receipt, protected capability and required artifact is retained in the candidate, or their absence is proved by a complete validated read. Re-Bootstrap cannot recreate local accepted work. Keep unknown/lost state explicit and refuse automatic reset when proof is unavailable. | Destructive abandonment of unknown accepted work is a separate explicit maintainer/user decision, not an implicit recovery fallback. |

The recommendations form one narrow contract. Locked/quarantined Account export uses the approved new password-protected envelope. The
alternatives materially weaken or widen that contract and are outside the approved implementation.

## Versioned export envelope

There is **no existing protected backup format** to reuse. `.bttrx` is a plaintext ZIP containing
`export.json` and decrypted attachments (`apps/web/src/lib/runtime-vault-export.ts`). Its ordinary
Import creates fresh Operations and does not restore exact immutable request identities.

The implementation uses a distinct binary `Bittery Replica Recovery`, version 1, unrelated to `.bttrx`:

- Protection is entirely inside Rust; host grants only opaque byte source/sink capabilities and
  collects a separate export password. No host-side crypto, row policy or archive assembly.
- Reuse the already deployed PBKDF2-HMAC-SHA256, SHA256, AES-256-GCM and system RNG primitives.
  Do **not** call Account `derive_master_key`: it deliberately mixes the Account Secret Key and
  email and is the wrong purpose/salt. Add a narrow recovery-purpose wrapper instead.
- Export KDF: PBKDF2-HMAC-SHA256, 600,000 iterations (current repository policy default), a fresh
  random 32-byte salt prefixed by the bytes `bittery.replica-recovery.v1\0` (including the final NUL), 32-byte output.
  Import accepts only this version's supported iteration range 600,000–1,200,000, checked before
  expensive work. Password input is exact UTF-8, no normalization; require 16–1,024 bytes for
  export, with a strong separate password prompted explicitly. Never suggest the Account password
  is required, and never store/log the password or derived key.
- Header is 56 bytes: `BTRREC01` identifies version 1 and its fixed algorithms, followed by
  big-endian iteration count, 32-byte salt, random 8-byte nonce prefix, and big-endian chunk size. It contains no Account identity, file
  names, Operation IDs or recovery details. Each frame uses a 12-byte nonce formed from that
  prefix plus its unsigned 32-bit big-endian sequence number, and authenticates the exact header
  bytes, purpose tag, sequence and frame kind as AAD. A fresh salt/key/prefix is minted per export.
- Reuse the existing 256-KiB artifact transfer chunk bound. Frames contain at most 256 KiB of
  plaintext (which itself is mostly original ciphertext); every frame has its own GCM tag.
  The encrypted manifest carries Account/Server/User identity, logical format version and
  `complete` versus `partial` classification. The exact authenticated head supplies source
  incarnation/revision/lock epoch; row and artifact records supply their references and hashes,
  which Core validates and counts while streaming. One final authenticated report records the
  actual three physical database versions, source and emitted-pass completeness, accepted-work
  and artifact-proof status, emitted record count, and bounded known invalid/missing identities.
  These fields preserve the promised provenance without duplicating every row in a second manifest.
  An unread remainder stays explicitly unknown; a partial second read cannot claim the first
  pass's complete emitted contents. Complete import requires exactly one final report agreeing
  with the records, followed by the authenticated terminal and actual EOF.
- Require one authenticated terminal frame with total frame count and plaintext byte length. Reject truncation, trailing data, duplicate/reordered frames and
  missing terminal frames. Authentication of a prefix never authorizes publication.
- Initial implementation safety defaults: 1 GiB payload total, at most 100,000 logical rows and 4,096
  artifact references, with a 64-MiB per-record decoded byte bound. Current stored
  `payloadJson` has no universal row-byte limit; a 15-MiB Import body represented as a numeric byte
  array can expand toward 60 MiB. The targeted maximum-Import regression constructs the full
  15-MiB immutable body and validates its approximately 60-MiB durable row against this bound;
  the chunk bound alone does not bound JSON allocation. Reject oversized declared records before
  allocating, with a bounded decoder.
  Read/write the archive incrementally; one bounded record may span frames, but do not build
  the whole bundle in JS/Rust memory. An oversized Account is a visible refusal that
  preserves storage, **not** a truncated export. These are implementation resource guards,
  not new Account/product limits or claims that every existing Account fits. Oversize refusal must
  identify the bound and preserve the complete source; changing a guard later must not weaken
  authenticated format validation. The maintainer approves explicit bounded refusal, not arbitrary
  truncation or a new Account capacity restriction.
- Zeroize password, derived key, decrypted frame buffers and any plaintext image chunks on
  completion, cancellation and error. Wrong password/tampered envelope yields one bounded
  authentication refusal without publishing data. Outer encryption protects metadata and the
  existing plaintext Vault-image artifact; copying only inner Item ciphertext is insufficient.

The crypto algorithms are reuse; this framing, AAD domain, key derivation purpose, password policy
are **new versioned format decisions**; allocation/count limits are implementation guards. They require dedicated vectors, tamper
and truncation tests plus independent review before implementation can claim compatibility. No
claim is made that an existing encryption API already provides a streaming recovery archive.

## Exact recoverable material and exclusions

Current Replica logical records are defined by
`packages/client-runtime/crates/bittery-client-core/src/replica/persistence_contract.rs`:
head plus `optimisticItems`, `operations`, `attachmentMovePreparations`, `shareCapabilities`,
`operationReceipts`, `replicaMetadata`, `bootstrapGenerations`, `bootstrapPages`,
`authorityVaults`, and `authorityItems`. Preserve the original `payloadJson` and immutable
HTTP request method/path/headers/body/fingerprint bytes; do not parse and reserialize immutable
request bodies or mint new Operation/Item/Attachment IDs. Core reconstructs and independently
validates domain relationships before calling an export complete or permitting import.

The references extend beyond Replica rows:

1. `bittery_attachment_artifacts` (v3 after the maintenance barrier) contains `artifacts`, `chunks`,
   `provisional_artifacts`, `provisional_chunks`. Copy published ciphertext chunks and the exact
   recoverable provisional generation/proof required by accepted Attachment Move preparations or
   an Operation's `attachment_move_recovery`. Validate Account/Operation/Attachment identity,
   canonical artifact ID, ciphertext SHA256, byte length, chunk sequence and publication state.
   A source grant cannot be reconstructed from a byte count. If an accepted preparation still
   needs remote source ciphertext, retain that preparation and state its network dependence;
   the bundle is not a promise of immediate offline completion.
2. `bittery-vault-image-artifacts` (v2 after the maintenance barrier) contains `artifacts` and `chunks`, scoped to Account+Operation.
   These are explicitly **plaintext** image bytes, at most 2,097,152 bytes each. Copy all locally
   retained bytes required by accepted Create-Vault image intent and any pending receipt cleanup
   obligation, with Vault ID/content type/hash/length/progress metadata. Do not weaken the current
   final-request/remote-upload/local-cleanup checkpoints or pretend missing local bytes exist.
3. Include only referenced accepted/recoverable material in a complete executable bundle. Arbitrary
   unaccepted staging and transient File/Blob/source handles are not accepted work. When a corrupt
   record prevents deciding its references, quarantine may preserve scoped opaque bytes as partial
   evidence, but cannot label them safely classified or resumable.

Share capability ciphertext is protected by the **MUK**, not DeviceKey, with AAD containing local
Account ID and Operation ID (`crypto-core/src/share_capability.rs`; Runtime `create.rs`). Created
Vault keys are MUK-wrapped; Attachment Move keys are wrapped to the target Vault key. DeviceKey
protects Quick Unlock material (`authentication_installation.rs`) and is not needed merely to copy
Replica ciphertext. Therefore do not justify same-Account scope by falsely claiming all Replica
rows depend on DeviceKey; the scope is deliberate identity preservation and bounded recovery.

Export minimal non-secret identity/provenance from the existing Account metadata/catalog needed to
match normalized Server URL, Server User ID and local Account ID. Do not export the Device catalog
wholesale or any other Account. Do not reinstall preferences, transport consent, Travel Mode
policy or pinned authentication policy from an untrusted bundle. Keep current locally validated
policy and revalidate against the existing Server authentication ceremony.

Explicit exclusions: `DeviceKeyDocument`, every `QuickUnlockDocument` field (including its encrypted
MUK and Secret Key), `CurrentSessionDocument`, bearer/refresh material, raw MUK/Vault/Attachment/
Share keys, biometric material, plaintext Item data, decrypted Share tokens and capability grants.
The outer envelope key is derived for this export only; it is never an Account/Session credential.

## Consistency, quarantine and same-Account import

The three IndexedDB databases cannot share one transaction. The existing Attachment Move Account
lease is purpose-specific, not proof of a universal recovery/writer lock. A recovery implementation
must acquire exclusive ownership across all participating writers or refuse with `busy`:

Use one narrow **physical maintenance exclusion**, not a generic lock/mutation RPC: every
normal Runtime storage-owner instance acquires a shared origin+database-family lease before opening
any of the three stores and holds it through its final drained callback. Recovery closes its own
normal owner, then tries an exclusive lease for the same family with an immediate `busy` refusal.
Because the family is shared, this closes the whole local Runtime and temporarily affects every
Account, even though exported/restored contents remain strictly Account-scoped. Other tabs must be
closed or explicitly retired before retry; recovery never commandeers them or
starts a replacement writer alongside them. The host adapter only obtains/releases this physical
lease and exposes the resulting scoped executor lifetime; Rust decides admission, eligibility,
quarantine and publication. No operation names, policy predicates or arbitrary resource keys cross
this port. Include the existing artifact/source/sweep executors under the same lifetime lease, so a
late GC callback cannot escape it. When maintenance exclusion is unsupported in a host, ordinary previously supported IndexedDB
startup remains available, but recovery maintenance is unavailable. Do not add a browser support
floor. Where the exclusion primitive is available, normal owners must acquire their shared lifetime
lease: blocked/rejected acquisition cannot silently fall back to an unfenced owner while another
context could enter maintenance. Distinguish an unsupported capability from an operational failure
of a supported one; the latter fails closed for admission/maintenance, with retry and explicit
diagnostics. This is private adapter admission behavior, not a new host policy API.

A storage owner from an older build that never acquired the lease
is **not fenced** by this scheme. A concrete prior-build barrier is coordinated additive physical
version bumps for all three databases before recovery becomes available. The pre-recovery
openers pin explicit versions (Replica 7, Attachment artifacts 2, Vault images 1). Recovery upgrades
them to 8, 3 and 2 respectively; after successful upgrades, old-version reopen fails. Older artifact
openers may retain connections without closing on versionchange, so blocked upgrades visibly
refuse until those contexts close. All three current openers apply ticket38 blocked/versionchange/
late-success cleanup, and all three upgrades must succeed before maintenance. A partially upgraded family
preserves its data and remains unavailable until it can finish; never reset or fall back. Recovery maintenance has no fallback without proven cross-context exclusion; this does not
disable ordinary IndexedDB on a platform where maintenance is unsupported. This is an explicit implementation
requirement of the decision, not a claim the current Attachment Move lease already does this.

- Stop Account admission, Sync, dispatch, foreground transfers, artifact publication and sweeps;
  cancel/drain in-flight work with the existing lifecycle registry/fences. Fence other tab/process
  ownership too; a single-tab mutex is insufficient. If physical corruption affects the entire
  shared DB, block only what can actually be isolated safely; never claim Account isolation while
  scanning or copying unscoped rows from another Account.
- Capture a transaction-consistent Replica snapshot, then its referenced immutable artifact bytes
  under the same exclusive recovery boundary. Recheck the original catalog/head generation before
  declaring completion. Missing/busy/error is explicit; export never runs cleanup as a side effect.
- If normal domain decoding fails but the engine can still read rows, permit password-protected,
  strictly Account-scoped partial evidence export. Preserve original bytes; never feed malformed
  evidence straight into the normal loader. If the engine cannot enumerate any scoped bytes,
  diagnostic-only is honest. No API can export bytes the browser has erased.
- Import first authenticates the entire bundle and validates closed schema, exact Account binding,
  row uniqueness, immutable Operation fingerprints, terminal receipt correlations and every required
  artifact. Reject foreign/mixed Account rows, changed IDs, unsupported versions, corrupt hashes,
  duplicate/conflicting work and partial bundles. Do not fetch network data to conceal a bad bundle.
- Keep existing readable state untouched while staging. Artifacts are immutable under existing
  Account/Operation/artifact identity: add only missing exact bytes, verify identical existing bytes,
  and reject conflicting existing metadata/chunks/publication state. Retain original artifacts;
  no overwrite, sweep or artifact rollback is needed to publish the candidate. All writers/sweeps
  remain excluded through this sequence. A crash before Replica publication leaves only harmless
  unreferenced additions, which existing accepted references cannot mistake for new accepted work.
- Narrow executable repair to a **readable guarded head with independently proved complete
  accepted-work coverage**. Head/revision equality alone is not proof: validate every accepted
  Operation/preparation, receipt, overlay, protected capability, cleanup obligation and required
  artifact relationship in the current state. The candidate must contain the **exact same accepted
  row identities and raw payload hashes**, not merely a superset. Extra archived Operations or
  protected Share results could resurrect work/results already resolved, acknowledged or removed;
  refuse those older/conflicting bundles rather than merge them. Derived authority may differ.
  Malformed accepted rows, incomplete enumeration or unknown references make the result evidence-only.
  A bundle cannot declare its own coverage of work accepted after its snapshot.
- Quarantine is the **blocked original Account state** during inspection/staging. Keep that state
  untouched on failure or partial export; optional protected evidence export may precede repair.
  Apply the Core-prepared repaired rows/head in one guarded transaction of the existing Replica
  database. Clear only the failure state whose resolution is proved in that same transaction.
  Successful complete repair ends quarantine and resumes ordinary cleanup using the preserved live
  references. There is no copied quarantine store, permanent rollback archive, GC pin registry or
  physical database selector. Thus no retained archive can falsely promise artifact bytes that
  ordinary cleanup later removes. Existing guarded commit/install mechanics provide atomicity;
  a narrow Rust recovery preparation/policy path must establish these additional proofs, rather
  than exposing arbitrary host row writes or weakening the existing normal validators.
- Keep the stable local Account ID and **current** catalog identity/incarnation. The archive's
  incarnation is authenticated provenance, not a rollback target or by itself a rejection rule:
  normal full Sign-in can change incarnation for the same Account. A previous-incarnation archive
  still needs exact Account/Server/User matching and the same exact current-work coverage proof; it
  authorizes no identity remapping. Use current guarded revision/lock epoch and advance them
  by exactly one for a published repair, never install archived counter values. Existing lifecycle retirement plus the
  origin-wide barrier prevents old callbacks/writers from running. Fail closed on counter exhaustion.
  No catalog selector change or new Account installation is needed. Existing local Quick Unlock
  documents remain outside the repair and retain their current classification/lifetime; restored
  access is still locked/signed out until the existing authentication path succeeds.
- Do not merge into a healthy or newer Account snapshot. Exact duplicate import can be an idempotent
  no-op only after proving complete logical+artifact equality. Otherwise show a conflict and preserve
  both original evidence and proposed bundle without making either a second active writer.

Device-state distinction is explicit: a completely empty Device with no catalog and no Replica
remains valid ordinary onboarding. The recovery view cannot distinguish a first installation from
both stores having been erased, so it may only say previous state is unknown; a new Sign-in is not
reported as recovery. A retained catalog entry whose Replica is missing is evidence of storage
loss, never permission to install an empty replacement. The initial same-existing-Account repair
scope does **not** recreate a registration on a cleared/fresh Device, remap a newly signed-in local
Account ID to an old one, or repair an unguardable/missing head. A protected backup in those cases
remains preserved evidence; broader restoration would require a separate approved identity/loss
policy. These limitations must be visible in the maintainer choice and UI, not hidden in tooling.

For host transfer plumbing, reuse bounded chunk ownership/cancellation/backpressure patterns from
existing source/sink grants, but add a closed AccountRecovery purpose with Account identity and
bundle byte limit. Do not fabricate an Attachment ID/Vault ID or use `downloadAttachment` for a
recovery archive. The host handles bytes only; Rust owns format, limits, classification and admission.

An older bundle cannot prove what was accepted after it was created. Corrupt/missing current state
therefore cannot automatically be replaced by that older bundle just because its password is valid.
The original Account stays blocked until coverage is proved; retaining unreadable bytes is evidence
preservation, not proof that their work was recovered. Re-Bootstrap may recover Server authority but cannot discover lost local Operation IDs or
recreate bytes never sent to the Server.

Existing explicit **Remove** and **Wipe** semantics remain available and unchanged. The rule against
a recovery reset means no new silent/automatic discard path and no recovery action that impersonates
those commands. It does not prohibit a user from explicitly choosing the already supported destructive
lifecycle action. Such removal is reported as removal, never as successful recovery of accepted work.

## Implemented recovery boundary

The four closed requests are `InspectRecovery`, `ExportAccountRecovery`,
`RepairAccountRecovery`, and `RebootstrapAccountRecovery`. The first request permanently drains
and retires the existing Runtime's normal admission, Accounts and cached secrets. That same object
can subsequently serve recovery requests only; it never resets its closed flag or installs a second
Runtime/Crypto owner. Leaving maintenance releases the physical lease. Retry starts a fresh normal
Worker/Runtime incarnation through the existing host lifecycle barrier.

- Diagnostics combine the existing catalog with a bounded enumeration of Account IDs from the
  fixed Replica/Attachment/image stores. This can reveal surviving physical scopes when the catalog
  is absent or corrupt, but cannot infer a Server/User identity or recreate registration. Such
  scopes have explicitly absent metadata and permit partial evidence only. A known catalog entry
  with no head remains missing storage; completely absent catalog and physical scopes remain
  `freshOrUnknown`. The separate schema status is `supported` only after the three-database
  barrier, `unsupported` for a proved incompatible layout/version, and otherwise `unknown`.
- Core's streamed coverage validator retains compact identities, hashes and dependencies instead
  of a second full Replica. Summary state is bounded to 16 MiB; physical continuation tokens are
  bounded to 1,024 bytes. Archive record headers are bounded to 64 KiB. Physical control JSON is
  bounded to 64 MiB plus 64 KiB, with exact UTF-8/JSON escaping checked before host serialization
  and before Core decoding. Quote/control-heavy malformed records cannot turn a bounded raw row
  into an unbounded escaped bridge allocation. The authenticated report is bounded to 64 KiB;
  exhausting its findings capacity refuses the export instead of dropping known findings.
  Resource refusals use `SIZE_REJECTED` with the closed optional `recoveryBound` discriminator.
  Every such refusal is terminal and discards the export sink; it cannot become a partial prefix.
  The field is absent from unrelated size refusals. Diagnostics show work totals only after a
  complete read and valid coverage; a readable prefix does not establish an Account total.
- The same immutable source capability is rewound for two authenticated import passes. Each pass
  requires both the authenticated terminal and actual source EOF; trailing bytes or an error after
  the terminal refuses publication. An internal comparison of the ciphertext seen in the two
  passes detects a changed source. It is not an extra persisted framing digest.
- After complete validation, candidate rows are streamed into private, unreachable input staging
  in the existing Replica database. Staging contains no active head and is not a physical selector
  or copied quarantine. The final transaction rechecks the exact current head and every current
  row's raw hash, copies one bounded staged row at a time, advances the head, and removes staging.
  The host keeps that transaction alive across bounded hash work and resumes from a pending
  IndexedDB request callback before continuing the guard and publication. This uses the same held
  transaction; merely keeping it alive does not make an external WebCrypto callback active in
  Firefox. No whole-bundle `PreparedReplicaCommit` crosses the control port. Failed or cancelled publication leaves the
  original Replica intact. Missing immutable artifact additions may remain unreachable, as above.
- Explicit re-Bootstrap reuses this staging/guard/publication path with a different proof: every
  current accepted row and required local artifact must already be valid and retained. It removes
  only derived authority/Bootstrap state. Malformed accepted work or missing required artifact
  bytes cannot be bypassed by choosing re-Bootstrap. Normal authentication and Server hydration
  happen only after the fresh normal owner starts.
- Cancellation identifies the exact physical recovery scope and waits for held callbacks and
  transactions to settle before releasing ownership. An ambiguous maintenance acknowledgement
  still requires confirmed release. If cancellation races a committed repair acknowledgement,
  the committed result remains durable truth; it is never reported as proof that nothing changed.

The implementation boundaries are [crypto framing](../../packages/crypto/core/crates/bittery-crypto-core/src/replica_recovery.rs),
[streamed coverage](../../packages/client-runtime/crates/bittery-client-core/src/replica/recovery.rs),
[transfer](../../packages/client-runtime/crates/bittery-client-core/src/recovery/transfer.rs),
[repair policy](../../packages/client-runtime/crates/bittery-client-core/src/recovery/repair.rs), and
[Runtime lifecycle](../../packages/client-runtime/crates/bittery-client-core/src/runtime/recovery.rs).
The [independent format vector](../../packages/crypto/core/crates/bittery-crypto-api/tests/format_vectors.rs)
and targeted Core/host tests verify these mechanics. Browser acceptance and its limits are recorded
below; full CI was waived and was not run.

## Minimum acceptance and useful reuse

Use the existing generated Replica corpus unchanged to check logical round trips, plus accepted
Create/Import/Share/Attachment Move/Create-Vault-image checkpoints with real artifact bytes. Add
failure injection at every staging/publication write, restart on both sides of publication, exact
same-ID/fingerprint replay, wrong Account/User/Server, older/conflicting snapshot, foreign row,
missing/corrupt artifact, password/header/frame tampering, size/KDF refusal, quota/read/capability
failure, user-cleared storage and private-context loss. Explicitly prove no plaintext/key/bearer
appears in exported bytes or diagnostics, no second tab can write during recovery, old callbacks
cannot publish after it, partial import cannot become visible, and failure does not trigger sweeps
of the blocked original accepted bytes. After successful repair, ordinary cleanup may resume only
with all required live references preserved; there is no archive lifetime to manage. Real browser acceptance must retain exact ticket32 durability and
live-Sync lifecycle behavior. Targeted tests/types/format/generated checks apply; full CI remains
waived for this run.

Useful existing deep boundaries: Rust domain validation; the closed generated persistence request
contract; lifecycle cancellation/retirement; immutable artifact identity/digest/publication; existing
catalog pending-install reconciliation; opaque host byte grants; the small crypto crate. Keep UI
presentation in the host and recovery policy in Rust. `.bttrx`, host JSON row manipulation, whole
live-file copying, and the Attachment Move lease alone are not suitable recovery abstractions.

## Validation and limits

2026-09-08: independent Standards/Spec review and the complete simplification pass approved the
implementation. Validation was targeted; full CI was waived and was not run.

- Chromium: all six recovery/loss scenarios passed, followed by the affected owner-retirement and
  final guarded-publication pairs. All six Firefox cases passed across targeted runs: four earlier
  cases and the final repair/re-Bootstrap pair.
  These scenarios cover locked protected export, real cross-tab exclusion, held historical database
  versions, wrong-password/truncated import refusal, actual Worker loss before and after publication,
  exact accepted Operation/image preservation, explicit re-Bootstrap and authenticated convergence,
  cleared storage, nonpersistent context loss and injected OPFS quota.
- Existing behavior: the first-slice six-fault/renewal/lost-ack/SQL durability scenario, Attachment Move
  restart and all seven live Sync scenarios passed. Exact immutable replay and If-Match/outcome
  assertions remain intact.
- Fault boundaries: 158 injected IndexedDB staging/publication/artifact failures preserve the original
  state or only permitted immutable additions. These are deterministic host tests, not 158 browser
  crashes. Separate real Chromium/Firefox probes verify exact guarded publication after hashing,
  other-Account preservation and staging cleanup in the same transaction. Cancellation and competing
  writer tests cover that transaction boundary.
- Core and crypto: targeted tests cover the independent envelope vector and tampering/EOF refusal,
  bounded streaming including a 15-MiB Import body in its approximately 60-MiB durable row,
  accepted-work coverage,
  real encrypted Attachment and plaintext image recovery, authenticated report findings and typed
  resource refusal. Affected types, Server/Desktop checks, scoped formatting/Clippy, generated
  contracts/native/Web bindings, i18n and architecture checks passed.
- Limits: quota is injected at the actual Worker write primitive, not demonstrated by exhausting
  physical disk. Context-loss tests use real nonpersistent browser contexts, not manual private-mode
  UI. No Safari/iOS acceptance is claimed. Firefox signup has a bounded setup allowance after measured
  real RSA generation exceeded the generic setup deadline; recovery assertion deadlines are unchanged.
