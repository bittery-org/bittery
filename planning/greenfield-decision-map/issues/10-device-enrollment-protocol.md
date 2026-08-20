# Device enrollment protocol

Type: grilling
Status: ready-for-human
Blocked by: 08, 09

## Question

`AUTH-004` names three enrollment paths (trusted-device QR, master password plus Secret Key, Emergency Kit) and says the Server alone cannot provision decryption keys. The protocol behind the QR path does not exist yet.

Decide:

- The trusted-device enrollment protocol end to end: channel, authentication of both ends, what the QR payload carries, replay and relay resistance, and expiry.
- Whether the existing device must approve explicitly, and what it displays so a user can detect a relay attack.
- What the Server sees during enrollment, checked against the closed plaintext list.
- Device identity: how a Device is named, keyed, and listed, and whether it holds a device keypair.
- Enrollment when the user has exactly one device and it is lost.
- Rate limiting and abuse on the enrollment endpoints.

Produces: an enrollment protocol specification, `AUTH-004` refinement, and seed scenarios.

## Comments

### Inherited from ticket 04, threat model and server-visible plaintext

`PRIVACY-004` makes silent Device enrollment Detectable, not merely audited. Every existing Device of
an Account must be told when a Device is enrolled, and the notification cannot depend on the Server
choosing to deliver it. `PRIVACY-007` puts the Device name in Server-visible plaintext, so enrollment
carries a user-chosen label the operator reads.
### Inherited from ticket 06, password authentication protocol

`AUTH-011` makes the full sign-in protocol authenticate **enrolment and full sign-in only**. Every
ordinary request runs on a Device credential this ticket defines: its shape, its lifetime, how it is
issued at the end of a successful full sign-in, and what forces a Device back to a full sign-in.

Device state must hold the **key-derivation profile identifier** under `AUTH-010`, because there is no
pre-login exchange that could supply it.

`AUTH-014` requires that a protocol-version rotation be a specified path: each client re-derives and
re-registers its Authentication Key at next full sign-in while the Server refuses the superseded version.
Decide how an enrolled Device with a live Device credential is driven back to a full sign-in when that
happens.

### Inherited from ticket 07, key derivation profiles

`AUTH-019` fixes how a Device with no local state learns the Account's **pinned key-derivation
profile**: from the Emergency Kit, which prints it, or by attempting the Server's published profile and
then each older registry entry in descending order. There is no Server endpoint and no per-Account
profile stored Server-side, because that would reinstate the account-existence oracle ADR 0007 closed.
Each walk attempt costs one Argon2id run, so enrolment must report a wrong password only after the walk
completes, and the enrolment UI must account for that wait.

Device state holds the pinned profile identifier. `AUTH-018` requires an upgrade offer at the end of a
full sign-in when the Server publishes a stronger profile, so enrolment is one of the two moments that
offer can appear.

### Inherited from ticket 08, key hierarchy and canonical envelope format

`CRYPTO-001` settles what enrolment actually transports: the **Account Key Set**, not a set of Vault
keys. Vault keys seal to the Account encryption key, never to a Device key, so a new Device that holds
the Account Key Set can open every Vault the Account was granted without the Server re-wrapping
anything. `CRYPTO-010` reserves key context `0x03` for the Account Key Set under a Device Unlock
Wrapper key, which is where the enrolled Device parks it.

A Device key pair still exists, but only for the `AUTH-011` Device credential on ordinary traffic. It
never receives Vault content. `CRYPTO-014`'s Account Fingerprint is the natural thing for a QR
enrolment to display and confirm.

### Inherited from ticket 09, recovery model and single-artifact paths

`AUTH-004` now names the three enrolment inputs as trusted-device QR, master password plus Secret Key,
and the `AUTH-026` recovery sign-in. A fresh Device reads the Server address, the Account email, the
Secret Key, the profile identifier and the Account Fingerprint from the Emergency Kit, and `AUTH-024`
gives it a check symbol to validate before any derivation runs.

Enrolment must deliver the `AUTH-027` Account Private Object alongside the Account Key Set, or a
Device enrolled before a Secret Key rotation will never learn the current Secret Key.

`AUTH-026` ends a recovery by signing out every other Device, and `AUTH-025` and `AUTH-027` offer the
same sign-out with it off by default. What "sign out every other Device" does to a Device that is
offline is this ticket's to specify, inside `AUTH-008`'s existing limit.
