# Device Unlock Wrapper and quick unlock

Type: grilling
Status: ready-for-human
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

`CRYPTO-010` reserves key context `0x03` and `CRYPTO-011` reserves the HKDF label
`bittery/1/device-unlock`, so the Device Unlock Wrapper wraps the **Account Key Set** envelope, not a
master key and not Vault keys. That fixes what quick unlock must reconstitute and what a Lock must
destroy.

Because `CRYPTO-002` makes the Account Key Set random rather than derived, a quick unlock path that
recovers it does not need the master password anywhere in its chain, and an `AUTH-018` profile upgrade
does not invalidate the wrapper.

### Inherited from ticket 09, recovery model and single-artifact paths

`AUTH-001` makes the Device Unlock Wrapper one of exactly three unlock routes, and it must consume
**two independent factors**: possession of the enrolled Device plus the local authorization the
wrapper requires. A quick unlock that opens the Account Key Set from Device state alone would add a
fourth route without amending `AUTH-001`, and `AUTH-029` renders that as a defect on a screen.

`AUTH-025` leaves the key context `0x03` envelope valid through a master password change, so quick
unlock survives one. This ticket owns what happens to that envelope when a Device is signed out by
`AUTH-026` recovery or by the optional sign-out on `AUTH-025` and `AUTH-027`, within `AUTH-008`'s
limit on Devices that never reconnect.
