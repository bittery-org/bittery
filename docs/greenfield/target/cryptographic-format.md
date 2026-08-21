# Cryptographic format version 0x01

This document fixes the canonical bytes selected by `CRYPTO-001` through `CRYPTO-017`,
`VAULT-ROTATION-007`, and `PRIVACY-018` in
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
| `0x04` | symmetric | Device credential private seed under Device Unlock Wrapper key | Account identifier, Device identifier, runtime host `u8`, authorization method `u8` |
| `0x10` | HPKE | Vault key grant to an Account | Vault identifier, granter Account identifier, recipient Account identifier, recipient fingerprint `[32]`, role `u8`; epoch |
| `0x12` | HPKE | Account Private Object to its own Account | Account identifier |
| `0x13` | HPKE | Search Index Key to its own Account | Account identifier, Device identifier, snapshot identifier `[16]`, derivation version `u16be`, source commit `u64be` |
| `0x20` | symmetric | Item revision under a Vault key | Vault identifier, Item identifier, revision `u64be`; epoch |
| `0x21` | symmetric | Attachment key under a Vault key | Vault identifier, Item identifier, Attachment identifier; epoch |
| `0x22` | symmetric | Attachment chunk under an Attachment key | Vault identifier, Item identifier, Attachment identifier, chunk index `u32be`, total chunk count `u32be` |
| `0x30` | symmetric | Search Snapshot manifest or data under Search Index Key | Account identifier, Device identifier, snapshot identifier `[16]`, derivation version `u16be`, source commit `u64be`, chunk index `u32be`, total chunk count `u32be` |
| `0x31` | symmetric | Suggestion Snapshot manifest or data under Suggestion Index Key | Account identifier, Device identifier, snapshot identifier `[16]`, derivation version `u16be`, source commit `u64be`, chunk index `u32be`, total chunk count `u32be` |
| `0x40` | symmetric | Share snapshot under its Share key | Share-link identifier |

`0x00` and every unlisted value are invalid. A Share snapshot never binds the source Item identifier.

## Local index snapshot formats

Index records are Device-only derived state. They are not synchronized or backed up by Bittery. A
snapshot identifier is 16 random bytes. Every index key is 32 fresh random bytes, every context
`0x30` or `0x31` nonce is independently random, and every index envelope has `key_epoch = 0`.

The ordinary Search Snapshot record is:

```text
SearchSnapshotRecord =
  record_version:u8 | derivation_version:u16be | source_commit:u64be |
  snapshot_id[16] |
  wrapped_key_length:u32be | key_context_0x13_envelope[*] |
  chunk_count:u32be |
  repeated(chunk_length:u32be | key_context_0x30_envelope[*])
```

`record_version` is `0x01`. The context `0x13` plaintext is exactly the Search Index Key. The
recipient is the Account encryption public key from the Account Key Set, and the binding tuple uses
the local Device identifier plus every duplicated record field shown above. The core rejects a key
envelope whose plaintext is not exactly 32 bytes.

The Suggestion Snapshot has the same framing with a Device-protected key record instead of context
`0x13`, and every chunk uses context `0x31`:

```text
SuggestionSnapshotRecord =
  record_version:u8 | derivation_version:u16be | source_commit:u64be |
  snapshot_id[16] |
  protected_key_record_length:u32be | protected_key_record[*] |
  chunk_count:u32be |
  repeated(chunk_length:u32be | key_context_0x31_envelope[*])

DeviceProtectedSuggestionKey =
  record_version:u8 | adapter_id:u8 |
  anchor_reference_length:u16be | anchor_reference[*] |
  sealed_key_length:u32be | sealed_key[*]
```

Both record versions are `0x01`. Adapter `0x01` is Apple Keychain: `anchor_reference` selects one
non-synchronizable `WhenUnlockedThisDeviceOnly` item whose value is the 32-byte Suggestion Index Key,
and `sealed_key_length` is zero. Adapter `0x02` is Android Keystore: `anchor_reference` selects one
non-exportable AES-256-GCM key requiring an unlocked Device but no per-use authentication, and
`sealed_key` is `nonce[12] | ciphertext[32] | tag[16]` for the Suggestion Index Key. Unknown adapters,
empty references, wrong lengths, trailing bytes, unavailable Device-only protection, and keys of any
other length fail closed. The platform adapter releases the random key only into the constrained Rust
core and zeroizes transient copies after use.

For both snapshot kinds, `chunk_count` is 2 through 65,536: chunk zero is one manifest and all later
chunks are data. Every duplicated derivation version, source commit, snapshot identifier, chunk index,
and total count must equal its record and tuple value. Chunk indices are consecutive from zero with no
duplicate, omission, alternate order, or trailing record byte.

```text
IndexManifest =
  chunk_kind=0x00 | payload_length:u64be | data_chunk_count:u32be |
  repeated(data_plaintext_length:u32be | data_digest[32])

IndexDataChunk =
  chunk_kind=0x01 | payload_slice[*]
```

`data_chunk_count = chunk_count - 1`. Every data plaintext is at most 32 MiB, including its kind
byte; every slice except the last is exactly 32 MiB minus one byte. `payload_length` is the sum of
slice lengths. Each digest is SHA-256 of the exact corresponding `payload_slice`. The manifest and all
chunks authenticate before the engine parses or emits any index payload. A length or digest mismatch,
authentication failure, oversized chunk, unknown kind, missing chunk, or partial plaintext fails the
whole snapshot with the same corrupt-derived-state outcome.

## Device Unlock Wrapper format

Every local authorization method owns a separate context `0x03` envelope for one Account and Device.
The envelope plaintext is the complete Account Key Set. The local record that selects it is not sent
to a Server and is not synchronized by Bittery.

### Password quick unlock

Password-wrapper record version `0x01` is:

```text
PasswordUnlockRecord =
  record_version:u8 | key_derivation_profile:u8 | device_factor[32] |
  envelope_length:u32be | key_context_0x03_envelope[*]
```

`record_version` is exactly `0x01`; `0x00` and unknown values fail. `device_factor` is generated from
a cryptographic random source for this record and is stored as ordinary local Device state. It is a
possession input, not a claim of hardware binding or secrecy after local storage is copied.

The password bytes are NFKD UTF-8 under `AUTH-021`. The `Server` and `Account` fields use this
document's `u16be` tuple rule and `Device` is the 16-byte Device identifier.

```text
PasswordQuickUnlockInput =
  label("bittery/device-unlock/password-input/1") |
  format_version:u8 | key_derivation_profile:u8 |
  Server | Account | Device[16] |
  password_length:u16be | password[*] | device_factor[32]

stretched[64] = Argon2id-profile(
  password = PasswordQuickUnlockInput,
  salt = zero[16]
)

PasswordQuickUnlockRoot =
  HKDF-Extract-SHA-512(salt = zero[64], IKM = stretched)

PasswordQuickUnlockInfo =
  label("bittery/device-unlock/password-wrapping/1") |
  format_version:u8 | key_derivation_profile:u8 |
  Server | Account | Device[16]

PasswordQuickUnlockKey =
  HKDF-Expand-SHA-512(PasswordQuickUnlockRoot, PasswordQuickUnlockInfo, 32)
```

`label(x)` is `u16be(len(x)) | ASCII(x)`. Argon2id uses every immutable parameter of the Account's
pinned profile, including the all-zero salt, 64-byte output, and absence of optional secret or
associated data. Empty or over-65,535-byte normalized password input fails before Argon2id. The
derived 32-byte key opens only the record's bound context `0x03` envelope. The stretched value, HKDF
root, and wrapping key are zeroized after the core opens or rejects that envelope.

### Platform quick unlock

One local platform anchor may authorize several Accounts, but it produces a distinct 32-byte wrapping
key for each Server, Account, and Device tuple. A Secure Enclave anchor is installation-wide. A
WebAuthn PRF credential is registered under one Server's RP ID, so Web and Extension keep one PRF
anchor per stable Server and never introduce a central Bittery RP.

For WebAuthn PRF, `eval.first` is the exact ASCII bytes
`bittery/device-unlock/platform-prf/1`. Registration must report PRF enabled, and every unlock must
return `results.first` from a user-verified assertion. Missing output fails without fallback inside
the ceremony. The output is narrowed as follows:

```text
PlatformQuickUnlockRoot =
  HKDF-Extract-SHA-512(salt = zero[64], IKM = prf_results_first[32])

PlatformQuickUnlockInfo =
  label("bittery/device-unlock/platform-wrapping/1") |
  format_version:u8 | Server | Account | Device[16]

PlatformQuickUnlockKey =
  HKDF-Expand-SHA-512(PlatformQuickUnlockRoot, PlatformQuickUnlockInfo, 32)
```

The PRF output and root are zeroized after the batch unlock. A new or re-registered WebAuthn
credential is a new platform anchor and cannot open records under the old one.

On a Secure Enclave Mac, the local anchor is one access-controlled non-exportable P-256 key. Each
Account has an independent random 32-byte wrapping key sealed to that public key with Apple's
`eciesEncryptionCofactorX963SHA256AESGCM` operation. One fresh LocalAuthentication context may
authorize the batch, but each sealed key is opened separately and delivered only to the Rust core.
The Apple sealed blobs are adapter-private local state, not Bittery envelopes or portable backup
material.

### Credential Provider wrapper records

The main host and Credential Provider never select the same local wrapper record. Each Provider
Account has an independently generated password record and, when enabled, an independently generated
platform record. A Provider password record is byte-for-byte the `PasswordUnlockRecord` above with a
fresh `device_factor` and context `0x03` envelope; it introduces no second KDF, cheaper profile, or
Provider derivation label.

A Provider platform record has this canonical outer framing:

```text
ProviderPlatformUnlockRecord =
  record_version:u8 | adapter_id:u8 |
  anchor_reference_length:u16be | anchor_reference[*] |
  sealed_key_length:u32be | sealed_wrapping_key[*] |
  envelope_length:u32be | key_context_0x03_envelope[*]
```

`record_version` is `0x01`. Adapter `0x01` is Apple Security/Secure Enclave and `0x02` is Android
Keystore; `0x00`, unknown values, an empty anchor reference, length mismatch, or trailing bytes fail.
The anchor reference is the exact opaque local identifier used to find the non-exportable platform
key. It is not a Server or Account identifier and grants nothing outside the platform key store. The
core generates one random 32-byte wrapping key per record; `sealed_wrapping_key` is that key protected
by the named anchor, and the wrapping key opens only the record's context `0x03` envelope.

For Apple adapter `0x01`, `sealed_wrapping_key` is the complete byte string returned by
`eciesEncryptionCofactorX963SHA256AESGCM` under a non-exportable P-256 Secure Enclave key carrying
`userPresence`; the keychain record is `WhenPasscodeSetThisDeviceOnly` and non-synchronizable. For
Android adapter `0x02`, the anchor is a non-exportable AES-256-GCM Keystore key with user
authentication required. The sealed bytes are exactly `nonce[12] | ciphertext[32] | tag[16]` under a
fresh uniformly random nonce. The adapter requests StrongBox, falls back to TEE, then to the
system-enforced software Keystore; it reports the runtime security level and never infers it from the
record. Every unlock requires a fresh biometric or Device-credential authorization before the one
unseal operation.

Platform blobs and Provider records are Device-only local state: Bittery does not synchronize or
back them up. The platform adapter releases the 32-byte wrapping key directly into sensitive Rust
memory, where the core opens the Account Key Set and zeroizes the wrapping key. Swift, Kotlin, UI
bindings, and the Suggestion Index never receive it.

### Host Device credential record

The Mobile main host and Credential Provider are one protocol Device and therefore use one Ed25519
Device credential key pair. Runtime host `0x01` is the Mobile main host and `0x02` is its Credential
Provider. Authorization method `0x01` is password quick unlock and `0x02` is platform quick unlock;
zero and unknown values fail. Each available `(runtime host, authorization method)` pair stores:

```text
HostDeviceCredentialRecord =
  record_version:u8 | runtime_host:u8 | authorization_method:u8 |
  envelope_length:u32be | key_context_0x04_envelope[*]
```

`record_version` is exactly `0x01`. The context `0x04` plaintext is exactly the Device credential's
32-byte Ed25519 private seed. The envelope uses the same 32-byte wrapping key as that host and
authorization method's paired context `0x03` Account Key Set envelope; its binding tuple includes the
record's runtime-host and authorization-method bytes. Moving a credential envelope between hosts,
methods, Accounts, or Devices therefore fails authentication.

Enrollment creates the main-host records. Enabling a Provider method requires an unlocked Account
core to rewrap the same seed for that Provider record; no seed crosses a platform or UI binding.
Removing a method deletes its Account and Device-credential records together. Learned Device
revocation, recovery, sign-out, or Account removal removes every host copy. These local duplicate
wrappings create no additional Device Grant and are never synchronized or backed up.

## Canonical authenticated messages

Each message starts with its label as a length-prefixed byte string. Fixed-width fields follow as
shown; identifiers use the tuple rule above.

```text
VaultGrant =
  "bittery/sign/vault-grant/1" |
  format_version:u8 | Server | Vault | key_epoch:u32be |
  granter_Account | recipient_Account | recipient_fingerprint[32] |
  role:u8 | hpke_body_length:u32be | hpke_enc_and_ciphertext[*]

VaultEpochGrant =
  recipient_Account | recipient_fingerprint[32] | role:u8 |
  grant_envelope_length:u32be | key_context_0x10_envelope[*] |
  grant_signature[64]

VaultEpochStatementInput =
  "bittery/sign/vault-epoch/1" |
  format_version:u8 | Server | Vault |
  previous_epoch:u32be | key_epoch:u32be | trigger:u8 |
  membership_revision:u64be | initiator_Account |
  grant_count:u32be | VaultEpochGrant[*]

VaultEpochStatement =
  VaultEpochStatementInput | account_signature[64]

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

Ed25519 signs the protected message inputs directly. The Item and Account Private Object signatures
live inside their ciphertext. The Vault grant signature is a separate 64-byte field beside the HPKE
envelope. SHA-256 of `AccountFingerprintInput` is the full Account Fingerprint.

For a Vault epoch statement, trigger `0x01` is `access-loss`, `0x02` is `usage-limit`, and `0x03` is
`manual`; `0x00` and all other values fail. `previous_epoch` is at least 1 and `key_epoch` is exactly
`previous_epoch + 1`; overflow fails. Every embedded context `0x10` envelope and grant signature must
reconstruct the canonical `VaultGrant` bytes with the statement's format, Server, Vault, epoch, and
initiator. Entries sort by the unsigned lexicographic bytes of `recipient_Account`, with no duplicate,
and are the complete grant set for the bound membership revision. A missing, extra, reordered, or
invalid entry fails the whole statement.

## Device protocol 0x01

Device protocol `0x01` uses Ed25519 credential keys and format `0x01` Account signatures and HPKE.
`0x00` and every other Device-protocol version are invalid. A Device identifier is 16 random bytes.
Surface values are `0x01` Web, `0x02` Desktop, `0x03` Extension, `0x04` iOS, and `0x05` Android;
`0x00` and every unlisted value are invalid.

A Device name is its exact UTF-8 byte string prefixed by `u16be` length. It is 1 through 128 bytes,
uses the shortest valid UTF-8 encoding, and contains none of U+0000 through U+001F or U+007F through
U+009F. It is not normalized or case-folded. Names need not be unique.

### Device status and credential issuance

The Account signing key signs each status input directly. The signature is appended as 64 bytes to
form the event. A **Device Grant** is exactly a signed `DeviceAddInput`.

```text
DeviceAddInput =
  "bittery/sign/device-add/1" |
  format_version:u8 | device_protocol_version:u8 | Server | Account |
  previous_generation:u64be | generation:u64be |
  Device[16] | surface:u8 | name | credential_public_key[32]

DeviceRenameInput =
  "bittery/sign/device-rename/1" |
  format_version:u8 | Server | Account |
  previous_generation:u64be | generation:u64be |
  Device[16] | name

DeviceRevokeInput =
  "bittery/sign/device-revoke/1" |
  format_version:u8 | Server | Account |
  previous_generation:u64be | generation:u64be |
  Device[16]

DeviceAdd    = DeviceAddInput    | account_signature[64]
DeviceRename = DeviceRenameInput | account_signature[64]
DeviceRevoke = DeviceRevokeInput | account_signature[64]

DeviceRevocationBatch =
  revoked_count:u32be |
  (device_revoke_length:u32be | DeviceRevoke[*])[*]
```

An Account begins at Device generation zero with no event. Every event requires
`generation = previous_generation + 1`; overflow fails. The Server also verifies
the route-specific live authority for the exact event before changing state. A revocation batch has at
most 65,535 entries, sorts them by the target Device's unsigned lexicographic identifier bytes, and
advances the generation once per entry without a gap. An empty batch is encoded as a zero count and no
following byte. The Device credential
proves possession of the key named by the grant:

```text
DeviceCredentialProofInput =
  "bittery/device-credential/proof/1" |
  device_protocol_version:u8 | Server | Account |
  device_grant_digest[32]

DeviceCredentialRequest =
  device_protocol_version:u8 | Server | Account |
  device_grant_length:u32be | DeviceAdd[*] |
  credential_proof[64]
```

`device_grant_digest` is SHA-256 of the exact `DeviceAdd` bytes. The Ed25519 Device credential key
signs `DeviceCredentialProofInput`. The Server rejects a request unless every duplicated version,
Server, Account, Device, surface, name, and credential key agrees; the grant is the next valid Add
event; both signatures verify; and the outer full-sign-in, recovery, or trusted-enrollment authority
commits the exact request. This is the canonical request nested by `RecoveryReplacement` and covered
by `AUTH-011`'s HMAC.

The one-time checkpoint transported by trusted enrollment uses current derived Device state, not the
event history. Status `0x01` means active and `0x02` revoked; `0x00` and other values fail. Entries sort
by unsigned lexicographic Device-identifier bytes, with no duplicate identifier. A checkpoint contains
at most 65,535 entries.

```text
DeviceRosterEntry =
  Device[16] | surface:u8 | name | credential_public_key[32] |
  enrollment_generation:u64be | status:u8 | status_generation:u64be

DeviceRosterCheckpointInput =
  "bittery/sign/device-roster/1" |
  format_version:u8 | device_protocol_version:u8 | Server | Account |
  generation:u64be | entry_count:u32be | DeviceRosterEntry[*]

DeviceRosterCheckpoint =
  DeviceRosterCheckpointInput | account_signature[64]
```

### Trusted-Device enrollment

The Server assigns the random attempt identifier and expiry before the new Device signs the attempt.
The credential proof is an Ed25519 signature over the complete input. It proves the credential key at
attempt creation; possession of the X25519 private key is proved only by the encrypted receipt.

```text
EnrollmentAttemptInput =
  "bittery/device-enrollment/attempt/1" |
  device_protocol_version:u8 | Server |
  attempt_id[16] | expires_at:u64be |
  Device[16] | surface:u8 | name |
  credential_public_key[32] | hpke_recipient_public_key[32]

EnrollmentAttempt =
  EnrollmentAttemptInput | credential_proof[64]
```

The QR text is ASCII `bittery-enroll:1:` followed by unpadded base64url of the exact
`EnrollmentAttempt` bytes. A parser accepts no whitespace, padding, alternate alphabet, unknown prefix,
or trailing byte.

The trusted Device runs HPKE sender setup with the suite in this document, Base mode, the QR's X25519
recipient key, and `info = "bittery/device-enrollment/hpke/1"`, then relays this public offer before
any Account secret:

```text
TrustedEnrollmentOffer =
  "bittery/device-enrollment/offer/1" |
  format_version:u8 | device_protocol_version:u8 | Server | Account |
  attempt_id[16] | expires_at:u64be | Device[16] |
  account_fingerprint[32] | hpke_enc[32]
```

The new Device runs receiver setup over `hpke_enc`. Both contexts export four bytes with this exact
exporter context:

```text
ComparisonContext =
  "bittery/device-enrollment/compare/1" |
  enrollment_attempt_digest[32] | enrollment_offer_digest[32]

comparison_integer =
  u32be(HPKE.Export(ComparisonContext, 4)) mod 1000000
```

The two digests are SHA-256 of the exact `EnrollmentAttempt` and `TrustedEnrollmentOffer` bytes. The
value displays as exactly six decimal digits, including leading zeroes, grouped `DDD DDD`. It is never
sent to the Server. A Server that substitutes the Account, fingerprint, encapsulated key, or either
transcript gets an independent exporter value and one online chance in 1,000,000 of matching the
trusted Device's display.

After fresh local authorization and explicit approval of matching displays, the trusted Device creates
the signed Add event and resulting roster checkpoint. Its AAD is:

```text
TrustedEnrollmentBinding =
  "bittery/device-enrollment/binding/1" |
  enrollment_attempt_digest[32] | enrollment_offer_digest[32] |
  device_grant_digest[32] | receipt_nonce_digest[32]
```

The plaintext is:

```text
TrustedEnrollmentPayload =
  format_version:u8 | device_protocol_version:u8 |
  authentication_version:u8 | key_derivation_profile:u8 |
  Server | Account | Device[16] |
  account_key_set[64] | account_fingerprint[32] |
  private_object_generation:u64be |
  private_object_length:u32be | key_context_0x12_envelope[*] |
  device_grant_length:u32be | DeviceAdd[*] |
  roster_checkpoint_length:u32be | DeviceRosterCheckpoint[*] |
  receipt_nonce[32]
```

The relay ciphertext is the HPKE `ciphertext || tag[16]` output; `hpke_enc` lives only in the offer.
`receipt_nonce_digest` is SHA-256 of `receipt_nonce` and is stored with the pending ciphertext; the
nonce itself remains encrypted until receipt. The relay digest is SHA-256 over the exact
`TrustedEnrollmentBinding` followed by the ciphertext. After decryption, the new Device requires every
duplicated Server, Account, Device, fingerprint, version, and digest to agree, derives the Account
public keys from `account_key_set`, checks them against the fingerprint and Server-visible copies,
verifies the private object, grant, and checkpoint, constructs the canonical
`DeviceCredentialRequest`, and signs:

```text
TrustedEnrollmentReceiptInput =
  "bittery/device-enrollment/receipt/1" |
  format_version:u8 | device_protocol_version:u8 | Server | Account |
  attempt_id[16] | relay_digest[32] | receipt_nonce[32] |
  device_request_digest[32]
```

`device_request_digest` is SHA-256 of the exact `DeviceCredentialRequest`. The Server hashes the
presented `receipt_nonce` and matches the pending digest before verifying the signature. The receipt,
request, Add event, checkpoint, relay digest, and attempt state activate in one transaction or none.
The receipt proves both credential-key possession and successful HPKE decryption.

### Device Sessions and HTTP requests

A Device-session challenge is random Server state addressed by `challenge_id`; the Device signs the
complete proof input directly with its credential key:

```text
DeviceSessionProofInput =
  "bittery/device-session/proof/1" |
  device_protocol_version:u8 | Server | Account | Device[16] |
  active_grant_generation:u64be |
  challenge_id[16] | challenge[32] | challenge_expires_at:u64be

DeviceSessionProof =
  DeviceSessionProofInput | credential_signature[64]
```

The first proof submission, success or failure, consumes the five-minute challenge. Success creates a
random `session_id[16]`, an idle deadline thirty minutes after the last accepted request, an absolute
deadline twenty-four hours after creation, a highest counter initially zero, and a 64-bit replay
bitmap initially empty. Counter values are unsigned 64-bit integers starting at one. A value above the
highest shifts the bitmap; a value within the previous 63 positions is accepted only if its bit is
clear; an older value, duplicate, zero, or overflow fails. Status checking and counter acceptance have
one authorization point before application dispatch. A consumed counter is never restored after a later
application failure; retry uses a new counter and the command's ordinary idempotency key.

Ordinary requests implement [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421) with algorithm
`ed25519`. `Bittery-Session` is an RFC 8941 Byte Sequence containing exactly `session_id[16]`.
`Bittery-Counter` is an RFC 8941 Byte Sequence containing exactly the counter's eight big-endian bytes.
Every request, including one with an empty content body, carries the RFC 9530 `Content-Digest` field
with exactly one `sha-256` value.

The `Signature-Input` label is `bittery`. Its covered components, in this exact order, are
`"@method"`, `"@target-uri"`, `"content-digest"`, `"bittery-session"`, and `"bittery-counter"`.
Its parameters are exactly `alg="ed25519"`, `keyid` equal to the 32 lowercase hexadecimal characters
of the Device identifier, and `tag="bittery-device-request"`. There is one 64-byte `bittery` value in
`Signature`. Missing, extra, duplicated, reordered, or differently parameterized coverage fails.
The Server resolves the key only through the Session's active Account and Device Grant, checks current
Device status before every verification, and accepts no Bearer or refresh credential as an alternate.

The dedicated Device-authorized OPAQUE replacement request body is:

```text
DeviceAuthenticationReplacementInput =
  "bittery/sign/device-authentication-replacement/1" |
  device_protocol_version:u8 | Server | Account | Device[16] |
  current_authentication_version:u8 |
  new_authentication_version:u8 | new_key_derivation_profile:u8 |
  expected_authentication_generation:u64be |
  opaque_registration_length:u32be | opaque_registration[*] |
  account_wrapper_length:u32be | key_context_0x01_envelope[*]

DeviceAuthenticationReplacement =
  DeviceAuthenticationReplacementInput | account_signature[64]
```

It is the complete content body of an ordinary RFC 9421 Device-authenticated request. The Server
requires the current Account authentication generation and active Device to match, verifies both
signatures, validates the nested OPAQUE record and envelope before commit, and permits no omitted,
extra, reordered, or trailing field.

Positive and negative fixtures cover every Device event, issuance route, checkpoint order and status,
attempt and QR parse, six-digit value including leading zeroes, HPKE binding, receipt, expiry,
idempotent retrieval, Session proof, RFC 9421 signature base, counter-window edge, revocation, mismatched
identity or generation, invalid signature, relocation, omitted field, alternate encoding, and trailing
byte. Rust and WASM consume identical fixture bytes.

## Recovery protocol 0x01 (`RK1`)

Recovery protocol `0x01` uses the 16 decoded bytes after the printed `RK1` prefix as `RecoveryKey`
and the 16 decoded bytes after `SK1` as `SecretKey`. It computes one RFC 5869 root and two outputs:

```text
RecoveryRoot = HKDF-Extract-SHA-512(salt = SecretKey, IKM = RecoveryKey)

RecoveryInfo(label) =
  label | Server | Account

RecoveryWrappingKey =
  HKDF-Expand-SHA-512(RecoveryRoot, RecoveryInfo("bittery/recovery/wrapping/1"), 32)

RecoverySigningSeed =
  HKDF-Expand-SHA-512(RecoveryRoot, RecoveryInfo("bittery/recovery/signing/1"), 32)
```

`label`, `Server`, and `Account` are each `u16be` length-prefixed. The signing seed is interpreted
exactly as the 32-byte private-key seed in RFC 8032 and yields the 32-byte Ed25519 public key stored in
the recovery authentication record. That record is `recovery_version:u8 | public_key[32]`; `0x00` and
every version other than `0x01` are invalid in this format. The wrapping key protects the key-context
`0x02` envelope. Neither derived value is reused for another job.

The Server generates a fresh random `attempt_id[16]` and `challenge[32]`. Unix times are unsigned
64-bit seconds. The client signs these canonical messages directly with the old recovery signing key:

```text
RecoveryProof =
  "bittery/recovery/proof/1" |
  recovery_version:u8 | Server | Account |
  attempt_id[16] | challenge[32] | proof_expires_at:u64be

RecoveryCommit =
  "bittery/recovery/commit/1" |
  recovery_version:u8 | Server | Account |
  attempt_id[16] | challenge[32] | commit_expires_at:u64be |
  replacement_length:u32be | RecoveryReplacement

RecoveryReplacement =
  authentication_version:u8 | key_derivation_profile:u8 |
  opaque_registration_length:u32be | opaque_registration[*] |
  account_wrapper_length:u32be | key_context_0x01_envelope[*] |
  recovery_record_length:u32be | new_recovery_authentication_record[*] |
  recovery_wrapper_length:u32be | key_context_0x02_envelope[*] |
  private_object_generation:u64be |
  private_object_length:u32be | key_context_0x12_envelope[*] |
  device_revocations_length:u32be | DeviceRevocationBatch[*] |
  device_request_length:u32be | canonical_device_credential_request[*]
```

Every quoted label is encoded as a `u16be` length-prefixed byte string under this document's general
rule. `RecoveryReplacement` contains no optional field: recovery always installs a new Recovery Key
and enrolls the recovering Device. Its revocation batch contains exactly every active old Device in
the stored pre-commit state; the Add event inside its Device-credential request follows the batch's
last generation. Its Device-credential request uses the canonical bytes settled by the Device
enrollment decision. The Server requires the private-object generation to be exactly one greater than
the stored generation, validates every nested record and envelope before commit, and
rejects an unknown version, zero or oversized length, missing or reordered field, trailing byte,
expired or wrong-state attempt, invalid signature, or changed retry. Positive and negative fixtures
cover both derivations, both messages, every nested field, the five-minute proof transition, the
thirty-minute proven transition, byte-identical commit replay, and known-versus-fake failure shapes.

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
