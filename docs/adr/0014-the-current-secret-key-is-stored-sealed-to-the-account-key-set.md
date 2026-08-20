# The current Secret Key is stored sealed to the Account Key Set

Status: proposed

Previously accepted; reopened by Wayfinder ticket 09 on 2026-08-20.

The Secret Key had one home: paper, and whatever local state each Device kept. That is fine until it
rotates. `AUTH-027` makes rotation cheap in cryptographic terms, one re-wrap and one re-registration,
but a rotation has to reach the User's other Devices or it is not finished. A Device keeps working on
the old Secret Key, because `AUTH-011` authenticates ordinary traffic with a Device credential and
`CRYPTO-010`'s key context `0x03` opens the Account Key Set locally. The old key only fails at the next
full sign-in, possibly months later, in an airport.

The alternative was re-enrolling every other Device by hand after each rotation. A User with a laptop,
a phone, a work machine and an extension will do two of them and stop, leaving an Account whose
Devices disagree about the current Secret Key.

So `AUTH-027` puts the current Secret Key in an **Account Private Object**, key context `0x12`, sealed
to the Account's own X25519 encryption key. An enrolled Device holds the Account Key Set, so it opens
the object and picks up the rotation on its next sync.

This does put the Secret Key on a Server for the first time, as ciphertext. It widens nothing:
whoever can open the object already holds the Account Key Set, which opens every Vault key the Account
has. The object is worth less than the thing that decrypts it. What it costs is one more field on
`PRIVACY-007`, and the discipline of saying plainly that the Secret Key is now stored rather than only
printed.

## Considered options

**Manual re-enrolment of every Device after a rotation** was rejected: the machinery is simpler and
the outcome is half-rotated accounts.

**Not supporting Secret Key rotation at all** was rejected. A photographed Emergency Kit is a
plausible accident and "create a new Account and export into it" is a poor answer to it.

**Distributing the new Secret Key through the trusted-device QR channel** was rejected as a
device-by-device ceremony wearing a different hat, and it needs both Devices present at once.

**Sealing the object to each Device key instead of the Account key** was rejected: it turns one object
into a fan-out over Devices, and Device enrolment already transports the Account Key Set.

## Consequences

`PRIVACY-007` gained the Account Private Object ciphertext on the Account row, and `CRYPTO-010` gained
key context `0x12`.

`CRYPTO-009` binds the Account identifier into the object's additional authenticated data, so one
Account's object cannot be served in place of another's.

The object is a container, not a single field. Later tickets that need small Account-private state
should extend its plaintext rather than inventing a second object, and the format inside the ciphertext
is versioned for that.

A recovery sign-in rotates the Secret Key under `AUTH-026`, so the object is written on the one path
where the User may have no other Device at all. It must therefore be created at Account creation, not
lazily at first rotation.
