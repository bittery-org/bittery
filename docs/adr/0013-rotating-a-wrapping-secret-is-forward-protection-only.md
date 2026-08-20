# Rotating a wrapping secret is forward protection only

Status: accepted

`CRYPTO-002` makes the Account Key Set random and long-lived, wrapped by whatever the User unlocks
with. That is what makes a password change cheap: re-wrap one envelope and leave every Vault key and
every grant alone. The same property has a cost nobody had written down. Changing the master password,
rotating the Secret Key, or revoking a Recovery Key replaces a **wrapping**, never the thing wrapped.
Anyone holding an old copy of the envelope plus the matching old secrets opens the same Account Key
Set afterwards, and `HOST-004` backups are exactly where old copies live.

So `AUTH-006`'s old promise of a "revocable" Recovery Key was unenforceable as written, and the same
hole sat under every other rotation the product offers.

`AUTH-028` states the limit rather than closing it. The only real close is generating a new Account
Key Set, and the first release generates none. `CRYPTO-014`'s Account Fingerprint covers the Account's
public keys, and `CRYPTO-005` binds that fingerprint into every Vault grant signature, so new account
keys mean every granter must re-issue and re-sign every grant to this Account. The User cannot do it
alone: re-sealing your own grants would mean accepting membership nobody signed, which is the attack
`PRIVACY-004` classes as Detectable. Old Account Signing public keys would also have to be kept
forever, or every Item revision this Account ever wrote becomes unverifiable under `CRYPTO-012`.

The remedy for a confirmed Account Key Set compromise is therefore exporting into a fresh Account,
which ticket 33 already owns as a supported path.

What rotation does buy is real and worth keeping. The realistic loss is a photographed sheet or a
misplaced Kit, not an operator with a database backup. Against that adversary, deleting the Server's
recovery records ends the route immediately, and rotating the Secret Key makes any kept copy of the
old envelope useless to anyone who never held the old Secret Key. `AUTH-030` therefore offers a Secret
Key rotation the moment a Recovery Key is revoked.

## Considered options

**Shipping Account Key Set rotation in the first release** was rejected on cost and coupling: the
grant re-issue ceremony, a retained history of signing keys so old revisions still verify, a
fingerprint that changes under everyone who verified it out of band, and a dependency on the Vault
authorization work that has not happened yet.

**Rotating only where the User is their own granter,** personal Vaults, and refusing while any shared
Vault exists, was rejected as half a feature with a rule that cannot be explained at the moment a User
needs it.

**Forcing a Secret Key rotation on every Recovery Key revocation** was rejected as too blunt: it voids
every printed Kit for what is often a false alarm. It is offered instead, one click away.

**Saying nothing, and letting "revocable" stand,** was rejected. That is the defect this ADR exists to
close.

## Consequences

`PRIVACY-005` gained an Acknowledged attack: reopening an Account Key Set from a backed-up wrapping
after the matching secret was revoked or rotated.

Product documentation and the `AUTH-029` routes screen must use the words "forward protection", not
"revoked", so a User does not read a deletion as an erasure.

Account Key Set rotation stays on the map as later-release work, alongside the transparency-log
question that ticket 04 and ticket 08 also deferred. Both are about an operator who keeps or
substitutes key material, and a later effort may find they share a construction.

The Account Fingerprint is stable for the life of an Account in the first release. Ticket 29 can treat
it as fixed, and out-of-band verification never has to be redone.
