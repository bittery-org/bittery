# Runtime session lifecycle, lock, and observation delivery

Type: task
Status: resolved
Blocked by: 26
Spec: ../spec.md#sign-in-and-session-behavior

## Delivered contract

- `Lock` and `SignOut` retire live keys, plaintext delivery, and decrypted Items; advance the durable
  lock epoch; and publish the resulting access state. Lock retains Quick Unlock material and
  Session. Sign-out deletes both for the active incarnation while retaining the Account, Replica,
  and accepted Operations. It does not revoke the Server Session.
- Production startup restores `Locked` when usable Quick Unlock material and the Device key remain,
  otherwise `SignedOut`. No missing credential is rendered as an empty Vault.
- One Device-wide `RuntimeStatus` observation supplies Session state. The shallow client reconciles
  the host's active-Account pointer against it; an explicit Quick Unlock target takes precedence.
- Background publications wake a binding drain outside Runtime locks and plaintext delivery leases.
  The host receives them without a request in flight.
- Route guards use Runtime status. The fake `runtime-session` bearer and localStorage Session mirror
  were removed. Browser client IDs and the build version identify real Sessions.

[Ticket 48](48-runtime-account-removal-and-wipe.md) adds explicit destructive removal/Wipe and maps
the Web “Log out” gesture to confirmed removal. It is distinct from Runtime `SignOut`.

## Verification

Tests prove key/plaintext retirement, pending Operation preservation, Locked restart and Quick
Unlock, unsolicited projection delivery, explicit Account targeting, and distinct browser identity.
The original full CI gates passed; later host integration is tracked in ticket 58.
