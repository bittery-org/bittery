# Key derivation profiles and downgrade resistance

Type: grilling
Status: ready-for-human
Blocked by: 04, 06

## Question

Format altitude. The frozen product uses PBKDF2-HMAC-SHA256 at 600,000 iterations, with `argon2` present only as a reserved comment, and derives the recovery path at **100,000** iterations outside the KDF profile: a 6x weaker route to the same master key. See [current-state verification](../research/current-state-verification.md). Ticket 06 now fixes one Argon2id key-stretching function inside RFC 9807 OPAQUE; its client-only export key yields the Account Unlock Key.

Decide:

- Exact Argon2id parameters and output length, with measurements on the weakest Rust/WASM client rather than an asserted wall-clock budget.
- The finite one-byte profile registry and how a fresh Device discovers its pinned entry without trusting the Server, walking an unbounded registry, or silently falling back.
- Downgrade resistance and legitimate upgrade. An upgrade replaces the OPAQUE registration and Account Key Set wrapper atomically under `AUTH-014`.
- Whether every derivation path, recovery included, is governed by one profile with no weaker exception.
- Master-password minimum and strength guidance, including what a character count means. NFKD UTF-8 bytes are already fixed by ticket 06.

Produces: `AUTH-*` requirements at parameter level, a versioned profile format, and negative test vectors.
### Inherited from ticket 06, password authentication protocol

`AUTH-003` fixes **one Argon2id run inside RFC 9807 OPAQUE**, not a separate authentication and unlock
derivation. OPAQUE's export key feeds the labeled HKDF expansion that produces the Account Unlock Key.
This ticket chooses the Argon2id parameters and output length as an RFC 9807 application profile and
prices them on browser WASM.

The profile identifier is one byte, `0x00` is invalid, and it appears in every OPAQUE header and in the
authenticated context. Device state and the Emergency Kit pin it before KE1. A profile upgrade changes
the OPAQUE registration and export key, so it must use `AUTH-014`'s atomic replacement of the
registration record and Account Key Set wrapper. No registry walk or Server-selected fallback has been
approved; this ticket must define a finite discovery and upgrade rule without creating one.

Ticket 06 fixed NFKD UTF-8 as the master-password bytes and unsigned 16-bit length encoding. This ticket
still owns the password policy, what its character count means, and the exact Argon2id profile.


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

## Reopened 2026-08-20

The profile discovery algorithm is incorrect under its own adversary model. `AUTH-019` tries the
Server-published profile and then only older entries. If an Account is pinned to a newer profile than
a malicious or misconfigured Server publishes, a fresh Device never tries the valid profile and the
Account is locked out.

The second pass must also decide a finite complexity bound for registry walks and migrations. Password
policy must define what "10 characters" counts. Ticket 06 has now fixed compatibility normalization as
NFKD UTF-8 for the OPAQUE input; do not reopen that byte choice here.

Resolve after ticket 06. Apply ticket 53's preference for standard KDF use and a small migration
surface; the previous registry is not binding.
