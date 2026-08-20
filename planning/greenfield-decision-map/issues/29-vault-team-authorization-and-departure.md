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
