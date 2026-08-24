# Remaining Item write kinds through the Runtime

Type: task
Status: ready-for-agent
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
