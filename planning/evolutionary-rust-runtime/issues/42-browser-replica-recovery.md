# Browser Replica recovery and export

Type: task
Status: needs-info
Blocked by: 38, 39, 40, 41

## Outcome

Storage corruption, capability loss, quota failure, and export/import have explicit recovery
behavior. An unreadable Replica must not be reported as successful discard of accepted Operations.

## Decision frontier

Choose the diagnostic/export surface, export contents, and conditions for authoritative
re-Bootstrap after quarantine. Preserve durable work or prove its absence before any reset.
Use the engine selected by tickets 39/41. If ticket 40 is `wontfix` because IndexedDB remains selected,
that resolves the conditional branch; recovery still applies to IndexedDB.

## Work after the decision

- Define visible storage-unavailable/corrupt states and quarantine.
- Preserve active Operations, overlays, and receipts before re-Bootstrap; avoid silent empty-database
  fallback or a second authority.
- Define consistent export/import through the selected engine rather than copying live files.
- Exercise user-cleared storage, private mode, quota/persistence denial, corruption, partial import,
  and restart. Irrecoverably missing bytes must be reported honestly, not claimed recovered.

## Verification

Inject failures and prove surviving accepted work is neither silently discarded nor duplicated.
Unknown/lost state stays explicit. Recovery exposes no plaintext, crosses no Account scope, and
creates no reachable dual writers.
