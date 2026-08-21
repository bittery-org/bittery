# Key derivation profiles and downgrade resistance

Type: grilling
Status: resolved
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

## Answer — second pass 2026-08-21

Resolved with the maintainer and promoted to `AUTH-015` through `AUTH-021` in
[`docs/greenfield/target/product.md`](../../../docs/greenfield/target/product.md), accepted ADRs
[0008](../../../docs/adr/0008-memory-hard-work-is-spent-once-and-only-on-human-secrets.md) and
[0009](../../../docs/adr/0009-key-derivation-profiles-are-a-closed-append-only-registry.md), and the
[`CONTEXT.md`](../../../CONTEXT.md) definitions of Profile registry and Pinned profile. Local benchmark
evidence is recorded in
[`research/key-derivation-profile-benchmark.md`](../research/key-derivation-profile-benchmark.md).

### Profile `0x01`

Profile `0x01` is Argon2id version `0x13`, 65,536 KiB, three passes, four lanes, a 16-byte all-zero
salt, a 64-byte output, and no optional secret or associated data. This is RFC 9106's
memory-constrained recommendation adapted to RFC 9807's `T = Nh` ristretto255/SHA-512 configuration.
The earlier one-lane, Secret-Key-derived-salt, 32-byte profile is rejected: it departed further from
the standards and the one-lane comparison showed no consistent WASM benefit.

A throwaway RustCrypto 0.5.3 benchmark completed at 64 MiB in native Rust and Rust-generated WASM.
Native samples were about 118 ms; Node WASM samples were 182–308 ms. This proves allocation in the
available environment, not performance on a weakest Device or either browser. Release therefore gates
on successful allocation and repeated vector completion on the approved low-end Rust/WASM baseline for
every full-sign-in client, including Chromium and Firefox. Time and peak memory are reported; there is
no cryptographic time threshold, and the Performance budgets decision owns user-visible limits.

### Finite monotonic registry

The complete profile identifier space is `0x01` through `0xFF`; `0x00` is invalid. Entries are
immutable and never removed or reused. A higher entry is admitted only when integrated review finds it
no weaker on every accepted security dimension. A construction that is incomparable with an existing
profile requires a new authentication-protocol version rather than a misleading larger number.

Each Account occupies exactly one entry. Migration moves directly to one higher entry through the
atomic OPAQUE-registration and Account-Key-Set-wrapper replacement already fixed by Password
authentication protocol and its fallback. There is no registry window, retirement state, dual
registration, or search. The one-byte space is the hard complexity bound.

### Client-carried discovery, not a walk

The pinned profile is authoritative client-carried state. An enrolled Device stores it, trusted-device
enrollment transports it, and the Emergency Kit prints it as a separate field beside the stable `SK1`
Secret Key code. A fresh Device must get the pin from one of those carriers before KE1. It never asks a
per-Account Server endpoint, accepts a Server-selected pin, or tries registry entries.

This deliberately makes a standalone Secret Key or stale Kit insufficient for fresh full sign-in. The
alternative is worse: the first-pass downward walk could not find a valid pin newer than a false Server
preference, an exhaustive walk grows, and a bounded window eventually strands Accounts. Missing,
stale, and unsupported pins refuse with recovery guidance rather than a wrong-password report.

### Upgrade and downgrade

A Server descriptor may advertise one deployment-preferred identifier but no parameters. After full
sign-in, a client offers it only if it is compiled, deployment-supported, and greater than the pin.
The User may defer indefinitely. Acceptance updates the registration, wrapper, client pin, and
Emergency Kit without pretending those cross-system writes are one transaction: the User first saves
the updated Kit, the Server then atomically replaces the registration and wrapper, and the client
records the new pin after confirmation.

A lower or unknown preference never changes derivation and produces a persistent local security
warning. Registration data inconsistent with the pin fails authentication under the authenticated
OPAQUE context and never triggers fallback. Blocking merely on the descriptor mismatch was rejected:
the pin already preserves cryptographic security, while blocking would add another operator-controlled
denial-of-service switch.

### Memory-hard work follows entropy

Every route consuming any human-chosen secret runs the Account's pinned profile. HKDF-only is allowed
only when every consumed secret is independently machine-generated with at least 128 bits. This removes
the frozen product's 100,000-iteration recovery door without wasting Argon2id on random secrets or
creating route-specific parameters.

### Master-password policy

The OPAQUE bytes remain NFKD UTF-8 without trimming or case folding. The minimum is 15 Unicode code
points in the entered string before normalization. There is no separate character maximum beyond the
unsigned 16-bit bound of 65,535 normalized UTF-8 bytes, and there are no composition or periodic-change
rules.

Every client bundles the same versioned common-and-compromised-password blocklist. Rejection compares
the complete candidate and entry after NFKD plus Unicode Default Case Folding under the Unicode data
version pinned by that blocklist; it checks no substring or Account-specific contextual value. The
comparison does not alter the OPAQUE input. There is no online lookup, administrator knob, or mandatory
estimator score. Clients show an advisory strength estimate and offer generated passphrases.

### Handed to other decisions

- **Key hierarchy and canonical envelope format:** the Account Unlock Key comes from OPAQUE's export
  key; there is no KDF salt label or second password derivation for an envelope to inherit.
- **Recovery model and single-artifact paths:** both recovery secrets must retain their independent
  128-bit generation floor to qualify for HKDF-only work.
- **Device enrollment protocol:** a fresh Device receives the separate pin from the Emergency Kit or
  trusted enrollment; no wrong-password registry walk exists.
- **Vault key rotation and epochs:** a profile migration atomically replaces one registration and one
  Account Key Set wrapper; it is not a Vault rotation plan.
- **Administration, registration, and retention:** all master-password acceptance behavior is local;
  the operator has no policy or per-Account profile diagnostic.
- **Extension architecture for Chromium and Firefox**, **Desktop architecture and the extension IPC**,
  and **Mobile architecture seams:** any surface performing full sign-in must pass the 64 MiB capability
  gate or relinquish that route.

The breached-password blocklist fog entry is cleared. No new decision ticket surfaced.
