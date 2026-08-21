# Vault key rotation and epochs

Type: grilling
Status: resolved
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

`AUTH-018` makes a key-derivation profile upgrade create the new OPAQUE registration and re-wrap the
single Account Key Set envelope under the new Account Unlock Key. The User first saves the updated Kit;
the Server then atomically commits the two records, and the client records the new pin after confirmation.
There is no dual registration or partial Server migration. This is Account credential replacement, not
Vault key rotation, so this ticket must not add a second plan or resumable Vault-wide re-wrap.

The upgrade is offered at the end of a full sign-in, while the master password is in hand, and the User
may decline it. An Account can therefore sit on an old profile indefinitely, which is a normal steady
state rather than a rotation transient.

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

`CRYPTO-003` limits one AES-256-GCM-SIV key to 2^32 envelopes. This ticket must set a much earlier
rotation threshold and account for concurrent offline writes without pretending they share a nonce
counter. Reaching the threshold is a format safety event, not an operator-configurable performance
setting.

### Inherited from ticket 09, recovery model and single-artifact paths

`AUTH-028` rules out Account Key Set rotation for the first release, so rotation in this product is
Vault-scoped only. Nothing in the recovery model asks for a Vault key to move: a password change, a
Secret Key rotation, a Recovery Key removal and a recovery sign-in all re-wrap the Account Key Set and
leave every grant intact.

The reason Account Key Set rotation is out is worth carrying here: `CRYPTO-005` binds the Account
Fingerprint into every grant signature, so new Account keys would force every granter to re-issue, and
`CRYPTO-012` would need a retained history of signing keys or every past revision becomes
unverifiable. A Vault key epoch design must not quietly acquire the same property.

## Answer

Resolved with the maintainer on 2026-08-21. Promoted to `VAULT-ROTATION-001` through
`VAULT-ROTATION-011` and the `PRIVACY-007` amendment in
[`product.md`](../../../docs/greenfield/target/product.md), the canonical Vault epoch statement in
[`cryptographic-format.md`](../../../docs/greenfield/target/cryptographic-format.md), seed scenarios
7, 13, and 14, the capability disposition, glossary terms in
[`CONTEXT.md`](../../../CONTEXT.md), and
[ADR 0020](../../../docs/adr/0020-vault-key-rotation-is-a-forward-atomic-epoch-cutover.md).

### Resolution

1. **Rotation is forward-only.** It protects writes accepted after the cutover. It does not bulk
   re-encrypt old Item revisions, Attachment-key envelopes, manifests, or chunks, and it makes no
   claim to revoke keys or plaintext a former member could already have copied.
2. **Epochs are consecutive.** The first Vault key is epoch 1. Every rotation is exactly predecessor
   plus one; zero, gaps, repeats, and `u32` overflow fail. Old epochs and their grants stay available
   while any retained ciphertext references them, then may be collected.
3. **There are three triggers.** Removing an Account's decryption access and exhausting the fixed key
   budget are mandatory. A policy-authorized User may rotate manually after suspected exposure. There
   is no scheduled rotation or operator-configurable threshold, and one compromised Attachment key
   does not by itself rotate the Vault.
4. **The operational budget is far below the format ceiling.** An epoch permits at most 2^24 emitted
   context `0x20` and `0x21` envelopes. The Server reserves 2^12 emissions at a time to an online
   Device. Emission consumes a reservation even when the envelope never uploads; retries reuse the
   same bytes and unused reservations are conservatively spent. An offline Device that exhausts its
   block remains readable but becomes read-only until it reconnects.
5. **Mandatory triggers persist as a write block.** Access loss immediately removes honest-Server
   authorization and sets Rotation required on each affected Vault; budget exhaustion sets the same
   state. It survives every restart and has no timeout, cancellation, or operator override. Reads and
   unrelated Vaults remain usable, and any still-authorized unlocked client whose Account has rotation
   authority may finish it. Ticket 29 owns the exact role matrix and multi-Vault departure policy.
6. **Cutover is one atomic command, not a resumable plan.** A client prepares one fresh Vault key and
   the complete current grant set. Finalization revalidates predecessor, membership revision, actor,
   and grants, then installs the next epoch, resets the budget, records the statement, and removes the
   block in one transaction. No Item or Attachment inventory, staged output, progress state, or
   cleanup job exists. A mandatory failure leaves the block; another client starts preparation again.
7. **Manual rotation has no half-state.** The client prepares locally and submits the same atomic
   command without first blocking writes. Failure leaves the predecessor authoritative and says that
   rotation did not occur.
8. **The whole epoch is Account-signed.** The canonical Vault epoch statement binds stable Server and
   Vault identities, predecessor, next epoch, the coarse trigger, membership revision, initiator, and
   the complete ordered grant set. It uses `bittery/sign/vault-epoch/1`. Per-grant signatures remain;
   the outer statement stops a Server from mixing valid grants from different attempts.
9. **A still-authorized offline edit is re-sealed.** The Server distinguishes a superseded epoch. The
   engine fetches the new grant, opens the old envelope, and seals the same signed logical revision
   under the current epoch. It is not a new edit or Conflict copy. A Device that cannot obtain the new
   grant follows ticket 19's authorization-rejection policy.
10. **Lost responses are queried, never guessed.** Finalization has one idempotency identifier. The
    client fetches the signed current statement and may resend only the byte-identical command; it
    neither assumes success nor generates an accidental second rotation.
11. **Visibility is deliberately narrow but honest.** The operator already sees the Vault, current
    epoch, grants, membership, and chronology. Rotation adds only timestamp, initiating Account, and
    the coarse class `access-loss`, `usage-limit`, or `manual`, plus the reservations needed to enforce
    the budget. There is no free-text reason, stored compromise suspicion, or re-encryption progress.

The frozen Rotation-plan design was used as negative prior art. Its manifest, staged Item and
Attachment outputs, expiry states, cleanup, and bulk atomic replacement answer a bulk rewrite that the
accepted forward-only security goal does not need. No fog graduated and no new ticket was created.
Existing tickets 19, 21, 29, and 32 received the consequences they own.
