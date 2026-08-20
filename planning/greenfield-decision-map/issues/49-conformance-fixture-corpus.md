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
### Inherited from ticket 06, password authentication protocol

`AUTH-012` hands this ticket the **authentication vectors**: Argon2id output, HKDF-Extract and
HKDF-Expand steps, the Ed25519 seed, the canonical length-prefixed signed message, and the signature.
The construction is bespoke, so cross-implementation agreement between the Rust core, the WASM build,
and the Server is proven by fixtures rather than by an RFC's published vectors.

The canonical encoding of the signed message is the sharp edge: the corpus must include cases that would
catch an ambiguous encoding, where two different field sets could produce the same byte string.

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
