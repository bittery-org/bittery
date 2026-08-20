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
