# Key derivation profiles and downgrade resistance

Type: grilling
Status: resolved
Blocked by: 04, 06

## Question

Format altitude. The frozen product uses PBKDF2-HMAC-SHA256 at 600,000 iterations, with `argon2` present only as a reserved comment, and derives the recovery path at **100,000** iterations outside the KDF profile: a 6x weaker route to the same master key. See [current-state verification](../research/current-state-verification.md). `AUTH-002` domain-separates authentication from Vault-key derivation, so a full sign-in runs two expensive KDFs on the weakest devices.

Decide:

- Argon2id parameters per platform class, or a reasoned choice of something else, with a benchmark budget that is measured rather than asserted.
- Unicode normalisation and encoding of the password before derivation.
- The profile record: how parameters are represented, versioned, and upgraded.
- Downgrade resistance. The frozen client pins parameters after first use so they cannot be silently weakened; this has no successor requirement. Decide whether pinning is a `MUST` and what happens on a legitimate upgrade.
- Whether every derivation path, recovery included, is governed by one profile with no exceptions.
- The combined cost of two KDFs on a low-end device, and whether that changes `AUTH-002`.

Produces: `AUTH-*` requirements at parameter level, a versioned profile format, and negative test vectors.
### Inherited from ticket 06, password authentication protocol

`AUTH-010` makes key-derivation parameters **Server-wide and published in the Server descriptor**,
never per Account. There is no pre-login exchange left to carry per-Account parameters, and removing
them also removes the vector where a Malicious Operator hands one Device weaker parameters than
another. This ticket owns what the published profile contains, how the client pins it, and what a
parameter upgrade looks like when it necessarily applies to every Account at once.

`AUTH-003` fixes **two independent Argon2id runs per full sign-in**, one producing the Authentication
Key and one producing Vault-unlock material. Profile selection must be priced against double cost on
the weakest hardware, which is browser WASM. `AUTH-011` bounds how often that cost is paid: enrolment
and full sign-in only.

The Authentication profile identifier is not secret and lives in Device state and on the Emergency Kit,
because the Server cannot supply it before a full sign-in begins. Decide whether the Vault-unlock
profile is carried the same way or separately.


## Answer

Resolved 2026-08-20 with the maintainer. Requirements `AUTH-015` through `AUTH-021` in
[`docs/greenfield/target/product.md`](../../../docs/greenfield/target/product.md); ADRs
[0008](../../../docs/adr/0008-memory-hard-work-is-spent-once-and-only-on-human-secrets.md) and
[0009](../../../docs/adr/0009-key-derivation-profiles-are-a-closed-append-only-registry.md);
glossary terms in [`CONTEXT.md`](../../../CONTEXT.md).

### One memory-hard run, not two

`AUTH-003` claimed the Vault-unlock derivation was "a second, independent memory-hard run". It is not.
HKDF-Expand under two labels already gives the domain separation `AUTH-002` asks for: sibling outputs
are computationally independent in both directions. A second Argon2id run over the same password adds
no entropy, no new secret, and no new independence, and doubles the cost on browser WASM, the weakest
supported build. `AUTH-015` fixes one run; `AUTH-003` is amended. The frozen product's single PBKDF2
plus HKDF split was right about this.

### Profile 1

Argon2id version `0x13`, 64 MiB, 3 passes, 1 lane, 16-byte salt, 32-byte output (`AUTH-016`). One
lane because a browser Worker is single-threaded without cross-origin isolation headers, which cannot
be relied on; more lanes give a single-threaded build no speedup and cover less memory each. 64 MiB
was chosen over 128 MiB because a 128 MiB allocation may fail inside an extension background context
or a future mobile autofill extension, and that failure is a lockout rather than a slowdown.

The salt is 16 bytes of HKDF-Expand output from the Secret Key, under a label carrying the profile
identifier. Argon2id's optional secret parameter is unused, because it is the least exercised corner
of Argon2 bindings and a binding that ignores it fails silently. Server identity is not bound into the
salt: the signed sign-in message binds it already, and binding it here would make an operator changing
Server identity a lockout event.

Parameters are the normative contract and the product states **no wall-clock budget**. A time gate in
CI was rejected: hardware varies too much for a time target to mean much, and a noisy runner failing
unrelated pull requests would get the gate removed. Measurement is a one-off sanity check recorded in
the `AUTH-012` design note before an entry is frozen.

### Closed, append-only registry

Every client compiles in an ordered registry of frozen profiles; the Server descriptor names one entry
and publishes no parameters (`AUTH-017`). An unknown identifier means "update your client", never
"derive with what I sent you", so a Malicious Operator publishing weak parameters achieves nothing.
Downgrade resistance is an integer comparison rather than parameter validation.

Entries are never removed. Retiring one does not discourage old Accounts, it destroys every Account
still pinned to it, including one whose owner declined an upgrade or has not signed in for years.

### Pinning, upgrade, and downgrade

An Account is pinned to the profile it was created under and derives under it whatever the Server
publishes (`AUTH-018`). A stronger published profile becomes an upgrade offer at the end of a full
sign-in, while the master password is in hand; the User may decline and is asked again. The upgrade
re-derives both HKDF outputs and re-wraps what the Vault-unlock material protects, which is the master
password change path, not a new mechanism. A weaker published profile is derived past and written to
Security History: a downgrade attempt is **Detectable**.

A Device with no local state finds its profile from the Emergency Kit, which prints it, or by trying
the published profile and then walking older entries in descending order (`AUTH-019`). Each attempt
costs one derivation, so a genuinely wrong password is reported only after the walk. A Server endpoint
returning the profile was rejected: it reinstates the account-existence oracle ADR 0007 closed. The
Server stores no per-Account profile, so `PRIVACY-007`'s plaintext allowlist is unchanged.

### Which paths are stretched

The memory-hard step governs every path consuming a user-chosen secret. A path uses HKDF alone only
where every secret it consumes is machine-generated with at least 128 bits (`AUTH-020`). The frozen
product's 100,000-iteration recovery path against a 600,000-iteration main path is fixed by removing
the stretch from paths that never needed it, not by tuning a second number someone must keep in step.
No path may derive under a profile weaker than the pinned one.

### Password bytes and policy

UTF-8 after NFKD normalization, no trimming, no case folding, empty refused (`AUTH-021`). NFKD over
NFC because it also folds fullwidth characters and ligatures, so a password entered through an IME
derives the same key on every platform; the entropy fold is negligible for human-chosen passwords, and
a cross-platform byte mismatch is an undiagnosable lockout.

Minimum length is 10 characters with no composition rules, plus an advisory strength estimate and a
generated-passphrase offer. The estimate is backed by zxcvbn in the first release. A common and
breached password blocklist is deliberately deferred to a later release; the maintainer's decision is
that zxcvbn ships first and the blocklist follows.

A Server cannot enforce master password policy, because no Server ever sees a master password. An
administrator has no lever here, which the administration work must state rather than imply.

### Handed to other tickets

- **Recovery model:** the Emergency Kit and any Recovery Key must be machine-generated with at least
  128 bits, or `AUTH-020` denies them the HKDF-only path.
- **Key hierarchy and envelope format:** the HKDF labels are the whole of the domain separation, so
  `AUTH-012`'s conformance vectors must pin them. A label collision would make both outputs equal and
  nothing else would catch it.
- **Vault key rotation and crash safety:** a profile upgrade is a resumable re-wrap. An interruption
  must not strand an Account between two profiles.
- **Extension, Desktop, and mobile architecture:** any surface performing a full sign-in must allocate
  64 MiB. The registry is append-only, so this does not bend later.
- **Administration:** master password policy is unenforceable Server-side.
