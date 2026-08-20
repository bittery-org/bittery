# Password authentication uses OPAQUE RFC 9807

Status: accepted

Bittery full sign-in uses OPAQUE-3DH from RFC 9807 with ristretto255, SHA-512, and Argon2id. The
master password, Secret Key, stable Account identity, and stable Server identity form the canonical
OPAQUE input. The client-only export key is expanded into the Account Unlock Key, so one registered
protocol supplies both authentication and the wrapping key without a second password derivation.

## Considered options

**The earlier Ed25519 signature challenge-response** was rejected on the second pass. It was smaller
and the 128-bit Secret Key already made a stolen password database impractical to grind, so OPAQUE's
pre-computation resistance added little to the stated threat model. The exchange was nevertheless a
Bittery composition of Argon2id, HKDF, Ed25519, a canonical signed message, registration, and migration.
Under ADR 0017, locally smaller code does not beat a complete final-RFC construction unless a mandatory
property requires the exception. None did.

**The frozen product's SRP-6a** remains rejected. Its 1,703-line implementation contains hand-written
big-integer arithmetic and variable-time modular exponentiation over a secret exponent. Reusing it
would violate the no-product-arithmetic policy and adopt a protocol the CFRG PAKE process passed over.

**An authentication hash or shared HMAC key** remains rejected because the value held by the Server is
password-equivalent. A Malicious Operator could harvest it directly.

**P-256/SHA-256 OPAQUE** was considered only to obtain a 32-byte export key. Bittery has no external
P-256 interoperability requirement, while `opaque-ke` defaults to the RFC's ristretto255/SHA-512
configuration. A labeled HKDF expansion is the ordinary application use of a 64-byte export key and
does not justify changing the group.

## Consequences

Authentication protocol version `0x01` fixes OPRF `ristretto255-SHA512`, 3DH over ristretto255,
HKDF-SHA-512, HMAC-SHA-512, SHA-512, and Argon2id with parameters supplied by a one-byte profile. RFC
messages and registration records remain RFC bytes behind a two-byte Bittery version header; neither
CBOR nor Rust serialization enters the public format. Stable Account and Server identities appear both
in the canonical OPRF input and as OPAQUE identities. Ticket 23 must define the Server-identity trust
ceremony before the product claims relay resistance.

The initial dependency is pinned exactly to `opaque-ke` 4.0.1. CI runs the applicable RFC 9807 vectors
and Bittery-profile vectors on Rust and WASM. Independent review of the pinned dependency, profile,
encodings, integration, and Account Key Set wrapping blocks general availability. No second protocol is
kept as a fallback: an implementation defect blocks release until an interoperable implementation
passes, and rejection of OPAQUE itself reopens this decision.

OPAQUE's export key makes fresh-Device recovery depend on the Server's OPRF evaluation. The Server-wide
OPRF seed and static 3DH key are therefore root authentication secrets and mandatory backup material.
An enrolled Device remains independently usable through its local wrapper. Authentication and profile
migration atomically replace the registration record and Account Key Set wrapper before deleting the
old pair; an unsafe old version may be replaced only through an enrolled Device or an independent
recovery route, never an operator bypass.

RFC 9807 is final but is an IRTF Informational RFC, not an Internet Standards Track specification. The
security whitepaper, protocol documentation, this ADR, and review material say so; routine product UI
does not.
