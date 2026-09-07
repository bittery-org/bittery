# Add the durable Runtime Import batch behind the gate

Type: task
Status: resolved
Blocked by: 55
Parent: [28 — finalized E1–E10 frontier](28-remaining-item-write-kinds.md#final-web-item-and-import-frontier)

## Delivered

Delivered in `5dbbeec8`. The contract below records this foundation's scope; later cutovers
are tracked separately.

Acceptance is public, but production dispatch still skips `ImportItems`. The Web importer has not
switched to it. [Ticket 57](57-import-atomic-cutover.md) owns that cutover.

Recorded validation: focused checks and `pnpm check:ci:rust` passed. A clean root `pnpm check:ci`
pass was not established at delivery; final integration verification remains ticket 58's gate.

## Contract

- Add a closed Account/Vault-scoped request carrying at most 200 category drafts. Rust generates
  every Item ID, encrypts every draft, preserves favorite, freezes one ordered immutable request,
  and atomically accepts it with the Operation as its local progress record, without an optimistic
  Item overlay.
- Implement persisted unbounded retry, one-renewal recovery cycles, exact POST replay, tagged outcome
  validation, and bounded authoritative Item fetch/reconciliation within 200 Items and 16 MiB.
- Require exact ID, Vault, category, favorite, ciphertext fields, and version 1 before one guarded
  commit installs authority, records the compact receipt, advances progress, and removes the
  Operation.
- Preserve applied zero semantics: an accessible writable Vault produces `{ importedCount: 0 }`, no
  Item fetch, no optimistic Item, and zero progress; inaccessible/read-only Vaults retain their
  semantic rejection. Keep production transport eligibility closed.

## Verification

- Start with failing shared histories for all five categories, favorite, ordered 200-item bounds,
  duplicate IDs, empty zero, every rejection, offline acceptance, restart, more than five failures,
  duplicate send, dropped response, exact/changed replay, paginated/bounded authoritative fetch,
  second-401 parking, and stale guarded commit.
- Prove caller cancellation only detaches waiting, rejected/pending batches never project imported
  Items, earlier independent batch receipts remain intact, and production dispatch is unreachable.
- Run focused Core/binding/conformance/generator/client tests, affected type checks,
  `pnpm check:ci`, `pnpm check:ci:rust`, and `git diff --check`.

## Progress

The accepted Operation is the only durable progress record. Reconciliation removes it and writes
the receipt atomically. Pending or rejected batches publish no imported Items. Ticket 57 must add
the Account-scoped Operations projection used by the host. Shared histories currently use one Item
per batch to avoid the nondeterminism tracked by [ticket 59](59-bootstrap-write-order-nondeterminism.md).
