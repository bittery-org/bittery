# Device Unlock Wrapper and quick unlock

Type: grilling
Status: resolved
Blocked by: 02, 08

## Question

`ARCH-STORE-002` says the wrapper never stores the master unlock key as an ordinary retrievable value, and `ARCH-STORE-003` says browser storage must not claim native-equivalent guarantees. Neither is specified as an interface. Feeds on [platform authenticator facts](02-platform-authenticator-and-prf-support.md).

Decide:

- The Device Unlock Wrapper interface: what it wraps, what gates the unwrap, and what it may never return.
- Per-platform capability levels for macOS, Windows, Linux, and browsers, and the honest label each carries.
- The browser quick-unlock baseline, and whether WebAuthn PRF is a requirement, an enhancement, or out.
- Auto-lock policy: triggers, timeouts, and what "locked" reveals. The frozen product reveals as little as possible; confirm that stands.
- Recovery when a platform invalidates the key, for example on biometric re-enrolment, without losing the Account.
- Whether an extension and a desktop app on the same machine share one wrapper or hold separate ones.

Produces: an interface specification, per-platform `ARCH-STORE-*` requirements, and seed scenario 11.

### Inherited from ticket 08, key hierarchy and canonical envelope format

`CRYPTO-010` reserves key context `0x03`, so the Device Unlock Wrapper wraps the **Account Key Set**
envelope, not a master key and not Vault keys. `CRYPTO-011` reserves no Device derivation label: add
one only if the chosen platform construction actually derives a key. This fixes what quick unlock must
reconstitute and what a Lock must destroy without pre-deciding the wrapper mechanism.

Because `CRYPTO-002` makes the Account Key Set random rather than derived, a quick unlock path that
recovers it does not need the master password anywhere in its chain, and an `AUTH-018` profile upgrade
does not invalidate the wrapper.

### Inherited from ticket 09, recovery model and single-artifact paths

`AUTH-001` makes the Device Unlock Wrapper one of exactly three Unlock routes. The local route combines
an enrolled Device's held key with the local authorization the wrapper requires; unlike the remote
routes, the inputs are not mislabeled as independent factor categories. A quick unlock that opens the
Account Key Set from Device state alone would add a fourth route without amending `AUTH-001`, and
`AUTH-029` renders that as a defect on a screen.

Before this ticket, `AUTH-025` leaves the existing key context `0x03` envelope valid through a master
password change, so platform quick unlock survives one. This ticket owns the newly introduced
password-bound variant and what happens to every local envelope when a Device is signed out by
`AUTH-026` recovery or by the optional sign-out on `AUTH-025` and `AUTH-027`, within `AUTH-008`'s limit
on Devices that never reconnect.

## Answer

Resolved with the maintainer and promoted to `AUTH-007`, `AUTH-025`, `AUTH-041` through `AUTH-044`,
`CRYPTO-011`, and `ARCH-STORE-002` through `ARCH-STORE-011` in
[`docs/greenfield/target/`](../../../docs/greenfield/target/), the canonical bytes in
[`cryptographic-format.md`](../../../docs/greenfield/target/cryptographic-format.md), seed scenario 11,
the root glossary, and accepted ADR
[0021](../../../docs/adr/0021-password-quick-unlock-is-a-memory-hard-local-wrapper.md).

### One local route, two authorization methods

Quick unlock is the enrolled-Device route into the Account Key Set without a Server or Secret Key.
**Password quick unlock** is the portable baseline. **Platform quick unlock** is an optional faster
method. Each method owns a separate key-context `0x03` envelope for one Account and Device, so no
method protects another method's key and no Account becomes a root for another.

The public `ClientRuntime` returns only unlocked Account capabilities and projections. A platform
adapter may release one account-and-Device-bound 32-byte wrapping key directly into sensitive Rust
memory after authorization. The core opens the Account Key Set, zeroizes that key, and retains the
Account keys only behind its in-memory session. No client binding returns a wrapping key, Account Key
Set, Secret Key, Account Unlock Key, or Vault key.

### Password quick unlock

Every enrolled Device that passes the existing 64 MiB capability gate gets password quick unlock.
The canonical input contains exact domain labels, format and pinned-profile bytes, stable Server and
Account identities, the 16-byte Device identifier, NFKD UTF-8 master password, and a random local
32-byte Device factor. It runs the Account's immutable Argon2id profile once, including profile
`0x01`'s zero salt and 64-byte output, then labeled HKDF-SHA-512 narrows to the 32-byte wrapping key.
Argon2's optional secret and associated-data inputs remain unused. The record format and derivation
bytes are fixed in the cryptographic format document.

The Device factor is ordinary local possession state, not a hardware-secret claim. Anyone who copies
the record can test passwords offline at the pinned Argon2id cost. There is no cheaper local profile,
app rate limit presented as cryptographic protection, or ordinary-keychain shortcut. Full sign-in
creates the first wrapper. Trusted enrollment has the transferred Account Key Set and Secret Key, so
it verifies the entered master password through full sign-in before creating one.

### Platform capability levels

| Environment | Password quick unlock | Platform quick unlock and honest label |
| --- | --- | --- |
| Secure Enclave Mac (Apple silicon or T2) | Baseline | **Hardware-gated quick unlock**. One access-controlled non-exportable P-256 anchor separately unwraps a random key for each Account. |
| Other Mac | Baseline | Unavailable. An ordinary Keychain item is not presented as Secure Enclave gating. |
| Windows | Baseline | Unavailable. Documented Windows Hello is sign-only; DPAPI, PasswordVault, and Credential Manager are handed-back storage. No signature-derived Bittery KDF is introduced. |
| Linux | Baseline | Unavailable. Secret Service mandates no access-control or hardware-binding floor. |
| Web or Extension | Baseline | **Authenticator-gated quick unlock** only after conformance and a runtime user-verified WebAuthn PRF result. PRF is an enhancement, never a browser requirement. |

WebAuthn PRF supplies one local-anchor root per stable Server and RP ID. Labeled HKDF-SHA-512 separates
it by Server, Account, and Device. A Secure Enclave uses one installation-wide anchor and never
exports a root: it unwraps one independent random 32-byte key per Account instead. Both adapters
therefore expose the same core operation—release this Account's key after one fresh ceremony—without
forcing the platform primitives into a false common shape. A standalone multi-Server Extension may
need one PRF ceremony per Server; Desktop delegation may still open them together.

Platform quick unlock is explicitly enabled per Device after password quick unlock. Existing Accounts
are confirmed individually; a later Account asks once before joining the anchor. A fresh platform
authorization may batch all joined Accounts, but its authorization context dies at Lock. Permanent
key, credential, biometric, or passcode invalidation removes only the unusable platform record and
falls back to password quick unlock. Re-enabling is explicit after successful password quick unlock;
there is no weak reserve copy or automatic rebinding.

### Shared locked screen and Desktop delegation

One entered master password is tried sequentially against independent local wrappers with one
Argon2id allocation at a time, and every matching Account opens. One platform ceremony likewise opens
every Account joined to that local anchor, subject to WebAuthn's per-Server boundary. Accounts that do
not match stay visibly locked. This
matches the documented 1Password interaction without adopting its primary-Account key dependency:
[multiple Accounts](https://support.1password.com/multiple-accounts/) and
[adding an Account](https://support.1password.com/add-account/) say one password opens all Accounts
using that password; the exact internal checking algorithm is not public.

Desktop and Extension remain separate Devices with separate grants and wrapper records. When the
Desktop is present and unlocked, the Extension may delegate only the Vault operations allowed by the
authenticated IPC that [Desktop architecture and the extension IPC](42-desktop-architecture-and-ipc.md)
will specify. It receives no Desktop Account Key Set or wrapping key and keeps its own password-wrapper
fallback when Desktop is absent, stopped, or locked.

### Lock policy and password changes

Auto-lock is Device-wide. It defaults to ten minutes and offers 1, 5, 10, 30, or 60 minutes; there is
no never value. Real User interaction in Bittery resets the timer. Background Sync, web-page activity,
and unauthorised IPC do not. Explicit Lock, OS session lock, suspend or hibernate, process or browser
runtime termination, and learned Device revocation lock immediately. Lock zeroizes core Account and
wrapping keys before publishing the locked projection while preserving encrypted state and valid
wrappers.

The locked screen shows only a User-chosen local Account label, lock reason, and available Unlock
routes. It shows no email, Server address, Vault or Item data, Team data, count, activity, or blurred
snapshot. Platform quick unlock periodically requires password quick unlock after 30 days by default;
the Device-wide choices are 14, 30, 60, or 90 days or disabled. This is a reminder policy, not a new
factor.

A password change on the initiating Device prepares its new password wrapper and activates it after
the Server's atomic registration-and-`0x01`-wrapper replacement. A different Device that learns a
newer authentication generation may use its old wrapper only inside a migration state that reveals no
Vault data. It asks for the new master password, obtains the current Secret Key from the now-open
signed Account Private Object, completes full sign-in, and atomically replaces its local wrapper.
An offline copy may still expose old local state under old secrets; no password change claims remote
erasure.

Recovery, sign-out, or ordinary revocation that the Device learns locks and removes its local wrapper
records. An offline Device may retain previously held data until it reconnects, as `AUTH-008` already
states. Seed scenario 11 now exercises permanent platform-anchor invalidation, password fallback,
explicit replacement, and preservation of the encrypted Account state.
