# Web cutover and replaced-path cleanup

Type: task
Status: resolved
Blocked by: 21, 27
Spec: ../spec.md#web-cutover

## Delivered

Web Sign-in, Account status, Item/Vault reads, and Login creation use Runtime. Dashboard,
security report, Vault headers/roles, sidebar tags, and Item counts share Runtime projections.
The Web transitional Sync loop is removed; a shallow provider still supports unrelated REST reads.

The accepted scope was narrowed to reads and create. The whole-entry import graph checks those
paths; remaining Item writes and their read holdouts belong to
[ticket 28](28-remaining-item-write-kinds.md) and [ticket 58](58-final-web-host-cutover.md).

## Contract and remaining boundaries

- Runtime is the sole writer for the migrated Account paths. Shared TypeScript modules remain only
  while unmigrated hosts or product paths still need them.
- `VaultProjection.role` carries the Server's closed role, from which the host derives affordances.
- The graph starts at production entries and follows lazy imports; an unclassified transitional
  symbol fails the audit.
- [Ticket 30](30-runtime-owned-live-sync.md) supplies live cross-device Sync.
- [Ticket 54](54-create-vault-atomic-cutover.md) delivered Vault creation. Vault update/delete/type
  conversion remain outside this Item cutover and need their own frontier.
- IndexedDB v6-to-v7 preservation is delivered. [Ticket 38](38-replica-persistence-evolution.md)
  owns the remaining migration lifecycle, replacing the old destructive-upgrade warning.

## Verification

Read/create ownership is checked by `apps/web/scripts/transitional-reachability.test.ts`.
The original first-slice browser and full CI evidence was accepted by
[ticket 23](23-first-slice-adversarial-review.md); it does not certify the later final Web cutover.
