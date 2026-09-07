# Remaining Item write kinds through the Runtime

Type: task
Status: claimed
Blocked by: 22, 24, 31, 32, 43, 45, 46, 48, 58
Spec: ../spec.md#offline-create

## Outcome and current state

Complete the Web Item, Share, Attachment, Vault-create, and Import cutover through the shared
Runtime client. This ticket stays open until [57](57-import-atomic-cutover.md) and
[58](58-final-web-host-cutover.md) satisfy their acceptance gates.

Delivered: ordinary Item acceptance/dispatch/reconciliation, durable Share creation and acknowledged
results, Attachment Move preparation, foreground Attachment services, authenticated browser Move
acceptance, and [49–56](49-five-category-runtime-item-interface.md)'s category/Vault/Import foundations.
Commit `87386201` contains the Server Import half and some Web consumer work, not a completed Import
or final Web cutover. Ticket 57 records the verified remaining work.

## Item Operations

- Applied Item outcomes retain `{ itemId, version }`. Validate exact Operation kind, identity,
  accepted Item/Vault, positive version, and the per-kind rejection set.
- Unknown/unparseable outcomes remain retryable; parsable cross-kind or contradictory identity
  fails the Account. Lookup is a hint until identical mutation replay proves the fingerprint.
- Applied non-permanent mutations fetch authority; permanent delete proves absence. Rejections
  reconcile current presence/absence. One guarded commit writes authority and receipt and removes
  Operation/overlay. Fetch or commit failure preserves accepted work.
- Sync reconciliation is cursorless. After every event in a page succeeds, `AdvanceSyncPageCursor`
  advances the exact expected Cursor and refuses to pass page-named active Operations or Move
  preparations. An earlier event cannot skip a later unresolved one.
- Retry deadlines persist without an attempt limit. Host cancellation detaches waiting only.
  Transitional queues remain for unmigrated hosts; Web must lose reachability to them.

## Share creation

`create_share` is durable. Rust generates the existing raw token and Share key before acceptance;
the immutable Server request contains the token hash only. Local capability material is MUK-protected
with Account/Operation-bound AAD. Applied Server data is exactly
`{ shareLinkId, baseShareUrl, expiresAt }`. Rejections are `item_not_found`, `vault_read_only`,
`share_entitlement_denied`, and `share_limit_reached`; transport/rate limits remain retryable.

After authoritative reconciliation, `PendingShareResult` reconstructs the URL from protected local
capability plus non-secret Server result. It survives restart/Quick Unlock without time expiry.
Lock hides it. Sign-out, Remove, and Wipe destroy the capability. Rejection also destroys it.
The host renders before idempotent `AcknowledgeShareResult` removes the result; receipt identity
survives ACK. This avoids losing a once-only capability between read and rendering.

The atomic Server/Web cutover is delivered. Desktop/Mobile create-Share affordances stay absent
until their Runtime host slices; reads/history remain.

## Attachment Move

The accepted design re-encrypts blobs and metadata under target-Vault AAD. Rewrapping only the key
was rejected because existing blob/name/content-type AAD binds the Vault. Preserve the original
`uploaded_by` identity and Attachment key; the target key wrap binds envelope version `N + 1`.

- Offline acceptance stores immutable Move intent, complete source Attachment identity/version
  authority, target Vault, and stable staging identities. Final HTTP bytes freeze only after
  preparation. One durable record owns preparation or the ready Operation, never both.
- Source processing uses two bounded downloads because the legacy JSON envelope may place the IV
  after ciphertext. The first validates the envelope; the second binds its digest/IV and
  authenticates while producing target ciphertext. Only successful source authentication permits
  publication. Algorithms, field-order compatibility, formats, and vectors remain unchanged.
- A distinct binary artifact store holds bounded ciphertext chunks (256 KiB), chunk hashes,
  complete digest/length, and authenticated provisional generations. Replica JSON holds references,
  never blob bytes/Base64. Publish bytes before checkpointing the reference. Restart recovery cannot
  recreate a writable unauthenticated handle; old writers and cleanup cannot touch new generations.
- The User/Operation manifest fixes the complete Attachment set. A rolling 24-hour lease renews on
  manifest/credential access. Expiry affects reproducible staging only, never the accepted Operation.
  One live manifest owns a source Attachment; duplicate staging does not consume product quota.
  Busy or incomplete staging retains no outcome and resumes with backoff.
- Server-authoritative length, `application/octet-stream`, and lowercase ciphertext SHA-256 bind
  each presigned upload. Logical identity is stable; physical keys advance after expired or
  indeterminate cleanup so a delayed delete cannot remove a later generation.
- `ATTACHMENT_AUTHORITY_STALE` is a preparation signal, not an outcome. The existing Move route's
  closed `mode` union is `prepared` or `reject_stale_authority`. Only its transaction can prove and
  retain `attachment_state_conflict`. A rejection probe against matching authority returns
  `ATTACHMENT_STAGING_INCOMPLETE` without an outcome; manifest/intent mismatch is an invariant
  failure, not permission to rewrite accepted bytes.
- Finalization atomically switches Item and Attachment metadata, Vault scopes, and storage keys
  with audit, outcome, and Sync events. Rejection emits no `item_moved`. Durable cleanup removes old
  applied blobs or rejected staging. Incomplete staging can reactivate preparation from the ready
  Operation's recovery record without rerunning random-IV encryption.
- Browser upload copies published ciphertext into a generation-scoped OPFS `File` so the browser
  supplies exact Content-Length. Account/Device locks span writing, Fetch, and cleanup.
  IndexedDB remains the canonical artifact store.
- Core owns authenticated manifests/source grants, Session renewal, live-set derivation, and sweep.
  Each browser-wide Account lease covers a fresh orphan sweep before drive; lease loss cancels work.
  See [43](43-attachment-move-uploader-aad.md),
  [45](45-core-attachment-move-manifest-authority.md), and
  [46](46-core-attachment-source-and-exclusive-lifecycle.md).

Production authenticated Move acceptance is delivered in `b2552167`: six manifest failures, Lock,
Worker restart, Quick Unlock, sweep-before-resume, real artifact/binary execution, exact dispatch,
and authoritative Item/Attachment convergence.

### Deployment gate

Before enabling Attachment Move on an S3-compatible provider, exercise a generated hash-bound PUT
with all required headers: correct bytes must succeed and different same-length bytes must fail.
Browser/fake-store tests prove request construction, not each deployment provider's enforcement.

## Foreground Attachments

Upload, download, rename, and delete are foreground Runtime requests outside the durable Operation
union. One attempt may renew its Session once; cancellation/restart ends that attempt.
Ambiguous mutations require an authoritative Item/Attachment probe and guarded commit before success,
otherwise return a closed retryable error. A DELETE 404 alone is not proof of authoritative absence.

Upload addresses Account + Item; other actions address Account + Attachment. Rust derives Vault,
uploader, storage, and envelope authority. Public projections retain decrypted name/content type
while unlocked and expose no storage key. Rename changes its three ciphertext fields and preserves
the key-envelope version unless the same transition also rewraps the key.

Single-use source/sink capabilities bind actual Runtime incarnation, Account, and request. Binary
chunks stay out of JSON. Downloads publish an atomic plaintext sink only after full authentication;
partial output is discarded. Per-Item mutation writers serialize with Item Operations; long downloads
release the Account execution fence. Lock, Sign-out, Remove, Wipe, close, and failed-open retirement
cancel and drain transfers/cleanup before retiring authority. Only owned/transferred buffers are
covered by zeroization.

## Final Web Item and Import frontier

The accepted continuation is [49–58](49-five-category-runtime-item-interface.md):

- [49](49-five-category-runtime-item-interface.md): all five category drafts/projections and ordinary
  actions preserve editable/importable fields. Authenticator keeps Server wire spelling `totp`.
- [50](50-create-vault-outcome-foundation.md), [51](51-vault-image-local-ingress.md),
  [52](52-vault-image-server-staging.md), [53](53-runtime-create-vault-lifecycle.md), and
  [54](54-create-vault-atomic-cutover.md): durable `create_vault`, bounded pre-accept image ingress,
  remote staging, reconciliation, cleanup, and atomic Server/Web caller replacement.
- [55](55-import-outcome-foundation.md), [56](56-runtime-import-batch.md), and
  [57](57-import-atomic-cutover.md): one durable `import_items` per ordered batch, exact outcome and
  authority reconciliation, then production dispatch and Web cutover.
- [58](58-final-web-host-cutover.md): finish consumers and prove zero transitional Item/Import
  reachability through real production entry graphs.

### Vault and image invariants

Rust owns IDs, key generation, unchanged version-1 wrapping, immutable intent, and retry.
`PendingVaultCreation` reserves identity without making it authoritative or writable.
A shared facade derives the multi-Account writable-Vault catalog from Runtime projections.

An image is copied to a distinct Account/Operation-bound durable plaintext artifact before
acceptance. Ticket 51 fixes MIME/size/chunk/capacity limits and cleanup fencing. Acceptance verifies
and references published bytes; it is not a cross-store atomic publication claim. Crashes may leave
a bounded orphan, never accepted work without bytes. Accepted work never reopens a host capability.

Remote staging follows acceptance. Persist `artifact_ready`, `remote_upload_confirmed`, and
`final_request_frozen`; transient grant URLs are not checkpoints. Ticket 52 fixes deterministic
object identity, exact length/MIME/digest confirmation, 24-hour lease, and 64-binding/128-MiB quota.
Only confirmation permits final PUT freezing. Image-free work freezes at acceptance.

Applied reconciliation requires accepted Vault identity, name/type/icon, owner role, wrapped key,
and image presence; exact replay proves the image binding. One guarded commit installs authority
and receipt and removes the Operation/optimistic effect while retaining cleanup obligations.
Applied cleanup removes the local artifact only; rejected cleanup removes local and remote staging,
with the Server rejection transaction also marking cleanup pending. Lock/Sign-out retain accepted
work. Remove/Wipe destroy local scope; remote cleanup is best effort and the Server lease sweep
owns remaining orphans.

### Import invariants

At most 200 Items in one target Vault form one all-or-nothing batch. Earlier successful batches
survive a later rejection. Preserve every category, favorite, mapping, warning, and final count.
The Operation itself is progress; pending/rejected batches publish no imported Items.

Applied result is exactly `{ vaultId, importedCount }`. Reconcile exact accepted IDs, Vault,
category, favorite, ciphertext, and version 1 within aggregate 200-Item/16-MiB authority bounds.
Lookup needs exact POST replay. One recovery cycle shares one renewal budget across all exchanges;
second 401 parks without manufacturing a failed-Vault result.

Empty writable batches apply with zero, no Item fetch, bulk audit, or `vault_updated`;
only outcome and `operation_resolved` record completion. Inaccessible/read-only targets still reject.
Ticket 57 records the later bulk-authority route, byte ceiling, Operations projection, and full
parking-store retirement decisions.

## Completion gate

Ticket 58 must prove the complete Web graph and whole-repository create/Import graphs have zero
forbidden reachability, with production Worker/browser acceptance and full TypeScript/Rust CI.
[ticket 29](29-rotation-operation-outcomes.md) alone owns final response-cache deletion;
[ticket 30](30-runtime-owned-live-sync.md) owns live Sync. Later hosts reuse Runtime behavior.
