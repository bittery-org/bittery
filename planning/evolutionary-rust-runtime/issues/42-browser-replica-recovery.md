# Browser Replica recovery and export

Type: task
Status: needs-info
Blocked by: 38, 39, 40, 41

## Outcome

Browser storage corruption, capability loss, quota failure, and export/import have explicit behavior
which never translates an unreadable Replica into successful discard of accepted Operations.

## Decision frontier

Ask the maintainer in German which diagnostic/export surface ships, what an export includes, and when
authoritative re-Bootstrap is allowed after quarantining a corrupt Replica. Recommend preserving or
proving the absence of active Operations, overlays, and receipts before any reset.

## Work

- Specify a visible storage-unavailable/corrupt state and quarantine behavior.
- Preserve durable work before authoritative re-Bootstrap; never silently create an empty database
  under another IndexedDB name or OPFS VFS.
- Define consistent export/import through the selected engine rather than copying live files.
- Test user clearing, private mode, quota/persistence denial, corruption, partial import, and restart.

## Verification

Failure injection proves that no recovery path loses or duplicates an accepted Operation, exposes
plaintext, crosses Account scope, or creates reachable dual writers.
