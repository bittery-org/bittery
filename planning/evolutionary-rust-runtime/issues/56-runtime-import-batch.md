# Add the durable Runtime Import batch behind the gate

Type: task
Status: ready-for-agent
Blocked by: 55
Parent: [28 — finalized E1–E10 frontier](28-remaining-item-write-kinds.md#2026-08-30--final-web-item-and-import-frontier-resolved)

## Outcome

Runtime can durably accept and reconcile one ordered, all-or-nothing Import batch of at most 200
five-category Items, including an applied empty batch, while production Import dispatch remains
closed and the legacy Web writer stays unchanged.

## Work

- Add a closed Account/Vault-scoped request carrying at most 200 category drafts. Rust generates
  every Item ID, encrypts every draft, preserves favorite, freezes one ordered immutable request,
  and atomically accepts it with a local progress effect.
- Implement persisted unbounded retry, one-renewal recovery cycles, exact POST replay, tagged outcome
  validation, and bounded authoritative Item fetch/reconciliation within 200 Items and 16 MiB.
- Require exact ID, Vault, category, favorite, ciphertext fields, and version 1 before one guarded
  commit installs authority, records the compact receipt, advances progress, and removes the
  Operation.
- Preserve applied zero semantics: an accessible writable Vault produces `{ importedCount: 0 }`, no
  Item fetch, no optimistic Item, and zero progress; inaccessible/read-only Vaults retain their
  semantic rejection. Keep production transport eligibility closed.

## Path ownership and failure domain

This slice owns Import Operation/Replica/scheduler/reconciliation policy in
`packages/client-runtime/crates/bittery-client-core`, shallow generated binding/protocol values,
shared conformance histories, and the platform-neutral client facade. It owns batch encryption,
durability, retry, validation, and guarded-commit failures. It must not edit the Server Import
handler/public contract, Web Import hook/dialog, provider adapters, transitional storage/HTTP, or
production dispatch composition.

## Verification

- Start with failing shared histories for all five categories, favorite, ordered 200-item bounds,
  duplicate IDs, empty zero, every rejection, offline acceptance, restart, more than five failures,
  duplicate send, dropped response, exact/changed replay, paginated/bounded authoritative fetch,
  second-401 parking, and stale guarded commit.
- Prove caller cancellation only detaches waiting, rejected/pending batches never project imported
  Items, earlier independent batch receipts remain intact, and production dispatch is unreachable.
- Run focused Core/binding/conformance/generator/client tests, affected type checks,
  `pnpm check:ci`, `pnpm check:ci:rust`, and `git diff --check`.
