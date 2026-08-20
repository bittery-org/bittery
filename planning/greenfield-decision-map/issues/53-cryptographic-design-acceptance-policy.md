# Cryptographic design acceptance policy

Type: grilling
Status: resolved
Blocked by: 04

## Question

Set the acceptance bar for the second pass over authentication, key derivation, the key hierarchy,
persisted envelopes, grants, recovery, and rotation before choosing primitives again.

The maintainer wants the design to be secure, easy to implement and audit, low in operational and
migration complexity, and based on final RFC standards wherever possible. Those goals usually align,
but not always: a standard protocol can add dependencies and states, while a small-looking custom
composition can hide proof and interoperability work.

Decide:

- The order in which security properties, final RFC standardization, mature audited implementations,
  interoperability, implementation size, format count, and performance break ties.
- What concrete unmet requirement permits a bespoke construction or a non-final standard.
- The complexity budget: number of primitives, registries, envelope shapes, canonical encodings, and
  migration states the design may carry.
- Whether a standard construction is used in its registered mode rather than decomposed and recombined.
- Dependency acceptance: maintenance depth, independent implementations, audit recency, unsafe-code
  policy, WASM support, and conformance vectors.
- The external review gate and the exact integrated design surface it covers before beta and general
  availability.

Produces: a short `CRYPTO-POLICY-*` requirement family used as the scoring rule for reopened tickets
06 through 09, plus a review-gate handoff to ticket 49 and the release gate.

## Comments

This ticket decides policy, not algorithms. It must not preserve OPAQUE, signature
challenge-response, Argon2id, HPKE, XChaCha20-Poly1305, X25519, Ed25519, or the existing envelope merely
because the first pass selected them. Each survives only if it wins under the accepted policy and the
threat model resolved by ticket 04.

## Decisions so far

- **Ranking:** first reject any design that misses the threat model. Among designs that meet it,
  prefer final RFC constructions with mature reviewed libraries, then the smallest implementation,
  protocol-state, persisted-format, and migration surface. Performance breaks ties later and never
  buys a weaker security property silently.
- **Exception bar:** a bespoke construction or primitive without a final RFC requires a mandatory
  threat-model property no suitable final RFC construction meets, a written alternatives comparison,
  mature implementation support, conformance vectors, and independent cryptographic review before
  beta. Convenience, consistency with the first pass, or avoiding a dependency is insufficient.
- **Complexity budget:** use one mechanism per security job, one canonical encoding, and one migration
  path. A second primitive, registry, envelope shape, or state machine requires a recorded requirement
  the first cannot satisfy. Local elegance does not justify global crypto surface.
- **Registered-mode rule:** use a standard protocol's complete registered mode and specified wire
  semantics. Export-only use or custom recombination crosses the bespoke-construction exception bar.
  A composition is not standards-based merely because each primitive inside it has a standard.
- **Dependency gate:** require active maintenance, RFC and test-vector conformance, WASM support, no
  Bittery-written arithmetic, documented unsafe code, vulnerability monitoring, and either meaningful
  independent review or broad interoperable deployment. A recent audit is strong but not exclusive
  evidence; reducing dependencies never justifies implementing primitives in this repository.
- **Release review gate:** beta may precede external review, but must be labeled non-production and
  must not claim reviewed cryptographic assurance. Independent review of the integrated design and
  implementation, followed by penetration testing of the running product, all block general
  availability. Any bespoke or non-final-standard exception remains subject to its stricter
  before-beta review rule.

## Answer

Resolved 2026-08-20. Promoted to `CRYPTO-POLICY-001` through `CRYPTO-POLICY-006` and ADR 0017.

Security properties are the hard filter. Among designs that meet the threat model, final RFC
constructions with mature reviewed implementations win, followed by global simplicity. The design
uses one mechanism per job and complete registered protocol modes. Bespoke constructions,
non-final-standard primitives, export-only composition, and second mechanisms carry an explicit
exception burden.

Dependencies must be maintained, conformant, WASM-capable, transparent about unsafe code, monitored
for vulnerabilities, and supported by review or broad interoperable deployment. Bittery implements no
cryptographic arithmetic.

Beta may precede the integrated external review. General availability requires independent design and
implementation review followed by penetration testing. An exceptional bespoke or non-final-standard
choice is stricter: it must be reviewed before beta.
