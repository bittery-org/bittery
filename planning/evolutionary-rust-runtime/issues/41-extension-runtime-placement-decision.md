# Extension Runtime placement decision

Type: task
Status: needs-info
Blocked by: 30, 32, 34
Research: ../sqlite-everywhere-research-2026-08-24.md

## Question

Where does one restorable Extension Runtime/Replica owner live in Chrome MV3, Firefox, and Safari,
and which browser storage engine does each use?

## Decision criteria

Use the host acceptance/live-Sync results and ticket 34's VFS evidence. Retain IndexedDB unless an
alternative proves one recoverable writer across the supported matrix.

For Chrome compare the service-worker owner with an offscreen document plus a combined dedicated
Runtime/Crypto Worker. Decide Firefox/Safari background ownership separately. Normal Web SQLite
success does not prove Extension placement.

Record recovery after suspension, update, Worker/offscreen loss, concurrent popup/content-script
calls, and browser restart, including Desktop connection/lock authority. Later hosts reuse Runtime
policy; a browser adapter does not reimplement it.
