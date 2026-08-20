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
