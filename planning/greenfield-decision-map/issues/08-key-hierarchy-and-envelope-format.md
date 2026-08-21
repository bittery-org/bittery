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

`AUTH-015` fixes exactly one memory-hard run: OPAQUE's Argon2id key-stretching function. OPAQUE's
client-only export key then yields the 32-byte Account Unlock Key under
`bittery/opaque/account-unlock/1`; this ticket owns the one wrapper that consumes it and must add no
second password derivation.

`AUTH-016` fixes profile `0x01` at Argon2id `0x13`, 65,536 KiB, 3 passes, 4 lanes, a 16-byte all-zero
salt, a 64-byte output, and no optional secret or associated data. `AUTH-020` forbids an envelope or
recovery route from carrying its own parameters or silently choosing a weaker profile. The OPAQUE
authenticated context, not a salt label, binds the profile identifier.

## Superseded answer from 2026-08-20

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

## Reopened 2026-08-20

The maintainer requested a full simplicity and standards pass before persisted bytes are frozen.
Reconsider the hierarchy and format from zero under ticket 53's acceptance policy.

In particular, compare the previous HPKE export-only plus separately exported XChaCha20-Poly1305
construction with using an RFC 9180 authenticated-encryption suite directly. Count custom labels,
registries, envelope shapes, encoders, migration paths, and negative-test obligations as security and
maintenance cost. XChaCha20-Poly1305's lack of a final RFC and the bespoke composition are accepted
costs only if a concrete requirement rules out a simpler standardized construction.

The external cryptographic review gate must cover the final derivation, hierarchy, envelope, grant,
revision, recovery, and rotation construction as one system, not authentication alone.

### Inherited from the reopened password authentication decision

OPAQUE's 64-byte export key is now the sole password-derived source for the Account Unlock Key.
`AUTH-002` fixes the narrowing operation as HKDF-Expand-SHA-512 with
`bittery/opaque/account-unlock/1` as `info` and a 32-byte output. This ticket decides the wrapper that
consumes that key; it must not add a second password derivation or reuse the OPAQUE session key.

Changing the OPAQUE protocol, profile, master password, Secret Key, or stable Server identity changes
the export key. Each such ceremony re-wraps the Account Key Set in the same atomic transaction that
replaces the OPAQUE registration. Vault keys must remain untouched.

## Answer

Resolved again with the maintainer on 2026-08-21 under ticket 53's accepted cryptographic design
policy. Promoted to `CRYPTO-001` through `CRYPTO-017` in
[`docs/greenfield/target/product.md`](../../../docs/greenfield/target/product.md), the exact
[`cryptographic-format.md`](../../../docs/greenfield/target/cryptographic-format.md), accepted ADRs
[0010](../../../docs/adr/0010-one-envelope-one-suite-and-a-version-byte-that-names-the-whole-format.md)
and
[0011](../../../docs/adr/0011-vault-grants-are-flat-signed-and-sealed-to-an-account-key-set.md), and
the glossary in [`CONTEXT.md`](../../../CONTEXT.md).

### Resolution

1. **The stable hierarchy survives the standards pass.** OPAQUE's export-derived Account Unlock Key
   wraps one random Account Key Set. Its X25519 key receives Vault keys and its Ed25519 key signs
   authored state. Vault keys encrypt Item revisions directly and wrap per-Attachment keys. Recovery
   and Device unlock wrap the same Account Key Set; no Team key opens Vault content.
2. **The Account Key Set has one exact body.** It is the 32-byte X25519 static secret followed by the
   32-byte Ed25519 signing seed. Public keys are derived after unwrap and must match the published
   Account identity. Credential and protocol changes re-wrap this object and do not fan out through
   Vault grants.
3. **AES-256-GCM-SIV replaces XChaCha20-Poly1305.** RFC 8452 is final, directly permits random
   96-bit nonces, and does not turn an accidental repeat into GCM's key-wide confidentiality and
   authenticity collapse. Ordinary AES-GCM and ChaCha20-Poly1305 fail because offline writers cannot
   coordinate unique nonces. XChaCha fails the accepted policy because its CFRG draft never became a
   final RFC and no unmet property remains. One key is capped at 2^32 envelopes and one envelope at
   32 MiB of plaintext. Those are one joint policy inside RFC 8452's random-nonce bounds, not two
   independent maxima; larger files are chunked.
4. **HPKE is used whole.** Vault keys use RFC 9180 Base mode with
   `DHKEM(X25519, HKDF-SHA256)`, `HKDF-SHA256`, and `ChaCha20Poly1305`. The old export-only plus
   XChaCha recombination is gone. HPKE `info` is `bittery/envelope/hpke/1`; typed envelope context is
   AAD. RSA remains absent.
5. **Durable authenticity stays Ed25519 and is now payload-complete.** A Vault grant signature covers
   its policy fields and the exact HPKE `enc || ciphertext`, so an operator cannot pair valid metadata
   with a substituted Vault key. An Item revision signs its canonical unsigned body directly, then
   stores body and signature inside ciphertext. No application-level payload hash sits between the
   message and RFC 8032.
6. **Two missed forgery cases are closed.** The Account Private Object is signed inside its HPKE
   ciphertext because Base mode lets anyone with the public key create ciphertext to the Account. A
   signed Item revision commits to its ordered Attachment manifest, including wrapped-key bytes and
   every chunk-envelope digest, because a Vault Co-member can otherwise forge chunks with the shared
   Attachment key.
7. **Grants remain flat.** Every Vault key is sealed directly to each member. Team membership alone
   opens nothing and departure rotation touches only affected Vaults. Ticket 04's reopened answer has
   already removed Security History and its Team History Key, so no narrow Team key remains either.
8. **One version names the whole format.** Version `0x01` names AES-256-GCM-SIV, the registered HPKE
   suite, Ed25519, SHA-256, and the byte layouts. There is no negotiation or per-algorithm field. A
   future version uses one explicit resumable decrypt-validate-reencrypt migration; writers never
   dual-write.
9. **The envelope is fixed binary.** Every envelope starts
   `version:u8 | context:u8 | epoch:u32be`. A symmetric body is
   `nonce[12] | ciphertext | tag[16]`; an HPKE body is `enc[32] | ciphertext | tag[16]`. There are no
   inner lengths, optional fields, or ignored trailing bytes.
10. **Typed context is mandatory.** AAD is the complete header plus a per-context binding tuple. The
    tuple begins with stable Server identity and binds the natural Account, Device, Vault, Item,
    revision, Attachment, chunk, grant, or Share identifiers in a fixed order. Byte strings are
    `u16be` length-prefixed. No crypto API accepts a context-free blob. Share snapshots bind the Share
    link, never their source Item.
11. **The context table is closed.** The accepted values remain `0x01`, `0x02`, `0x03`, `0x10`,
    `0x12`, `0x20`, `0x21`, `0x22`, and `0x40` for the Account, Vault-grant, Account-private, Item,
    Attachment, and Share jobs recorded in the format specification. `0x00` and unlisted values fail.
12. **The domain-label registry is literal and lazy.** This ticket freezes
    `bittery/envelope/hpke/1`, the three `bittery/sign/.../1` labels, and
    `bittery/account-fingerprint/1`. It creates no custom HKDF derivation. Speculative recovery,
    Device, Share, and search labels are removed; their owning tickets add one only if their accepted
    designs actually derive a key.
13. **Epoch and Attachment framing stay explicit.** Every header carries a `u32be` epoch and requires
    zero outside Vault-key generations. Each Attachment chunk independently binds its Attachment,
    index, and total count, so truncation and reordering fail without blocking trusted streaming.
14. **The Account Fingerprint is full-width.** It is SHA-256 over its literal label, Account
    identifier, and both public keys, displayed as the complete grouped lowercase hexadecimal value.
    Grants bind it. It remains a manual comparison floor, not automatic key transparency.
15. **Decoding has one closed refusal contract.** Unknown or malformed formats, wrong shapes or
    contexts, noncanonical tuples or signatures, invalid public keys, authentication failure, key
    mismatch, and usage-limit overflow return no plaintext and one non-oracular authenticity outcome.
    A missing known Vault epoch alone is recoverable so its grant can be fetched. Positive and negative
    fixtures cover every context and refusal.
16. **Compatible dependency ranges do not mean release drift.** Initial Rust ranges begin at
    `aes-gcm-siv` 0.12, `hpke` 0.14, and `ed25519-dalek` 3.0, while a committed lockfile fixes each
    released artifact. Automated crypto updates never auto-merge and rerun RFC, Wycheproof, and
    Bittery vectors with proportional review.
17. **Review gates sharpen.** The maintained, conformant, WASM-capable Rust AES-GCM-SIV path lacks a
    direct independent audit, so targeted review of the pinned path blocks beta. The already-settled
    integrated design and implementation review plus penetration test still block general
    availability and cover derivation, hierarchy, envelopes, grants, revisions, recovery, and
    rotation as one system.

### Evidence checked in the reopened pass

- [RFC 8452](https://www.rfc-editor.org/rfc/rfc8452.html) defines AES-GCM-SIV's random-nonce bounds,
  misuse resistance, limits, and Appendix C vectors.
- [RFC 9180](https://www.rfc-editor.org/rfc/rfc9180.html) registers the selected complete HPKE suite
  and supplies Appendix A.2 vectors.
- [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032.html) defines Ed25519 and its vectors.
- The XChaCha document remains an
  [expired CFRG draft](https://datatracker.ietf.org/doc/draft-irtf-cfrg-xchacha/), not a final RFC.
- RustCrypto's [`aes-gcm-siv`](https://docs.rs/aes-gcm-siv/latest/aes_gcm_siv/) documents that the
  crate itself has not been independently audited; its AES and POLYVAL dependencies were in the cited
  NCC review. The maintained crate is `no_std`, carries RFC 8452 and Wycheproof tests, and is usable in
  WASM with host randomness.
- The Rust [`hpke`](https://github.com/rozbb/rust-hpke) crate runs final RFC vectors and is `no_std`;
  Cloudflare documented deploying the same implementation in
  [browser WASM](https://blog.cloudflare.com/using-hpke-to-encrypt-request-payloads/).
- [`ed25519-dalek`](https://docs.rs/ed25519-dalek/latest/ed25519_dalek/) supplies strict, pure-Rust,
  `no_std` RFC 8032 support. The 2019 Dalek review covered its arithmetic dependencies deeply but only
  reviewed the Ed25519 wrapper at high level, so the resolution does not overstate its audit coverage.

### Considered and rejected in the reopened pass

- **XChaCha20-Poly1305:** excellent random-nonce properties, but no final RFC and therefore no longer
  justified under `CRYPTO-POLICY-002` once AES-256-GCM-SIV meets the requirement.
- **AES-256-GCM and ChaCha20-Poly1305:** one accidental 96-bit nonce repeat is catastrophic, while
  offline Devices cannot allocate a coordinated nonce space.
- **AES-SIV:** final-RFC misuse resistance, but a 512-bit external key, a lower invocation bound, and
  weaker Rust implementation assurance than AES-256-GCM-SIV.
- **HPKE Auth mode:** duplicates the durable Ed25519 authentication job and still does not replace a
  persistent signed grant.
- **HPKE export-only:** crosses the bespoke-composition exception bar and adds exporter labels and
  custom envelope logic without an unmet property.
- **Per-Item or per-revision keys:** reduce use per key but add a wrapped-key object and migration path
  for every protected object. Misuse-resistant AEAD removes the need.
- **Deterministic CBOR and algorithm fields:** add canonicalization, parser, downgrade, and decoder
  matrix surface without a required capability.
- **Unsigned Account Private Object or Attachment manifest:** allow ciphertext creation or replacement
  by an actor who has the public key or shared Vault key but not the claimed author's signing key.

No new Wayfinder decision ticket surfaced. Ticket 11 owns how the AES-GCM-SIV usage ceiling triggers
Vault rotation; ticket 29 supplies the canonical role byte; tickets 09, 12, 20, and 30 decide whether
their routes need any new derivation label; ticket 32 supplies operational Attachment limits; and
ticket 49 owns the shared fixture container and runners.
