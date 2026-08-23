# Bootstrap and offline read

Type: task
Status: ready-for-agent
Blocked by: 18, 19
Spec: ../spec.md#bootstrap

## Outcome

Bootstrap the existing encrypted Vault/Item feed into staged Replica generations and publish the same
Items after an offline Worker/browser restart and unlock.

## Work

- Implement current bounded Bootstrap, pinned tagged watermark, page fingerprint/resume, promotion,
  expiry refresh, changes fetch, and hint-only SSE in Rust.
- Store only authoritative encrypted records and wrapped keys; decrypt full projections in Rust memory
  under incarnation/revision/lock-epoch tags.
- Wire the Web Items observation into the existing UI without moving filter/sort/render behavior into
  Rust.
- Run the shared conformance suite against fault-injected IndexedDB and add browser restart acceptance.

## Verification

Cold versus captured-empty, page crash/resume, watermark race, old-or-new promotion, expired Cursor,
failed authority fetch, failed commit, stale version, lock during decrypt, and offline restart cases
pass with no staged or plaintext leakage.

## Comments

### 2026-08-23 — Web offline acceptance starts after an online unlock

- A recreated Web Worker or browser session restores encrypted Replica authority with the Account
  signed out. The acceptance flow then performs one online Full Sign-in or password Quick Unlock,
  disconnects the transport, and proves that subsequent reads come entirely from the encrypted local
  Replica.
- Password Quick Unlock remains a complete online SRP ceremony. Issue 20 does not add an offline
  password shortcut, a WebAuthn/platform-authenticator port, or another persistable login credential.
- The separately accepted biometric exception remains available only to hosts that provide its local
  operating-system capability and still does not mint or refresh a Server Session.
