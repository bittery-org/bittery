# Key hierarchy and canonical envelope format

Type: grilling
Status: resolved
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

## Answer

Resolved 2026-08-20 with the maintainer. Requirements `CRYPTO-001` through `CRYPTO-015` in
[`docs/greenfield/target/product.md`](../../../docs/greenfield/target/product.md), with amendments to
`PRIVACY-001`, `PRIVACY-003`, `PRIVACY-004`, and `PRIVACY-007`; ADRs
[0010](../../../docs/adr/0010-one-envelope-one-suite-and-a-version-byte-that-names-the-whole-format.md)
and
[0011](../../../docs/adr/0011-vault-grants-are-flat-signed-and-sealed-to-an-account-key-set.md);
glossary terms in [`CONTEXT.md`](../../../CONTEXT.md).

Twelve decisions, in the order they were taken.

1. **Hierarchy.** `AUTH-015`'s HKDF output is the Account Unlock Key, which wraps a randomly generated
   **Account Key Set** (X25519 encryption, Ed25519 signing). Vault keys seal to that encryption key,
   so a password change, Secret Key rotation, or `AUTH-018` upgrade re-wraps one envelope.
2. **Below the Vault key.** No per-Item key. `PRIVACY-007` gives an Item no wrapped-key column, so a
   per-Item wrapper would live inside the blob and cost a full rewrite to re-wrap. Item ciphertext
   sits under the Vault key of the epoch its envelope names; Attachments keep their own key.
3. **AEAD.** XChaCha20-Poly1305 only. Offline multi-Device writes make a coordinated nonce counter
   impossible, so nonces must be random, and 96 bits is too few for a key covering every Item,
   revision, and Attachment chunk for the life of a Vault.
4. **Sharing.** HPKE (RFC 9180) **export-only** over `DHKEM(X25519, HKDF-SHA256)`, chosen because RFC
   9180 registers no XChaCha suite and export-only keeps the product at one AEAD. RSA-4096-OAEP
   dropped: seconds of keygen in the WASM build, on the signup path.
5. **Teams.** Flat grants, plus a narrow **Team History Key** for Security History alone. A Team Key
   over Vault keys would contradict `TEAM-003` and `TEAM-004` at once.
6. **Versioning.** One format version byte indexing a closed append-only registry naming the whole
   suite. No negotiation, so no downgrade surface. Same governance shape as `AUTH-017`.
7. **AAD.** Header bytes plus a binding tuple the decoder reconstructs from where it found the blob.
   Relocating ciphertext and substituting a revision become **Prevented** rather than Detectable, and
   `PRIVACY-004` was amended to say so. Share links bind the link, never the source Item.
8. **Revisions are signed** with the Account Signing Key, inside the ciphertext, so an operator learns
   no authorship.
9. **Attachments.** One envelope per chunk, binding Attachment id, chunk index, and total chunk count,
   so truncation fails rather than reading as a short file.
10. **Account Fingerprint** defined and bound into the grant signature, because this ticket freezes
    the signed grant field list.
11. **A seventh adversary class, Vault Co-member,** amending resolved ticket 04. Signing revisions and
    grants defends against a member of a shared Vault, whom the six classes had no name for.
12. **`PRIVACY-007` gained three fields:** the wrapped Account Key Set, a granter identifier and grant
    signature per wrapped Vault key, and a wrapped Team History Key per reader.

### Considered and rejected

AES-256-GCM with random 96-bit nonces, on the birthday bound. AES-256-GCM with an HKDF-derived
per-message subkey, which gets the same unlimited-nonce property from FIPS-approved primitives and was
rejected because the product carries no compliance obligation and the construction would need its own
review. AES-256-GCM-SIV, as slower and thinner in audit coverage. A separate suite byte beside the
version byte. HPKE base mode with ChaCha20-Poly1305, safe but a second AEAD. AAD over the header
alone. A tiered Team Key. Deriving the Account Key Set rather than generating it. Sealing Vault keys
to Device keys. Reusing the Authentication Key for grant signatures. Leaving revisions unsigned.

### Open, deliberately

XChaCha20-Poly1305's CFRG draft expired without becoming an RFC and it is not FIPS 140 approved. Both
are recorded in ADR 0010 as accepted costs, not oversights. A future compliance obligation would make
this an expensive reversal.

Notes appended to tickets 09, 10, 11, 12, 15, 20, 21, 27, 29, 30, 31, 32, 38 and 49. Ticket 04 carries
an amendment note for the seventh adversary class and the `PRIVACY-004` and `PRIVACY-007` changes. The
post-quantum fog entry is cleared: content is symmetric, so harvest-now-decrypt-later threatens only
the X25519-sealed Vault keys, and a hybrid KEM would arrive as a new format version rather than a new
field.

