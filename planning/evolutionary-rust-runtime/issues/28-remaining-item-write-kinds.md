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
