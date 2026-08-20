# Password authentication protocol and its fallback

Type: grilling
Status: resolved
Blocked by: 04, 53

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

## Reopened 2026-08-20

The maintainer requested a second pass biased toward final RFC standards, mature reviewed libraries,
low complexity, and security. The previous answer is historical evidence, not a constraint.

The pass must correct two specific defects. `AUTH-014` deadlocks protocol rotation if the Server
refuses the old version before a client can authenticate and register the new key. `AUTH-009` also
claims relay resistance before ticket 23 defines how a client authenticates, pins, restores, and
changes Server identity. Specify migration and identity prerequisites rather than assuming them.

Reconsider standard PAKEs, the signature challenge-response, and any simpler standard alternative
under ticket 53's acceptance policy. A bespoke construction is not the default merely because its
primitive operations are standard.

## Answer — second pass 2026-08-20

Promoted to rewritten [`AUTH-002`](../../../docs/greenfield/target/product.md), `AUTH-003`, and
`AUTH-009` through `AUTH-015`; accepted [ADR 0006](../../../docs/adr/0006-password-authentication-is-a-signature-challenge-response-not-a-pake.md);
superseded [ADR 0007](../../../docs/adr/0007-the-authentication-salt-derives-from-the-secret-key.md);
and revised authentication language in [`CONTEXT.md`](../../../CONTEXT.md).

**Full sign-in uses OPAQUE-3DH from RFC 9807.** Protocol version `0x01` fixes OPRF
`ristretto255-SHA512`, 3DH over ristretto255, HKDF-SHA-512, HMAC-SHA-512, SHA-512, and Argon2id.
Ticket 07 owns the exact Argon2id profile. `opaque-ke` is initially pinned exactly at 4.0.1. RFC 9807
is final but IRTF Informational rather than Internet Standards Track; the public security and protocol
documents and review material say so, while routine UI does not.

**Both factors and both stable identities enter one canonical OPAQUE input.** It is the ASCII label
`bittery/opaque-input/1`, then unsigned 16-bit big-endian length-prefixed Account identifier, Server
identifier, and NFKD UTF-8 master password, then the raw 16-byte Secret Key. Account and Server
identifiers are also OPAQUE identities; Account identity is the credential identifier and email is
lookup-only. Ticket 23 must define Server-identity trust before relay resistance is claimed.

**The public format is RFC bytes behind a two-byte header.** The first byte is the append-only
authentication version and the second the key-derivation profile; zero is invalid. The authenticated
context binds the Bittery context label, both bytes, and fixed suite name. No CBOR, textual delimiter,
variable integer, crate serialization, version negotiation, or automatic fallback exists here.

**OPAQUE supplies authentication and Account unlocking without a second password derivation.** A
labeled HKDF-Expand-SHA-512 narrows the 64-byte client-only export key into the 32-byte Account Unlock
Key. A separately labeled confirmation key from the session key authenticates one Device-credential
issuance, after which both sides erase the session material. Ordinary traffic uses the Device
credential.

**Server state is explicit and shared.** One OPRF seed and static 3DH key exist per Server and protocol
version. They are root authentication secrets and mandatory backup material. A random 128-bit Sign-in
attempt identifies short-lived Server-side OPAQUE state, atomically consumed by the first KE3. No
sticky session, Redis correctness dependency, general registration endpoint, or sealed continuation
format was accepted.

**Migration cannot deadlock or downgrade.** A client pins the authentication version and the Emergency
Kit prints it. A normal migration authenticates the old version or uses an enrolled Device, then
atomically installs the new OPAQUE registration and Account Key Set wrapper before deleting the old
pair. The updated Kit is saved before commit. If the old version is unsafe, only an enrolled Device or
independently valid recovery route may authorize replacement; otherwise the Account is unrecoverable.
The operator has no bypass.

**There is no alternate authentication protocol.** A library defect blocks release until an RFC-
conformant implementation passes. Rejection of OPAQUE itself reopens the decision rather than activating
a rushed fallback. CI runs RFC Appendix C and Bittery-profile vectors on Rust and WASM; integrated
external review blocks general availability, but independent cross-implementation execution is not a
separate release gate.

Updated handoffs in tickets 07, 08, 09, 10, 14, 22, 23, 24, 25, and 49. No fog graduated and no new
ticket was necessary.
