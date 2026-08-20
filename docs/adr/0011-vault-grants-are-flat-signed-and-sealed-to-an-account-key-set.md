# Vault grants are flat, signed, and sealed to an Account Key Set

Status: proposed

Previously accepted; reopened by Wayfinder ticket 08 on 2026-08-20.

`AUTH-015` ends at "Vault-unlock material" and says nothing about what that material protects. This
ADR records the shape underneath it: `CRYPTO-001` and `CRYPTO-002` put a randomly generated **Account
Key Set** between the Account Unlock Key and every Vault key, and `CRYPTO-006` seals Vault keys flat
to each member rather than through any Team-level key.

The intermediate key set exists so that a life event costs one re-wrap. A master password change, a
Secret Key rotation, an `AUTH-018` profile upgrade, and a Recovery Key are all the same operation:
re-wrap one envelope. Wrapping Vault keys directly under the Account Unlock Key would make each of
those a fan-out over every Vault an Account can open, and would make a Recovery Key a second wrapping
of each. `AUTH-018` already describes an upgrade as re-wrapping "what the Vault-unlock material
protects", in the singular; this makes that literal.

The Account Key Set is **random, not derived**. A derived key set would need no storage at all and
would fall out of the master password and Secret Key alone. It was rejected because an `AUTH-018`
profile upgrade would then change the Account's public keys, orphaning every grant ever sealed to the
old ones. Randomness is what decouples the password from the sharing graph.

Flat grants are forced by requirements that already exist. A Team Key wrapping Team Vault keys would
make every member a decryptor of every Team Vault, contradicting `TEAM-003`, and would make one
departure rotate every Vault the Team owns, contradicting `TEAM-004`. With X25519 the cost of flat
grants is negligible: sealing to twenty members is twenty 32-byte operations. The one thing a Team
genuinely needs a key for is `AUDIT-001`'s Team Security History, so `CRYPTO-006` gives it a **Team
History Key** scoped to exactly that and nothing else, cheap to rotate on departure because it
protects only a log.

Signatures are the other half. `PRIVACY-003` and `PRIVACY-004` require that a client reject Vault
membership no member signed, which needs a signature and a field to hold it. `CRYPTO-005` uses a
dedicated Ed25519 Account Signing Key rather than the `AUTH-003` Authentication Key, because
`AUTH-014` rotates the Authentication Key without touching Vault data and a shared key would invalidate
every past grant on rotation.

Signing surfaced an adversary the model had no name for. Holding a Vault key is enough to write an
Item revision attributed to another member, so `CRYPTO-012` signs revisions, and `PRIVACY-001` grew a
seventh class, **Vault Co-member**, to name who that answers. `CRYPTO-012` places the signature inside
the ciphertext, because a plaintext signature would let an operator attribute every revision to an
author and revision authorship is not on the `PRIVACY-007` list.

`CRYPTO-014` defines an Account Fingerprint now rather than later, and binds it into the grant
signature. The reason is timing rather than urgency: this ADR freezes the signed grant message's field
list, and adding a bound field afterwards would leave two signed forms every verifier must carry
forever.

## Considered options

**Wrapping Vault keys directly under the Account Unlock Key** was rejected: fewer moving parts, at the
price of turning every password change, key rotation, profile upgrade, and Recovery Key into a
fan-out over every Vault.

**Deriving the Account Key Set from the master password and Secret Key** was rejected because an
`AUTH-018` upgrade would change the Account's public keys and orphan every grant sealed to them.

**A tiered Team Key wrapping Team Vault keys** was rejected as contradicting `TEAM-003` and
`TEAM-004`, as above. Adding a member would be one wrapping instead of one per Vault, which is not
worth breaking two settled requirements for.

**No Team key at all** was rejected because `AUDIT-001`'s Team Security History would then have nothing
to be encrypted to, and ticket 27 would have had to invent one anyway.

**Sealing Vault keys to Device keys instead of Account keys** was rejected. It would make Device
enrolment re-wrap every Vault key the Account can open, where sealing to the Account makes enrolment a
question of transporting one Account Key Set.

**Reusing the Authentication Key for grant signatures** was rejected on the `AUTH-014` rotation
argument.

**Leaving revisions unsigned** was rejected. It saves 64 bytes and a signature per revision, and
leaves Security History's actor field as an unverifiable claim in exactly the case that matters, a
shared Vault.

## Consequences

`PRIVACY-007` gained three fields: the wrapped Account Key Set on an Account, a granter identifier and
grant signature on every wrapped Vault key, and a wrapped Team History Key per reader. `PRIVACY-006`
makes that list closed, so each is a deliberate addition rather than a side effect.

`PRIVACY-001` gained a seventh adversary class, amending resolved ticket 04. Every requirement that
answers a Vault Co-member says so.

Device enrolment becomes a question of transporting one Account Key Set safely, which is the whole
shape of the enrolment protocol work. The recovery model inherits the same object: a Recovery Key
wraps the Account Key Set and nothing else.

Signature verification defends against a Vault Co-member, not against a Malicious Operator, who can
substitute the signing public key it publishes. That remains Acknowledged until a transparency-log
construction exists. `CRYPTO-014`'s fingerprint gives out-of-band verification something to compare in
the meantime, and the product must not imply more than that.

Rotating a Vault key means re-sealing it to every current member, which is the departure path. Because
grants are flat, that cost is proportional to the members of one Vault rather than to the Teams above
it.
