# One envelope, one suite, and a version byte that names the whole format

Status: accepted

Every byte of Bittery ciphertext is written against the decision this ADR records, which makes it the
most expensive one on the greenfield map to reverse. `CRYPTO-003` fixes XChaCha20-Poly1305 as the only
authenticated encryption algorithm in the product. `CRYPTO-007` fixes a single format version byte
that indexes a closed, ordered, append-only registry naming the entire suite at once. `CRYPTO-008`
fixes the byte layout, and `CRYPTO-009` fixes what the additional authenticated data covers.

XChaCha20-Poly1305 was chosen for one reason that outranks the others: **Bittery cannot coordinate a
nonce counter.** Devices write offline under the same Vault key and reconcile later, so nonces must be
random. A 96-bit random nonce puts the birthday bound near 2^32 messages under a key that covers every
Item, every revision, and every Attachment chunk for the life of a Vault. A 192-bit nonce removes the
question without any coordination. ChaCha20-Poly1305 underneath it is RFC 8439 and carries TLS 1.3,
SSH, QUIC, and WireGuard traffic; the X extension is the XSalsa20 construction with a published
security reduction, shipped by libsodium for a decade.

Two honest costs come with it. The CFRG draft for XChaCha20-Poly1305 expired without becoming an RFC,
so the citation is a draft plus libsodium rather than a standard. And it is not FIPS 140 approved,
where AES-GCM is. Neither binds a product that is MIT-licensed, self-hosted, and carries no compliance
obligation. A future compliance story would make this an expensive reversal, and that is stated rather
than discovered later.

Because RFC 9180 registers no XChaCha20-Poly1305 suite, `CRYPTO-004` uses HPKE in **export-only**
mode: HPKE performs the key agreement and exports a key and a nonce into the same envelope every other
context uses. Export-only mode is the rare option that is both more conformant and simpler, since the
alternative would put a second AEAD in the product for the sole purpose of sealing 32-byte keys.

The version byte is a single byte on purpose. Algorithm agility is a liability, not a feature: every
negotiable field is a downgrade surface, and TLS spent two decades demonstrating it. One byte naming
the whole suite means a decoder has no branch a Server can steer. It is the shape `AUTH-017` already
established for key-derivation profiles, so the codebase governs two registries with one pattern.

`CRYPTO-009` is the requirement most likely to be misread as an optimisation. Binding the object's
identity into the AAD, reconstructed by the decoder from where the blob was found, is what turns
"operator moved this ciphertext somewhere else" from an attack a revision chain notices afterwards
into an attack that simply fails to decrypt. It costs the architecture something real: no component
may hand the cryptographic layer a bare blob, so the local replica interface and the `ClientRuntime`
must carry context through every read and write.

## Considered options

**AES-256-GCM with random 96-bit nonces**, which 1Password and Keeper ship, was rejected on the
birthday bound above. Bitwarden's AES-256-CBC with HMAC-SHA256 was rejected outright: a hand-assembled
composition rather than an AEAD, with RSA-OAEP over SHA-1 alongside it.

**AES-256-GCM with an HKDF-derived per-message subkey** was the strongest rejected option. A 256-bit
random salt per envelope, expanded with the parent key into a message key, gives the same unlimited
random nonce property from FIPS-approved primitives alone. It was rejected because it trades a named,
widely-deployed primitive for a construction the `AUTH-013` reviewer must check, in exchange for a
compliance property this product does not need.

**AES-256-GCM-SIV** was rejected as slower, thinner in library and audit coverage, and still 96-bit
nonced.

**A separate suite identifier alongside the version byte** was rejected. It buys the ability to change
algorithms without changing layout, and costs a second registry plus a decoder matrix of
layout-by-suite combinations, each of which must be tested and each of which must be refused when
invalid.

**HPKE base mode with ChaCha20-Poly1305** was considered and rejected only because it puts a second
AEAD in the product. It is not less safe; HPKE derives a fresh key per seal, so its 96-bit nonce
carries no risk.

**AAD covering the header alone** was rejected. It keeps the storage interface simple and independent
of the cryptographic layer, at the cost of leaving ciphertext relocation and revision substitution to
be noticed rather than prevented.

## Consequences

Adding a format version requires a client release, and every client must hold the new entry before any
Server writes it. Format changes are release-coordinated, like `AUTH-017` profile changes.

No component may hand the cryptographic layer a blob without its context. The replica schema and
storage interface, the `ClientRuntime` interface, and the conformance fixture corpus all inherit this,
and it will not bend later.

A Share link snapshot binds the Share link identifier and never the source Item identifier, or
`PRIVACY-010` unlinkability fails. Any later feature that wants a Share link to remember its origin
must find another way to store it, inside ciphertext.

Post-quantum posture follows from the split: content is symmetric, so harvest-now-decrypt-later
threatens only the X25519-sealed Vault keys, not Item ciphertext. No post-quantum work ships now. The
format registry is where a hybrid KEM would arrive, as a new version rather than a new field.

The product ships no algorithm negotiation, so there is nothing for an external reviewer to check in
that area and nothing for an operator to configure. Every question about which algorithm was used has
exactly one answer per format version.
