# Make prepared Bootstrap writes deterministic

Type: task
Status: needs-info
Spec: ../spec.md#shared-replica-conformance

## Outcome

The shared conformance corpus generator emits the same bytes on every run for any plan, including a
plan that installs more than one Bootstrap Item, so shared histories may exercise realistic
multi-Item batches instead of avoiding them.

## Problem

`bootstrap_write_diff` in
`packages/client-runtime/crates/bittery-client-core/src/replica/persistence_contract.rs` builds its
rows through `bootstrap_rows`, which iterates the Bootstrap `HashMap` collections unsorted. A plan
that installs several Items at once therefore emits its prepared-write rows in hash order, and two
generator runs of the same plan can produce different `history-corpus.json` bytes. The corpus is a
checked-in generated artifact with a `--check` runner, so that difference would read as spurious
drift.

This is pre-existing and predates Ticket 56; it is not an Import defect. Ticket 56 found it while
writing shared Import histories.

Current mitigation: every shared Import history carries exactly one Item per batch. A comment at
`replica_conformance.rs::import_operation` names the cause so the constraint is not mistaken for an
Import limit. The mitigation costs coverage — no shared history proves multi-Item prepared-write
behavior.

No committed history is affected today. Verified during Ticket 56: the largest step emits 4 prepared
writes, each into a different store, and 5 or more consecutive `--check` runs produced identical
bytes.

## Decision frontier

Before implementation, ask the maintainer in German whether deterministic prepared-write order
becomes part of the shared Replica persistence contract that adapters and conformance may rely on,
or stays a generator-local reproducibility property.

Recommend the contract answer: sort prepared writes by store and then by key inside
`persistence_contract`, and state in the contract that a prepared commit's write order is
deterministic but semantically irrelevant, because the adapter applies the whole plan atomically.
The alternative — sorting only in the generator — leaves the real ordering nondeterministic for every
other consumer and would hide the same defect again.

Ticket 38 owns physical Replica evolution; confirm with the maintainer whether this ordering promise
belongs there instead, and schedule this ticket accordingly.

## Work

- Sort the prepared writes produced by `bootstrap_write_diff` deterministically, in the direction the
  decision selects.
- Remove the one-Item-per-batch constraint on shared Import histories and the comment that explains
  it, and add at least one shared history whose plan installs several Items in one step.
- Leave Operation, receipt, outcome, and authority semantics unchanged. Prepared-write order carries
  no meaning; only its stability changes.

## Verification

- Start with a failing test that generates the same multi-Item plan twice and asserts byte-identical
  prepared writes.
- Regenerate the corpus and prove repeated `--check` runs stay clean, and that no existing history's
  bytes change beyond the intended reordering.
- Run focused Core and conformance tests, the generated-contract `--check` runners,
  `pnpm check:ci:rust`, and `git diff --check`.

## Comments

### 2026-09-01 — filed from Ticket 56

Recorded while closing [Ticket 56](56-runtime-import-batch.md). The defect blocked nothing there:
one Item per Import batch kept the corpus reproducible and still proved every required Import
history. Filed as `needs-info` rather than `ready-for-agent` because an implementer would otherwise
have to invent the contract answer above — whether adapters may rely on prepared-write order — which
is an architecture decision, not an implementation detail.
