# Sync protocol: cursor, bootstrap, and retention windows

Type: grilling
Status: resolved
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

## Comments

### Inherited from Operation state machine and crash safety

The exact Operation lifecycle, request fingerprint, Account-lifetime outcome ledger, and lost-response
recovery are settled in [`operations.md`](../../../docs/greenfield/target/operations.md). This ticket
defines the opaque commit-marker bytes carried by a committed `OperationOutcome` and how that marker
relates to the Sync cursor. Sync-event retention or cursor expiry may never delete or weaken the
Account-lifetime exactly-once ledger. Seed scenario 3 already proves the generic lost-response path;
this ticket may refine its marker without weakening its invariants.

## Answer

Resolved with the maintainer on 2026-08-22. Promoted to refined `ITEM-006` and `SYNC-002` through
`SYNC-009` in [`product.md`](../../../docs/greenfield/target/product.md), the normative
[`sync-protocol.md`](../../../docs/greenfield/target/sync-protocol.md), Replica and Server architecture
contracts, accepted ADRs
[0027](../../../docs/adr/0027-sync-is-a-per-account-transaction-stream.md) and
[0028](../../../docs/adr/0028-permanent-deletion-fences-outlive-item-content.md), the root glossary,
and seed scenarios [5](../../../docs/greenfield/scenarios/05-interrupted-bootstrap.yaml) and
[8](../../../docs/greenfield/scenarios/08-offline-device-permanent-deletion.yaml).

### Resolution

1. **There is one ordered stream per Account.** A Server transaction appends one atomic Sync Commit
   to each affected Account in the same transaction. This accepts write-time fan-out and rejects a
   growing per-Vault Cursor vector and a Server-global client position.
2. **The Cursor is a pinned 25-byte value.** V1 is `0x01 | random generation[16] | position:u64be`.
   Positions are consecutive and never wrap. The Replica rejects a lower position in the same
   generation. Another generation installs only through complete Bootstrap. A Server signature was
   rejected because it cannot constrain the Malicious Operator who owns the signing key.
3. **The Operation marker is the Cursor.** Every committed ordinary Operation allocates an initiating
   Account Sync Commit, which may be empty only when no other Account-visible object changed. Its exact
   25-byte Cursor commits atomically into the canonical outcome and survives event expiry through the
   Account-lifetime ledger.
4. **Delta mirrors Server transaction boundaries.** Closed binary V1 frames carry typed, length-bound
   changes inside Sync Commits and pages. Positions are consecutive, a page never splits a Commit, and
   unknown or noncanonical bytes fail closed. A page is limited to 512 total changes and 2 MiB.
5. **One Delta page is one local guarded commit.** The client validates the complete page, referenced
   canonical objects, signatures, relationships and floors before applying its remote-base effects
   with the end Cursor. Local Operations and overlays never move in that transaction.
6. **The retained index stays compact.** It stores only the Account, Cursor, registered change type,
   typed Server-visible path, required revision/epoch/generation controls and operational time. Delta
   joins exact canonical ciphertext or signed control objects into a self-contained response; it does
   not duplicate them in the retained event row or require N+1 fetches.
7. **Bootstrap is fixed, resumable and bounded.** A non-renewing 24-hour Server lease captures one
   logical snapshot Cursor and pins its objects plus Delta suffix. Records sort by closed section and
   canonical key. Opaque 32-byte tokens replay byte-identical pages. Pages stop at 512 records or 2
   MiB; only a complete validated staging generation promotes with its Cursor.
8. **Event expiry changes cost, not correctness.** Server-wide retention defaults to 30 days, permits
   48 hours through indefinite, and removes only complete prefixes after lease and object pins. A
   typed expired Cursor keeps the active base and local overlay while Bootstrap runs. It never touches
   Operation outcomes, accepted floors or Deletion Fences.
9. **Trash is immutable revision state.** Trash creates the next signed Tombstone referring to the
   forced-retained last live revision and Attachment material. Restore creates another signed live
   revision. Server-wide retention defaults to 90 days, permits one day through no automatic purge,
   applies shortening to existing Tombstones and remains user-visible.
10. **Permanent deletion leaves an exact Fence.** Manual and automatic purge use one transaction to
    delete every content revision and Attachment, retain the exact signed Tombstone plus permanent
    status and position until Vault deletion, and append the Sync Commit. The same Item identifier is
    never reused; every later operation receives `permanently_deleted` with the Fence. Unique local
    work remains for ticket 19's resolution.
11. **SSE is a content-free hint.** `sync_available` carries only the current Account Cursor and never
    applies state. Without SSE, lifecycle triggers pull immediately and a running runtime polls after
    a uniformly random 60–120 seconds; errors back off to five minutes. Suspended runtimes promise no
    deadline and catch up on wake.
12. **The plaintext boundary does not grow into content.** Account target, Cursor, change kind, typed
    admitted path, revision/generation control, ciphertext, operational time, retention and Bootstrap
    control are visible. Item-derived content remains encrypted or absent. Connection and change
    chronology remain explicitly operator-visible.

### Legacy evidence and rejected shapes

The frozen Server used random event IDs, a 30-day event cleanup, 90-day Trash cleanup, permanent-delete
events, cursor-paginated HTTP catch-up, staged cache promotion and SSE as a hint. Explicit searches of
`legacy/apps/server/src/jobs/sql.rs`, `legacy/packages/sync/`, and the frozen REST ADR confirmed those
facts. They were useful prior art for bounded catch-up and staging, but their event ID had no monotonic
rollback rule, permanent deletion retained no durable signed Fence, and the policy was not present in
the target corpus.

Rejected alternatives were per-Vault Cursor vectors, a Server-global Cursor, signed or arbitrary
opaque Cursors, JSON or CBOR Delta identity, per-change or per-page Server positions, non-resumable or
stateless Bootstrap, activity-renewed or operator-sized leases, infinite-only or fixed-only event
retention, full event payload copies, invalidation-only N+1 fetches, SSE event metadata or authority,
trigger-only polling, mutable Trash flags, copied Tombstone ciphertext, finite or probabilistic
deletion markers, and Server-only unsigned revision floors.

No new ticket surfaced. Existing
[Conflicts, indeterminate outcomes, and authorization rejection](19-conflicts-indeterminate-and-authorization-rejection.md),
[Item revision history and retention](21-item-revision-history.md),
[Server domain architecture and atomic command writer](22-server-domain-architecture-and-atomic-writer.md),
[Server identity, protocol versioning, and OpenAPI compatibility](23-server-identity-and-protocol-versioning.md),
[Backup, restore, and rollback detection](24-backup-restore-and-rollback-detection.md),
[Deployment profiles and operations](25-deployment-profiles-and-operations.md), and
[Attachments: keys, chunking, and lifecycle](32-attachments-keys-and-lifecycle.md) inherit the exact
boundaries they already own.
