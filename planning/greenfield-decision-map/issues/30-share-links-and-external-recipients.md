# Share links and external recipients

Type: grilling
Status: ready-for-human
Blocked by: 08, 29

## Question

`SHARE-001` makes Vault membership the ongoing mechanism and Share links a one-off encrypted Item snapshot, and `SHARE-002` lists expiry, view caps, one-time use, recipient passphrase, revocation, and email allowlists.

Decide:

- The Share envelope format and the fragment-key scheme, so the key never reaches the Server.
- Which policies are enforceable and which are advisory, stated honestly. A view cap on a fetched ciphertext is not the same as a view cap on knowledge.
- Recipient passphrase: derivation, and what protects against guessing.
- The anonymous recipient experience, and what the recipient's browser loads and from where.
- Revocation semantics, and what a recipient who already fetched retains.
- What the Server learns about Share links, checked against the closed plaintext list.
- The one-time-secret rule that makes `Idempotency-Key` invalid on share creation.

Produces: `SHARE-*` refinement and a format specification.

## Comments

### Inherited from ticket 04, threat model and server-visible plaintext

`PRIVACY-010` requires Share links to be unlinkable: the Server does not learn which Item a Share link
was created from. That rules out storing an Item reference beside the Share link, so the snapshot must
be independent ciphertext with no shared identifier.

`PRIVACY-007` puts Share-link existence, expiry, view count, maximum views, and ciphertext length in
Server-visible plaintext.

### Inherited from ticket 08, key hierarchy and canonical envelope format

`CRYPTO-009` carries a carve-out written for this ticket: a Share link snapshot binds the **Share link
identifier** into its additional authenticated data and never the source Item identifier, because
binding the Item would defeat `PRIVACY-010` unlinkability. `CRYPTO-010` reserves key context `0x40`
but `CRYPTO-011` reserves no Share derivation label. This ticket adds an exact literal only if its
accepted fragment-secret construction actually derives the snapshot key.

If a later feature wants a Share link to remember which Item it came from, that association must live
inside ciphertext. There is no plaintext field for it and `PRIVACY-006` will not grow one.
