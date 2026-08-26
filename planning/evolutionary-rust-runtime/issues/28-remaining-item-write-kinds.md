# Remaining Item write kinds through the Runtime

Type: task
Status: claimed
Blocked by: 22, 24, 31, 32, 43, 45, 46
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

### 2026-08-26 — Web Attachment Move composition exposed a Core authority blocker

The C4b Web-composition implementer stopped before editing or writing a test because the committed
C4a facade still requires the host to implement `renew_manifest`. The Server URL, current Session,
one-refresh policy, durable Session replacement, and HTTP response classification are private Rust
Runtime authorities. Implementing C4b as scoped would therefore move authenticated route policy into
bindings or TypeScript, contrary to the binding Rust-network-ownership decision.

Ticket 45 owns the missing Core seam and is split into two independently verifiable, path-disjoint
slices before C4b resumes. It deliberately makes no new product-protocol choice. C4b remains limited
to Web binary primitives, per-Account Worker composition, and exclusive lifecycle ownership.

### 2026-08-26 — Core manifest authority blocker resolved

Ticket 45 now owns the typed authenticated manifest exchange, one-refresh durable Session lifecycle,
renewed-credential propagation, and one Account execution fence shared by preparation, dispatch,
Bootstrap/Sync, Lock, close, and reconciliation. The public preparation facade is binary-only, and
both repository CI gates pass from a clean tree. C4b may resume without exposing route, bearer,
Session, or manifest response policy to bindings or TypeScript.

### 2026-08-26 — retried C4b exposed source-grant and exclusive-lifecycle blockers

A fresh C4b implementer stopped before edits or TDD. Core's binary download request carries only a
durable storage key, while the fixed browser executor requires an invocation-scoped URL that only the
authenticated Attachment download-grant route can mint. Bindings cannot obtain that URL without
duplicating Server route, Session, and refresh policy.

The audit also proved that bindings cannot lawfully initiate an orphan sweep or fence preparation:
Core privately owns the live artifact set and `ExclusiveStartupBoundary`, while its current lifecycle
scans all Accounts. Placing a Web Lock around binary calls alone would leave secret resolution,
manifest work, Replica checkpoints, and promotion outside the browser-wide writer authority.

Ticket 46 owns both missing Core seams and is split into three independently verifiable path slices
before C4b resumes. This follows the already-binding Rust network ownership and per-Account Web Lock
decisions; it introduces no new product-protocol choice.

### 2026-08-26 — resumed C4b split at the WASM and Worker seams

Ticket 46 resolved the source-grant and exclusive-lifecycle blockers and both repository gates pass
from a clean tree. C4b now has two independent failure domains that cannot be implemented and
verified faithfully in one pass, so it is split before new implementation:

1. **C4b1 — Rust/WASM composition bridge:** binding-only Rust paths adapt the committed Core binary
   transfer port to the committed C3b executor, adapt one primitive JavaScript Account lease guard
   to Core's lease port, construct the shared IndexedDB artifact/provisional ports, and expose one
   configured Web Runtime constructor that starts and observes the Core preparation lifecycle. Native
   and WASM binding tests prove closed error mapping, abandonment, guard loss/release, and that no
   route, Session, Operation, live-set, sweep proof, or active-Account policy crosses the binding.
   This slice edits no TypeScript Worker or browser-host path.
2. **C4b2 — fixed Worker composition and browser reachability:** TypeScript-only Runtime Worker paths
   construct the fixed IndexedDB artifact executor, fixed binary executor/OPFS spool, and one
   browser-wide per-Account Web Locks lease executor, then call the C4b1 constructor and await its
   lifecycle errors. Actual browser tests prove startup sweep before preparation, restart/unlock
   reachability, two contexts cannot write one Account, lease loss/close cleanup, production executor
   use, and more than five failures without discard. This slice does not edit Rust, C2, C3, or store
   implementations.

The slices remain sequential and path-disjoint. C4b2 is the production reachability proof; C4b1 is
only the deep binding bridge and cannot make preparation reachable by itself.

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

### 2026-08-25 — C1 delivered format-preserving two-pass cryptography

Crypto Core now scans the complete closed Attachment envelope with bounded memory, binds the second
download to the first by its exact envelope digest and IV, and incrementally authenticates and
transcrypts the existing AES-256-GCM payload under the unchanged Attachment AAD. Production owns the
fresh target nonce; only successful source authentication and authenticated UTF-8 validation return
the opaque authority needed to publish the provisional target artifact. Independent Node-generated
vectors prove the exact legacy JSON/Base64 envelope, field order, algorithm identifier, and AAD remain
compatible across arbitrary chunk boundaries.

Review found real product defects rather than fixture defects: the first implementation exposed a
caller-provided production nonce, rejected authenticated non-UTF-8 plaintext at the wrong compatibility
boundary, and then allowed unauthenticated plaintext validity to affect `push` before source-tag
verification. Production nonce generation is now internal, invalid plaintext is latched until after
authentication, and corruption can only report authentication failure after the complete second pass.
Review also found a real integration defect in Client Runtime's exact `zeroize` pin; its native and
combined WASM graphs now resolve the required 1.9.0 version, with the generated binding artifact checked
for deterministic drift.

Deliberately left open: C1 owns no Replica checkpoint, remote manifest, blob transport, artifact-store,
retry, scheduling, Account selection, or host composition behavior. Those remain sequenced in C2, C3,
and C4.

### 2026-08-25 — target artifacts use an authenticated provisional writer

The maintainer selected an Account-, Operation-, and Attachment-bound provisional artifact writer.
C1 emits target-envelope chunks during the authenticated second source download, but the canonical
artifact identity binds a digest and byte length that cannot be known before those chunks exist.
Requiring the final identity before the first write would otherwise force either a third complete
source download or unbounded in-memory buffering.

The provisional writer persists only bounded ciphertext chunks under an opaque writer generation.
It carries no plaintext, final Replica reference, or publication authority. A new generation prevents
a delayed writer from changing a later attempt; a crash before finalization can therefore leave only
an unreferenced generation eligible for the existing exclusive-startup sweep. After C1 has consumed
the complete second pass and authenticated the source tag, Runtime supplies the opaque publication
proof, final ciphertext digest, and byte length. The store verifies the complete generation and makes
the canonical `AttachmentMoveArtifactRef` readable in one final durable publication transition before
Replica may checkpoint that reference.

This newly discovered durability seam changes the remaining preparation order. It is split before
implementation so native and browser persistence do not stand in for each other:

1. **Provisional writer protocol and native SQLite adapter (B3):** add the Rust-owned bounded draft
   protocol, opaque generation fencing, authenticated final binding, restart behavior, and native
   SQLite fault boundaries without editing Replica, browser, transport, or host-composition paths.
2. **Web and MV3 provisional writer adapter (B4):** extend the generated closed control contract and
   IndexedDB binary adapter with the same generation, verification, publication, restart, and orphan
   semantics without editing the native implementation.
3. **Deep preparation workflow (C2):** consume B3/B4 and C1 through in-memory ports and retain the
   previously recorded workflow scope. C3 transfer mechanics and C4 production scheduling/composition
   remain unchanged and follow C2.

Deliberately rejected: buffering an unbounded target envelope in memory, and a third source download
with a reusable internal target nonce. Neither is needed once provisional ciphertext has a durable but
unpublished home.

### 2026-08-25 — B3 delivered the native provisional artifact boundary

The Rust-owned provisional protocol and native SQLite adapter now write fixed-size ciphertext chunks
under one Account-, Operation-, Attachment-, and generation-scoped writer before the final digest and
length exist. C1 itself hashes and counts every exact target-envelope byte it emits and returns those
values only inside a one-use publication proof bound to Account/User, Operation, and Attachment. The
store accepts no caller-supplied replacement digest, length, or identity. It durably seals that proof,
verifies chunks outside a long transaction, and publishes by one atomic metadata mapping to the stable
physical generation; it neither copies nor Base64-encodes unbounded BLOBs.

Authenticated state survives actual process restart through a closed recovery token. State-1 `Begin`
and explicit recovery expose no writable handle, and `ResumeRecovered` returns only the final canonical
owner after exact durable state-1/state-2 validation. Unauthenticated, malformed, random, wrong-scope,
or swept tokens cannot write, finalize, or publish. A new nonce attempt may coexist with an earlier
unreferenced published artifact until exclusive startup sweep, while generation fencing prevents an
old writer or cleanup step from touching the new attempt. Existing B1 SQLite files gain the nullable
physical-generation mapping idempotently without losing their canonical metadata or chunks.

Independent review findings were all real product, durability, security, or integration defects, not
fixture defects. Review corrected an unbounded final BLOB copy, same-scope retry blockage, missing B1
schema evolution, destruction of an authenticated seal by `Begin`, restart fixtures that retained the
writer in memory, an unbound publication proof, a recovery API that the external Web bindings crate
could not implement, and a public enum path that exposed a state-0 writer before durable validation.
Each now has a behavioral regression test, including tests compiled outside the Core crate.

Deliberately left open: B3 provides no IndexedDB implementation, browser control-contract variants,
Runtime preparation worker, network transport, scheduling, or host composition. B4 owns the Web/MV3
adapter for this exact token and physical-generation protocol; C2 follows only after B4 is committed.

### 2026-08-25 — B3 integration seam corrected before B4

B4's first real WASM integration exposed a missing public Core seam: an external persistence adapter
could hold the provisional writer and the one-use publication proof but could not derive the canonical
owner without duplicating Core's artifact-ID protocol. This was a real integration defect, not a
fixture defect. Core now consumes the proof through a constructor bound directly to the provisional
writer, validates Account, Operation, and Attachment against that writer, and exclusively owns the
digest, length, and artifact-ID derivation. Native SQLite uses the same constructor. External API
tests assert the exact canonical identity and reject every cross-scope proof.

Deliberately left open: this correction adds no new writer authority or persistence behavior. B4 still
owns the IndexedDB control protocol, restart and fault behavior, and orphan semantics.

### 2026-08-25 — B4 delivered the Web and MV3 provisional artifact boundary

The generated closed artifact-control contract and IndexedDB v2 adapter now implement the same
Rust-owned provisional protocol as native SQLite. Browser hosts persist bounded binary ciphertext
chunks under the opaque Account-, Operation-, Attachment-, and generation-scoped token; Rust verifies
each chunk and the complete authenticated artifact before one atomic mapping makes the canonical owner
readable. State-0 writing, state-1 authenticated recovery, state-2 restart, exact concurrent
finalization, rollback boundaries, Account deletion, resumable orphan cleanup, and the B2 database
upgrade are covered by behavioral tests. Raw recovery tokens never reconstruct a writable Rust handle,
and mapped physical generations survive cleanup.

Independent review found one real product defect and one fixture defect. The product cleanup path had
compared only generation instead of the full Account-filtered Operation, Attachment, and generation
identity, which could hide a deliberately colliding orphan; the adapter and regression tests now use
the complete identity. The generated bounds test had become positional after a new fixture step and
was rejecting unknown fields rather than testing u32 limits; it now selects the request by behavior
and proves both the maximum and overflow cases.

Deliberately left open: B4 adds no preparation worker, network transfer, retry policy, scheduling,
Replica checkpoint, or production host composition. C2 now owns consumption of the authenticated
provisional writer and C1 transcryption through the in-memory Runtime ports.

### 2026-08-25 — C2 delivered the deep Attachment Move preparation workflow

One explicitly Account- and Operation-scoped Rust drive interface now owns manifest renewal, the
two-pass source download, authenticated transcryption into bounded provisional chunks, publication
before the guarded Replica checkpoint, canonical artifact upload, stale-authority freezing, final
promotion, persisted unbounded retry, restart, and staging-incomplete reactivation. It consumes the
committed Replica, crypto, and artifact-store contracts through in-memory ports without editing their
implementations or any host-composition path. Download or authenticated-envelope failure remains
retryable work rather than a semantic outcome; unexpected local secret or artifact-store failure is
surfaced and never converted into transport backoff.

Independent review found a real product defect: the first worker resolved target key material and
prepared metadata twice, so ciphertext produced by one bundle could be checkpointed with another.
Fresh work now resolves exactly one coherent bundle. Recovery of an already-published owner uses a
separate metadata-only seam that re-seals the same durable Attachment key from immutable authority and
validates the canonical owner; it cannot mint a second key bundle. Review also found a real fixture
defect: the restart test retained the first provider's metadata in RAM. Restart now creates a fresh
provider, reconstructs owner-bound metadata without transient state, and proves it decrypts the
existing published artifact. Behavioral coverage includes malformed manifests, failures after actual
download and upload progress, every local store boundary, more than five persisted retries, credential
renewal, exact uploaded digest and length, Account isolation, and one live writer.

Deliberately left open: C2 provides only in-memory transfer and secret ports. C3 owns the generated
Web/MV3 bounded binary transport adapter and its cancellation/header/CORS behavior; C4 alone owns
production scheduling, Worker composition, exclusive startup sweep, and reachability.

### 2026-08-25 — browser uploads use a temporary OPFS ciphertext spool

Real Chromium invalidated C3's original direct-streaming PUT assumption. The Fetch Standard makes
`Content-Length` a forbidden request header, and Chromium removes a script-supplied value from a
`ReadableStream` request even though Bun retains it. The original Bun header-preservation test was
therefore a fixture false-green: Web and MV3 could not satisfy the recorded hash-bound upload contract
with exact `Content-Length` through that request shape.

The maintainer selected a deterministic temporary OPFS ciphertext spool. IndexedDB remains the
canonical Web/MV3 artifact store; this does not reopen the SQLite-everywhere decision. The adapter
copies only bounded, already-published ciphertext chunks into an Operation/Attachment/artifact-scoped
OPFS file, validates its exact expected size while Rust retains digest policy, and uploads the resulting
browser-known-size `File`. The user agent, rather than script, emits `Content-Length`; the signed
`application/octet-stream` and `x-amz-content-sha256` headers remain explicit. Partial or completed
spools carry no plaintext, capability, or credential and are restartable, generation-fenced, and
idempotently removable after success or as exclusive-startup orphans.

C3 is split before further implementation because OPFS durability and Fetch contract drift require
independent browser evidence:

1. **Known-length OPFS upload spool (C3a):** new browser-internal spool paths own bounded writes,
   truncation/rebuild after interruption, exact length, immutable `File` handoff, cleanup, and actual
   Chromium network evidence that the user agent sends the correct `Content-Length`. They do not edit
   the generated Rust transfer contract or Runtime worker.
2. **Web and MV3 binary transfer adapter (C3b):** the paused generated control/WASM/TypeScript adapter
   consumes C3a, streams download chunks through the binary side channel, and performs the hash-bound
   `File` PUT with cancellation, CORS/header, response-bound, and retry-classification coverage. It
   does not edit the spool implementation or production composition.

Deliberately rejected: weakening the signed upload contract merely to accommodate Fetch, and adding a
Server proxy or multipart assembly protocol. The deployment-provider enforcement exercise remains a
recorded release gate; repository and Chromium fixtures prove request construction, not provider
acceptance or rejection.

### 2026-08-25 — C3a delivered the known-length OPFS upload spool

The browser-internal spool now copies bounded published-ciphertext chunks into an opaque,
Account/Operation/Attachment/artifact/generation-scoped OPFS file and exposes that `File` only inside
an awaited lifecycle callback. One Account-wide Web Lock spans stale-file truncation, bounded writes,
exact-length sealing, the complete future upload callback, and final cleanup. Explicit cleanup and
exclusive Account orphan sweeping use the same lock, so another handle, generation, delayed cleanup,
or sweep cannot rewrite or remove the backing entry while Fetch consumes it. Interrupted or stale
files are rebuilt with `keepExistingData: false`; no plaintext, credential, capability, or Base64 is
stored.

Actual bundled Chromium running an MV3 service worker proves OPFS and Web Locks are available in that
host, the user agent sends the exact `Content-Length` for the OPFS `File`, and the explicit media type
and SHA-256 header survive without script setting the forbidden length header. The controlled endpoint
also holds its response while a second context requests cleanup and proves cleanup remains blocked
until the upload callback completes.

Independent review found a real product defect: the first API returned a `File` after releasing all
coordination, so another same-generation writer or cleanup could make it unreadable during upload.
The lifecycle callback and shared Account lock close that race. Review also found fixture defects: the
opacity assertion serialized `Map` as `{}`, the Chromium harness buffered the whole file to compute a
digest that Rust already owns, and the restart test never recreated its root or retained stale bytes.
Tests now inspect physical keys, pass a known digest without reading the File, and rebuild a faithful
stale partial file through a new root.

Deliberately left open: C3a performs no Fetch classification, download streaming, Rust control, or
Runtime composition. C3b consumes this callback to deliver the paused generated Web/MV3 transfer
adapter; C4 remains the sole production-composition owner.

### 2026-08-25 — C3b delivered the Web and MV3 binary transfer adapter

Rust now owns a generated closed transfer-control contract, bounded chunk and whole-upload integrity
policy, response classification, and crate-internal WASM handles. The fixed browser executor streams
download bytes only through bounded binary side channels and copies canonical upload chunks into C3a;
the resulting OPFS `File` is PUT while the Account lifecycle lock remains held. Script sets only
`application/octet-stream` and the exact ciphertext SHA-256, never `Content-Length`. URLs and signed
headers remain invocation-scoped and are neither persisted nor logged. Actual MV3 Chromium execution
through the fixed exported executor and Rust-produced fixture controls proves cancellation, Account
lock behavior, UA-owned length, and the observed request headers. Provider enforcement remains the
separate recorded release gate.

Independent review found real lifecycle defects. Rust handles initially had no abandonment cleanup,
so C2 dropping a download after crypto failure or an upload after artifact-read failure could retain a
browser session, presigned request, and OPFS lock. Handles now own a generated `cancelTransfer` guard,
arm it before JavaScript open invocation begins, disarm only after a proved closed result, and emit one
cancel on pending-open or handle drop. Review then found two same-ID races: old async read/finish work
could delete a replacement session, and an Open future could be cancelled before its returned handle
existed. Every async continuation is now fenced by captured session identity, and the pre-invocation
guard closes the second gap. Held Fetch/read/PUT fixtures prove immediate same-ID reuse cannot be
deleted, aborted, or fed bytes by stale work.

Review also found a fixture defect: the first Chromium harness instantiated the configurable internal
executor and handwrote controls, bypassing the fixed production TypeScript surface. It now imports the
fixed executor and drives Rust-generated fixture controls. The crate-private Rust adapter remains
unexported until C4 composition; native guard tests execute exact generated cancel serialization while
the production WASM graph is compiled and the fixed JavaScript boundary runs in Chromium.

Deliberately left open: C3b does not schedule accepted preparation, construct production C2 ports,
sweep under startup authority, or expose a host workflow API. C4 alone owns that composition and the
end-to-end retry/restart reachability proof.

### 2026-08-25 — C4 split at the core scheduler and browser ownership boundary

Pre-implementation scoping found that C2 intentionally keeps its preparation driver and port types
inside Client Core, while C3 intentionally keeps its binary-transfer primitives inside the Web
bindings crate. Neither slice exposes a production composition surface. The browser artifact sweep
also assumes a caller-proved exclusive startup boundary, which an in-process Rust mutex or one
module-scoped Worker cannot prove across tabs and MV3 worker restarts. Treating those independent
facts as one fixture would let a fake core port stand in for browser reachability, or let a browser
lock test stand in for restart-safe scheduling.

C4 is therefore split before implementation into two sequential, path-disjoint commits:

1. **Core preparation scheduler and composition facade (C4a):** new Client Core scheduler paths and
   their Runtime lifecycle hooks consume C2 through crate-internal types without editing the C2
   implementation. A narrow adapter-neutral facade accepts explicit Account-scoped artifact,
   manifest/binary-transfer, and secret authority. Deterministic tests prove restart and unlock
   resumption, persisted unbounded backoff beyond five transient failures, renewed credentials,
   promotion before ordinary dispatch eligibility, and one scheduler writer per Account. No Web,
   IndexedDB, OPFS, binding, or worker-composition file belongs to this slice.
2. **Web binding and exclusive Worker composition (C4b):** new binding bridge paths consume C4a and
   the already-committed B2/B4/C3 primitives, while Web Worker composition constructs the fixed
   Replica, artifact, HTTP-control, and binary-transfer executors. A browser-wide Account Web Lock
   grants startup/sweep and writer authority across tabs and MV3 restarts; actual browser fixtures
   prove orphan sweep ordering, restart/unlock reachability, one reachable writer, and production
   executor use. This slice does not edit C2, C3, artifact-store, or core scheduler implementations.

C4a may add a new facade and lifecycle hooks in `runtime.rs`; it must not widen C2's existing types
or make its worker a host-callable policy surface. C4b may construct those ports only through the
facade. The previously recorded C4 omissions remain unchanged: Server Share, ordinary cross-kind
dispatch/outcome widening, the general Attachment service, and final Web host cutover follow later.

### 2026-08-26 — C4a review filed the shared-uploader C2 blocker

Production secret-resolution review proved that the Server preserves an Attachment's original
`uploaded_by` identity when Move finalization switches its Vault and storage object, and ordinary
reads use that retained identity in Attachment AAD. Committed C2 instead used the User performing the
Move for both source and target blob scopes. A shared Attachment uploaded by another authorised User
therefore fails source authentication and would remain unreadable after finalization.

[Ticket 43](43-attachment-move-uploader-aad.md) is claimed as the path-disjoint C2 correction and now
blocks this ticket. It owns only blob-scope construction and its shared-uploader vector. The paused
C4a slice retains its own reviewed companion correction: target encrypted metadata uses the retained
uploader, and the target-wrapped Attachment key binds the Server's incremented envelope version.

### 2026-08-26 — C4a delivered the Core preparation scheduler and facade

Client Core now owns one resettable Attachment Move preparation lifecycle and a narrow facade whose
only external authorities are the committed artifact stores and Account-scoped binary/manifest
transfer. Core privately resolves the live MUK, source and target Vault keys, the existing durable
Attachment key, and target metadata; bindings receive no secret-policy surface. The lifecycle scans
durable Replica candidates, runs only unlocked explicit Accounts under the existing Account execution
lock, respects C2's persisted unbounded deadlines, wakes ordinary dispatch only after C2 promotion,
and rejects a duplicate lifecycle runner before it can scan stale work. Normal close, cancellation,
or an observable error releases that runner lease so the host can restart it without discarding the
accepted preparation.

Runtime tests close and recreate the Runtime while an attempt-count-seven preparation remains pending,
prove it stays idle while locked, resume it on explicit unlock, observe no dispatch-ready Operation
before promotion, and prove a later restart cannot prepare it again. Held-drive tests prove Lock and
close wait until plaintext/credential work releases the Account boundary. Fixed crypto vectors keep
the original uploader as Attachment AAD authority, retain the same Attachment key, bind its target
wrap to Server envelope version `N + 1`, and reject the mover identity, version `N`, and overflow.

Independent review found real product defects in the initial slice: a binding-supplied secret provider
would have moved crypto authority out of Core; preparation did not share Lock/close fencing; clock
failure parked invisibly; target metadata used mover/version `N`; and two lifecycle futures could
drive one stale Operation. It also found fixture defects where restart occurred only after promotion
and the first metadata vector made mover equal uploader. Each is now behaviorally covered. Review
also found the committed C2 shared-uploader blob defect fixed separately in Ticket 43.

Deliberately left open: C4a constructs no Web binding, IndexedDB/OPFS executor, browser-wide writer
lock, exclusive orphan sweep, or Worker lifecycle/error surface. C4b owns those production-reachability
properties and must await this lifecycle `Result`; Server Share, ordinary cross-kind dispatch/outcome,
the general Attachment service, and final Web host cutover remain later Ticket 28 slices.

### 2026-08-26 — C4a and its review blockers passed the repository gates

Ticket 43 resolved the committed C2 shared-uploader blob scope; Ticket 44 repaired the earlier
prepared-Move caller and Server/Desktop lockfile drift that its first clean-tree gate exposed. From
the resulting clean tree, both `pnpm check:ci` and `pnpm check:ci:rust` pass without changing a tracked
file. C4a is therefore closed. Deliberately left open: C4b still owns browser-wide writer authority,
exclusive orphan sweeping, fixed production adapter construction, Worker error observation, and
actual browser reachability before Ticket 28 proceeds to its remaining Server/dispatch/outcome/
Attachment-service/Web-cutover slices.

### 2026-08-26 — C4b1 delivered the Rust/WASM composition bridge

Commit `99e92c58` adds the one configured Web Runtime constructor for Attachment Move preparation.
The binding adapts Core's transfer port to the fixed binary executor, uses one shared artifact-store
instance for provisional and published artifacts, accepts only an explicit Account ID through the
closed JavaScript lease surface, and starts the Core-owned preparation lifecycle. Transfer attempt
IDs and OPFS spool generations are fresh opaque binding identities; the Server storage key never
crosses the binary-transfer boundary. Closing or freeing the wrapper releases acquired or late lease
handles once, abandons pending and opened transfers, and cancels the preparation future, including a
reentrant free from a synchronous JavaScript callback.

Native tests and a feature-only generated-WASM harness cover exact error mapping, JS `this` binding,
own-key and symbol rejection, lease denial/loss/release, close during pending acquisition, download
and upload abandonment, upload serialization without `storageKey`, lifecycle redaction, drop before
open, and reentrant lifecycle cancellation. The production binding drift gate proves that the test
harness is not exported.

Independent review found real defects in the initial slice: Server storage identity was used as a
spool generation; resource shutdown could wait behind a live drive; exact lease validation missed
symbol and non-enumerable keys; late and rejected handles could leak browser locks; the first WASM
suite did not exercise the upload boundary; and lifecycle ownership leaked or panicked during drop
and reentrant free. Each is now behaviorally covered. A generated-contract test failure after
constructor factoring was a fixture-sensitive funnel check rather than a product defect, so the
established constructor funnel was preserved without weakening the test.

Deliberately left open: this slice edits no Worker or browser-host composition and therefore makes no
production write path reachable. C4b2 still owns the fixed IndexedDB artifact executor, OPFS binary
executor, browser-wide per-Account Web Locks lease, Worker lifecycle observation, and actual browser
proofs for exclusive startup, restart/unlock reachability, lease loss, and unbounded retry.

### 2026-08-26 — C4b2 paused on dependent Web binary typing

The first authenticated production Worker import of the fixed binary executor makes the Web
application's ES2022 DOM compiler reach a pre-existing `Uint8Array<ArrayBufferLike>` to
`BufferSource` mismatch in the committed digest comparison. C4b2 excludes the binary implementation,
so [Ticket 47](47-web-binary-buffer-source-compatibility.md) owns the minimal path-disjoint correction
and its focused behavior/type proof. The C4b2 implementer did not edit that excluded path.

### 2026-08-26 — C4b2 split at composition and authenticated browser acceptance

Ticket 47 resolved the dependent Web compiler blocker. The resumed C4b2 audit then proved that its
remaining claims span two independently reachable graphs and cannot be verified honestly in one
package-level slice:

1. **C4b2a — fixed Worker composition and browser lease:** TypeScript package paths construct the
   production IndexedDB artifact executor, OPFS binary executor, and exact Account-only Web Locks
   lease, call only the C4b1 constructor for an authenticated Runtime, and close/redact/reconstruct a
   failed preparation runner without a finite restart limit. Unit tests exercise constructor and
   lifecycle races; actual Chromium proves two same-origin contexts cannot hold one Account lease and
   that release or context loss permits reacquisition.
2. **C4b2b — authenticated real-Core browser acceptance:** after the dedicated Attachment Runtime
   service exposes the required public host path, an `apps/web` E2E slice uses the production Worker,
   generated Runtime, Server ceremony, and fixed browser executors to prove exclusive startup sweep
   before preparation, restart and unlock reachability, actual artifact/binary invocation, and more
   than five real preparation failures without durable discard. It lands before the final Web host
   cutover and uses no production test hook.

The package Chromium harness has no authenticated Server/crypto ceremony, while the generated Core
starts preparation only for a valid installed and unlocked Account with live keys and a durable Move
preparation. Fake WASM lifecycle tests prove only Worker policy and therefore do not satisfy C4b2b.
The split records that acceptance gap rather than weakening it or exporting a fixture/install-key
surface from production.

### 2026-08-26 — C4b2a delivered fixed Worker composition and the browser Account lease

Commit `74acae4b` constructs the production IndexedDB artifact executor, one fresh close-owned OPFS
binary executor per authenticated Runtime incarnation, and the exact browser-wide
`bittery:attachment-move:account:<AccountId>` exclusive Web Lock. The authenticated Worker calls
only the C4b1 constructor. Lifecycle failure closes its exact runner once, rejects commands that
raced the failed incarnation, reconstructs without a finite limit after proven cleanup, and remains
terminal with one stable redacted error when cleanup cannot prove that writer ownership ended.

Behavioral unit tests cover synchronous construction failure, lifecycle/open/close races, fresh
binary ownership, unbounded reconstruction, and retained terminal failure. An actual Chromium test
proves that two same-origin contexts cannot hold the same Account lease and that explicit release or
context loss permits reacquisition. The focused Worker, lease, composition, and Chromium suites pass;
all fourteen dependent type-check tasks, Biome, and `git diff --check` pass.

Independent review found real product defects in reused closed binary resources, a request admitted
after its resolved Runtime incarnation failed, swallowed cleanup failure that could permit a second
writer, and a concurrent close that acknowledged success despite uncertain ownership. Each now has
behavioral regression coverage. The earlier unsupported Bun polling matcher was a fixture/tooling
defect and was replaced with bounded behavioral polling rather than a softened assertion.

Deliberately left open: C4b2a does not prove the Core lifecycle through authenticated Web/Server
ceremony. C4b2b still owns sweep-before-preparation, restart/unlock reachability, actual production
artifact and binary invocation, and more than five real failures without durable discard after the
dedicated Attachment Runtime service exposes the host path. Server Share, ordinary cross-kind
dispatch/outcome, the Attachment service, final Web cutover, transitional-writer reachability audit,
and `idempotency_record` removal remain later Ticket 28 slices.
