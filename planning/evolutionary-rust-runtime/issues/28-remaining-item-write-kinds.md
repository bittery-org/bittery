# Remaining Item write kinds through the Runtime

Type: task
Status: needs-info
Blocked by: 22, 24
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

## Frontier — why this is `needs-info`

Ticket 24 owns the Server side and is itself a maintainer frontier: eleven legacy response-cache call
sites remain, and the cross-kind semantic outcome and rejection contract is undecided. `createItem`
has a retained semantic outcome; update and delete still run through the old idempotency table.

Resolve that contract before implementing. The specific questions:

- Does every write kind retain a User-lifetime semantic outcome the way `createItem` does, or do
  idempotent-by-nature kinds (favorite, move) get a cheaper contract?
- What is the rejection vocabulary across kinds? `CreateItemRejectionCode` is create-shaped; a stale
  version on update and a missing Item on delete are different failures.
- Does an update carry a concurrency precondition in the request fingerprint? `create_item_fingerprint`
  hashes an empty precondition today, and the Server hashes normalized preconditions in the same slot.
- Is delete a tombstone Operation with an authoritative fetch, or does reconciliation need a different
  plan shape than "fetch the authoritative entity, then commit"?

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
