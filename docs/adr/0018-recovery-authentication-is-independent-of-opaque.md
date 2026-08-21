# Recovery authentication is independent of OPAQUE

Status: accepted

An unsafe OPAQUE version cannot safely authenticate its own replacement. Bittery nevertheless needs
the Recovery Key route to recover an Account with no enrolled Device, without granting an operator
reset. Recovery protocol `RK1` therefore derives a wrapping key and an Ed25519 signing key from the
Recovery Key and Secret Key through one domain-separated HKDF root. The Server stores only the public
key. One signed proof gates release of the encrypted recovery envelope; a second signature binds the
same attempt to every byte of the atomic replacement.

This is a deliberate narrow exception to the preference for complete standard protocols. Reusing
OPAQUE would make recovery unavailable exactly when its pinned version is unsafe. Making migration
Device-only would strand an otherwise recoverable Account. A bearer recovery session was rejected
because the first proof would become a transferable reset credential. The fixed derivation, canonical
messages, state transitions, conformance fixtures, integrated review, and penetration test are all
release-gated with the rest of authentication.
