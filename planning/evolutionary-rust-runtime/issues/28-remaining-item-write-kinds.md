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
