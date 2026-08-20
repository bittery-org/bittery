# Conformance fixture corpus

Type: grilling
Status: ready-for-human
Blocked by: 08, 15, 39

## Question

`ARCH-SERVER-004` makes the fixture corpus the definition of compatibility for third-party clients, and the architecture requires native Rust, WASM, Swift, and Kotlin bindings to execute the same corpus. The first release ships only Rust and WASM, so decide what the corpus must prove now and what it must be shaped to accept later.

Decide:

- The fixture format, and whether the scenario shape in `scenarios/README.md` survives contact.
- What each fixture asserts: visible projection, durable replica, operation state, server state, emitted events.
- How crypto negative vectors are expressed, from [the envelope format](08-key-hierarchy-and-envelope-format.md).
- Whether the corpus is genuinely shared across hosts or splits by durability class, handed over from [browser durability](16-browser-durability-floor.md).
- How a third-party client runs it without the Rust engine.
- Where the twelve seed scenarios land, and which are replaced.

Produces: the corpus specification and the resolution of the seed scenario list.

The first-release gate must not require unshipped Swift and Kotlin bindings to execute the corpus.
Define a first-release Rust/WASM obligation and a fixture format that later native bindings must adopt;
this corrects the unconditional wording in `docs/greenfield/target/architecture.md`.

Ticket 53 also hands this ticket the integrated cryptographic review surface and acceptance-policy
fixtures. Reopened tickets 06 through 09 may replace all previously listed vectors.
### Inherited from ticket 06, password authentication protocol

`AUTH-013` hands this ticket every applicable RFC 9807 Appendix C real and fake vector plus Bittery-
profile positive and negative vectors. Rust and WASM must consume the same fixture bytes. Independent
cross-implementation execution is not a release requirement; external review separately covers the
pinned `opaque-ke` implementation and its integration.

The Bittery vectors pin the two-byte header, canonical OPRF input, Account and Server identities,
authenticated context, Argon2id profile, KE1 through KE3, registration record bytes, export-key HKDF,
and session-key confirmation MAC. Negative cases cover every rejected length, zero or unknown version,
context mismatch, malformed RFC payload, replayed attempt, and second KE3 submission.

### Inherited from ticket 08, key hierarchy and canonical envelope format

`CRYPTO-015` enumerates every rejection rule the corpus must prove, and states that each has a negative
fixture: unknown format version, key context `0x00` or unknown, a context whose envelope shape does not
match the bytes, a non-zero epoch where the context has none, a blob shorter than header plus tag,
trailing bytes after the tag, tag mismatch with no partial plaintext, and strict RFC 8032 Ed25519
verification rejecting non-canonical `S` and small-order points. Nonce reuse is explicitly **not**
detectable and must not have a fixture implying otherwise.

`CRYPTO-011` requires a check that the HKDF label table is pairwise distinct, and `AUTH-012`'s vectors
must pin the exact label bytes, because a collision would make two keys equal and nothing else in the
design would catch it. `CRYPTO-009`'s binding tuple needs positive and negative vectors per key
context, since a relocated blob must fail.
