# Password authentication protocol and its fallback

Type: grilling
Status: ready-for-human
Blocked by: 04

## Question

`AUTH-003 SHOULD` names RFC 9807 OPAQUE with the exact suite left OPEN. Research findings that bear on it: RFC 9807 is **Informational, IRTF/CFRG, not Standards Track**, and its own text says the results "might not be suitable for deployment". `opaque-ke` 4.0.1 is synced to the RFC and verifies its Appendix C vectors, but it is effectively single-vendor, has a five-month commit gap, and its only audit is NCC Group June 2021 against version 0.5.0. See [library maturity](../research/library-maturity.md). The frozen product runs SRP-6a with a 4096-bit group.

Decide:

- OPAQUE or an alternative, given that `AUTH-001`'s Secret Key already makes a stolen server database useless, which is most of what OPAQUE buys.
- If OPAQUE: exact ciphersuite, record encoding, identity binding, and the pinned `opaque-ke` version.
- The named fallback if the conformance or audit gate fails, decided now rather than under pressure later.
- What the conformance gate actually is: RFC vectors in CI, an external review, or both.
- Whether the protocol status (Informational, not a standard) is stated accurately anywhere user- or auditor-facing.

Produces: `AUTH-003` resolution, a pinned dependency decision, and an ADR (hard to reverse once accounts exist).
