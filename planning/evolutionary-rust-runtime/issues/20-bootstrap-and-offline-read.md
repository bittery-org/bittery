# Bootstrap and offline read

Type: task
Status: claimed
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

### 2026-08-23 — Runtime-owned Bootstrap and offline Item reads

Rust now owns Bootstrap on the staged Replica authority from `522e1681`: bounded pages, pinned
tagged watermark, page fingerprint/resume, old-or-new promotion, Cursor expiry refresh, changes
fetch plus authoritative Item fetch, and hint-only SSE. Persisted rows are encrypted authority
and wrapped keys; Login projections decrypt in memory under the current lock epoch.

Verification covered: cold vs captured-empty, watermark races without a mixed generation,
fingerprint mismatch without promotion, stale Server versions leaving the Cursor unchanged,
Session refresh success and 401-with-preserved Operations, IndexedDB same-revision page writes
and no plaintext markers, and restart-from-durable-Replica: signed-out restore, one online
unlock, disconnected transport, same Items with no further Server fetch. Web ItemList still
owns filter/sort/render.

### 2026-08-23 — Web offline acceptance starts after an online unlock

- A recreated Web Worker or browser session restores encrypted Replica authority with the Account
  signed out. The acceptance flow then performs one online Full Sign-in or password Quick Unlock,
  disconnects the transport, and proves that subsequent reads come entirely from the encrypted local
  Replica.
- Password Quick Unlock remains a complete online SRP ceremony. Issue 20 does not add an offline
  password shortcut, a WebAuthn/platform-authenticator port, or another persistable login credential.
- The separately accepted biometric exception remains available only to hosts that provide its local
  operating-system capability and still does not mint or refresh a Server Session.

### 2026-08-23 — Remaining Bootstrap verification cases

Vault ItemList now consumes Runtime `observe(Items)`; filter, sort, and render stay in the host.
An expired Cursor (`requiresFullRefresh`) marks `RefreshRequired`, starts a new staging generation,
and keeps the previous complete projection readable. Lock during decrypt publishes no plaintext.
Failed authority fetch or commit leaves the prior generation and Cursor unchanged.

Ready for adversarial review of this ticket. Tickets 18 and 21–24 are unchanged.
