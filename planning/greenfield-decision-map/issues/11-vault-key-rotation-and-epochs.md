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
Secret Key rotation, a Recovery Key revocation and a recovery sign-in all re-wrap the Account Key Set
and leave every grant intact.

The reason Account Key Set rotation is out is worth carrying here: `CRYPTO-005` binds the Account
Fingerprint into every grant signature, so new Account keys would force every granter to re-issue, and
`CRYPTO-012` would need a retained history of signing keys or every past revision becomes
unverifiable. A Vault key epoch design must not quietly acquire the same property.
