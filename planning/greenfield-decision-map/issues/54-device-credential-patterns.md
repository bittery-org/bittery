# Device credential patterns in established password managers

Type: research
Status: resolved
Blocked by: none

## Question

Investigate how established end-to-end encrypted password managers authenticate an enrolled Device
to their Server after initial sign-in. Cover 1Password and Bitwarden, and add another directly relevant
implementation only if primary evidence is available.

For each product, establish from official protocol documentation, security papers, and source code:

- what persistent credential material a Device holds;
- how that material is created, enrolled, bound to an Account, and revoked;
- whether ordinary traffic uses per-request signatures, a key-bound session, or bearer credentials;
- credential and session lifetime, replay protection, rotation, and stolen-token consequences;
- which Device identity and metadata the Server stores; and
- any material difference between Web, browser extension, Desktop, and mobile clients.

Separate documented behavior from source-based inference and unknowns. Compare each pattern against
Bittery's settled constraints: one protocol across Web, Desktop, and Extension; an Account-signed
Device Grant; a Server-issued credential that cannot obtain Account keys by itself; explicit Device
revocation; and a Malicious Operator in the threat model. Produce facts and design implications, not
the Bittery decision.

Produces: a primary-source research report under `planning/greenfield-decision-map/research/` and a
resolution pointer to it.

## Answer

Research report: [Device credential patterns in established password managers](../research/device-credential-patterns.md).

1Password binds ordinary requests to a fresh SRP-derived session key; Bitwarden sends one-hour Bearer
access tokens backed by reusable sliding refresh tokens. Neither product has a durable Account-signed
Device grant. 1Password has per-client unlinking, while Bitwarden's effective bearer-session revocation
is Account-wide. The evidence supports keeping Bittery's Account-key release separate from its Server
credential, binding ordinary requests to the granted Device key, and specifying credential and session
revocation independently.
