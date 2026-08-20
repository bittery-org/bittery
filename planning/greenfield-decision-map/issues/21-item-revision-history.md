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

### Inherited from ticket 04, threat model and server-visible plaintext

`PRIVACY-004` hash-chains Item revisions so that dropping or reordering one is Detectable. Bounded
retention prunes revisions, which breaks a naive chain. Decide how pruning preserves detectability:
a checkpoint hash at the prune boundary, or an explicit signed pruning record.

`PRIVACY-008` removes stored wall-clock times, so revision ordering uses sequence numbers and the
displayed date comes from inside the ciphertext.

### Inherited from ticket 08, key hierarchy and canonical envelope format

`CRYPTO-012` settles two things this ticket inherits. The revision chain hash is
`SHA-256(previous chain hash || envelope bytes)`, computed over ciphertext so a Server can check
continuity without decrypting. And every revision carries an Ed25519 signature by its author's Account
Signing Key, placed **inside** the ciphertext, so retention pruning must not silently break either the
chain or the ability to verify an old author's key.

`CRYPTO-009` binds the revision number into the envelope's AAD, so revisions cannot be renumbered
after the fact. Any retention scheme that renumbers rather than tombstones would make old revisions
undecryptable.
