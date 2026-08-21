# One envelope version names a complete standard suite

Status: accepted

Persisted bytes are Bittery's most expensive compatibility commitment. Format `0x01` therefore names
the whole suite and byte layout at once: RFC 8452 AES-256-GCM-SIV for symmetric envelopes, complete
RFC 9180 HPKE Base mode for public-key sealing, Ed25519 for durable signatures, and SHA-256. There is
no negotiation, component algorithm field, export-only HPKE composition, or dual-write migration.

AES-256-GCM-SIV replaces the previously accepted XChaCha20-Poly1305 design. Offline Devices cannot
coordinate a nonce counter, so ordinary AES-GCM and ChaCha20-Poly1305 fail the threat-model filter.
XChaCha makes random collisions negligible but has no final RFC, while RFC 8452 directly permits
random 96-bit nonces and prevents a repeated nonce from becoming the catastrophic key-wide failure it
is under GCM. Its two-pass cost is accepted for a password manager. One key is limited to 2^32
envelopes and one envelope to 32 MiB of plaintext, a fixed joint policy inside RFC 8452's
random-nonce bounds; larger files are already chunked.

HPKE uses the registered X25519/HKDF-SHA256/ChaCha20-Poly1305 suite in Base mode. The earlier
export-only design was rejected on the reopened pass because recombining an exported key with
XChaCha crossed the bespoke-construction gate even though both pieces were individually sound.
Ed25519 separately authenticates durable grant and revision semantics, a different security job from
recipient encryption.

One fixed binary envelope has a common version, context, and epoch prefix with the two bodies forced
by those jobs: a random nonce plus AES-GCM-SIV ciphertext, or an HPKE encapsulated key plus HPKE
ciphertext. Typed binding tuples authenticate where each object was found. A component may never hand
the crypto layer a context-free blob.

The Rust AES-GCM-SIV implementation is maintained, vector-conformant, and WASM-capable but has not
itself received an independent audit. Targeted review of the pinned implementation path therefore
blocks beta. Releases use committed lockfile resolutions; compatible manifest ranges do not permit
automatic crypto updates to enter a release.
