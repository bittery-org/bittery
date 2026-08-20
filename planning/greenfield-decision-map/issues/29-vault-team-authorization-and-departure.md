# Vault and Team authorization, and member departure

Type: grilling
Status: ready-for-human
Blocked by: 11, 22

## Question

`TEAM-002` proposes Team Owner/Admin/Member and Vault Manager/Editor/Viewer, `TEAM-003` separates governance from decryption, and `TEAM-004` blocks writes in affected Vaults until rotation completes.

Decide:

- The final role sets and the exact capability matrix for each.
- How a Vault grant is represented cryptographically, and what the Server can see about it.
- Personal to Team Vault conversion, one-way per `VAULT-002`: the ceremony and what it costs.
- Departure: what blocks, for how long, what the remaining members see, and what the departing member keeps.
- Whether a Team Owner can be locked out, and what recovers it.
- Invitation flow, given email may not exist.

Produces: `TEAM-*` and `VAULT-*` refinement, plus seed scenario 7.

## Comments

### Inherited from ticket 04, threat model and server-visible plaintext

`PRIVACY-004` requires Vault membership to be signed by an existing member, so a grant the Server
invented is rejected outright rather than merely noticed. Decide what a member signs over and how a
client verifies a grant it did not witness.

`PRIVACY-011` holds a Co-tenant User to a stricter bar than the operator: they learn nothing about a
Vault they are not a member of, including its existence.

### Inherited from ticket 08, key hierarchy and canonical envelope format

`CRYPTO-005` freezes the signed grant message's field list: purpose label, format version, Server
identity, Vault identifier, key epoch, granter Account identifier, recipient Account identifier,
recipient Account Fingerprint, and **granted role**. This ticket supplies the role enum that the last
field carries; the field itself is no longer negotiable.

`CRYPTO-006` makes grants flat, so a Team is an authorization grouping plus a name plus a Team History
Key, and never a key that opens Vault content. That is what keeps `TEAM-003` and `TEAM-004` true.
Departure therefore rotates only the Vaults the departing member was actually granted.

`CRYPTO-014` defines an Account Fingerprint and binds it into every grant. Whether any screen shows it,
and what a User is told about comparing it out of band, is this ticket's call together with ticket 47.
