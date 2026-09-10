# Browser Replica recovery and export

Type: task
Status: resolved
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

## Accepted contract

2026-09-08: the maintainer approved the [recovery contract](../browser-replica-recovery.md):
protected Account-scoped locked export, metadata-only diagnostics, whole-Runtime maintenance,
strictly proved same-Account repair and explicit re-Bootstrap. Preserve accepted work, report
unknown state honestly, and retain existing explicit Remove/Wipe behavior without automatic reset.

## Completion

2026-09-08: implemented the approved contract. Independent Standards/Spec review and the complete
simplification pass approved the result. Recovery reuses existing ownership, cancellation,
persistence fences and artifact storage. Guarded publication resumes after hashing inside an
IndexedDB callback in the same transaction, preserving atomicity in Chromium and Firefox.

Targeted crypto/Core/host tests, types, formatting and generation checks passed. Chromium's six
recovery/loss cases and the affected final repair pair passed. All six Firefox cases passed across
targeted runs: four earlier cases and the final repair/re-Bootstrap pair. The existing durability
and Attachment Move scenarios and all seven Sync scenarios passed.
See [validation and limits](../browser-replica-recovery.md#validation-and-limits) for the exact scope.
Full CI was waived and was not run.
