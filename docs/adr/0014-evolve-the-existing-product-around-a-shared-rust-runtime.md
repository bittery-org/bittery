# Evolve the existing product around a shared Rust runtime

Bittery evolves the existing Server, Web, Desktop, and Extension applications instead of rebuilding
the product from a clean slate. A shared Rust client runtime will absorb replica, operation, and Sync
behavior behind a small interface; the existing applications migrate first, followed by a native
Android Compose host and then a native iOS SwiftUI host. The current SRP, KDF, encryption algorithms,
key hierarchy, persisted cryptographic formats, and compatible Rust crypto behavior remain fixed.
Because Bittery has no users, Server schemas, OpenAPI, Sync contracts, and clients change together in
place without parallel versioned routes or a permanent compatibility stack.

This supersedes the Greenfield assumptions that the Server is a clean-room rewrite, legacy client
surfaces are not preserved, cryptography is reopened, and mobile is deferred behind a reconstructed
Web/Desktop/Extension release. Greenfield research and compatible decisions remain evidence for the
evolutionary design.

This also narrows ADR 0008. Injected platform capabilities and one shared behavioral core remain
binding principles, but `packages/core` and a React-family UI are transitional owners only for hosts
not yet migrated. The final shared behavioral core is the Rust Client Runtime. Web, Kotlin, and Swift
adapters may add host ergonomics and platform primitives but do not retain parallel authentication,
Replica, Operation, or Sync policy.
