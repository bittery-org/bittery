# Key hierarchy and canonical envelope format

Type: grilling
Status: ready-for-human
Blocked by: 04, 07

## Question

Format altitude, and the most expensive decision on this map to reverse: it is the one that ciphertext is written against.

The frozen product uses AES-256-GCM with AAD and RSA-4096-OAEP as the only asymmetric primitive. There is no X25519 and no Ed25519 anywhere.

Decide:

- The full key hierarchy from master unlock key down to Item and Attachment keys, drawn explicitly, including which keys wrap which.
- AEAD selection per format: XChaCha20-Poly1305 or AES-256-GCM, and why, including nonce strategy and reuse resistance.
- Asymmetric primitive for Vault-key sharing: keep RSA-4096-OAEP or move to X25519, and whether signatures are needed at all.
- The canonical envelope encoding: byte layout, version field, suite identifier, AAD contents, and the suite allowlist a decoder accepts.
- HKDF labels and domain separation strings, written down as literals.
- Key epochs: how an epoch is represented in the envelope, since [vault key rotation](11-vault-key-rotation-and-epochs.md) depends on it.
- Negative vectors: what a decoder must reject, and the fixtures proving it does.

Produces: a versioned format specification, the fixture corpus seed, and an ADR.

### Inherited from ticket 07, key derivation profiles

`AUTH-015` collapses key derivation to **one Argon2id run**: HKDF-Extract mixes in the Secret Key and
HKDF-Expand under two labels produces the Authentication Key seed and the Vault-unlock material. Those
labels now carry the *whole* of the `AUTH-002` domain separation, so this ticket owns the label
namespace and `AUTH-012`'s conformance vectors must pin the exact label bytes. A label collision would
make both outputs the same value and nothing else in the design would catch it.

`AUTH-016` fixes profile 1 at Argon2id `0x13`, 64 MiB, 3 passes, 1 lane, 16-byte salt, 32-byte output.
`AUTH-020` forbids any derivation path from carrying its own parameters or deriving under a profile
weaker than the Account's pinned one, so every envelope this ticket defines inherits the pinned profile
rather than naming parameters of its own.
