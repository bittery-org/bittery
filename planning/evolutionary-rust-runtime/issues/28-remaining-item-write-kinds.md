# Remaining Item write kinds through the Runtime

Type: task
Status: claimed
Blocked by: 22, 24, 31, 32
Spec: ../spec.md#offline-create

## Outcome

Update, delete, favorite, move, and share reach the Server through the Runtime with the same
durability, unbounded retry, and exactly-once reconciliation that create already has, so no Web
write path touches the transitional repository.

## Problem

Ticket 21 delivered one Operation kind, `CreateLoginItem`. Ticket 22 cut the Web reads and the create
path over to the Runtime, which leaves every other write targeting a repository the vault pages no
longer read. Those actions look successful and change nothing.

That gap is deliberate and time-boxed: this rebuild ships only once every path is ported, so no user
meets it, and gating the UI would be throwaway work. It is nonetheless the last thing standing
between the current state and a Web host that is genuinely complete.

## Contract, inherited and now decided

This ticket was `needs-info` while ticket 24's cross-kind contract was open. It is resolved:

- Lookup answers one `OperationOutcome` union tagged on `kind`. An unrecognised `kind` fails to parse
  and is retried rather than misread; a parsable `kind` this Device never accepted under that id is
  identity reuse and fails the Account.
- Rejections share `invalid_ciphertext`, `vault_access_denied`, and `vault_read_only` across kinds and
  add only genuinely new failures. Ticket 24 confirmed the real per-kind sets against the handlers,
  including that a stale version and a missing Item apply to all six Item routes, not just update and
  delete.
- Every Item kind retains `{itemId, version}`, which is both the strong validator the next command
  sends as `If-Match` and enough to tell applied from rejected without replaying.
- The trash, restore, and permanent routes carry no body, so their request fingerprint rests on the
  normalized `If-Match`, and method is part of route identity.

One client-side bridge from ticket 24 is this ticket's to remove: `packages/sync/outbound-queue.ts`
translates `item_version_conflict` back into a 412-shaped error so its existing rebase-and-resend path
keeps working. That queue dies here.

## Work

- Extend the closed protocol with the remaining write variants and their drafts.
- Repeat the four proven stages per kind: durable accept with canonical IDs and immutable bytes,
  dispatch attaching only Authorization and the Idempotency-Key, unbounded retry with persisted
  backoff, and one atomic reconciliation plan against a retained semantic outcome.
- Reuse `runtime/create.rs`, `dispatch.rs`, and `outcome.rs` rather than forking them per kind. The
  fingerprint, lease, retry, and reconciliation machinery is kind-agnostic by construction; only the
  request shape and the reconciliation entity differ.
- Route the Web edit, delete, favorite, move, and share flows at the Runtime and delete the
  transitional mutation hooks they leave behind.
- Reduce ticket 24's response-cache inventory to zero and remove the old idempotency table.

## Verification

No Web write path reaches a transitional owner, proven by a dependency and import audit over the
whole Web entry graph rather than a file list. Each kind passes the offline accept, restart, more
than five transient failures, forced duplicate dispatch, and dropped-response cases that create
already passes. `pnpm check:ci` and `pnpm check:ci:rust` pass.

## Comments

### 2026-08-24 — ticket 23 added acceptance prerequisites

The first-slice adversarial review found that the shared Replica adapter conformance and the complete
Web acceptance scenario had been specified but never implemented. Tickets 31 and 32 must establish
those gates before this ticket widens the same Operation machinery to the remaining Item kinds.

### 2026-08-24 — claimed and split into four delivery slices

Ticket 23 and its blockers are resolved. Following ticket 21's proven boundaries, ticket 28 will
land as four sequential, independently reviewed commits with disjoint implementation paths:

1. **Durable acceptance and projections:** extend the closed Runtime request/draft, Operation,
   Replica mutation, and Item projection contracts for every remaining Item action, including the
   deleted/Attachment authority the recorded Web holdouts require. Prove atomic offline acceptance,
   restart restoration, immutable bytes, and explicit Account scope for every accepted kind.
2. **Dispatch and retry:** widen the kind-agnostic dispatcher to the new immutable requests and prove
   authorization-only attachment, persisted unbounded backoff beyond five failures, restart, and
   forced duplicate dispatch for every kind.
3. **Outcome and reconciliation:** validate the tagged cross-kind outcome identity and atomically
   reconcile each applied or rejected result against authoritative Item state, including dropped
   mutation responses recovered by lookup.
4. **Web host cutover:** route all remaining Item mutation consumers and the four recorded
   transitional read holdouts through Runtime-owned projections/requests, remove the obsolete Web
   mutation bridge, and tighten the whole-entry audit so no Web Item write reaches a transitional
   owner.

Generated contract artifacts belong to the Rust slice that defines them. The final Web slice owns
only host/TypeScript paths. Each slice starts with its own failing behavioral test, receives a fresh
implementer and reviewer, and must remain green before the next begins.

### 2026-08-24 — Share and Attachment ownership frontier resolved

The maintainer confirmed that TypeScript Core ownership must be replaced by the Rust Runtime for
both surfaces.

**Attachments use a dedicated Runtime service.** Bootstrap Item authority already carries encrypted
Attachment metadata. Rust will own Attachment cryptography, metadata, download, upload, rename, and
delete through the existing Attachment endpoints, but these streaming/binary workflows do not join
the closed Item Operation union. This preserves their current request semantics while removing the
transitional TypeScript owner.

**Share creation is a durable `create_share` Operation.** A crash or lost response must not require
the user to create another link. Rust generates the share token and Share key before acceptance and
keeps the capability material only in Account-encrypted local durable result state until the host
acknowledges delivery. The Server accepts and persists only the token hash, retains a non-secret
applied payload `{ shareLinkId, baseShareUrl, expiresAt }`, and never stores or replays the raw token.
Rust combines that payload with the locally protected capability material after reconciliation.
This deliberately replaces the current once-only Server-generated-token route contract rather than
weakening its hash-only storage rule.

The retained `create_share` rejection set is `item_not_found`, `vault_read_only`,
`share_entitlement_denied`, and `share_limit_reached`. Rate limiting, authentication, and
infrastructure failures remain transport retry; invalid input is rejected before durable acceptance.

### 2026-08-24 — slice split amended after the ownership decision

The decision above adds two boundaries that did not exist in the original four-slice split. Before
implementing either, the remaining sequence is amended to six commits:

1. **Durable acceptance and projections:** the already-started slice now also accepts
   `create_share` with Account-encrypted local capability state; Attachment work remains read
   authority/projection only.
2. **Server Share Operation:** replace the once-only create-Share route with the decided atomic
   retained outcome while preserving hash-only token storage and keeping raw capability material
   off the Server.
3. **Dispatch and retry:** dispatch every accepted Item and Share request with persisted unbounded
   backoff, restart, duplicate-send, and renewed-Session coverage.
4. **Outcome and reconciliation:** reconcile the tagged Item/Share outcomes, authoritative Item
   state, and acknowledged local Share capability delivery atomically.
5. **Attachment Runtime service:** move Attachment crypto and existing read/download/upload/rename/
   delete endpoint ownership into a dedicated Rust module, outside the Item Operation union.
6. **Web host cutover:** wire all remaining mutation consumers and four read holdouts to Runtime,
   remove their transitional hooks, and make `item-write` forbidden in the whole-entry audit.

The same test-first, fresh implementer, disjoint ownership, independent review, and green-slice rules
continue to apply. Generated artifacts travel with the slice that changes their source contract.

### 2026-08-24 — durable Share capability lifecycle resolved

The locally retained Share capability is encrypted under MUK-bound Account access with a new
Account- and Operation-bound AAD context and is decryptable only while that Account is unlocked. It
survives Runtime/Worker restart and password Quick Unlock, but Lock hides it and Sign-out, Account
removal, or Wipe destroys it with the Account's protected material. The new AAD context requires
unchanged existing crypto vectors plus its own fixed cross-language vector; it does not alter an
existing persisted cryptographic format.

After reconciliation, Runtime publishes a durable `PendingShareResult` projection containing the
Operation identity and reconstructed Share URL/result metadata. It remains visible without a time
expiry until the host sends idempotent `AcknowledgeShareResult { accountId, operationId }`. That ACK
atomically removes the protected capability/result record. A read-and-delete `take` was rejected
because a host crash after the delete but before rendering would lose the once-only capability; an
unbounded permanent Share-result history was rejected because it would retain capabilities forever.

### 2026-08-24 — Move with Attachments resolved

`move_item` atomically moves Attachment authority with the Item. Before acceptance, Rust unwraps
only each Attachment key with the source Vault key and rewraps it under the target Vault key; it
does not download or re-encrypt Attachment blobs. The immutable Move body carries the complete
Attachment-ID/envelope-version set and each new encrypted key envelope. The Server verifies that
the set and versions still match, then updates the Item and all Attachment Vault scopes/key
envelopes in the same Operation transaction, audit, entity event, retained outcome, and
`operation_resolved` boundary.

If the Attachment set or an envelope version changed between acceptance and Server execution, the
Server retains the terminal `attachment_state_conflict` rejection. It is distinct from
`item_version_conflict`: the Item validator may still match while an Attachment changed. Runtime
reconciles current authority; a later user command may accept a new Move with new immutable bytes.
An accepted Operation's bytes are never rewritten internally.

### 2026-08-24 — Attachment Move uses durable blob staging

The rewrap-only Move design above is superseded for Attachment payloads because the existing
Attachment name, content-type, and blob AAD all bind the Vault ID. Moving only authority and the key
envelope would make the existing ciphertext undecryptable. The maintainer chose full blob
re-encryption under the target-Vault AAD.

An Attachment-bearing Move is therefore a durable multi-stage Runtime workflow, not an ordinary
final-request-at-accept Operation. Offline acceptance commits one immutable Move intent, source
Attachment authority, target Vault, and stable per-Attachment staging identities. When transport is
available, Rust downloads each encrypted blob, decrypts and re-encrypts blob and metadata for the
target scope, uploads to deterministic Operation-scoped staging locations, and durably checkpoints
progress. Retries may renew transport credentials but never change the intent or staged object
identity. Only after every Attachment is staged does Runtime freeze and dispatch the final mutation
request.

The Server final transaction verifies the accepted Item and complete Attachment set/envelope
versions, then atomically switches the Item, Attachment metadata, Vault scopes, and storage keys with
the retained outcome and Sync/audit records. `attachment_state_conflict` remains the terminal stale
set/version result. Durable cleanup work deletes old blobs after an applied commit and deletes
staged blobs after rejection; deterministic object identities make crash/retry cleanup idempotent.

This is an explicit exception to final HTTP bytes existing at initial acceptance: the immutable
durable fact at that boundary is the closed Move intent, while the final request becomes immutable
after durable preparation. Until the dedicated staging slice lands, the first acceptance slice must
reject an Attachment-bearing Move before any durable write and prove that Item and Attachment
authority remain unchanged; it must not simulate success by hiding or retaining source-scoped
Attachments under moved Item authority.

The delivery order gains a dedicated **Attachment Move staging** slice immediately after the current
durable-acceptance slice. The later general dispatch slice only receives already-prepared immutable
requests. All subsequent slice numbers shift by one; the Attachment Runtime service still owns
ordinary upload/download/rename/delete behavior separately.

### 2026-08-24 — Attachment Move staging split for verification

The staging workflow cannot be implemented and fault-injected as one independently verifiable
slice. Before starting it, the new boundary is split once more:

1. **Server staging and atomic finalization:** add Operation-scoped stable Attachment staging
   identities/credential renewal, verify uploaded staged objects and the complete accepted
   Attachment set/envelope versions, atomically commit Item plus Attachment metadata/storage-key
   switch with the retained Move outcome, and durably enqueue idempotent old/staged object cleanup.
   Server fault injection covers each database boundary and cleanup replay.
2. **Runtime Move preparation:** replace the temporary pre-write refusal with a durable Move intent
   and per-Attachment progress. Rust downloads, decrypts, target-AAD re-encrypts, uploads, persists
   each checkpoint, survives restart and more than five transport failures, freezes the final
   request only when preparation is complete, and hands that request to the general dispatcher.

These are sequential and path-disjoint: the first owns Server schema/domain/routes/generated Server
contract; the second owns Client Runtime Move preparation and its protocol/Replica tests. Neither
widens ordinary Attachment service ownership or Share delivery.

### 2026-08-25 — Attachment Move staging lease and interface resolved

The maintainer selected one idempotent, User- and Operation-scoped staging manifest. It fixes the
complete stable `(User, Operation, Attachment)` identity set and renews upload credentials together;
individual upload-preparation calls do not independently define completeness.

Prepared staging has a rolling 24-hour lease, renewed by every manifest or credential access. Lease
expiry may delete only reproducible staged ciphertext and upload progress. It never expires the
accepted Runtime Operation, changes its immutable intent, or creates a semantic Operation outcome.
When the same Operation resumes, Runtime obtains the same stable staging identities, checks what is
present, and reuploads missing target-scoped ciphertext.

Finalization with missing, expired, or incomplete staging returns HTTP `409` with the closed code
`attachment_staging_incomplete` and retains no outcome. Runtime classifies it as a non-terminal
preparation state, renews the manifest, and resumes upload. This is distinct from the terminal
`attachment_state_conflict`, which proves that accepted Item or Attachment authority became stale.
No UI cancellation, retry count, Account removal, or elapsed lease may turn either prepared staging
or the accepted Operation into a false terminal result.

### 2026-08-25 — Attachment Move staging quota and parallel ownership resolved

The manifest never accepts a client-declared staged object size. Server authority supplies each
Attachment's exact current encrypted storage size, and the presigned upload fixes that size. The
encrypted staging media type is always `application/octet-stream`; plaintext filename or content type
is neither accepted nor persisted by this workflow.

Staged duplicate bytes do not consume additional product Attachment quota, so a team at its storage
limit can still move its existing Attachments. Instead, exactly one live Move manifest may own a
given source Attachment at a time. This bounds renewable staging amplification to one prepared copy
per committed Attachment without adding a second product quota. An expired owner is atomically
queued for cleanup and releases the Attachment before a new manifest takes ownership.

A competing manifest for an Attachment with another live owner returns HTTP `409` with the closed
code `attachment_staging_busy` and retains no Operation outcome. The later accepted Runtime Operation
waits and retries after the owner finalizes or its 24-hour lease expires; it is never rejected,
discarded, or allowed to replace the first Operation's preparation.

### 2026-08-25 — pre-staging stale authority and Finalize mismatch resolved

If the Server proves before the first manifest that the accepted Attachment set or envelope versions
are already stale, the manifest route returns a closed stale-authority preparation signal but retains
no outcome itself. Runtime then freezes a deterministic rejection-finalization request from the
immutable accepted Move intent. This is a distinct closed body variant on the existing Move route: it
carries the accepted source, target, Item validator, and complete Attachment identity/version set,
but no fabricated re-encrypted payload or staged object reference.

Only the existing Move Operation transaction may answer that variant. It independently compares the
accepted identity/version set with current Server authority and retains
`attachment_state_conflict` with audit, Sync, and Operation outcome only when the stale fact is true.
If authority still matches, the rejection-finalization request retains nothing and returns the
preparation-needed response. This keeps one outcome/fingerprint path and prevents an accepted
Operation from retrying manifest creation forever after authority becomes irreparably stale.

A prepared Finalize request whose Item, source Vault, target Vault, or Attachment intent does not
match its Operation manifest is not stale Server authority. It returns HTTP `409` with the closed
code `attachment_staging_mismatch`, retains no outcome, and leaves the accepted Operation durable.
Runtime treats it as a local invariant failure; corrected software may resume from the immutable
intent, while retry count or elapsed time still cannot discard or terminalize it.

### 2026-08-25 — stale preparation signal and Finalize body spelling resolved

The manifest route's exact non-outcome Problem Details code is `ATTACHMENT_AUTHORITY_STALE`. It is
deliberately distinct from the later retained rejection `attachment_state_conflict`, so observing the
preparation response cannot be mistaken for observing an Operation outcome.

The existing Move route accepts one closed body union tagged by `mode`:

- `prepared` carries the target-encrypted Item and Attachment payload plus the accepted intent needed
  to match the manifest;
- `reject_stale_authority` carries only the accepted source, target, and complete Attachment
  identity/version intent required for the Server to prove staleness.

Optional fields without a discriminator and a parallel route were rejected. A proved stale rejection
commits its rejection audit, retained outcome, and `operation_resolved` event atomically. It emits no
`item_moved` entity event because no entity moved. The applied `prepared` path continues to commit
both `item_moved` and `operation_resolved` with its effect and outcome. A rejection probe against
still-matching authority returns `ATTACHMENT_STAGING_INCOMPLETE` with no outcome.

### 2026-08-25 — staging object deletion is generation-fenced

The stable staging identity is logical: `(User, Operation, Attachment)` never changes. Its physical
object key is stable throughout one live manifest generation, so ordinary credential renewal and
retry continue to address the same object. After an expired lease has been atomically converted to
cleanup, or after an indeterminate cleanup boundary, the Server advances a durable generation and
any resumed upload uses a new physical key.

Cleanup rows always name one immutable old-generation key. A delayed Object-store delete from a
crashed or superseded cleanup worker can therefore delete only that old generation; it can never
delete ciphertext uploaded after resume. A database claim token by itself is not sufficient fencing,
because it cannot recall an external delete already sent before the claim expired. Generation state
survives manifest cleanup until the Operation resolves or the User is deleted. This clarification
supersedes interpreting "stable staging location" as one physical key for the entire lifetime of an
accepted Operation.

### 2026-08-25 — generated Move contract compatibility correction

The Server staging slice necessarily includes the narrow handwritten Runtime correction forced by
its generated contract. Server schemas change in place and no old Move protocol is retained, so the
existing attachment-free Move acceptance path now constructs the generated `prepared` body variant,
including its discriminator and empty Attachment set. The Runtime also maps the generated terminal
`attachment_state_conflict` rejection explicitly. This correction changes neither dispatch nor
Attachment preparation ownership; those remain in their separately planned Runtime slices.

### 2026-08-25 — staged ciphertext digest binding

Each manifest Attachment carries `ciphertextSha256` as exactly 64 lowercase hexadecimal
characters. The Server binds the presigned PUT's SigV4 payload to that SHA-256 digest, while the
authoritative encrypted byte length and `application/octet-stream` media type remain Server-owned.
The staged physical key may therefore safely become authoritative: every still-valid replay of its
upload credentials can write only identical ciphertext, never a different payload under the same
key. The digest is ciphertext authority and contains no plaintext metadata.

### Release gate — exercise hash-bound uploads against each deployment provider

Attachment Move must not be enabled on a deployment's S3-compatible provider until one generated
hash-bound upload URL has been exercised end to end with all required headers: exact
`content-length`, `application/octet-stream` content type, and `x-amz-content-sha256`. The correct
ciphertext must be accepted, while different same-length bytes must be rejected for that same URL.
AWS and MinIO evidence supports the signing construction, but the repository fake records the
canonical inputs and does not verify real provider enforcement. Provider verification is therefore
a recorded release gate rather than an inferred code guarantee or an expansion of this Server
slice into Web fixtures or deployment infrastructure.

### 2026-08-25 — Runtime Move preparation split at the durable Replica seam

Runtime Move preparation is two independently verifiable, path-disjoint commits:

1. **Replica-owned durable preparation contract:** the Replica and create paths atomically accept an
   Attachment-bearing Move outside the ready Operation collection, retain its immutable intent and
   optimistic projection, checkpoint or reset closed per-Attachment progress, freeze the stale-
   authority rejection request, and atomically promote only a complete preparation into the ordinary
   ready Operation record.
2. **Preparation worker:** a new Runtime preparation module owns manifest transport, streaming
   download/decrypt/target-AAD re-encrypt/upload work, retry scheduling, and classification of the
   Server's preparation responses while consuming the Replica contract without editing its files.

One pass cannot independently fault-inject both the Replica's atomic durable transitions and the
streaming transport/crypto lifecycle: combining them would make persistence tests depend on network
and worker fixtures, while transport tests could bypass the exact crash boundaries that make an
accepted intent durable. The first commit therefore proves the storage state machine and promotion
boundary without network calls; the second proves restart-safe transport and crypto against that
already-committed seam.

### 2026-08-25 — promoted Move retains single-record staging recovery

Promotion moves the complete preparation into an opaque recovery field owned by the one dispatch-
ready Operation record; it does not leave a second preparation writer. The retained artifact contains
the accepted source authority, canonical progress, ciphertext digest, and exact encrypted blob bytes,
but no plaintext or transient upload credentials. A nonterminal `ATTACHMENT_STAGING_INCOMPLETE`
response can therefore atomically replace that Operation with its original preparation under the
same Operation identity so manifest lease and upload work resumes without repeating random-IV
encryption. Semantic Operation removal removes the embedded recovery artifact with the Operation.

This is an internal durability consequence of the already-decided nonterminal staging-incomplete
response, not a new product protocol choice: at every boundary exactly one durable record owns the
accepted Move and its optimistic overlay.

### 2026-08-25 — binary Attachment Move artifact store and three-slice Runtime split

The maintainer chose a dedicated binary chunk store. Rust owns the artifact reference, digest, byte-
length, and chunk semantics. Web and MV3 hosts persist binary `ArrayBuffer` chunks through short
IndexedDB transactions; native hosts persist SQLite `BLOB` chunks. Replica JSON contains only the
immutable artifact reference, ciphertext length, and digest, never ciphertext bytes or Base64.

Artifact bytes commit before the guarded Replica checkpoint that first references them. A crash in
between can therefore leave an unreferenced artifact, but can never leave a committed reference to
partially durable bytes. Such orphan chunks are safe and are swept later. A semantic Operation
outcome removes the one owning Operation and makes its artifacts unreferenced for the same cleanup
mechanism; the Replica does not synchronously delete artifact bytes at the outcome boundary.

Runtime preparation is refined into three independently verifiable and path-disjoint slices:

1. **Replica reference and recovery state (A):** the current Replica/create paths accept preparation,
   validate immutable artifact references, checkpoint progress, promote or reactivate the single
   durable owner, and remove references with semantic outcomes. It stores no artifact bytes.
2. **Artifact-store protocol and adapters (B):** new protocol and adapter paths define Rust-owned
   chunk writes, complete-artifact publication, reads, and orphan sweeping for IndexedDB binary
   chunks and native SQLite BLOB chunks. This consumes A's reference contract without editing A's
   files.
3. **Preparation worker, transport, and wiring (C):** new Runtime worker paths stream download,
   crypto, artifact-store writes/reads, manifest calls, and upload work through A and B without
   redefining either durable contract.

The former two-slice note remains useful history but is superseded by this split: binary artifact
durability must be verified independently from both Replica JSON transitions and streaming network/
crypto behavior.

### 2026-08-25 — artifact-store adapter slice split for fault isolation

The artifact-store protocol and adapter slice is split before implementation because its native and
browser durability boundaries cannot be independently fault-injected in one pass:

1. **Rust-owned protocol and native SQLite adapter (B1):** new artifact-store Rust paths own the
   closed bounded-chunk protocol and its native SQLite `BLOB` implementation, including publication,
   restart, Account deletion, and exclusive orphan-sweep fault boundaries. It consumes Slice A's
   `AttachmentMoveArtifactRef` contract without editing Replica or Runtime preparation paths.
2. **Web and MV3 IndexedDB adapter (B2):** new generated artifact-contract and Web adapter paths
   implement the same Rust-owned protocol with binary `ArrayBuffer` chunks and independently exercise
   IndexedDB transaction, restart, and sweep boundaries. It does not edit the B1 native adapter.
3. **Preparation worker, transport, and wiring (C):** later new worker paths consume the already-
   committed A and B contracts and own streaming crypto/network behavior without editing either
   persistence implementation.

These implementation path sets remain disjoint. B1 can therefore prove SQLite transaction and
failure semantics without browser fixtures, while B2 can prove structured-clone and IndexedDB binary
semantics without treating the native adapter as evidence.

### 2026-08-25 — B1 review corrected sweep and concurrent publication fixtures

Independent review found that the first native fixture had incorrectly made a whole orphan sweep one
atomic transaction. Whole-sweep atomicity was never a requirement: under the caller-proved exclusive
startup boundary, each orphan is independently unreachable, so deleting one per short transaction is
safe and restart-idempotent. A later deletion failure now preserves already-committed cleanup, never
touches supplied live references, and restart resumes the remaining orphans.

The same review required two exact publishers to converge. Once both have verified the same complete
ciphertext, one may publish first and the other returns `AlreadyPublished`; the loser must not report
a false invariant failure, and neither path may expose an incomplete artifact.

### 2026-08-25 — B1 review added bounded authenticated chunk reads

Closure review found a product defect, not a fixture defect: native reads materialized a SQLite `BLOB`
before validating its bounded chunk length, and a same-length post-publication corruption was returned
without revalidation. Every exact initial write now records a per-chunk SHA-256. Idempotent replay,
publication hashing, and every published read validate both the fixed maximum length and that digest.
SQLite length is checked before incremental `BLOB` I/O allocates the bounded buffer; publication still
streams one fixed-size chunk at a time outside a long transaction and retains the overall artifact
digest as final authority.

### 2026-08-25 — B2 Web and MV3 binary artifact adapter delivered

The Web binding now projects the Rust-owned canonical owner, fixed 256 KiB chunk policy, per-chunk
SHA-256, total digest and length verification, closed publication states, bounded published reads,
explicit Account deletion, and exclusive-startup orphan sweep across the WASM boundary. Ciphertext
crosses only as bounded `Uint8Array` chunks; metadata and results remain closed primitives.

The browser executor persists each chunk as an IndexedDB `ArrayBuffer` and uses one short transaction
for each write, publication transition, or bounded Account/orphan deletion step. Tests exercise restart
at every durable publication state, exact replay and conflict, two-executor publication, same-length
corruption detection, deterministic rollback, and resumable partial sweep progress. This slice
deliberately leaves Runtime worker construction, crypto/network streaming, manifest upload, and
startup wiring to Slice C.

### 2026-08-25 — B2 review kept incomplete artifacts writable

Primary review found a product defect: the first browser publication transition entered durable
`verifying` before proving that every expected chunk key existed. A premature publish could therefore
fail during Rust hashing while leaving the missing chunk permanently unwritable. `beginPublish` now
checks the exact contiguous chunk-key set in its short IndexedDB transaction before changing state;
it does not materialize ciphertext or hash while that transaction is open. The review fixture proves
that premature publication stays incomplete, restart writes the missing chunk, and later publication
succeeds.

### 2026-08-25 — B2 review closed production test and policy surfaces

Closure review found two real module-boundary defects. First, generated production WASM exported the
artifact owner and policy store, allowing ordinary JavaScript to call publication transitions that
belong only to Rust. The store is now crate-internal, implements the Core artifact port directly, and
has a sibling-visible constructor for Runtime composition; generated WASM exposes neither policy
type. Second, the production IndexedDB executor accepted database redirection and deterministic
failure options. Those seams now live only in an internal configurable executor reached through the
testing export, while the public executor has a fixed zero-argument constructor.

Rust boundary tests also reject an invalid maximum chunk index without overflow and reject malformed
or oversized host chunk lengths before copying them into Rust. IndexedDB necessarily performs its
structured clone before the callback returns, but every durable value written through the trusted
Rust path was already capped at the canonical chunk size.

### 2026-08-25 — B2 closure generated the browser control contract

Final closure review found that the first internal port still handwrote owner fields, executor method
names, and result spellings independently in Rust and TypeScript. Rust now owns one generated tagged
artifact-control request/response contract. The WASM adapter calls one stable primitive
`invoke(controlRequestJson, optionalBinaryChunk)` function; TypeScript validates every control request
and response with the generated validator before dispatching IndexedDB primitives. Ciphertext remains
an independently bounded `Uint8Array`/`ArrayBuffer` side channel and never enters control JSON.

The generated schema, TypeScript types, standalone validator, and Rust-produced fixture are checked
for drift. The fixture drives the real TypeScript executor through write, publication, and binary
read boundaries and compares its closed responses with Rust-produced expectations, so a one-sided
owner-field, variant, or result rename fails generation, typing, or execution instead of surviving
parallel handwritten tests. Rust's actual read boundary uses the same digest validator whose
behavioral test rejects a same-length ciphertext mutation.

### 2026-08-25 — B2 closure hid primitive execution behind control invocation

Primary verification found that the fixed production executor still inherited every configurable
primitive and test inspection method. Ordinary JavaScript could therefore bypass the generated
control validator and call chunk/publication transitions directly. The production executor now uses
private composition and exposes only `invoke(controlRequestJson, optionalBinaryChunk)`; primitive
methods, database selection, failure injection, and raw-store inspection remain available only on
the internal configurable executor reached through testing exports.

### 2026-08-25 — B2 closure bounded completeness proof and unsigned controls

Review found two real defects. The generated validator accepted numbers above Rust's `u32` range,
so every generated chunk count and index now closes the range at 4,294,967,295. Publication also
enumerated every durable chunk key in one IndexedDB transaction. Each exact new chunk write now
atomically increments a durable count in the same metadata/chunk transaction; unique in-range keys
make equality with the immutable expected count an exact O(1) completeness proof. Failed count
updates roll back with their chunk, premature publication remains writable across restart, and no
publication transaction materializes the artifact's key set or ciphertext.

### 2026-08-25 — preparation worker split at crypto, workflow, adapter, and composition seams

Slice C cannot be implemented and independently verified in one pass. The persisted Attachment blob
format is one JSON/Base64 AES-GCM envelope, while self-hosted Attachment size is unbounded. Mixing a
format-preserving incremental cryptographic implementation with Replica checkpoints, remote manifest
and object-store behavior, browser streaming, and Runtime lifecycle would make a green fixture at one
seam stand in for four different failure domains. Slice C is therefore split before implementation:

1. **Format-preserving Attachment Move cryptography (C1):** new crypto-core paths incrementally
   authenticate the existing source envelope and produce the byte-for-byte compatible target envelope
   under the existing Attachment AAD model. Fixed vectors prove unchanged algorithms and persisted
   formats, corrupted input releases no result, and plaintext is zeroized rather than persisted or
   logged. This slice owns no Runtime, Replica, artifact-store, or transport paths.
2. **Deep preparation workflow module (C2):** new Client Runtime preparation paths expose one small
   drive interface and hide manifest renewal, source-download progression, artifact publication before
   checkpoint, upload progression, stale-authority freezing, final promotion, persisted unbounded
   backoff, restart, and Account/Operation scope. It consumes C1 and the committed A/B interfaces with
   in-memory transfer adapters, without editing their implementations or any host composition path.
3. **Web and MV3 binary transfer adapter (C3):** new generated transfer-contract, WASM adapter, and
   TypeScript host paths implement bounded download and one hash-bound streaming PUT through the C2
   transfer port. Browser tests own cancellation, CORS/header preservation, termination, response
   bounds, and binary-only ciphertext; production exposes no credential, fault-injection, or direct
   workflow surface. It does not edit the preparation implementation.
4. **Runtime scheduling and Web composition (C4):** Runtime lifecycle and Web Worker composition paths
   inject the committed Replica, artifact, HTTP-control, and binary-transfer adapters, sweep orphans
   only under exclusive startup, resume every accepted preparation after restart/unlock, and hand only
   complete immutable requests to ordinary dispatch. End-to-end tests prove more than five transient
   failures, dropped/renewed credentials, and no second writer for one Account.

These commits are sequential and keep their implementation path sets disjoint. C1 makes the legacy
cryptographic format a tested implementation detail behind the preparation module; C2 tests the owned
Server protocol with an in-memory adapter; C3 tests browser mechanics without faking workflow
durability; and C4 alone owns production reachability and lifecycle wiring.

### 2026-08-25 — Attachment Move source envelopes use a two-pass download

The maintainer selected a two-pass source download. Existing Attachment blob envelopes place the
unbounded Base64 ciphertext before the IV, so a one-pass AES-GCM transcryptor cannot begin without
buffering the whole object. The first pass therefore scans and validates the complete closed JSON
envelope with bounded memory, discards ciphertext bytes, and retains only the bounded IV and algorithm.
The second pass downloads the object again, requires the same bounded metadata, and incrementally
authenticates and transforms its ciphertext. Only successful source-tag verification grants authority
to publish the provisional target artifact.

This deliberately doubles source-download bandwidth. It preserves every JSON field order accepted by
the existing parser, requires no canonical-tail assumption or Range support, and introduces no local
ciphertext spool, schema, quota, or crash-cleanup lifecycle. A network failure in either pass remains
retryable preparation work; credential renewal, retry count, and restart never discard the accepted
Operation or change its immutable intent.
