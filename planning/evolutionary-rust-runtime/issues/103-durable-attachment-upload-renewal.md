# Durable Attachment upload renewal for accepted cross-Account Moves

Type: research
Status: resolved
Blocked by: none

## Question

What is the smallest extension of the existing Attachment reservation owner that lets an accepted
cross-Account Move renew upload authority after response loss, process loss and expired-object
cleanup, while preserving its fixed destination Attachment ID, sealed ciphertext and registration
bytes, current access and quota enforcement, and ordinary Attachment Upload behavior?

This is a discovered engineering prerequisite of [90](90-runtime-cross-account-item-move-workflow.md),
not a new product choice. The [accepted Move spec](../desktop-extension/cross-account-move.md) already
requires fixed identities, source-owned artifacts and restart at every sealed step. The following
contract has completed parent and independent review. Delivery belongs to
[104](104-durable-attachment-upload-renewal.md); research resolution does not claim implementation.

## Investigated facts

- [The ordinary grant route](../../../apps/server/src/domains/vaults/http/attachments.rs) is
  `POST /api/v1/items/{itemId}/attachment-uploads`. Its closed request contains only `fileName`,
  `contentType` and `fileSize`; every invocation allocates a new reservation and Attachment ID.
  [Reservation creation](../../../apps/server/src/domains/vaults/attachments.rs) persists the ID,
  User, Team, Vault, Item, storage key, plaintext/encrypted sizes, content type and lease timestamps.
- The current storage key includes a signed 15-minute expiration. Registration rejects the expired
  key independently of the reservation's `expires_at`. Extending only the database lease cannot
  preserve registration bytes. The [existing cleanup job](../../../apps/server/src/jobs/sql.rs)
  deletes expired objects and reservation rows, so renewal by a forgotten row cannot work either.
- `POST /api/v1/items/{itemId}/attachments` consumes a reservation and returns only `attachmentId`.
  It is not a retained Item Operation. A lost registration response can be reconciled against the
  exact current Attachment metadata; it must not be dressed as an Item operation outcome.
- The existing `PUT /api/v1/operations/{operationId}/attachment-move-manifest` renews same-Account
  staging, but requires the Server's current Item in the source Vault, its exact existing Attachment
  set, and the same User's access to both Vaults. It cannot reserve new files on another Server.
  Other public storage endpoints provide downloads, not arbitrary authenticated upload signing.
- [ObjectStorage](../../../apps/server/src/integrations/storage.rs) already provides
  `presign_exact_upload`, exact required headers, and provider-reported SHA-256 through `head`.
  The ordinary Attachment response currently drops the required headers. There is no need for
  another storage backend or signing implementation.
- Existing artifact publication separates owning Account from destination crypto scope. The
  provisional writer's file ID must equal the target Blob/Attachment ID; its Account and semantic
  Operation remain the source's. The source Attachment ID is separately retained in the manifest.

## Accepted API and retained record

Extend the existing grant request with optional, closed
`durableUpload: { attachmentId: string, ciphertextSha256: string }`. Omission preserves the ordinary
allocation path. Require a valid bounded client-selected Attachment ID and canonical lowercase
SHA-256. Core chooses that ID before target AAD construction, seals the artifact, then sends the
exact grant request. `fileSize` keeps its existing plaintext-size meaning; the Server derives the
encrypted object size using its existing envelope-size calculation. Content type is
`application/octet-stream`; the filename is opaque and carries no decrypted name.

For durable grants return the existing `attachmentId`, `key` and `uploadUrl`, plus
`uploadHeaders: [{ name, value }]` copied from `PresignedUploadResult.required_headers`. Generate
this additive contract normally; the ordinary branch omits the optional header field.
The public field is `key`; the internal domain field is `storage_key`. Core validates the exact
required headers and passes them through the existing binary port. Web validates `Content-Length`
against the fixed body size and
removes only that browser-forbidden header; it must forward Content-Type, `x-amz-content-sha256` and
`x-amz-checksum-sha256` exactly. URLs and headers are invocation capabilities, never persisted.

Use `pending_attachment_upload`, adding these fields in a new migration:

| Field | Meaning |
| --- | --- |
| `durable_request_fingerprint text NULL` | Marks the durable path; hash of the exact request bytes and route/Item under the authenticated User. Immutable. |
| `ciphertext_sha256 text NULL` | Exact sealed encrypted-object digest; present iff the durable fingerprint is present. Immutable. |
| `durable_created_by`, `durable_item_id`, `durable_vault_id`, `durable_team_id`, each `text NULL` | Immutable original-scope witnesses, without foreign keys. All present for durable rows and all absent for ordinary rows. |
| `next_cleanup_at timestamptz NULL` | Retained scheduled cleanup duty. Present for every durable row, including consumed rows; ordinary rows retain existing expiry cleanup. |

Add a global unique index on `attachment_id` across this shared table and checks requiring the digest,
fingerprint, original witnesses and cleanup timestamp together. Existing ordinary allocation creates
a fresh ID per reservation; migration must detect contradictory duplicate rows rather than discard
them. The claim/lock is global, not per User: before granting it, check all ordinary/durable
reservations and published Attachments under that lock. A different User or Item cannot obtain a
second claim for the same ID. Ordinary generated IDs obey the same collision check; their normal
allocation/request behavior remains. Index exact `item_attachment.storage_key` lookups if the current
schema lacks that index.

Make the existing `created_by`, `item_id`, `vault_id` and `team_id` references nullable with
`ON DELETE SET NULL`. These are live authorization references; renewal requires every reference
present and equal to its immutable original witness. A NULL reference is permanent retirement,
even if a later Account/Item appears with the original identity. Preserve ordinary cascade semantics
with one shared `BEFORE DELETE` database trigger function on the User, Item, Vault and Team tables:
delete only ordinary pending rows that refer to the removed parent before the SET NULL action.
Durable rows survive with their immutable identity and cleanup duty. No per-route deletion copies
or second reservation table are needed.

Preserve existing sizes, content type, reservation timestamps and ordinary key validation. A durable
storage key is deterministic from a versioned domain separator plus original User, Item and target
Attachment ID, for example `attachments/durable/<sha256>`. It contains no expiring authorization.
The retained reservation, live references, current access and exact-request check authorize renewal.
Expired and consumed durable identities are not deleted by generic cleanup. Parent teardown makes
them nonrenewable but retains ID, key, original witnesses, fingerprint and digest for collision refusal
and late-object cleanup. Add nullable `cleanup_attempt_id` on this same row for the durable pre-I/O
fence described below. A non-NULL value also refuses grants and registration. This is the existing
reservation's evidence, not another operation ledger.

## Accepted lease, registration and cleanup transitions

All allocating, renewing and registering branches use the same global Attachment-ID advisory lock.
The shared order is Sync event ordering first, then current User/Team authority and billing, the
existing Team `attachment_quota_lock`, Vault membership and Item authority locks, and finally this
reservation/object lock. Reuse existing authority, quota and rate
limits; never acquire the Sync lock after the reservation lock. Cleanup takes only the reservation
lock, reads/rechecks the row and exact published-object reference, and does not later acquire the
earlier locks. Hold the reservation lock across object `head`/delete I/O and the associated database
transition. Cleanup additionally commits its fence before issuing DELETE, because releasing a SQL
lock cannot stop an external request. Bound object requests and lock/database waits using existing
infrastructure. A failed transaction retains the prior state, including any previously committed fence.

| Current durable state | Action and result |
| --- | --- |
| Absent, with no other reservation or published target ID | Validate current User/Item/Vault access and plan/size/quota; insert immutable identity, live references and a 15-minute active lease. Set `next_cleanup_at=expires_at`. Return an exact signed grant. |
| Existing, unconsumed, unfenced, exact request and all original live references | Revalidate current access, size/plan and quota. Count an active reservation once; an expired lease reacquires quota. Extend `expires_at`, advance `next_cleanup_at` to the lease boundary, preserve every identity/request field, and return a fresh grant for the same key/digest. |
| Existing, different request/User/Item, retired live reference, cleanup fence, or published/consumed target | Refuse without a grant, new reservation, overwrite, or changed row. A cleanup fence returns conflict. Never recreate missing current metadata from an old consumed reservation. |
| Active unconsumed unfenced lease plus matching registration | Under the same locks, verify original/live scope, target ID and metadata, then require object HEAD size and provider SHA-256 to match. Recheck lease expiry after HEAD. Atomically insert metadata, consume the reservation and emit the existing Sync event. Retain `next_cleanup_at`; durable registration uses its reservation, not the legacy expiring-key signature. |
| Due, expired unconsumed row or retired/consumed row with no exact published-object reference | Lock and recheck, assign a fresh cleanup attempt token, and commit it with a 15-minute next check before issuing DELETE. Reacquire the lock, require that exact token and recheck reference/eligibility, then delete the exact object. Only the initially unfenced invocation's definite completion may clear its token. Success schedules `now+24h`; failure schedules `now+15min` and reports failure. Retain immutable fields and the cleanup duty. |
| Due row whose exact object remains published | Exclude it from cleanup selection; after taking the lock, recheck again before any delete. Retain its due timestamp so Attachment removal makes it eligible without requiring a separate removal hook. |

The database lock cannot fence an already-issued PUT executing in object storage. A late successful
PUT may recreate an unreferenced object after deletion; therefore successful deletion never clears
the durable cleanup duty permanently. Bounded scheduled rechecks remove such late objects. Neither
lease expiry, client cancellation nor process loss proves physical drain. A consumed row retains a
non-NULL cleanup timestamp even while published, so deletion of its current Attachment exposes the
same duty. Current exact-object references always prevent deletion.

Each job selects at most the existing pending-upload batch limit, ordered by `(next_cleanup_at, id)`,
and visits each selected ID at most once per invocation. Recheck eligibility under the lock. Persist
the next due time on both successful and failed object deletion; if that storage write fails, stop
the invocation with failure, leaving the row eligible for a later job. Do not loop forever on the
same due/failing rows. A crash after object deletion but before rescheduling retains its fence;
later cleanup may repeat deletion but cannot reopen renewal.
A renewed lease is rechecked after locking, so stale cleanup selection cannot delete it. A published
row must not monopolize a batch: exclude exact current references in the selection query as well.
Reference checks match `storage_key` across all current Attachments, not only Attachment ID: an
existing same-Account Move preserves ID while changing its key, so the obsolete key still needs
cleanup; any current reference to the exact key protects its object.
Ordinary rows retain their existing expiry/row-deletion behavior. The new durable scheduling is not
a new user-visible file-count or product quota; use existing quota, request limits and rate limits.

Presigning can follow the committed lease: loss of its response leaves an exact renewable row. Grant
lifetime must not exceed the lease. Registration proof is a real matching registration response
and/or fresh exact current Attachment authority, including identity, ciphertext metadata, versions,
Vault, uploader, size and storage key. Missing or changed evidence blocks Move; it never authorizes
deletion/recreation of target files. Fixed digest signing makes all accepted PUT retries write the
same bytes; a signed URL is not authority to change the accepted object.

## Accepted cleanup ambiguity frontier

Final delivery review found a second external lifetime: a timed-out DELETE may still execute after
the SQL transaction ends. With the same key and ciphertext, a renewed PUT followed by registration
could otherwise be erased by that old request. A later HEAD or successful retry does not prove the
earlier DELETE drained. HTTP 202 also does not prove enacted deletion; the S3 adapter accepts only
the documented completed 204 response as deletion success.
[HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.5),
[S3 DeleteObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObject.html).

The accepted correction keeps the existing owner and normal expiry cleanup followed by exact
renewal. The first cleanup transaction records a fresh `cleanup_attempt_id` and the next due time,
then commits before any object DELETE. The invocation remembers whether the prior row was unfenced.
Its second transaction takes the same global identity lock, requires its exact token, and holds the
lock through object I/O and final state. Only that initially unfenced invocation, after definite
completion, can clear its token. Before that proof, failure, cancellation or process loss retains the
committed fence and prevents registration and new grants for this identity. An uncertain pre-I/O
commit acknowledgement never authorizes issuing DELETE. If acknowledgement of the final token-clear
commit is lost after definite deletion, either durable outcome is safe: the object deletion completed
before that commit could clear the fence.

Every later cleanup attempt that encounters a fence must commit a new token before its own DELETE
and must keep a fence even after its own successful deletion. Rotating the token invalidates an old
paused invocation before it can clear the fence. The pre-I/O next check prevents ordinary concurrent
jobs from immediately taking over an active attempt; a later takeover deliberately sacrifices renewal
availability. Exact current object references remain protected in both phases. No finite delay,
HEAD result or subsequent DELETE authorizes clearing an inherited fence.

This is a deliberate failure behavior: after ambiguous cleanup, the fixed target identity stays
nonrenewable and the Move retains its source and reports a blocked transfer. A new grant/key or
destructive source step cannot silently replace the accepted intent. Scheduled cleanup still removes
late objects, including after parent deletion. Avoiding deletion for all renewable rows would retain
expired objects outside active quota indefinitely. Provider-version-specific deletion could offer a
stronger recovery path, but the current storage port has no version witness; adding that capability
is outside this prerequisite. Neither alternative justifies pretending an ambiguous DELETE completed.

## Required review and implementation evidence

Before resolving this question, review the immutable identity fields, stable-key authorization,
lock order and cleanup I/O lifetime, consumed behavior, quota accounting, generated header passage,
and compatibility of optional request/response fields. Confirm that source-owned Core artifact
recovery uses the target file ID without changing its source Account owner or crypto proof checks.

The dependent implementation must begin with an actual Server route test: first durable grant,
lost response, exact retry with the same ID/key, then expiry and cleanup followed by exact renewal.
Extend through a nonempty sealed artifact and registration before widening. Required refusals cover
changed bytes/digest/size/Item/User, malformed IDs, current permissions and plan/quota loss, consumed
and published IDs, missing or mismatched provider checksum, and registration after target removal.
Race cleanup against renewal and registration with held object I/O, including failed deletion,
a late remote DELETE after a failed caller, committed-fence owner loss before I/O, stale cleanup
owners and successful retries that must remain fenced. Reject a 202 DELETE as definite completion.
Also cover a late old PUT after successful cleanup. Delete Attachment/Item/Vault/User/
Team and prove the retained claim cannot renew or lose its future cleanup duty. Show published objects
are protected, dormant rows are fairly scheduled and neither successes nor failures spin in one job.
Verify ordinary Upload remains
unchanged, regenerate OpenAPI/API/Core contracts, test actual required headers, and run the affected
Server/Core/host acceptance plus both required full CI commands before closing delivery.

## Comments

2026-09-14: created during ticket90's no-file implementation. IDs103/104 were unused. Read-only
investigation found no existing route capable of renewing the same cross-Account destination file
identity after sealed-artifact restart and lease cleanup. Parent requested this bounded question and
proposal; parent/independent review and a separate delivery ticket remain outstanding. No Server
source or migration changed, and this document claims no capability acceptance.

2026-09-14 parent accepted the refined contract after independent review. The original proposal's
per-User ID index, cascading loss of cleanup evidence and permanent cleanup flag were corrected:
the real global Attachment namespace is claimed once, nullable live references fence permanently
retired ownership while immutable witnesses survive, and bounded scheduled cleanup retains the
late-PUT duty. Ordinary cascade behavior is preserved by one database trigger function. The precise
Sync/authority/quota/Item/reservation lock order and exact signed-header passage are settled.
No outstanding product decision remains. [Delivery 104](104-durable-attachment-upload-renewal.md)
implements and verifies this prerequisite before ticket90's Attachment path can be accepted.

2026-09-14 final cleanup review reopened the external-I/O frontier before104 closure. Parent and
independent review confirmed that SQL locking and a client timeout cannot prove remote DELETE drain.
The accepted same-row pre-I/O attempt fence above supersedes renewal after ambiguous cleanup; normal
confirmed cleanup remains renewable. This records the engineering decision before implementation
and does not claim that its new race tests or full CI have passed.
