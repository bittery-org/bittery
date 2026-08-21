# Cryptographic format version 0x01

This document fixes the canonical bytes selected by `CRYPTO-001` through `CRYPTO-017` in
[`product.md`](product.md). All integers are unsigned big-endian. A byte string in a tuple is encoded
as `length:u16be | bytes`; a variable protected body in a signature message is encoded as
`length:u32be | bytes`. Encoders emit one form. Decoders reject every other form.

## Suite registry

| Format | Symmetric AEAD | Public-key seal | Signature | Hash |
| --- | --- | --- | --- | --- |
| `0x01` | RFC 8452 AES-256-GCM-SIV | RFC 9180 Base mode: KEM `0x0020`, KDF `0x0001`, AEAD `0x0003` | RFC 8032 Ed25519 | SHA-256 |

`0x00` is invalid. The registry is append-only and has no negotiation or component algorithm fields.

## Envelope grammar

The common prefix is:

```text
format_version:u8 | key_context:u8 | key_epoch:u32be
```

The key context selects exactly one body:

```text
symmetric = nonce[12] | ciphertext[*] | tag[16]
hpke      = enc[32]   | ciphertext[*] | tag[16]
```

The symmetric body is AES-256-GCM-SIV with a fresh uniformly random nonce. The HPKE body is the
registered `enc || ciphertext` output of Base mode with `info = "bittery/envelope/hpke/1"`. In both
shapes, AAD is the complete prefix plus nonce or encapsulated key, followed by the context's binding
tuple. No envelope contains an inner length, optional field, or trailing byte.

## Key-context registry and binding tuples

Every tuple begins with the stable Server identity. Identifiers are `u16be` length-prefixed. The role
is the canonical `u8` assigned by ticket 29; revision and object generation are `u64be`; chunk index
and total chunk count are `u32be`. `key_epoch` is zero unless the table says `epoch`.

| Context | Body | Plaintext purpose | Binding fields after Server identity |
| --- | --- | --- | --- |
| `0x01` | symmetric | Account Key Set under Account Unlock Key | Account identifier |
| `0x02` | symmetric | Account Key Set under recovery wrapping key | Account identifier |
| `0x03` | symmetric | Account Key Set under Device Unlock Wrapper key | Account identifier, Device identifier |
| `0x10` | HPKE | Vault key grant to an Account | Vault identifier, granter Account identifier, recipient Account identifier, recipient fingerprint `[32]`, role `u8`; epoch |
| `0x12` | HPKE | Account Private Object to its own Account | Account identifier |
| `0x20` | symmetric | Item revision under a Vault key | Vault identifier, Item identifier, revision `u64be`; epoch |
| `0x21` | symmetric | Attachment key under a Vault key | Vault identifier, Item identifier, Attachment identifier; epoch |
| `0x22` | symmetric | Attachment chunk under an Attachment key | Vault identifier, Item identifier, Attachment identifier, chunk index `u32be`, total chunk count `u32be` |
| `0x40` | symmetric | Share snapshot under its Share key | Share-link identifier |

`0x00` and every unlisted value are invalid. A Share snapshot never binds the source Item identifier.

## Canonical authenticated messages

Each message starts with its label as a length-prefixed byte string. Fixed-width fields follow as
shown; identifiers use the tuple rule above.

```text
VaultGrant =
  "bittery/sign/vault-grant/1" |
  format_version:u8 | Server | Vault | key_epoch:u32be |
  granter_Account | recipient_Account | recipient_fingerprint[32] |
  role:u8 | hpke_body_length:u32be | hpke_enc_and_ciphertext[*]

ItemRevision =
  "bittery/sign/item-revision/1" |
  format_version:u8 | Server | Vault | Item | revision:u64be | author_Account |
  unsigned_body_length:u32be | unsigned_canonical_revision_body[*]

AccountPrivateObject =
  "bittery/sign/account-private-object/1" |
  format_version:u8 | Server | Account | object_generation:u64be |
  secret_key_payload_length:u32be | canonical_secret_key_payload[*]

AccountFingerprintInput =
  "bittery/account-fingerprint/1" |
  Account | x25519_public_key[32] | ed25519_public_key[32]
```

Ed25519 signs the first three messages directly. The Item and Account Private Object signatures live
inside their ciphertext. The Vault grant signature is a separate 64-byte field beside the HPKE
envelope. SHA-256 of `AccountFingerprintInput` is the full Account Fingerprint.

## Attachment manifest

The unsigned canonical Item revision body contains its ordered Attachment manifest. Each entry binds
the Attachment identifier, exact wrapped-key envelope bytes, chunk count, total byte size, and the
ordered list of SHA-256 digests of the stored chunk envelopes. The Item signature authenticates the
manifest before the revision is encrypted.

## Limits and rejection

One AES-256-GCM-SIV key protects at most 2^32 envelopes. One envelope contains at most 32 MiB
(2^25 bytes) of plaintext. This fixed pair stays inside RFC 8452's random-nonce bounds without a
per-size limit table. The format never attempts to detect nonce reuse.

A decoder returns no plaintext for any failure listed by `CRYPTO-015`. Fixtures include RFC 8452,
RFC 9180 Appendix A.2, RFC 8032, and applicable Wycheproof vectors; one positive vector per context;
and negative vectors for every refusal, relocation, field reordering, context mismatch, signature
failure, and public-key mismatch. Rust and WASM consume identical fixture bytes.
