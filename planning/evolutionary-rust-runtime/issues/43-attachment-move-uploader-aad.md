# Preserve Attachment uploader AAD through Move preparation

Type: task
Status: claimed
Blocked by: 24
Spec: ../spec.md#replica-contract

## Outcome

Attachment Move preparation authenticates and reseals a shared Attachment with the durable
`uploaded_by` identity that the Server preserves, so another authorised User can move the Item
without making the blob or encrypted metadata unreadable.

## Problem

Ticket 28's C4a review exercised production secret resolution with a shared Attachment and found a
cross-slice defect. The committed C2 worker constructs both source and target blob AAD with the User
performing the Move. Existing Attachment reads instead use the Attachment's durable `uploaded_by`,
and Server Move finalization deliberately preserves that column. A Move by another authorised User
therefore cannot authenticate the source blob and would produce target ciphertext that later reads
cannot authenticate.

The same review found a C4a-local companion defect: Server finalization increments the Attachment
envelope version, so the target-wrapped Attachment key must bind the retained uploader and version
`N + 1`, not the mover and source version `N`. C4a owns that correction in its existing paths; this
ticket owns only the already-committed C2 dependency blocker.

## Work

- In C2's Attachment Move preparation path, derive both source and target blob AAD from the exact
  accepted source Attachment `uploaded_by` identity rather than from the current Runtime User.
- Preserve the existing Account, Operation, Attachment, source/target Vault, two-pass, artifact,
  retry, and checkpoint semantics. Do not change persisted crypto formats or algorithms.
- Add a fixed behavioral vector where the mover and original uploader differ. Prove source
  authentication succeeds, target ciphertext opens only with the retained uploader scope, and the
  mover scope is rejected.
- Leave C4a facade, scheduler, lifecycle, metadata, Server, and browser-composition paths untouched.

## Verification

The focused C2 shared-uploader test fails before the fix and passes afterwards. Existing C1/C2
format, corruption, retry, restart, artifact-publication, and target-scope tests remain green, as do
the Client Core Rust checks and `git diff --check`.

## Comments

### 2026-08-26 — filed and claimed from Ticket 28 C4a review

Independent review classified this as a product defect in the committed C2 dependency, not a C4a
fixture choice. It is split into this ticket so the C2 implementation remains independently reviewed
and committed before C4a consumes the corrected invariant. No maintainer decision is open: current
read behavior and Server finalization already make `uploaded_by` the durable AAD identity.

### 2026-08-26 — shared-uploader blob scope delivered

C2 now derives the source blob scope, target blob scope, and authenticated publication identity from
the exact accepted source Attachment `uploaded_by`. A behavioral shared-Vault vector uses a different
mover, authenticates the source, opens the target only under the retained uploader, and rejects the
mover scope. Independent review confirmed the old mover-bound scope was a product defect rather than
a fixture mismatch and found no retry, persistence, scope, ordering, or format regression.

Deliberately left open: C4a still owns target encrypted-metadata AAD and the Server-incremented target
envelope version. Browser composition and host reachability remain C4b. This ticket remains claimed
until its required clean-tree CI and Rust gates run after the paused, path-disjoint C4a work closes.
