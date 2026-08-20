# Sync protocol: cursor, bootstrap, and retention windows

Type: grilling
Status: ready-for-human
Blocked by: 17

## Question

The frozen server prunes sync events after **30 days** and hard-deletes trashed items after **90 days**, emitting permanent-deletion events. Neither window appears anywhere in the target corpus, and the 30-day one is a hard constraint on any offline design: a device offline longer must full-bootstrap. See [current-state verification](../research/current-state-verification.md).

Decide:

- The cursor format and its guarantees, including whether it is signed or otherwise rollback-detectable.
- Bootstrap: pagination, atomic promotion, and resumption after interruption.
- The sync-event retention window, and what a device does when its cursor has aged out.
- Tombstone semantics and compaction, such that an old offline Device cannot resurrect a permanently deleted Item.
- Trash retention: whether it is fixed or operator-configurable, given quotas are gone.
- SSE as an optional wake-up hint only, and what happens with no SSE at all.
- What the event stream leaks to the operator, checked against the closed plaintext list.

Produces: a protocol specification, `SYNC-*` and `ITEM-006` refinement, and seed scenarios 5 and 8.
