# Item revision history and retention

Type: grilling
Status: ready-for-human
Blocked by: 15

## Question

`ITEM-005 SHOULD` replaces the frozen product's ad hoc password-history field with bounded encrypted revision history, and leaves the bound undefined.

Decide:

- What a revision captures: whole Item, changed fields, or password values only.
- The retention bound: count, age, or both, and whether an operator or a user controls it.
- Where revisions live, and whether they sync or stay local.
- Whether revisions survive a Vault-key rotation, and at what cost.
- What deletion means for history: whether emptying Trash erases revisions.
- What the Server learns from revision counts, checked against the closed plaintext list.

Produces: `ITEM-005` promotion to a defined requirement, plus a retention decision consistent with quotas being gone.

## Comments

### Superseded by ticket 04's reopened answer

There is no mandatory per-Item revision chain, and ordinary Server timestamps are allowed. Decide
revision retention and user-visible history without inheriting the old chain-pruning or no-time rules.

### Inherited from ticket 04, threat model and server-visible plaintext

`PRIVACY-004` hash-chains Item revisions so that dropping or reordering one is Detectable. Bounded
retention prunes revisions, which breaks a naive chain. Decide how pruning preserves detectability:
a checkpoint hash at the prune boundary, or an explicit signed pruning record.

`PRIVACY-008` removes stored wall-clock times, so revision ordering uses sequence numbers and the
displayed date comes from inside the ciphertext.

### Inherited from ticket 08, key hierarchy and canonical envelope format

`CRYPTO-012` makes every revision an Ed25519-signed canonical unsigned body plus its signature, both
inside ciphertext. Ticket 04's reopened answer removed the mandatory revision chain, so retention has
no chain-pruning problem. It must still preserve the historical Account public keys needed to verify
old authors, or state why first-release stable Account Key Sets make that unnecessary.

`CRYPTO-009` binds the revision number into the envelope's AAD, so revisions cannot be renumbered
after the fact. Any retention scheme that renumbers rather than tombstones would make old revisions
undecryptable.
