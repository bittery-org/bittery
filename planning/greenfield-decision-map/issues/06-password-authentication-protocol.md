# Password authentication protocol and its fallback

Type: grilling
Status: resolved
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

## Answer

Promoted to a rewritten [`AUTH-003`](../../../docs/greenfield/target/product.md) plus `AUTH-009`
through `AUTH-014`, two ADRs, and four new [`CONTEXT.md`](../../../CONTEXT.md) terms.

**OPAQUE is rejected, and so is SRP-6a.** The decisive fact is that no augmented PAKE removes the
offline dictionary attack against a stolen Server database; conceding it is what defines the category.
OPAQUE's distinguishing property is pre-computation resistance. `AUTH-001` already binds the Secret Key
into the credential, so an offline grind costs ~128 bits on top of the password, and the Server holds
Vault ciphertext derived from the same two secrets at identical cost. The property was already held,
and held better, by the Secret Key.

**The protocol is a signature challenge-response.** Argon2id over the master password, HKDF-Extract to
mix in the Secret Key, HKDF-Expand to a 32-byte Ed25519 seed. The Server stores the public key. Each
full sign-in signs a canonical, length-prefixed message binding a purpose label, protocol version,
Server identity, Account identifier, and a single-use Sign-in Challenge. Ed25519 over P-256 because
nothing outside the Rust core verifies, so P-256 buys no interoperability and costs signing-time
randomness.

**Reusing the frozen SRP-6a was examined and rejected on its own code.** It is 1,703 lines of
hand-written Rust at `legacy/packages/crypto/core/crates/bittery-crypto-core/src/srp6a/`, including its
own big-integer module, and `bigint.rs:174` records that the modular exponentiation is not constant-time
over a secret exponent. Adopting it means adopting bespoke big-integer arithmetic, a larger review
liability than the construction it would replace. SRP also carries no security proof, was passed over by
the CFRG PAKE selection, and was removed from TLS 1.3.

**The salt derives from the Secret Key,** so there is no pre-login request and therefore no
account-enumeration oracle on the sign-in path. This is stronger pre-computation resistance than OPAQUE
offers, for no dependency. It forces Server-wide published key-derivation parameters instead of
per-Account ones, which also deletes the per-Account downgrade vector.

**Two independent memory-hard runs per full sign-in**, one for authentication and one for Vault unlock,
accepted as the reading of `AUTH-002`. The cost is bounded because `AUTH-011` limits the protocol to
enrolment and full sign-in; ordinary traffic runs on the Device credential.

**One protocol on every surface, including Web.** The Web client cannot hold the property, because
`PRIVACY-015` concedes its serving operator ships the JavaScript, but a second authentication path would
give the Server two implementations and an attacker a downgrade target.

**The gate is a cryptographic construction review of the design note, before any penetration test,**
as a general-availability gate rather than a beta blocker. A pentest attacks a running system and would
not find a flaw in how the two secrets combine. Conformance vectors go to ticket 49 now. `AUTH-014`
makes version rotation a specified path so a rejected review is a scheduled migration.

Notes appended to tickets 07, 09, 10, 14, 23 and 49.
