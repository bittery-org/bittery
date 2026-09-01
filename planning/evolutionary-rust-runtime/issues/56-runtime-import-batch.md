# Add the durable Runtime Import batch behind the gate

Type: task
Status: resolved
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

## Comments

### 2026-09-01 — ready for agent

Ticket 55 is resolved in commit `c14aa81eeea87b9bad8e7cf86ee345cf08fb41c2` with independent final
standards and specification approval. It was this ticket's sole declared dependency, and the parent
Ticket 28 E7–E10 frontier is decision-complete. The existing `ready-for-agent` status is therefore
fully unblocked: this slice may add durable Runtime Import batch acceptance and reconciliation while
keeping production Import dispatch closed and leaving the legacy Server route and Web writer
unchanged.

### 2026-09-01 — resolved

Commit `5dbbeec8cb806a56c83b053f34445966486ccbb4` delivers the durable Runtime Import batch behind
its gate across 22 files, 7,247 insertions, and 116 deletions. Rust mints every Item ID, encrypts
every draft, preserves favorite, freezes one ordered immutable request, and atomically accepts it.
Persisted unbounded retry with bounded exponential backoff, one-renewal recovery, exact POST replay,
tagged outcome validation, and bounded authoritative fetch and reconciliation follow, after which one
guarded commit installs authority, writes the compact receipt, and removes the Operation. Applied
zero keeps its exact semantics, and inaccessible or read-only Vaults keep their semantic rejection.
Six standards review cycles and two specification review cycles; the final cycle on each axis ended
in fresh-reviewer approval.

Gate status: production Import transport stays unreachable until Ticket 57. `runtime/dispatch.rs`
still skips `OperationKind::ImportItems` in the scheduling loop, and `runtime/import_executor.rs`
still carries `#[allow(dead_code)]`. Acceptance itself is production-reachable by design:
`RuntimeRequest::ImportItems` durably accepts a batch today. No host calls it yet, so no accepted
Import Operation can strand in production — `apps/web/src/hooks/use-vault-import.ts` still writes
through the legacy `vaultApiClient.vaults.importItems` route until Ticket 57 cuts it over.

Green evidence: `bittery-client-core` 614 library tests, 26 of them in `runtime::import_tests`, plus
5, 3, and 5 integration tests, with 0 failed; `clippy -D warnings` clean; `fmt` clean; every
generated-contract `--check` runner clean, covering runtime protocol, Server, persistence, the
replica-conformance corpus, the native Kotlin and Swift bindings, and the Web bindings; the
client-runtime Bun suite at 360 passing; `client.test.ts` at 16 passing; `pnpm check:ci:rust`
passing; and `git diff --check` clean.

Honest caveat: root `pnpm check:ci` was **not** run to completion for this ticket. It is expected to
stop at the preserved uncommitted Ticket 58 Web overlap in Biome and type-checking, as recorded in
the [2026-09-01 handoff](../handoff-2026-09-01.md). No clean root CI pass is claimed here; that claim
waits for Ticket 58.

This slice also recorded a pre-existing conformance generator defect in
[Ticket 59](59-bootstrap-write-order-nondeterminism.md), and handed three open wiring questions to
[Ticket 57](57-import-atomic-cutover.md).

### 2026-09-01 — interpretation: the local progress effect

Ticket 56 Work asks acceptance to be atomic "with a local progress effect" and reconciliation to
remove "the Operation and progress record". This slice implements that as one record, not two: the
accepted Import Operation *is* the progress effect. While the Operation exists the batch is in
flight; the guarded reconciliation commit removes it and writes the compact receipt atomically, so
progress can never outlive, duplicate, or contradict the semantic outcome.

No second durable progress row exists, deliberately. It would be derived state with an independent
way of going stale, and Import has no optimistic projection to attach it to: Rust mints every Item ID
at acceptance, but nothing may show an imported Item before authority confirms it, so acceptance
writes no overlay the way an ordinary create does. A host renders progress by observing the
Operation; Ticket 57 assigns that display to the Web Import hook. Note that no host-observable
pending-Operation projection exists today — `RuntimeProjection` has no Operation variant — so Ticket
57 must deliver that surface, not merely style it. The shared conformance history
`import-batch-acceptance-and-zero-reconciliation-are-atomic` pins both halves of the atomicity.
