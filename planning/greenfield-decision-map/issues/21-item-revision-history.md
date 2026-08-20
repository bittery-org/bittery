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
