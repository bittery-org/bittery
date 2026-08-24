# Client Runtime boundaries

`bittery-client-core` is the single behavioral and semantic source for the Runtime protocol,
Replica plans, errors, and projections. It depends on the unchanged `bittery-crypto-core`, but it
has no binding-generator, browser, Kotlin, Swift, UI, or platform dependency.

The native binding crate contains wire projections solely because UniFFI metadata belongs at the
foreign boundary. They are not a second domain model. Every variant conversion uses an exhaustive
`match`; output records destructure every Core field without `..`, and opaque input objects construct
Core records with complete literals. Adding a Core variant or field therefore fails the binding build
until the projection is updated. The Web adapter does not restate the protocol: it serializes the
Core's Serde definitions directly.

The raw native UniFFI object calls semantic Runtime close `shutdown()`. UniFFI 0.31.2 reserves a
synchronous Kotlin `AutoCloseable.close()` for foreign-handle disposal, so exporting the Runtime's
asynchronous method under the same raw name produces a Kotlin source-level collision. The checked-in
Kotlin and Swift facades expose the stable asynchronous `close()` protocol and delegate it to
`shutdown()`; this transport spelling owns no Runtime policy. Core and Web use asynchronous `close()`
directly.

UniFFI records and enum payloads synthesize host-language stringification. Secret strings, Login
drafts, Custom fields, and decrypted Login projections therefore cross the native boundary as opaque
objects with explicit constructors/accessors rather than generated value records. Artifact tests pin
that generated Kotlin/Swift shape so host logging cannot recursively print their plaintext fields.

The generic Worker transport lives in `src/worker/`. It carries correlation, cancellation,
lifetime and a clone-safe wire vocabulary for every channel, and contains no crypto. The Runtime is
the top-level abstraction, so it owns the transport it is assembled from. `src/web/` holds the two
Web composition roots: `worker-entry.ts` inside the Worker and `composition.ts` on the main thread.
One owner means one Worker, and therefore one Crypto key table.

`@bittery/crypto-port` still imports that transport, because it still hosts Desktop's and Mobile's
own Worker roots (ADR 0010). Until those move, an import from this package into `crypto-port` would
close a package cycle that turbo rejects, so `src/web/worker-entry.ts` receives the Crypto channel
injected instead. `scripts/check-architecture.mjs` cannot forbid the `crypto-port` to
`client-runtime` edge until that inversion is gone.

`packages/crypto/wasm` holds the combined WebAssembly artifact, and its Rust crate depends on
`crates/bittery-client-bindings` and re-exports `WebClientRuntime`. That edge is a Cargo path
dependency, so the package graph holds a cycle neither pnpm, turbo, nor
`scripts/check-architecture.mjs` can see. Rehoming the artifact is its own ticket.

The host binding above the transport is three layers. `src/client/` is platform-neutral: a
`RuntimeTransport` seam, a `RuntimeClient` of typed calls over the generated protocol, and the
observation registry. The registry mints observation ids, reference counts them by logical
observation, defers and cancels teardown, and serializes per-key work, so observation identity and
lifetime never depend on a component's lifecycle. `src/react/` holds one `useSyncExternalStore` and
no effect at all; every feature hook is a derivation of it. `src/testing/` holds the fake transport
those tests run against. A host supplies a transport and nothing else; only `src/react/` imports
React, and both React and TanStack Query are optional peers.

Generated Server types are a recursively closed allowlist sourced from the checked-in OpenAPI
document. The generator is deterministic, committed output is compiled into the Core, and `--check`
fails on either OpenAPI drift or generator drift. Expanding the allowlist is an explicit Runtime
network-contract change; unrelated Server schemas never enter this package automatically.

Plaintext Login drafts and decrypted Item projections exist only at the external Runtime seam and in
the unlocked in-memory projection cache. Replica records and durable Operation bytes are encrypted
authority. Ticket 16 uses an unmistakable simulated sealed marker only to prove ownership and
atomicity; the Sign-in/create slice replaces it with existing crypto-core encryption and AAD before
production use.

The `Items` observation carries the Vaults its Items live in, each with the Account's role in the
Server's own closed `VaultRole` spelling. A host derives "may I write an Item here" from the role
rather than being handed a second boolean, and the same projection names the Vault a list row, a
sidebar entry or a Vault header renders. That is deliberate reuse of one observation: after the Web
cutover no transitional reader holds Vault metadata at all, and a separate Vault observation would
publish a second revision line a host would have to reconcile against the Items it just received.
Vault membership, Attachments and deleted Items are not in it; they still belong to the read paths
that own them.

The first Login shape is a closed subset of the existing TypeScript `DecryptedItemData`: `title`,
optional `url`, `urls`, optional `username`, optional `password`, optional `notes`, optional `note`,
`customFields`, and `tags`. A Custom field retains the existing `id`, `label`, `value`, and closed
`type` (`text`, `password`, `email`, or `url`). Password history, passkeys, and TOTP remain outside
the first create slice. Optional strings stay optional; an empty string is never a missing-value
sentinel.
