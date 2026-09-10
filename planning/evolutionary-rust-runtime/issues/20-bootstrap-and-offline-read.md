# Bootstrap and offline read

Type: task
Status: resolved
Blocked by: 18, 19
Spec: ../spec.md#bootstrap

## Delivered

Delivered staged Bootstrap, Cursor expiry recovery, encrypted authority, and offline projections.
Web restart requires one online Full sign-in or Quick Unlock before disconnecting for offline
reads; it introduces no offline password ceremony. [Ticket 35](35-empty-vault-bootstrap.md)
adds empty-Vault authority; [ticket 36](36-web-offline-authority-read.md) proves the offline read.
Long-lived Sync remains [ticket 30](30-runtime-owned-live-sync.md).

## Contract

- Implement current bounded Bootstrap, pinned tagged watermark, page fingerprint/resume, promotion,
  expiry refresh, and changes fetch in Rust.
- Store only authoritative encrypted records and wrapped keys; decrypt full projections in Rust memory
  under incarnation/revision/lock-epoch tags.
- Wire the Web Items observation into the existing UI without moving filter/sort/render behavior into
  Rust.
- Run the shared conformance suite against fault-injected IndexedDB and add browser restart acceptance.

## Verification

Cold versus captured-empty, page crash/resume, watermark race, old-or-new promotion, expired Cursor,
failed authority fetch, failed commit, stale version, lock during decrypt, and offline restart cases
pass with no staged or plaintext leakage.
