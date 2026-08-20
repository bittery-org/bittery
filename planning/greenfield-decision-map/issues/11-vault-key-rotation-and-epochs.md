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

### Inherited from ticket 07, key derivation profiles

`AUTH-018` makes a key-derivation profile upgrade re-derive both HKDF outputs and **re-wrap everything
the Vault-unlock material protects**. That is the master password change path, so this ticket owns it
rather than inventing a second mechanism. The upgrade must be **resumable**: an interruption partway
through the re-wrap must not strand an Account between two profiles, with some wrappers under the old
profile and some under the new.

The upgrade is offered at the end of a full sign-in, while the master password is in hand, and the User
may decline it. So an Account can sit on an old profile indefinitely, and the rotation model must treat
that as a normal steady state rather than a transient.

### Inherited from ticket 08, key hierarchy and canonical envelope format

`CRYPTO-008` puts a `u32` **key epoch** in every envelope header, so this ticket's rotation can be
lazy by construction: a new epoch governs new writes, and ciphertext under an older epoch stays
readable until it is rewritten, or forever. `CRYPTO-015` requires that an epoch naming a key the
client does not hold be reported distinctly from a tag failure, so a client fetches the missing grant
instead of alarming the User.

`CRYPTO-006` makes grants flat, so rotating a Vault key costs one HPKE seal per current member of that
Vault, proportional to the Vault rather than to any Team above it. Decide whether re-encrypting
existing ciphertext under a new epoch is ever mandatory: a departed member already read epoch N, so
the honest answer may be that it never is.
