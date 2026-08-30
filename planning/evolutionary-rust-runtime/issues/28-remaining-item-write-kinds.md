# Remaining Item write kinds through the Runtime

Type: task
Status: claimed
Blocked by: 22, 24, 31, 32, 43, 45, 46, 48, 58
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

### 2026-08-26 — missing durable Share acceptance inserted before the Server slice

The post-C4b2a sequence audit found that commit `2719bd25` delivered durable acceptance for the six
remaining Item mutations but not the `create_share` acceptance that the later ownership decision
added to that slice. No `CreateShare` request, Account-protected local capability state, Share AAD,
or restart/Lock/destruction proof exists in Client Runtime. Starting the Server Share Operation now
would therefore leave its accepted request producer undefined and would not be independently
verifiable as the recorded vertical slice.

Ticket 28 is amended with one path-disjoint correction before Server work:

1. **Durable Share acceptance correction:** Client Runtime and its generated contracts accept one
   explicit-Account `create_share` draft, generate the raw token and Share key locally, persist only
   their MUK-bound Account- and Operation-AAD-protected capability state, freeze the decided Server
   request containing the token hash rather than the token, and prove offline acceptance, restart,
   Quick Unlock, Lock hiding, and Account teardown destruction. It edits no Server path and performs
   no dispatch or reconciliation.
2. **Server Share Operation:** the already-recorded Server-only slice then consumes those immutable
   bytes and atomically retains the decided applied/rejected semantic outcome while the raw token
   remains absent from Server persistence and responses.

The public test seam for the correction is the existing explicit-Account Runtime request/projection
boundary used by the other durable acceptance tests. The later Server slice keeps the authenticated
HTTP route and Operation lookup as its separate public seam. This restores the binding order without
folding Client cryptography, Server transaction semantics, and generated OpenAPI into one
unreviewable commit.

### 2026-08-26 — Account removal and Wipe lifecycle gap filed separately

The durable Share acceptance correction can prove successful Sign-out destruction, Lock hiding,
and password Quick Unlock recovery. It cannot prove Account removal or whole-Device Wipe because
Client Runtime exposes neither request; those remain in the transitional TypeScript lifecycle
owner. [Ticket 48](48-runtime-account-removal-and-wipe.md) owns the unresolved destructive and
partial-failure protocol plus its host cutover. The Share correction does not infer that general
product contract, and Ticket 28 cannot resolve before Ticket 48 does.

### 2026-08-26 — durable Share acceptance correction delivered

Commit `e144b05d` adds the explicit-Account `CreateShare` Runtime request and atomically persists its
immutable `create_share` Operation with MUK-protected, Account- and Operation-AAD-bound capability
material. Rust preserves the existing 32-character alphanumeric token, lowercase SHA-256 token
hash, five-category shared-payload allowlist, and AES-GCM formats. SQLite retains every existing
numeric store code and adds Share capabilities as code 9; IndexedDB v7 adds its store without
destroying v6 heads, authority, accepted Operations, or receipts. Generated persistence, Runtime,
native, and Web contracts travel with the defining Rust change.

The slice proves atomic failure, restart and password Quick Unlock, Lock hiding, successful Sign-out
destruction without Operation discard, post-commit cancellation, close and Account lifecycle
fences, ready-authority admission, hostile persisted-row rejection, recursive plaintext JSON
zeroization, and fixed cross-language AAD and request-fingerprint vectors. `CreateShare` is
deliberately retained but not dispatched until the next Server slice replaces the old
server-generated-token request; already-supported Operations remain dispatchable with their
unbounded retry behavior.

Independent review found real product defects in premature dispatch against the old Server
contract, destructive IndexedDB upgrades, divergent admission guards, unvalidated protected rows,
and non-zeroized plaintext JSON copies. Behavioral regressions cover each. Updating fresh-schema
store-list expectations was a fixture change, while preserving a populated v6 database was a real
product requirement. The final independent review reported no remaining findings, and focused Rust,
Clippy, IndexedDB, TypeScript, generated-contract, native/WASM binding, Quick Unlock, crypto-vector,
format, and diff checks pass.

Deliberately left open: the Server Share Operation, Share dispatch and outcome reconciliation,
acknowledged capability delivery, the Attachment Runtime service, C4b2b authenticated browser
acceptance, final Web cutover and reachability audit, and `idempotency_record` removal remain later
Ticket 28 slices. Account removal and Device wipe capability destruction remain blocked on the
maintainer decision in Ticket 48.

### 2026-08-26 — Share Server slice split after dependent-contract review

The first uncommitted Server Share pass proved that the recorded Server-only route switch cannot be
an independently green slice. Replacing the public POST immediately widens `OperationOutcome` while
the reachable transitional Share service still sends the old request and expects the old raw-token
response; Client Runtime deliberately does not dispatch `create_share` until that replacement
exists. Dependent type checks fail, and an applied Share `operation_resolved` event makes the legacy
delta consumer attempt to fetch Item `undefined`. Adding a TypeScript compatibility token writer
would create the dual owner the accepted Rust decision forbids. None of that uncommitted pass may be
committed as the Server slice.

The remaining Share work is therefore re-split at three green, non-parallel boundaries:

1. **Outcome schema and lookup foundation:** add the closed `create_share` applied/rejected retained
   schema, migration invariants, generated lookup union, and safe existing union consumers. The
   public create-Share route and facade keep their legacy contract in this commit, so no caller or
   writer changes and the Runtime dispatch gate remains closed.
2. **Runtime Share outcome lifecycle:** implement typed dispatch classification, lookup/retry,
   atomic reconciliation, durable `PendingShareResult`, and idempotent acknowledgement against test
   transport while keeping the production `create_share` dispatch gate closed.
3. **Atomic Share cutover:** in one vertical commit, replace the public POST with the hash-only
   Operation executor, open Runtime dispatch, route Web Share creation/result acknowledgement to
   Runtime, and remove the transitional TypeScript Share writer. The route, generated facade, host,
   and only reachable writer change together.

Review of the rejected Server-only pass also found real defects that the owning later slices must
retain as regression requirements: semantic Share rejections need an audit in the same transaction;
entitlement lookup must not acquire a second pool connection while holding the Operation
transaction; and the create-only Operation-ID `422` must not be advertised through shared error
responses on unrelated Share routes. PostgreSQL enum use in one migration transaction, nullable or
incomplete applied payloads, and foreign Share rejection codes were already reproduced as real
migration defects. The stale exact enum-label expectation and an accidentally zero-test Cargo
filter were fixture/command defects, not product behavior.

### 2026-08-26 — Share outcome schema and lookup foundation delivered

Commit `3b3892c0` adds the closed `create_share` retained-outcome schema and authenticated lookup
union without changing the reachable Share writer. Its migration preserves every existing Item
outcome while requiring an applied Share result to contain exactly the three non-secret string
fields `shareLinkId`, `baseShareUrl`, and `expiresAt`; the raw token cannot be retained. Rejected
Share outcomes accept exactly `item_not_found`, `vault_read_only`, `share_entitlement_denied`, or
`share_limit_reached`, and Share-only codes cannot appear on Item outcomes. OpenAPI, the TypeScript
facade, and generated Rust agree on that closed union.

Existing Item mutation facade methods now return an explicitly Item-only outcome union, while the
User-scoped Operation lookup returns the complete union. Delta Sync ignores an applied Share
outcome before any Item fetch or cache mutation. The legacy public Share POST, Server-generated raw
token response, TypeScript Share service, and Client Runtime production dispatch gate remain
unchanged, so this foundation introduces neither a compatibility writer nor a second reachable
owner.

The widened union exposed real dependent defects: Delta Sync fetched Item `undefined` and cached
its response, and the outbound queue accepted Share-only results and rejection codes in Item paths.
Behavioral and type regressions cover both. The PostgreSQL enum-in-transaction, SQL `NULL`, closed
payload, and rejection-vocabulary failures from the rejected pass were real migration defects and
are covered here. Its stale closed-enum expectation and zero-test short Cargo filter were fixture
and command defects. A fresh independent review reported no remaining findings. The complete Server
suite passes 455 tests plus both migration-binary tests; all fourteen dependent type checks, API
contract and Delta Sync suites, generated-contract drift, generator tests, formatting, and diff
checks pass.

Deliberately left open: Runtime Share dispatch, retained-outcome polling and reconciliation,
durable `PendingShareResult`, and acknowledgement remain the next slice with production dispatch
still closed. The later atomic cutover still owns the hash-only public POST, same-transaction
rejection audit and entitlement lookup, scoped create-route `422`, opening production dispatch,
Web Runtime ownership, acknowledgement, and removal of the transitional TypeScript Share writer.

### 2026-08-26 — Runtime Share outcome lifecycle delivered behind the cutover gate

Commit `05c8965d` classifies the closed `create_share` applied/rejected union and reconciles it in
one guarded Replica commit. An applied outcome receipts and removes the accepted Operation while
retaining the non-secret Server result beside the locally protected capability; a rejection
receipts and removes the Operation and destroys that capability. An explicitly unlocked Account
can observe a durable `PendingShareResult` reconstructed from those two authorities, and
`AcknowledgeShareResult { accountId, operationId }` atomically removes it. ACK is idempotent,
Account-scoped, lifecycle-fenced, and leaves the receipt intact.

Restart, real password Quick Unlock, Lock hiding, Sign-out destruction, injected ACK persistence
failure, more than five transport failures, dropped responses, cross-kind outcomes, same-kind
Operation-ID reuse, and applied and rejected outcomes after Sign-out all have behavioral coverage.
Because the lookup response carries no request fingerprint or Share Item correlation, a Share GET
is only a hint: identical immutable POST replay must prove the request fingerprint before Runtime
can complete it. Sync cannot perform that verification while production Share dispatch remains
closed, so it leaves the Operation owed for the atomic cutover.

Independent reviews found real product defects in a Web binding queue that could outlive Core's
Lock lease, capability-less post-Sign-out reconciliation, same-kind GET identity acceptance, and
unwiped Rust-owned Core, Web JSON, and native UniFFI buffers. Account-scoped observation suspension
now starts before the Lock/Sign-out future, covers its complete asynchronous lifetime and nested
requests, and preserves the subscription for a later generation. Core projection storage uses
zeroizing drop; Web JSON is zeroizing; Swift and Kotlin use a fail-closed generated sensitive lift
whose RustBuffer is wiped before UniFFI frees it, with Kotlin also wiping its temporary byte array.
The first missing authoritative Item in the dispatch harness and one zero-test Cargo filter were
fixture and command defects. The final fresh review reported no findings.

The complete Client Runtime check passes 33 binding tests, 310 Core tests, every integration suite,
Clippy, formatting, 17 generator tests, all contract/conformance/native/Web drift checks, and the
combined WebAssembly binding checks. Deliberately left open: the production dispatcher still skips
`create_share`; the public Server route and transitional TypeScript Share writer remain unchanged.
The next atomic cutover still owns the hash-only Operation POST, same-transaction rejection audit
and entitlement lookup, create-route-only `422`, opening dispatch and Sync verification, Web Runtime
creation/result/ACK ownership, and removal of the transitional writer.

### 2026-08-26 — atomic Share cutover delivered

Commit `e29e3d96` replaces the public Share POST and its transitional TypeScript writer in one
vertical cutover. The Server now accepts the Runtime's hash-only immutable request, serializes exact
Operation replay, and performs access, entitlement, active-link limit, Share/allowlist writes,
applied or rejected audit, retained outcome, and ordered Item/Operation Sync events on the same
transaction connection. Only the create route advertises Operation-identity reuse as `422`; raw
tokens and Share keys never enter Server persistence or responses.

Production Runtime dispatch now includes `create_share`. A lookup remains only a hint until replay
of the identical POST proves the accepted fingerprint. Applied results retain the Server's
non-secret payload beside the protected local capability, derive Item correlation from the
authoritative Operation receipt, and remain durable until an explicit Account-scoped ACK. Web
creates only through Runtime, renders a result before ACK, retries ACK without an attempt bound, and
resumes a keyed Account-and-Item result after unmount or restart. The whole-entry import audit now
classifies the retired Share writer as forbidden and proves it unreachable.

The in-place Server contract makes the legacy Desktop and Mobile create writer invalid, so their
create-Share affordances are deliberately absent until those later Runtime host slices; Share reads
and history remain. Independent review found real defects in unseen late-result ACK, mutable
Account/Item delivery scope, redundant unverified persisted Item correlation, a stale dispatch-gate
comment, and unrelated lockfile drift. Mounted lifecycle tests, receipt-derived authority, corrected
documentation, and an importer-only lockfile cover those findings. A moved test value, a text-as-JSON
audit query, and the generated positive projection without required `itemId` were fixture defects;
an exhaustive-access Clippy failure was a real production quality defect.

Primary gates pass for the complete Server, Client Runtime (311 Core tests plus generator and native/
Web binding drift), API, UI, Web ownership/reachability, dependent types, contracts, formatting, and
diff checks. The unchanged sharing E2E cannot reach Share because Sign-in waits on the held SSE body:
the finite ping fixture in the existing Runtime acceptance explicitly records that Ticket 30 owns
this lifecycle. No finite SSE bypass or softened test was added.

Deliberately left open: ordinary cross-kind dispatch/outcome widening, the dedicated Attachment
Runtime service and authenticated C4b2b browser acceptance, final Web mutation/lifecycle cutover,
`idempotency_record` removal, native host Share creation, and Ticket 30's held-SSE loop. Ticket 48 now
records the maintainer's teardown contract and remains an implementation dependency before Ticket 28
can resolve.

### 2026-08-28 — cross-kind Operation dispatch proof delivered

Commit `9271963e` adds the missing executable dispatch fixture and behavioral coverage for the six
ordinary mutation kinds. The exact RED was six panics on unsupported fake-Server routes, proving
that every kind already reached the shared kind-agnostic production dispatcher; this was missing
fixture and coverage, not a production defect. Only `dispatch_tests.rs` and the test-only
`operation_fixtures.rs` changed. The deliberately transient-only fixture cannot reconcile an
Operation or manufacture a semantic outcome.

The tests prove each immutable request's exact method, URL, body, and headers, with only the
Runtime-added idempotency, client-identification (`Bittery-Client-Id`, `Bittery-Client-Platform`, and
`Bittery-Client-Version`), and authorization headers; seven transient attempts with durable backoff
delays of 1, 2, 4, 8, 16, 32, and 64 seconds; restart from the persisted remaining deadline; and
forced exact duplicate transport sends while the Operation remains accepted. Fresh
independent review mutation-tested these guarantees and approved the slice. The orchestrator's
focused test, Clippy, formatting, and diff gates pass.

Deliberately left open: outcome and reconciliation widening, the dedicated Attachment Runtime
service and C4b2b authenticated browser acceptance, final Web cutover, `idempotency_record` removal,
native host Share creation, and Ticket 30's held-SSE work. Ticket 28 remains claimed.

### 2026-08-28 — remaining Item Operation reconciliation delivered

Commit `e0eb2323` widens the Runtime's semantic-outcome and reconciliation path to `update_item`,
`set_item_favorite`, `trash_item`, `restore_item`, `move_item`, and `permanently_delete_item`. The
initial RED classified all six correctly tagged ordinary outcomes as cross-kind identity reuse. The
closed decoder now validates the exact accepted kind, Operation and Item identities, positive
validator, and per-kind rejection set before an answer can affect durable state. An unrecognised
outcome remains retryable; a parsable wrong kind or invalid same-kind answer fails closed. Because
lookup carries no request fingerprint, a same-kind lookup answer remains only a hint until replay of
the exact immutable mutation through the shared dispatch path proves its identity.

One generic `ReconcileItemMutation` plan now owns every ordinary Item terminal result. Applied
non-permanent mutations require the authoritative Item to be present with the accepted Item, Vault,
and retained version; an applied permanent deletion requires authoritative absence. Rejections fetch
the current authority and either replace the local record or remove stale local authority when the
Server proves absence. In the same guarded transaction the plan retains the compact receipt, removes
the accepted Operation and its optimistic overlay, and applies the authoritative presence or absence.
Fetch or commit failure preserves the Operation, overlay, prior authority, and retry obligation.

Dropped responses recover through lookup plus exact replay for all six kinds. Forced duplicate sends
converge on one semantic effect and one receipt, while foreign Operation IDs, unknown outcomes,
transport failures, invalid authority presence, and rejected or stale commits cannot manufacture
completion. The Rust logical history for ordinary reconciliation is generated into the shared
Replica corpus, so SQLite and IndexedDB execute the same atomic mutation and final snapshot rather
than relying on parallel adapter-specific expectations.

Sync page ownership is now explicit. Operation reconciliation is cursorless: Bootstrap processes the
whole multi-event page under the Account execution fence, and exact replay uses the same Session
renewal, send classification, and persisted backoff helper as background dispatch. Only after every
event succeeds does a separate guarded `AdvanceSyncPageCursor` commit the page's terminal Cursor.
That plan refuses to pass any page-named active Operation or Attachment Move preparation. It handles
a background dispatcher winning before the event, foreign Operations, repeated pages, and multiple
pages idempotently; a terminal Cursor commit failure retries without moving either the watermark or
accepted work.

Independent correction and review rounds closed real gaps in cursor preservation and page-watermark
ownership, removed a duplicated Sync send/backoff owner, repaired an invalid Move fixture, and covered
the background-wins race plus active-preparation and stale-guard fencing. They also corrected the
mixed- and two-page fixtures and moved the stale conformance expectation back to the Rust-owned shared
history. The resulting tests prove that no earlier event can advance a page past later undecided,
transport-failed, authority-fetch-failed, or reconciliation-commit-failed work.

The orchestrator's full `@bittery/client-runtime` check passes 394 Core tests, 43 binding tests, and
25 generator tests, including native and Web generated-binding drift. The focused IndexedDB shared
conformance run passes 1 test with 1,084 assertions, the failure-injection run passes 3 tests with 74
assertions, and `git diff --check` passes.

Deliberately left open: the dedicated Attachment Runtime service and C4b2b authenticated browser
acceptance, final Web cutover, `idempotency_record` removal, native host Share creation, and Ticket
30's held-SSE work. Ticket 28 remains claimed.

### 2026-08-28 — Attachment Runtime frontier resolved and split before implementation

The maintainer confirmed the remaining ordinary Attachment contract. Upload, download, rename, and
delete are foreground Runtime requests outside the durable `Operation` union. They have no durable
retry loop: one request may renew its Session once, but caller cancellation or Runtime restart ends
that attempt. After an ambiguous upload, rename, or delete response, Rust probes authoritative
Attachment and Item state before deciding whether the requested effect happened; if authority does
not prove the effect, the request returns the closed retryable error instead of reporting success or
silently retrying a mutation.

The external Runtime interface stays small and carries only explicit Account/entity addresses,
bounded metadata, opaque capability identities, and closed results. Binary data never appears as
Base64 or unbounded byte arrays in JSON or generated bindings. The production host capability
registry and its adapter are part of this external seam: the host grants each upload plaintext source
or download plaintext sink as an opaque, single-use capability scoped to the Account, Runtime
incarnation, and request. Rust consumes the capability through lower internal binary-chunk ports and
adapters, while its owned HTTP port and adapter remain at an internal seam and retain authenticated
route, Session-renewal, response-classification, and authoritative-probe policy. Capabilities close
on success, error, cancellation, Lock, or Runtime close. A download writes plaintext only to an
atomic host sink: publication occurs after complete authenticated success, and every partial output
is discarded.

The existing unlocked `AttachmentProjection` already owns decrypted `name` and `contentType`. It is
retained, but public `storageKey` is removed from that projection and the generated bindings because
storage identity remains a Runtime implementation detail under the opaque-capability and minimal-
addressing decisions. Lock removes the decrypted Attachment fields with the rest of the decrypted
projection. The minimal external addressing is `Account + Item` for upload and
`Account + Attachment` for download, rename, and delete. Rust derives the Item, Vault, uploader, and
Attachment envelope version from authoritative Replica state rather than asking a host to repeat or
choose them. A successful mutation is published only after an authoritative Attachment/Item fetch
and a guarded Replica commit; transport success alone cannot manufacture local success.

The interface exposes a closed success/result vocabulary and closed errors for authentication,
retryable transport, cancellation, missing authority, access denial/read-only authority, quota or
size rejection, source failure, sink failure, and invariant violation. Per Item, one mutation writer
serializes upload, rename, and delete. Every request reuses the existing Runtime teardown/admission
owner and Account lifecycle fencing. Mutation authority and Replica phases acquire the established
Account execution fence; long parallel downloads do not hold that exclusive fence across their whole
transfer. The deep module may retain internal per-Account cancellation and cleanup tracking for Lock
and close, but creates no second authority owner. Lock, Sign-out, Account removal, Wipe, and Runtime
close cancel every affected transfer and wait for capability and atomic-sink cleanup before retiring
the corresponding key or Account authority. These rules keep streaming, cryptographic, network,
reconciliation, and cleanup complexity local to one deep Rust module behind one small external
Runtime interface. Only the host capability registry and adapter occupy its production seam; the
owned HTTP and lower binary-chunk ports and adapters remain internal seams.

Implementation is split before code along independently green failure domains, amending the
historical single Attachment Runtime module slice without changing Rust ownership:

1. **A1 — projection cleanup and Rename vertical:** introduce the shared Rust-defined closed module
   interface, generated request/result contracts, and error foundation; retain the existing decrypted
   projection while removing its public `storageKey`; and route Rename alone through the unchanged
   existing PATCH endpoint. It owns the exact ambiguous-response authority probe, authoritative
   Attachments/Item fetch, guarded Replica commit, per-Item writer, and lifecycle tests, with no
   binary path. The common interface foundation travels here because it is the minimum needed to make
   this first public Rename path usable and testable through the Runtime seam.
2. **A2 — Delete vertical:** route Delete alone through the unchanged existing DELETE endpoint,
   reuse A1's interface, writer, lifecycle, probe, and reconciliation machinery, and prove that a lost
   response cannot report success until authoritative absence is fetched and committed to the
   Replica.
3. **B — atomic download vertical:** land the generated Runtime download request/result contract and
   production Web sink-capability registry and adapter, then add the authenticated source grant,
   encrypted binary read, decryption, atomic plaintext sink, parallel-read behavior, and complete
   cancellation/cleanup proofs. It reuses the existing binary executor policy and includes a focused
   browser proof through the production executor rather than only fake Core ports.
4. **C — foreground upload vertical:** land the generated Runtime upload request/result contract and
   production Web source-capability registry and adapter, then add the opaque plaintext source,
   format-preserving encryption, authenticated grant, digest and size enforcement, PUT, metadata
   creation, exact ambiguous-response probe, and authoritative reconciliation. It includes a focused
   browser proof through the production executor rather than only fake Core ports, and creates or
   retains no durable `Operation`.
5. **D — C4b2b authenticated real-Core browser acceptance:** only after A1 through C, use the
   production Worker, generated Runtime, authenticated Server ceremony, and production artifact and
   binary executors to prove exclusive startup sweep before preparation, restart and unlock
   reachability, actual production artifact/binary invocation, and more than five Move-preparation
   failures without durable discard.

Generated Kotlin and Swift request/result shapes may travel with B and C, but native production
capability-registry adapters remain owned by their later host slices. Deliberately left open after A1
through D: the final Web cutover and transitional-writer reachability audit, removal of
`idempotency_record`, native-host Share creation, and Ticket 30's held-SSE work. Ticket 28 remains
claimed.

### 2026-08-28 — Attachment Rename preserves the key-envelope version

A1 inspection found that the existing Rename handler increments `envelope_version` even though its
PATCH body carries no replacement `encrypted_attachment_key`. That creates unreadable authoritative
state: Runtime opens the retained encrypted Attachment key with `envelope_version` in its AAD, so an
increment without a matching rewrap makes the unchanged key envelope fail authentication. Keeping
the prior version only in the Replica would instead violate A1's authoritative-fetch and guarded-
commit contract.

The maintainer therefore confirmed that Rename keeps `envelope_version` unchanged. The existing
PATCH body remains exactly `encryptedName`, `encryptionIv`, and `encryptionAlgorithm`, and the Server
modifies only those three fields. `envelope_version` advances only in an authoritative transition
that also rewraps `encrypted_attachment_key` for the new version; Rename adds neither a fallback AAD
read nor a second request shape.

A1 acceptance is amended accordingly. A Server regression performs repeated Rename requests and
proves that the renamed ciphertext fields change while `envelope_version` and the Attachment key
envelope remain unchanged. The Runtime Rename proof then fetches that authoritative Attachment and
Item state, commits it through the existing guard, and proves the Attachment remains readable in the
unlocked projection after repeated Rename. All other A1 boundaries and later Attachment slices stay
unchanged.

### 2026-08-28 — A1 foreground Attachment Rename delivered

Commit `f4095156` delivers the first dedicated Attachment Runtime vertical. The public closed request
carries only Account ID, Attachment ID, and the bounded new name; results and errors use the recorded
closed vocabulary. Rust derives Item, Vault, uploader, envelope-version, and storage authority,
encrypts the name, sends the exact existing PATCH body, renews the Session at most once, and never
blindly resends an ambiguous mutation. Instead it probes authoritative Item and Attachment pages
within fixed cursor and aggregate bounds. Success requires the requested ciphertext plus the complete
original key and address authority; foreign, missing, malformed, drifted, or unproved authority fails
closed or returns the retryable result without publishing the requested effect.

The Server PATCH now preserves both `envelope_version` and the encrypted Attachment key, with a
repeated-Rename database regression for that invariant. Runtime publishes success only through one
foreground-specific, exact guarded Replica commit. Newer background authority wins that race, and
stale fetched or Replica authority cannot overwrite it. The unlocked Item projection retains the
decrypted Attachment name and content type while public `storageKey` is removed from Rust, generated
Runtime, Kotlin, Swift, and Web binding shapes. Native bindings keep the Rename plaintext behind an
opaque redacted input object, and neither the closed result nor error echoes it.

Rename uses the shared per-Item writer already used by existing Item Operations, including
`CreateShare`, and therefore serializes with those Item mutations. A2 Attachment Delete and C
foreground Upload are specified to reuse that writer; they are not implemented by A1. Existing
Runtime admission and teardown remain the authority owner, while
Account/incarnation-scoped tracking cancels and drains work for Lock, Sign-out, Remove, Wipe, and
Runtime close. The guarded Replica commit remains under teardown admission. Callback begin is
separately linearized against lifecycle retirement: lifecycle may win after the commit and suppress
an unbegun callback, while a begun callback owns its copied payload and does not block teardown.
Multiple fresh non-writer review and correction rounds exercised these races and the transport,
authority, writer, lifecycle, projection, and binding boundaries; the final review reported
**APPROVED**.

The orchestrator's Server database regression passes 1/1, `pnpm check:server` passes, and the full
`@bittery/client-runtime` check passes 426 Core tests, 43 binding tests, and 25 generator tests,
including contract, native, and Web drift checks; the WebAssembly run passes 7 tests with 1 skipped.
The dependent Turbo type checks and `git diff --check` also pass.

Deliberately left open: A2 Attachment Delete, B atomic download, C foreground upload, D authenticated
C4b2b browser acceptance, the final Web cutover and transitional-writer reachability audit, removal
of `idempotency_record`, native-host Share creation, and Ticket 30's held-SSE work. Ticket 28 remains
claimed.

### 2026-08-28 — A2 foreground Attachment Delete delivered

Commit `7b81a736` adds the non-durable foreground Delete request with only Account ID and Attachment
ID and a closed result. Rust sends the exact existing bodyless `DELETE /api/v1/attachments/{id}`
request. Only a 401 may renew the Session once and replay that exact request; a 200, 404, lost
response, or other ambiguous response never causes a blind mutation replay and never proves success
by itself.

Every such response requires a valid authoritative owning Item and a fully bounded, cursor-paginated
proof that the target Attachment is absent. Present or otherwise unproved Attachment authority is
retryable, while a missing owning Item is `AuthorityMissing`; in particular, DELETE 404 alone does
not establish success. The exact foreground guarded absence commit removes only the target
Attachment and preserves sibling and unrelated authority. Stale fetched or Replica authority cannot
manufacture a revision-only success, and newer background authority wins the guarded race.

Delete reuses A1's shared per-Item writer, optimistic-overlay exclusion, teardown admission,
Account/incarnation lifecycle cancellation and draining, and callback-begin fencing. Generated
native and Web request/result shapes remain closed and minimal, and diagnostic shapes preserve the
module's redaction boundary. The slice changes no Server route, Server schema, or generated Server
contract. Fresh non-writer review found corrections, then fresh re-review approved the corrected
slice.

The orchestrator's full `@bittery/client-runtime` check passes 447 Core tests, 44 binding tests, and
26 generator tests, including generated native and Web drift checks; the WebAssembly run passes 7
tests with 1 skipped. `pnpm check:server`, 14 dependent type checks, and `git diff --check` also pass.

Deliberately left open: B atomic download, C foreground upload, D authenticated C4b2b browser
acceptance, the final Web cutover and transitional-writer reachability audit, removal of
`idempotency_record`, native-host Share creation, and Ticket 30's held-SSE work. Ticket 28 remains
claimed.

### 2026-08-30 — B atomic Attachment Download delivered

Commit `3e6b28d5` adds the closed foreground Download request with only Account ID, Attachment ID,
and an opaque sink-capability ID. Rust derives the remaining Item, Vault, envelope, and storage
authority, obtains the authenticated source grant with at most one Session renewal, performs a
bounded two-pass exact-ciphertext read and format-preserving authenticated decryption, and transfers
plaintext only through the single-use capability. The production Web registry scopes that capability
to the Account, actual Runtime incarnation, and request; rejects replay, expiry, malformed or partial
buffers, and capacity overflow; and publishes the sink only after complete authenticated success.
Every failed, cancelled, or partial transfer discards provisional output and wipes owned plaintext.

Downloads release the Account execution fence during their long transfer and may run in parallel,
while the established teardown owner still controls admission and retirement. Lock, Sign-out,
Remove, Wipe, Runtime close, failed open, abandoned calls, callback races, timer failure, malformed
or duplicate reverse RPC, and Worker shutdown all cancel and drain unresolved scopes before key,
Account, or incarnation authority retires. Focused real-Chromium coverage exercises the production
Worker composition, registry, atomic sink, generated WebAssembly Runtime, failed-open cleanup,
Wipe/close, and fresh reconstruction rather than substituting fake Core ports. Native generated
shapes travel with the contract, while native production sink registries remain later-host work.

The orchestrator's full `@bittery/client-runtime` check passes 480 Core tests, 45 binding tests, and
27 generator tests, including generated native and Web drift checks; the WebAssembly run passes 9
tests with 1 audited skip. The complete TypeScript run passes 274 tests, all 7 Chromium tests pass
including the 3 production-sink tests, Crypto Core passes 138 tests plus 8 persisted-format vectors,
and all 14 dependent Turbo type checks pass. Biome passes for all 20 changed non-generated
JavaScript/TypeScript files, and `git diff --check` passes.

Deliberately left open: C foreground upload, D authenticated C4b2b browser acceptance, the final Web
cutover and transitional-writer reachability audit, removal of `idempotency_record`, native-host
Share creation, and Ticket 30's held-SSE work. Ticket 28 remains claimed.

### 2026-08-30 — C foreground Attachment Upload delivered

Commit `d96c7e40` adds foreground, non-durable `UploadAttachment` outside the accepted `Operation`
union. The generated closed Runtime, Kotlin, Swift, and WASM shapes carry only explicit Account and
Item identity, bounded plaintext metadata, declared size, and an opaque single-use source capability;
the host supplies no Runtime incarnation, and the closed result exposes only the new Attachment ID
and Replica revision.

The deep Rust Attachment module owns source claiming, key and uploader authority, format-preserving
streaming encryption, authenticated grant and metadata HTTP exchanges, exact plaintext/ciphertext
length and SHA-256 enforcement, at-most-once Session renewal, ambiguous-response probing, and the
single exact guarded Replica reconciliation that can publish success. It creates no durable
Operation. Owned plaintext is zeroized, while source and binary owners transfer failed or abandoned
cleanup into the lifecycle drain; Lock, Sign-out, Remove, Wipe, close, failed-open retirement, and
Account or incarnation retirement cannot complete before asynchronous source, OPFS, and binary
cleanup is proved complete. The production source registry closes replay, expiry, aggregate-capacity,
Account-retirement, and fresh-reconstruction behavior. The Server, OpenAPI, generated contract, and
Runtime now classify quota failure with the stable `ATTACHMENT_QUOTA_EXCEEDED` code rather than
Problem Details prose.

The joined production Chromium proof drives generated `UploadAttachment` through Web composition,
the Worker, source registry and reverse RPC, generated real WASM Core, controlled HTTP and storage
authority, and the production binary executor. It observes the grant, encrypted PUT, metadata
creation, exact guarded reconciliation, source cleanup, and closed result without substituting a
fake Core. Fresh final non-writer review reported **APPROVED**.

The orchestrator's independent gates pass 495 Core tests, 45 binding tests, 30 generator tests, 324
TypeScript tests, all 8 Chromium tests, 139 Crypto Core tests plus 9 persisted-format vectors, 89
Desktop Rust tests plus 50 Desktop Node tests, and all 14 dependent type tasks. The clean-tree root
`pnpm check:ci` and `pnpm check:ci:rust` gates, contracts, Biome, and `git diff --check` also pass.

C does not complete Ticket 28. D authenticated C4b2b browser acceptance and the ticket's later
cutover and cleanup work remain; Ticket 28 stays claimed.

### 2026-08-30 — D authenticated real-Core browser acceptance delivered

Commit `b2552167` completes the C4b2b acceptance path through the authenticated production Worker,
generated real WebAssembly Runtime, real SRP Full sign-in and password Quick unlock ceremonies, the
Server, and object storage. The focused cloud scenario accepts an Attachment-bearing Move, retains
one exact durable preparation through six real manifest failures, and proves that exceeding five
attempts cannot discard it. After Lock and Worker restart, Quick unlock resumes the same preparation.
The exclusive startup boundary sweeps deliberately seeded orphan chunks, artifacts, provisional
chunks, and provisional artifacts before the first exact resumed manifest request or any downstream
preparation work can begin.

The scenario invokes the actual production upload source, IndexedDB artifact executor, OPFS staging
spool, and binary executor. It observes source download, durable artifact publication, the hash-bound
staging upload, promotion into the one ready Operation record, exact Move dispatch, retained Server
outcome, local receipt, and authoritative Item plus Attachment convergence in the target Vault.
Production corrections completed both applied and rejected Move reconciliation with authoritative
Attachment state. They also made lookup, exact replay, Item authority, and paginated Attachment
authority share one outcome-resolution Session-renewal budget. A later-page renewal retries the exact
cursor request, while a second 401 or unrenewable lookup parks the Account for reauthentication,
publishes that transition idempotently, and preserves the Operation, optimistic authority, receipt
absence, and Sync cursor.

Fresh final non-writer review reported **APPROVED**. The orchestrator's independent gates pass 506
Core tests, 45 binding tests, 30 generator tests, all 8 Chromium tests, 139 Crypto Core tests plus 9
persisted-format vectors, 89 Desktop Rust tests plus 50 Desktop Node tests, and the targeted cloud
Playwright scenario 1/1 in 1.7 minutes. The clean-tree root `pnpm check:ci` and
`pnpm check:ci:rust` gates also pass.

D does not complete Ticket 28. Final Web cutover and the transitional-owner reachability audit,
`idempotency_record` removal, native host work, and Ticket 30's Runtime-owned live Sync remain open;
Ticket 28 stays claimed.

### 2026-08-30 — final Web Item and Import frontier resolved

The paused host-only cutover exposed a product-preservation gap. The current Rust external seam and
decrypted projection are Login-only, and ordinary existing-Item admission rejects every other
category. The reachable `use-vault-import` path still reads transitional Vault keys, creates Vaults
through `packages/core`, encrypts five-category plaintext in TypeScript, calls the Server's legacy
bulk-import writer directly, and repairs transitional caches afterward. Removing that path now would
drop existing Import behavior; completing the current host cutover around it would leave a second
writer and make the implementation Web-specific.

The maintainer confirmed that final Web Import preserves the existing product behavior and that Rust
Runtime owns both Vault creation and imported Item creation for Login, Secure Note, Credit Card,
Identity, and Authenticator. `totp` remains the existing Server wire spelling for Authenticator. The
deep shared module's external seam is the Rust-defined Runtime protocol and its platform-neutral
client facade. A React hook may retain file selection, provider parsing, localized preview, mapping,
progress, and summary state, but it owns no key, encryption, network, retry, outcome, Replica, or
cache-repair policy. Desktop and Extension eventually call the same client interface; Kotlin and
Swift receive the same generated closed values. No concrete Web registry or `apps/web` hook becomes
the reusable interface.

**Caller and route audit.** Production create-Vault reachability is not limited to Import. The Web
Vault route, Desktop Vault route, and Mobile create sheet all call the shared `useCreateVault` hook;
Web Import calls the same underlying `packages/core` service directly. The shared service mints the
Vault ID and key, optionally obtains an image upload, sends `PUT /api/v1/vaults/{vaultId}`, then
destroys its only plaintext key handle. The current PUT requires no `Idempotency-Key`, returns only
`{ vaultId }`, has no retained outcome, and can commit a Vault while a lost response leaves the
caller without its key authority. Its image-grant route also checks management access when given the
not-yet-created Vault ID, so pre-creation image handling must be covered by the cutover rather than
assumed to work. Extension has no create-Vault UI caller.

The PUT therefore cannot evolve underneath a reachable legacy caller. There is no parallel route or
compatibility response. Its one atomic cutover must open Runtime dispatch, replace both Web callers,
delete the transitional shared create writer, and make the incompatible Desktop and Mobile creation
affordances explicitly absent, as already done for Share creation. Their create UI returns only in
their later Runtime host slices, in delivery order. Extension remains unchanged because it exposes
no such affordance. This is an intentional temporary product boundary, not a silent broken button or
a native host implementation inside the Web slice.

**Five-category Item foundation.** Replace the Login-only draft and projection with one closed,
category-tagged Rust Item vocabulary covering the complete plaintext currently preserved by import
and edit, including Login TOTP, Password history, Passkeys, Custom fields and linked Item identity,
and the existing Secure Note, Credit Card, Identity and Authenticator fields. Generated Web, Kotlin,
and Swift shapes remain redacted at diagnostic/stringification seams. Bootstrap decryption and the
Items projection preserve the category and its exact data. Category tagging must not narrow away an
optional field that the current provider or Bittery export round trip preserves. Create and update
accept the matching category draft, while favorite, trash, restore, move, permanent delete, Share,
and Attachment authority stop imposing a Login-only admission guard. Existing ordinary Server Item
routes and their outcome kinds are already category-agnostic and need no new Server schema.

The reusable TypeScript client module derives the import Vault catalog from Runtime status and the
Account-scoped Items/Vault projections. That preserves mapping source Vaults to writable Vaults from
more than one unlocked Account without adding a second Rust Vault revision line or asking Web
storage. Active Account remains host UI state and is passed explicitly only when the user asks
Import to create a new target Vault.

**Vault creation is a durable `create_vault` Operation.** The closed Runtime request covers every
currently reachable Web input, not only Import: explicit Account, bounded trimmed name, personal or
shared Vault (`team` on the Server wire), icon, and an optional opaque image-source capability.
Import uses personal plus the existing default icon. Rust mints the stable Operation ID, final Vault
ID, and random Vault key, wraps that key under the live Master unlock key with the unchanged
version-1 Vault-key context, and builds one immutable intent. Its acceptance transaction commits the
intent together with a `PendingVaultCreation` optimistic effect that references the Operation and
reserves the Vault identity without duplicating key bytes or publishing authoritative or writable
Vault state. Plaintext key material is zeroized after that commit. No Web, Desktop, Mobile, React,
or source adapter supplies an ID, key, encrypted key, image key, request fingerprint, retry count,
or Runtime incarnation.

**A Vault image becomes Runtime-owned before acceptance.** The host grants one opaque, single-use
source through the shared client facade, not through an `apps/web` hook or a caller-visible registry.
Its closed grant declares Account, exact raw byte length, and bounded content type. Runtime claims it
for the prepared Operation ID and accepts exactly `image/jpeg`, `image/png`, `image/webp`,
`image/gif`, or `image/avif`, with no parameters or aliases, and 1 through 2,097,152 raw bytes,
adopting the product's existing 2 MiB native image limit as the shared contract. Reads are at most
256 KiB. Runtime requires exact EOF at the declared length and computes lowercase SHA-256 over the
exact raw bytes while copying them; it accepts no host-supplied digest. A short, long, replayed,
expired, wrong-Account, or wrong-content-type source fails before acceptance.

The copy is atomically published by a new **Vault-image artifact port** under
`(Account ID, Operation ID)`, with Vault ID, byte length, canonical content type, and raw-byte digest
as immutable metadata. It holds the original image bytes because those exact plaintext bytes are
what object storage receives. The existing Attachment artifact store holds format-preserving
Attachment ciphertext and is scoped by Attachment identity, ciphertext digest, and Move publication
proof; that interface does not fit and is not reused or renamed. Its chunking, atomic-publication,
exclusive-startup-sweep, and idempotent-deletion patterns are evidence for the new port, whose Web
adapter is IndexedDB and whose native conformance adapter is SQLite. The shared client facade reuses
and deepens the Attachment upload source-registry invariants rather than exposing another Web-owned
registry. Every claim binds the grant to the actual Runtime incarnation, Account, prepared Operation, and
exact closed request. One inclusive capacity of 1,024 identities counts live entries, expiry/replay
tombstones, retained Account states, and the active/pending/retired Runtime-incarnation state; at
most 1,024 source operations may be in flight, and a grant expires within at most one hour. Exact
replay and expiry remain fail-closed. Failed cleanup retries, while failed-open recovery drains the
old registry before constructing one fresh bounded registry. The Vault-image scope remains distinct
from Attachment-specific `itemId`, name, and ciphertext policy.

Artifact publication completes before the Replica acceptance transaction. These two different
stores are deliberately not described as one cross-store atomic commit: acceptance first verifies
the exact published artifact and then durably references it. Failure or cancellation before
acceptance drains and closes the source, leaves no Operation or optimistic effect, and idempotently
deletes every partial artifact. Lock, Sign-out, Remove, Wipe, Runtime close, failed-open cleanup,
Account retirement, and Runtime-incarnation retirement must cancel and drain source work and
complete or durably retain that deletion before the relevant authority retires. Acceptance shares
the same fence and cannot race any retirement. A crash after artifact publication but before
acceptance can therefore leave only a bounded local orphan, never an Operation without bytes; the
exclusive startup sweep removes it before accepting or resuming Account work. Runtime-owned and
transferred plaintext buffers are zeroized after copy or on every failure. The original host
`File`, `Blob`, provider backing, browser structured-clone source, and other memory the Runtime never
owned are outside that promise. Artifact cleanup logically deletes its metadata and chunks; neither
browser nor SQLite adapters promise physical media overwrite.

Acceptance freezes the artifact reference and one stable image request identity over Account,
Operation, Vault, raw-byte digest, length, and content type. The Server-facing canonical object key
is exactly `vaults/{userId}/{vaultId}/create/{operationId}-{lowercaseSha256}` after canonical
resource-ID validation and has no random filename component, so every retry names the same object
while the Server still binds it to the authenticated User. Accepted work never reads the host
capability again. Cancellation after acceptance, including before the first dispatch, detaches only
that caller's wait; it neither deletes nor rewrites the Operation, artifact, or staging identity.

**Remote image staging follows acceptance and precedes the final Vault request.** Runtime persists
closed checkpoints for `artifact_ready`, `remote_upload_confirmed`, and `final_request_frozen`.
Grant URLs and transport attempts are never checkpoints. It obtains or renews a grant for the exact
accepted identity, uploads the durable artifact with content length and payload SHA-256 bound by the
grant, and asks the Server to confirm the exact object length, digest, and content type. A lost grant
or upload response is resolved by that confirmation; absence or mismatch restarts the same-key
upload rather than changing the intent. Only an exact confirmation lets Runtime durably freeze the
final immutable Vault PUT body containing that image key. Only that body may be dispatched, and no
`create_vault` outcome can be retained before it. The image-free path freezes its final body at
acceptance.

The Server staging schema is keyed by `(User, Operation)` and stores the bound Vault ID, canonical
object key, digest, length, content type, state, and rolling 24-hour cleanup lease. Exact status,
grant, or confirmation access renews that lease; upload traffic alone and cleanup do not. Each User
may have at most 64 outstanding bindings and 128 MiB of declared raw image bytes across them. An
exact idempotent replay returns the existing binding and renews its lease without consuming another
slot or byte; a changed binding is `OPERATION_ID_REUSED`, never a second object or another quota
claim. New over-quota bindings fail before object access and retain no semantic Operation outcome.
Status, grant, confirmation, and cleanup exchanges remain idempotent. The existing image-grant route
evolves in the atomic cutover so a not-yet-created Vault is
admitted only under this staging identity; an existing Vault still requires management access. The
create executor accepts only the exact confirmed row and key for its Operation. Object-store or
confirmation failures are infrastructure failures and leave the accepted local Operation owed.
Each dispatch/recovery cycle shares one at-most-once Session renewal across image status/grant,
upload confirmation, final PUT, outcome lookup, exact replay, and authoritative Vault/key fetches.

The Server adds `create_vault` to the one retained `OperationOutcome` union. An applied result is
exactly `{ vaultId }`. Its closed semantic rejection set is `vault_id_conflict`,
`team_membership_required`, `vault_sharing_entitlement_denied`, and
`shared_vault_limit_reached`. Invalid name, type, encrypted-key shape, image-key binding, oversized
input, absent authentication, and malformed transport fail before Domain execution and retain no
outcome; database, object-storage, and other infrastructure failures roll back without one. Missing
or corrupt team billing authority is infrastructure, not a fabricated membership rejection.

`Idempotency-Key` is the stable Operation ID. The Server fingerprints kind, canonical Vault path,
and exact immutable body, locks `(user, operation)`, and in one transaction either replays the exact
retained answer or commits Vault, owner Vault key, audit, `vault_created`, outcome, and
`operation_resolved`. A different fingerprint returns `OPERATION_ID_REUSED`; a different Operation
claiming the same final Vault ID gets retained `vault_id_conflict`. The applied validator requires
the accepted kind, Operation ID, and Vault ID, and lookup is only a hint until an identical PUT
replay proves the fingerprint. It then fetches bounded authoritative Vault and Vault-key state and
requires the accepted name, type, icon, owner role, exact wrapped key, and image absence/presence;
the replayed fingerprint proves the exact bound image key. Anything missing or mismatched preserves
the Operation and its retry obligation. Every semantic rejection commits its rejection audit,
retained outcome, and `operation_resolved` atomically without Vault or Vault-key writes.

One guarded Replica transaction installs that exact `AuthorityVaultRecord`, a compact create-Vault
receipt, and removes the Operation and `PendingVaultCreation`. A rejection records the closed receipt
and removes the Operation and optimistic effect without publishing Vault or key authority. The
accepted immutable request is the only durable local copy of the wrapped new key before success;
rejection and Device Account removal erase it, while applied reconciliation replaces it with the
authoritative wrapped-key record. Outcome reconciliation also atomically creates any still-required
artifact/remote cleanup obligation before removing the Operation; cleanup may outlive semantic
completion but remains durable Runtime work. Applied cleanup deletes only the local plaintext
artifact because the authoritative Vault now references the remote object. Rejected cleanup deletes
the local artifact and requests deletion of the staging object; the Server rejection transaction
also marks that staging row `cleanup_pending`, so a lost client cleanup cannot strand it.

Lock fences readers and zeroizes transient buffers but retains the accepted Operation, artifact, and
checkpoints for later resumption. Restart, caller unmount, response loss, Sign-out, and more than five
transport failures also preserve them; Sign-out removes Session/key authority and parks Server work
until a later Full sign-in; retained artifact bytes are never projected or reopened to the host.
Sign-out therefore does not turn a UI lifecycle event into Operation discard. The explicit
`RemoveAccount` and `Wipe` teardown authorities from ticket 48 are different: after fencing work they
destroy the selected accepted Operations, image artifacts, checkpoints, and cleanup records under
their existing idempotent `complete | incomplete` contract. They make a best-effort bound
remote-cleanup request while usable authority remains, but local teardown completion does not depend
on the network; the Server lease sweep owns the resulting remote orphan.

At Account startup, the local sweep compares every published or partial Vault-image generation with
live Operations and cleanup records, deletes abandoned pre-accept and completed-work artifacts, and
retains exact live ones. On the Server, expired unconfirmed or `cleanup_pending` staging rows are
swept with idempotent object deletion. A lease may expire while an accepted Operation is offline;
because the local artifact is authoritative and the object key stable, resumption recreates the same
binding and reuploads if needed. An applied row is consumed by the Vault transaction and is never
swept as an orphan. Missing rows and already-deleted chunks/objects are successful cleanup states,
while partial adapter failures persist the obligation and retry with bounded backoff.

Each dispatch/recovery cycle has one shared at-most-once Session-renewal budget across the exact PUT,
outcome lookup, exact replay, Vault fetch, and paginated Vault-key fetch, extended by the image
exchanges above when present. A second 401 or failed renewal parks the Account for reauthentication
without completing or deleting the Operation. The number of cycles remains unbounded with persisted
bounded backoff. Tests must cover response loss before and after commit, exact duplicate and
changed-fingerprint replay, restart before dispatch and between staging/outcome/fetch/commit, Lock,
Sign-out, Account-removal, and Wipe races, one renewal at every request position, more than five
grant/upload/confirmation/final-request failures, every rejection, exact key wrapping and transient
zeroization, local and remote orphan recovery, cleanup failure at every primitive, and a stale
guarded commit.

**Each import batch is one durable `import_items` Operation.** The existing observable batch boundary
is retained: at most 200 Items in one target Vault are all applied or all rejected, earlier successful
batches survive a later batch failure, favorite values and every category are preserved, and summary
counts advance only after authoritative completion. Rust generates every final Item ID, encrypts
every closed draft, and atomically accepts one immutable ordered batch plus its local import-progress
effect. The host request waits for the terminal result, but caller cancellation only stops that wait.
Accepted encrypted bytes survive unmount, restart, more than five transport failures, and response
loss. Pending or rejected work never masquerades as imported Items.

The current `POST /api/v1/vaults/{vaultId}/item-imports` evolves in place. It requires
`Idempotency-Key`, fingerprints the exact ordered body and canonical Vault path, and commits the
complete Item set, existing bulk audit and `vault_updated`, retained outcome, and
`operation_resolved` in one transaction. The closed applied payload is `{ vaultId, importedCount }`;
the rejection set is `invalid_ciphertext`, `vault_access_denied`, `vault_read_only`, and
`item_id_conflict`. Malformed, oversized, or duplicate-ID input is rejected before Domain execution
and retains no outcome. Lookup cannot complete the local Operation until identical POST replay proves
the fingerprint. Reconciliation requires `importedCount` to equal the accepted ordered length, then
fetches all accepted Items within the existing 200-Item/16-MiB bounds and matches every ID, Vault,
category, favorite flag, ciphertext field, and version 1 before one guarded commit installs their
authority, the compact batch receipt, and removes the Operation and progress record.

Import dispatch, lookup, exact replay, and every authoritative Item page share one at-most-once
Session-renewal budget per recovery cycle. A second 401 parks the Account without advancing import
progress, removing accepted bytes, or producing a failed-Vault summary. Every semantic rejection
commits a rejection audit, retained outcome, and `operation_resolved` atomically without Item or
`vault_updated` effects.

An empty accepted batch retains the existing successful zero-item semantics. For an authenticated,
writable target it resolves applied with `{ vaultId, importedCount: 0 }`; it inserts no Item and
emits no bulk audit or `vault_updated` event. Only the retained outcome and `operation_resolved`
record the Operation decision. Reconciliation performs no Item fetch and advances counts by zero.
An inaccessible or read-only target still receives the corresponding retained semantic rejection,
matching the current access check before the empty-list return.

The route and Item-category enum already exist, but the durable batch and create-Vault facts do not.
Both need new Server `operation_kind` values, closed outcome variants and database constraints,
generated OpenAPI/Runtime contracts, non-Item Operation/receipt addresses, and shared Replica
conformance histories. The old responses are not sufficient evidence and cannot survive as parallel
production contracts.

The smallest sequential, independently verifiable continuation is:

1. **[E1 — five-category Runtime Item interface](49-five-category-runtime-item-interface.md):** land closed drafts/projections and widen every
   existing ordinary Item path through dispatch, outcome validation, reconciliation, bindings, and
   the shared client interface. Full fixtures cover all five categories and prove no plaintext
   persistence or diagnostic leakage. Import and Vault Server routes remain unchanged.
2. **[E2 — create-Vault outcome foundation](50-create-vault-outcome-foundation.md):** add the migration, `create_vault` outcome/rejections,
   exact applied-payload constraints, lookup union, OpenAPI/generated shapes, and consumer handling
   without changing the reachable PUT or accepting production Runtime work. No second writer exists.
3. **[E3 — durable local Vault-image ingress](51-vault-image-local-ingress.md):** define the Vault-image artifact and source-control
   ports, generated control contracts, atomic publication, raw-byte bounds/digest, local cleanup and
   startup sweep. Land IndexedDB, SQLite, and in-memory conformance histories without creating or
   dispatching a Vault Operation. Prove every write/delete failure, crash boundary, Account scope,
   cancellation, teardown, replay, zeroization, and the fact that Attachment ciphertext artifacts
   cannot satisfy this port.
4. **[E4 — Server Vault-image staging foundation](52-vault-image-server-staging.md):** add the Operation-bound staging schema and the
   idempotent status/grant, confirmation, cleanup, and lease-sweep Domain machinery with
   deterministic object identity, exact length/digest/content-type enforcement, and object-store
   failure tests. Keep it behind a test transport: the public image-grant route, legacy create PUT,
   OpenAPI, and all reachable callers remain unchanged, and no Runtime production dispatcher can
   use the staging exchanges yet.
5. **[E5 — durable Runtime create-Vault lifecycle behind the gate](53-runtime-create-vault-lifecycle.md):** add stable ID/key/intent
   generation, optional pre-accept artifact preparation, atomic Operation acceptance, resumable
   post-accept staging checkpoints, final-request freezing, persisted unbounded scheduling, exact
   replay and validator, authoritative Vault/key reconciliation, durable cleanup obligations,
   receipts, generated bindings, and the shared derived multi-Account catalog while production
   dispatch stays closed. In-memory and adapter histories prove loss, restart, Lock/Sign-out/
   removal/Wipe, renewal sharing, more than five failures at every stage, all rejections, key
   destruction, and local/remote orphan convergence.
6. **[E6 — atomic create-Vault Server/Web cutover](54-create-vault-atomic-cutover.md):** in one commit replace the PUT with its Operation
   executor, require the exact confirmed staging row, open production dispatch, route both the Web
   Vault dialog and Import's create-target branch through the shared Runtime client, and remove the
   transitional shared create writer and refresh/cache repair. Make Desktop and Mobile create
   affordances explicitly absent until their host slices; Extension has no caller. An executable
   whole-repository entry graph begins at every Web, Desktop, Mobile, Extension, and shared-package
   production entry and proves the legacy create-Vault writer unreachable in the same atomic
   change. Actual Web acceptance covers personal, team, image, Import-default creation, pre-accept cancellation,
   response loss, restart after every staging checkpoint, more than five upload failures, rejection
   cleanup, Sign-out recovery, and Remove/Wipe orphan handling.
7. **[E7 — Import outcome foundation](55-import-outcome-foundation.md):** add the migration, closed `import_items` outcome and lookup
   generation support while the one reachable import route retains its legacy contract. Existing
   consumers handle the new kind explicitly; no second import writer is created.
8. **[E8 — durable Runtime import batch behind the gate](56-runtime-import-batch.md):** add atomic acceptance, persisted unbounded
   retry, exact replay, tagged validation, bounded authoritative fetch, and guarded reconciliation
   with production dispatch closed. Shared histories cover empty zero, restart, more than five
   failures, duplicate send, dropped response, every rejection, all categories, and favorite.
9. **[E9 — atomic Import route and Web cutover](57-import-atomic-cutover.md):** switch the one route to its Operation executor,
   open dispatch, and make `use-vault-import` a shallow presentation adapter in the same commit.
   Preserve provider parsing, localization, empty-Source-Vault filtering, create/existing and
   multi-Account mapping, 200-Item batching, progress, partial-across-batches behavior, warnings,
   failed-Vault summaries, and final counts. Remove transitional storage, direct HTTP, crypto,
   invalidation, and cache-refresh reachability. An executable whole-repository entry graph begins
   at every Web, Desktop, Mobile, Extension, and shared-package production entry and proves no
   legacy Import read or writer survives the same atomic change. Browser acceptance covers all five categories and a
   favorite in newly created and existing Vaults, empty zero, response loss, and later-batch
   rejection.
10. **[E10 — resume the paused final Web host cutover](58-final-web-host-cutover.md):** only after E1 through E9 are reviewed and
   green, reconcile the preserved dirty host files, finish remaining mutation/lifecycle consumers,
   and tighten the whole-entry graph so `item-write` and the Import writer/read holdout are forbidden.

These slices amend the earlier assumptions that the final cutover was host-only and Vault creation
could be foreground. Ticket 28 remains claimed. Rotation outcome conversion and final
`idempotency_record` deletion remain Ticket 29; Ticket 30's held-SSE ownership and the later Desktop,
Extension, Android Compose, and iOS SwiftUI production host cutovers remain outside this frontier.
