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
