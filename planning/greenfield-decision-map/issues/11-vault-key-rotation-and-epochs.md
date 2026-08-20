# Vault key rotation and epochs

Type: grilling
Status: ready-for-human
Blocked by: 08

## Question

Rotation is load-bearing across departure, Recovery-Key revocation, and Attachment-key revocation, and `TEAM-004` is its only mention in the entire target corpus. No requirement says it exists, what it re-encrypts, how epochs are represented, who initiates it, or what happens under failure. The disposition table never classifies it, though the frozen product has Rotation plans and a dedicated ADR. See [corpus review, Critical #4](../research/corpus-review.md).

The hard case: a Device offline during rotation holds durably-accepted edits sealed under a superseded epoch. `ITEM-004`'s Conflict-copy rule does not help, because the problem is unreadability rather than divergence.

Decide:

- The `VAULT-ROTATION-*` requirement set: triggers, initiator, scope of re-encryption, and failure semantics.
- Whether Items carry an explicit key epoch in the envelope.
- What happens to a queued offline operation sealed under a superseded epoch: engine re-seals, user-visible rejection, or Conflict copy.
- Whether Attachment blobs are rewritten or only their wrapped keys.
- Whether rotation is atomic, resumable, or plan-coordinated as in the frozen product.
- What an observer learns from the fact that a rotation happened.

Produces: a `VAULT-ROTATION-*` requirement family, a disposition row that currently does not exist, and seed scenarios covering the offline-epoch case.
