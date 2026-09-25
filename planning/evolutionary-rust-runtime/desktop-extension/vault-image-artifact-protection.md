# Protected accepted Vault-image artifacts

[Research92](../issues/92-protected-vault-image-artifacts.md) resolves a concrete prerequisite to
[Travel71](../issues/71-runtime-travel-management-and-erasure.md). Root selected the mechanism below;
independent review passed and [delivery93](../issues/93-protected-vault-image-artifact-storage.md) is
ready for implementation. No plaintext retention exception or implementation is claimed.

## Actual contract mismatch

[Vault image ingress](../../../packages/client-runtime/crates/bittery-client-core/src/vault_image.rs)
explicitly describes durable plaintext ingress. `prepare_image` hashes bounded raw chunks and passes
them to `VaultImageArtifactPort.write_chunk`; the
[SQLite backend](../../../packages/client-runtime/crates/bittery-client-core/src/vault_image/sqlite.rs)
stores those bytes in a `plaintext BLOB` column. `read_published_bound` reconstructs the bounded image
and verifies its original byte length/digest. This differs from the authenticated encrypted Attachment
artifact contract. Calling the current image artifact encrypted-at-rest in planning prose is inaccurate.

CreateVault prepares this image before generating its new Vault key. UpdateVault reuses the same
image preparation with an existing target Vault. The artifact scope already binds Account, Operation
and allocated Vault identities; crypto authorization need not be inferred by the native/browser port.
An unbound Create picker becomes bound by Core before acceptance; there is no fake existing Vault
membership for that pre-creation identity.

The [checkpoint owner](../../../packages/client-runtime/crates/bittery-client-core/src/runtime/create_vault_staging.rs)
has `ArtifactReady`, `RemoteUploadConfirmed` and `FinalRequestFrozen` stages. ArtifactReady can require
the complete original bytes for upload. Later stages can progress without reading those bytes, but the
current [recovery coverage](../../../packages/client-runtime/crates/bittery-client-core/src/replica/recovery.rs)
still treats an image referenced by a live accepted Operation as required. A terminal receipt's image
cleanup record does not require its bytes. Do not delete bytes at an earlier checkpoint merely because
one present execution branch does not read them; first prove remote staging/recovery/retry semantics
and encode any reduced dependency in that same existing coverage owner.

Public Server image bytes and immutable image digest/length/content type must stay unchanged. Raw
image representation on the Server is not an exception to decision65's local retention policy.

## Existing primitives and options

[Crypto encryption](../../../packages/crypto/core/crates/bittery-crypto-core/src/encryption.rs) already
implements AES-256-GCM, `AES-GCM-AAD-V1`, `EncryptedData { ciphertext, iv, algorithm }` and `AadContext`.
The AAD serializer admits scoped entity types without a second cryptographic algorithm. Existing
encryption takes a string; bounded binary chunks therefore need an explicitly specified reversible
encoding inside that existing envelope, not lossy UTF-8. Bind Account/Operation/Vault, chunk index,
format version and User identity; fresh IVs and byte/digest validation remain mandatory. Specify this
context and vectors before writing protected artifacts. Do not change any existing cipher vector.

| Candidate | Fit and issues to resolve |
| --- | --- |
| Existing Device key | Available for Create before a Vault exists and survives Account lock/password changes. No new login secret. Core must still refuse hidden-image decryption; possession of this key is not current Vault authority. Recovery on another Device cannot depend on the source Device key or export that Device-wide secret, so an explicit protected artifact/recovery translation or wrapping mechanism is required. |
| Existing Account MUK | Already available during both admissions and derivable on another Device after full authorized authentication. Does not require an existing Vault. Establish password/Secret-Key replacement compatibility and locked encrypted recovery validation before choosing it; do not silently require unlocking a hidden artifact to build a recovery archive. |
| Existing/new target Vault key | Existing Update Vault scope is natural and key retirement limits local decryption. Create would need its new key prepared before image ingress. Membership/key rotation, hidden-key erasure, accepted creation wrappers and recovery can make an indispensable artifact unusable; an old accepted wrapper must not become hidden-key authority. |

These are technical candidates, not accepted alternate product policies. Prefer a single Core-owned
protection boundary around the existing image artifact port, with native/IndexedDB implementations
storing opaque protected envelopes. Avoid adapter encryption and parallel plaintext/encrypted owners.
Protection at initial ingress prevents new durable raw copies. Protecting only at Travel retirement
adds a larger failure/crash window and still needs a restartable conversion of legacy raw artifacts;
it cannot simply replace or delete the only accepted bytes before the protected publication commits.

## Compatibility and recovery conditions

- Preserve existing image metadata, public bytes, Server digests and exact accepted HTTP requests.
  A protected storage wrapper is separate from that public representation; no new Server image format.
- Explicitly version protected local records and read old plaintext records under their existing
  schema. Migrate with a guarded publication that retains one valid accepted artifact across failure,
  then removes unnecessary raw copies. Old software must not mistake ciphertext for a raw image or
  silently overwrite the protected format. Reuse existing schema/open-version fencing and generated
  cross-language definitions; do not hand-write a TypeScript mirror.
- Read existing encrypted recovery archives and preserve required artifact identity. Current image
  archive entries describe raw image chunks inside the encrypted recovery stream; opaque protected
  chunks require either a reviewed compatible entry/version extension or an authorized transformation.
  No source Device key may be exported as a convenience, and hidden artifact decryption is not
  automatically authorized by an Export action. Native/IndexedDB repair and locked recovery must use
  one coverage/validation owner.
- Determine when confirmed remote staging makes local bytes dispensable, including crash, expired
  grant, lost status/outcome, exact replay and terminal cleanup. Do not weaken accepted-work coverage
  to make deletion pass or silently rebuild an image from unavailable host selection.
- Include raw temporary files, old rows and relevant journal/WAL/cache behavior in evidence. Deleting
  a logical row alone is not proof that no retained raw representation remains. State the actual
  cleanup guarantees; do not claim physical forensic erasure from a database query.

The [crypto development contract](../../../packages/crypto/core/DEVELOPMENT.md) requires an explicit
migration and architectural decision for intentional persisted-format changes, plus compatibility
vectors. Reusing AES-GCM does not remove that requirement. No new password, login-equivalent secret,
Server retained outcome, or blanket public-image exception is proposed.

## Required tracer and review

First prove an accepted offline UpdateVault image remains the same image after durable protected
publication/reopen and later exact upload. Inspect actual SQLite and IndexedDB records, not just
projection filtering. Then hide before upload and prove the artifact cannot be read/decrypted or
used for new work while its indispensable encrypted evidence remains. Include a pre-creation image,
legacy raw artifact migration failure/crash, every checkpoint, password/key replacement, two Accounts,
locked encrypted export/repair on another Device and stale cleanup. Preserve exact bytes/digest through
real Server/object-storage acceptance and existing image/final-outcome gates.

## Selected mechanism and migration decision

2026-09-09: root selected one random key per image artifact, using the existing
`generate_encryption_key`, `encrypt_with_aad`, `EncryptedData` and `AadContext` primitives. The existing
Device key wraps only that artifact key and authenticated artifact metadata at rest. It is neither a
new login secret nor a Vault key: possessing it cannot establish membership, re-admit a hidden scope,
unlock an Account, or authorize an upload. Core's existing current-authority/foreground fence remains
the sole read and decryption admission owner. Identity-only terminal cleanup never unwraps a key.

This choice works for Create before the target Vault exists and for Update without tying accepted
bytes to a rotating Vault key or changed password/Secret Key. Each admission generates a fresh artifact
key and publication identity; cancelled unpublished work never reuses that key. A missing/corrupt
Device key gives an explicit unavailable/corrupt dependency, not a replacement key or silently lost
Operation. Existing Account installation already creates the Device key; native-only installation and
recovery must use that same platform-secret owner, never persist a second key store.

### Exact protected record and context

One versioned protected metadata record contains the original Account/Operation/Vault/User identity,
publication identity, image byte length/content type/SHA-256, protected chunk count, protected byte
length and SHA-256, and the existing `EncryptedData` key wrapper. The authenticated wrapper plaintext
is a closed, versioned encoding of those same metadata values plus the base64 artifact key. Core
compares every duplicated field after unwrap. The final image digest/counts are known at publication;
the wrapper is published only after all ciphertext chunks are durably validated, before accepting the
Operation. Incomplete unpublished ciphertext is ordinary existing orphan cleanup work.

- Key-wrapper AAD uses actual `vaultId`, actual `userId`, `entityType = vaultImageArtifactKey`,
  `version = 1`, and `entityId` equal to Core's compact JSON array encoding of
  `[AccountId, OperationId, publicationId]`, using existing validated identity values. The
  authenticated payload binds all image and ciphertext metadata, not merely
  the envelope's public columns.
- Chunk AAD uses the same actual Vault/User, `entityType = vaultImageArtifactChunk`, `version = 1`,
  and `entityId` equal to the same compact JSON array with a final numeric `chunkIndex`. The index
  is unsigned decimal with no leading zeros; the exact serializer is Core-owned and vector-tested.
  Fresh IVs come from the existing primitive. The unique
  key/publication plus authenticated final count and digests prevents replacement, reordering and
  truncation; read completion also verifies the original image byte count and digest.
- Binary input is standard padded base64 inside the existing string-encryption envelope. Protected
  records use bounded serialization of the unchanged `EncryptedData` structure. Use raw input chunks
  at most128KiB so base64 input plus ciphertext base64 and envelope overhead stays within the existing
  256KiB storage/recovery transfer bound; measure the actual maximum serialized record in a test.
  This changes internal segmentation only, not the existing image size limit, public bytes or digest.
- All wrappers, unwrapped keys, encoded plaintext and read buffers use existing zeroizing ownership.
  Hosts store opaque metadata/chunks and cannot call a new public decrypt-key primitive. No callback,
  projection, log or raw recovery report contains an artifact key.

Define these Rust records once, generate cross-language controls under ADR0012, and add deterministic
scope/encoding vectors without editing existing AES-GCM/AAD vectors. Native and IndexedDB ports
deepen their current image stores; there is no second protected-image backend.

The shared accepted image record gains an optional protected-publication witness, defaulted to absent
and omitted for existing raw records. It contains format/publication identity and ciphertext digest,
byte count and chunk count. It contains no Device-key wrapper, so destination rewrap does not alter
accepted identity. New admissions retain this witness alongside the existing original image digest;
immutable HTTP bodies and public metadata stay unchanged. The existing accepted-work coverage owner
compares recovered opaque chunks against this accepted witness, not only a portable record's own
claimed digest. This prevents a self-consistent replacement protected artifact from being treated as
the original accepted dependency without decrypting hidden image bytes.

Legacy raw metadata lacks User identity; migration derives it from the exact validated Account/Replica
owner under the captured source guard, never from a host-supplied guess or an unrelated active Account.

### Portable encrypted recovery without image decryption

The existing [archive framing](../../../packages/client-runtime/crates/bittery-client-core/src/recovery/archive.rs)
has closed image metadata/chunk variants, and
[integrity inventory](../../../packages/client-runtime/crates/bittery-client-core/src/recovery/artifacts.rs)
currently checks their raw image digest. They cannot reinterpret ciphertext as those old records.
Add protected-image metadata/chunk/key record variants in a new recovery manifest version; retain
the exact old manifest/raw-image reader. The outer authenticated recovery envelope and cipher format
remain unchanged. Existing readers reject unsupported versions instead of misreading new bodies.

Explicit encrypted recovery may unwrap only the small artifact-key envelope using the existing
Device-secret capability, and send that key with its authenticated scope/metadata directly into the
existing encrypted recovery record stream. It copies and validates opaque image ciphertext using its
protected digest/count; it does not decrypt hidden image chunks. The archive contains neither the
source Device key nor unrelated artifact keys. This narrow key transfer is not a host read or an
exception allowing hidden image decryption. The recovery password and artifact-key buffer remain
ephemeral and zeroized through cancellation/error.

On guarded repair, the same Core recovery owner verifies the authenticated archive/key scope and
opaque ciphertext integrity, then wraps that one key under the destination's existing Device key.
Image ciphertext, public digest and accepted request remain unchanged. Any rewrapped physical metadata
is prepared by Core before the existing guarded repair commit; hosts perform exact record writes.
Same-native restore may preserve an already valid identical wrapper. Cross-device restore must not
require copying the source platform secret. Missing Device-secret access cannot be called complete
portable recovery: report the precise unavailable dependency while preserving readable encrypted
evidence. Account-scoped repair and current accepted-work guards stay unchanged.
Portability here means the existing Account identity and accepted scope survive a change of Device-key
domain. It does not add arbitrary Account-ID remapping; chunk AAD binds the original Account identity.

This key translation belongs in the existing Core encrypted recovery owner. The actual current
`export_snapshot` reads physical records after normal-owner retirement and does not access Device
secrets, so93 must add a narrow Core-owned key translation capability using existing platform storage;
the physical recovery executor must not become a cryptographic owner. Its lifetime extends through
the existing maintenance gate and source/sink cancellation/cleanup.

### Legacy raw artifacts and stage coverage

The existing Account/Operation identity is an artifact family. Represent concurrent raw/protected
publications inside that same store: legacy raw publication has an absent publication ID, protected
publication uses its accepted UUID. Storage scope and metadata carry that optional generation through
the same Rust-defined port and generated native/Web controls. Writes/reads select the exact generation;
the existing `delete_bound(Account, Operation)` continues deleting the whole selected family without
key access. One exact `delete_generation` primitive supports abandoned protected output and raw cleanup
after witness commit without deleting the sibling indispensable publication.

SQLite deepens its existing metadata/chunk tables with the publication component in their keys and
optional protected metadata; the explicit schema migration retains old raw values/readers. Memory and
IndexedDB stores use the identical family/generation distinction. Do not overload Operation IDs with
a synthetic suffix or create a second image backend. Old source/read callers remain raw-compatible
while the protected path is composed; new protected Runtime admission stays inactive until scoped
authority/loans, accepted witness, legacy conversion and recovery integration are complete.

Use an additive versioned image-store schema/open contract; older software must fail closed on the
new schema. New readers retain old raw records and existing encrypted archives. Convert each legacy
artifact through existing guarded publication while keeping one valid accepted dependency across
failure: publish the protected artifact while retaining raw bytes, commit the optional witness into
the exact accepted local image evidence under the captured source revision, then delete raw rows.
This is an explicit one-way local-evidence migration, never a mutation of accepted HTTP bytes. Validate
the old raw digest and image identity before enriching a legacy record. A failed/stale witness commit
retains the raw dependency; cleanup cannot run merely because ciphertext publication succeeded.
Do not pretend the separate source/artifact stores share one atomic transaction. A restart resumes
from durable publication and witness state, not an in-memory migration cursor or a second runner.
Conversion before erasure is
a storage upgrade, not permission to read a hidden artifact for application work. A legacy raw
artifact cannot be declared protected while conversion/cleanup is incomplete; Travel stays fenced.

Initially preserve current image-byte dependency at all live accepted checkpoints, including
RemoteUploadConfirmed and FinalRequestFrozen. Receipt cleanup alone makes bytes unnecessary under
the current coverage contract. An optimization deleting them earlier is outside93 and needs actual
remote staging/recovery proof; it is not required to deliver the protection mechanism.

These changes are explicit additive local-storage/recovery representation migrations. Existing
cryptographic algorithms, envelope identifiers, serialized legacy records, old archives, immutable
HTTP bodies and public Server image bytes are preserved, not rewritten or reinterpreted. This
decision must pass independent review before implementation readiness.

### Delivery and evidence boundary

Delivery93 implements this one shared capability. Its first vertical slice is real protected ingress,
SQLite reopen and unchanged upload; then Web/IndexedDB, pre-creation images, migration and encrypted
recovery portability. Required negative vectors cover wrong Account/Operation/Vault/User/publication,
chunk swap/reorder/truncation/duplication, changed metadata, corrupt wrappers and protected digests,
wrong key and oversized envelopes. Require guarded failure/cancellation at publication, raw cleanup,
recovery rewrap and physical repair boundaries. No successful projection or query substitutes for
checking actual persisted representation.

Research92 can resolve after independent mechanism review and93's concrete readiness contract. It
does not mark93 implemented. Travel71 and70's accepted-image retirement variant depend on93;70's
no-image retirement foundation does not. No new product decision or plaintext exception is required.

Independent review required the accepted protected-publication witness and the three-stage legacy
upgrade above. Both are now part of the selected mechanism: opaque recovery integrity must derive from
original accepted evidence, and raw cleanup must follow its guarded witness commit. Add crashes after
each of those commits and stale-source races; the artifact metadata alone is insufficient proof.

2026-09-09 final independent review passed this mechanism and delivery contract. Research92 is
resolved;93 is ready for implementation, with no protection or migration acceptance claim. Existing
raw/WAL cleanup limits, legacy archive conversion, cross-key-domain repair and hidden-read refusal
remain actual required acceptance gates.

### Durable acknowledgement of raw-byte cleanup

The existing accepted image record carries optional `protectedWitness` plus `rawCleanupPending`
(default false, omitted when false). A pending raw cleanup requires a protected witness. Fresh
protected admission never writes a raw generation and starts false. Legacy conversion first publishes
the protected generation while retaining raw, then atomically installs its accepted witness and sets
the cleanup duty true in the same guarded Replica transition. Only a subsequent successful physical
cleanup followed by guarded acknowledgement clears that duty. Raw-row absence does not prove cleanup
completed: deletion may have committed before cleanup of freed pages/WAL failed, or its acknowledgement
may have been lost. Recovery preserves the duty. The existing image lifecycle resumes it after restart;
there is no separate retry map or runner.

For native SQLite, ordinary deletion is insufficient. Enable `secure_delete=ON` before migration and
subsequent writes. Exact raw-generation cleanup must reclaim previously freed content and complete a
checked WAL truncation before acknowledging success; contention or failure remains retryable through
the existing duty. These are database-file guarantees, excluding external snapshots and physical
storage recovery. SQLite documents [secure deletion](https://www.sqlite.org/pragma.html#pragma_secure_delete),
[VACUUM of deleted content](https://www.sqlite.org/lang_vacuum.html), and
[WAL truncation with an explicit busy result](https://www.sqlite.org/pragma.html#pragma_wal_checkpoint).
Acceptance scans actual database/WAL bytes and holds a competing reader to prove the failure and
retry path while the protected sibling remains available.

All native image deletion paths that can remove legacy raw bytes use that same checked SQLite
finalization primitive: exact generation, completed family, Account, Wipe and orphan cleanup. A retry
still runs finalization when its selected rows are already absent. IndexedDB acceptance proves
committed deletion and disposal of owned plaintext buffers; its host API cannot request or inspect
browser backing-file reclamation. Do not claim forensic erasure of browser files or external storage
snapshots from successful IndexedDB transactions.

### Existing Device-key initialization and lock order

Image admission already holds Account execution and only loads the existing Device key. It must not
acquire the catalog transition gate: installation uses catalog→Account ordering. Reuse one existing
Device-key load-or-create helper from normal installation, native-only installation and startup while
the existing catalog serialization is held. Startup initializes a missing key for pre-upgrade native-
only Accounts before opening image admission only when durable inventory proves there is no accepted
protected-image witness. A missing key with retained protected work is an unavailable capability;
preserve that evidence and fail closed instead of generating an incompatible wrapping-key domain.
No additional mutex, key owner or login secret is introduced.
