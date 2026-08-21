# Device admission is Account-signed and every request proves the Device key

Status: accepted

A Server-maintained Device row cannot prove that an Account admitted the Device when the operator is
in the threat model. Bittery therefore makes a signed Device Grant the durable admission authority and
requires every ordinary request to prove the corresponding Device private key through one fixed RFC
9421 profile. A short Server Session scopes replay counters but is neither a Bearer credential nor a
route to the Account Key Set.

This deliberately goes beyond the established products examined in
[the Device-credential research](../../planning/greenfield-decision-map/research/device-credential-patterns.md).
1Password binds requests to a fresh SRP-derived Session key but publishes no Account-signed Device
roster. Bitwarden uses replayable Bearer access and refresh tokens and makes its Server Device database
authoritative. Bittery already has an Account signing key and treats a Malicious Operator as an
adversary, so using the former for admission and the Device key for proof of possession is the smaller
trust boundary even though it costs one signature and one authoritative status check per request.

## Considered options

**Server-issued Bearer access and refresh tokens** were rejected because copying either credential can
impersonate the Device without its granted private key, and delayed expiry turns Session duration into
the revocation bound.

**A Session MAC after one Device-key proof** was rejected because a copied live Session key becomes the
whole credential until expiry. It would also add an application key exchange and request-MAC framing
where the final HTTP Message Signatures standard already defines Ed25519 request binding.

**Server-only Device membership** was rejected because a Malicious Operator could create the record it
later cites as authorization. Account-signed Add, Rename, and Revoke events let each client verify the
authority and detect rollback below a generation it has accepted.

## Consequences

Revocation stops the next request at an honest Server, including in an open Session, but cannot make an
offline or compromised Device forget Account keys it already obtained. A Malicious Operator can still
withhold or fork valid Device history between clients until a later transparency mechanism exists.
Trusted enrollment therefore supplies a signed roster checkpoint directly, while full sign-in and
recovery remain independent routes when no trusted Device survives.
