# Client Runtime boundaries

`bittery-client-core` is the single behavioral and semantic source for the Runtime protocol,
Replica plans, errors, and projections. It depends on the unchanged `bittery-crypto-core`, but it
has no binding-generator, browser, Kotlin, Swift, UI, or platform dependency.

The native binding crate contains wire projections solely because UniFFI metadata belongs at the
foreign boundary. They are not a second domain model. Every variant conversion uses an exhaustive
`match`, and every record conversion destructures every source field without `..`. Adding a Core
variant or field therefore fails the binding build until the projection is updated. The Web adapter
does not restate the protocol: it serializes the Core's Serde definitions directly.

The raw native UniFFI object calls semantic Runtime close `shutdown()`. UniFFI 0.31.2 reserves a
synchronous Kotlin `AutoCloseable.close()` for foreign-handle disposal, so exporting the Runtime's
asynchronous method under the same raw name produces a Kotlin source-level collision. Each future
native host facade exposes the stable asynchronous `close()` protocol and delegates it to
`shutdown()`; host-facade source is outside Ticket 16, and this transport spelling owns no Runtime
policy. Core and Web use `close()` directly.

Generated Server types are a recursively closed allowlist sourced from the checked-in OpenAPI
document. The generator is deterministic, committed output is compiled into the Core, and `--check`
fails on either OpenAPI drift or generator drift. Expanding the allowlist is an explicit Runtime
network-contract change; unrelated Server schemas never enter this package automatically.

Plaintext Login drafts and decrypted Item projections exist only at the external Runtime seam and in
the unlocked in-memory projection cache. Replica records and durable Operation bytes are encrypted
authority. Ticket 16 uses an unmistakable simulated sealed marker only to prove ownership and
atomicity; the Sign-in/create slice replaces it with existing crypto-core encryption and AAD before
production use.

The first Login shape is a closed subset of the existing TypeScript `DecryptedItemData`: `title`,
optional `url`, `urls`, optional `username`, optional `password`, optional `notes`, optional `note`,
`customFields`, and `tags`. A Custom field retains the existing `id`, `label`, `value`, and closed
`type` (`text`, `password`, `email`, or `url`). Password history, passkeys, and TOTP remain outside
the first create slice. Optional strings stay optional; an empty string is never a missing-value
sentinel.
