# Account Replica schema and storage contract

Status: **Candidate**.

This document fixes the logical local-storage contract selected by `ARCH-STORE-001` and
`ARCH-STORE-012` through `ARCH-STORE-022`. It is shared by native SQLite and browser transactional
storage. A physical adapter may choose files, tables, object stores, and encodings, but it may not
change the logical keys, transaction boundaries, or failure meanings below.

## Scope and ownership

One Replica belongs to exactly one `(Server identity, Account identifier)` pair. A multi-Account
runtime opens several independent Replicas. No transaction, bootstrap, migration, or removal spans
Replicas, even when their Accounts share a Server. Cross-Account and cross-Server features coordinate
committed operations and never imply atomic movement.

The encrypted Replica is separate from Device Unlock Wrapper records and platform anchors. One small
installation catalog locates Replicas and records lifecycle intent; it is not a multi-Account Replica.
Its Account key is `(Server identity, Account identifier)`.

## State classes

Every stored value belongs to exactly one class:

| Class | Meaning | Loss response |
| --- | --- | --- |
| canonical remote base | Validated protocol state at one fixed Sync cursor | Discard the whole damaged base and bootstrap again |
| canonical local overlay | Durably accepted local operations and their optimistic effects | Fail the Account closed; never discard or send damaged work |
| canonical local control | Schema, cursor, active-generation, accepted-revision and lifecycle facts | Fail the Account closed unless an older complete generation proves recovery |
| derived | Versioned indexes or materialized read data reproducible from canonical state | Drop and rebuild |
| volatile | Live keys, decrypted objects, and purpose-built client Projections | Drop on Lock, invalidation, or process termination |

No decrypted Vault content is durable. An unlocked core may hold decrypted material in sensitive
memory and may emit only the cleartext a purpose-built Projection needs. Lock invalidates every such
Projection and destroys core-owned live keys and plaintext buffers. Bittery does not claim forensic
erasure of host-language strings, swap, flash blocks, browser backups, or process dumps.

## Closed Replica-visible field registry

The following fields may be stored as engine-visible plaintext. An implementation schema containing
another plaintext field is non-conforming until this registry is amended. Presence in the separate
Server registry `PRIVACY-007` does not by itself admit a local field.

- **Framing and lifecycle:** schema and derivation versions, adapter Durability class, Replica
  locator, lifecycle intent, migration state, commit sequence, base-generation identifier and state,
  derived-set kind, source commit, snapshot identifier, chunk position and length, completeness marker,
  and local cleanup eligibility.
- **Account routing:** stable Server identity, configured Server origin, Account identifier, Device
  identifier, and the User-chosen local Account label permitted by `ARCH-STORE-010`.
- **Sync and operation routing:** Sync cursor and bootstrap page token, accepted local sequence,
  operation and idempotency identifiers, closed operation kind and state, retry/control counters,
  Device Session identifier and reserved request-counter range, typed target path, and authenticated
  outcome discriminator.
  [Operation state machine and crash safety](../../../planning/greenfield-decision-map/issues/17-operation-state-machine-and-crash-safety.md)
  fixes the closed state machine and exact operation payload.
- **Typed Domain paths:** Team, Vault, Item, revision, Attachment, chunk, Share-link, Device-event,
  Account-private-object, and Vault-epoch identifiers or counters needed to form primary keys and the
  `CRYPTO-009` binding tuple.
- **Protocol control:** tombstone and retention control, current key epoch, rotation-required state
  and coarse trigger, membership and Device generations, role/status discriminators, envelope-budget
  reservations, Attachment chunk count and total byte size, and ciphertext byte length.
- **Opaque protocol bytes:** complete Envelopes, signatures, signed statements and checkpoints,
  public keys, digests, protocol records, and sealed operation payloads. These are not decrypted by
  the storage adapter.

Vault, Team and Device names received as protocol plaintext may be stored only in a typed canonical
protocol row that needs them for offline product behavior. They are never part of the locked
Projection. Account email, Item titles, URLs, domains, tags, Favorite, category/custom-field data,
Attachment names and MIME types, user-authored timestamps, Secure Note text, TOTP secrets, passkey
material, and every other Vault-content field are absent from the plaintext registry. The separate
Search and Suggestion Indexes are encrypted derived state, never canonical Replica tables. Their
outer framing is admitted above; their content, keys, leakage bounds, and query rules are fixed by
[`search-index.md`](search-index.md). The Suggestion Index may expose only the locked preview admitted
by `PRIVACY-017`.

## Logical tables

All identifiers are the canonical protocol bytes. An adapter neither normalizes them nor constructs
identity from email, URL, display name, or an active-Account fallback. Every Envelope-bearing row
stores the complete Envelope verbatim and carries every typed path field needed to reconstruct its
binding tuple. A bare Envelope without that path is invalid.

### Installation catalog

This store is outside each Replica and contains:

| Table | Primary key | Purpose |
| --- | --- | --- |
| `installation_state` | singleton | installation identifier, normal or wipe-intent lifecycle |
| `account_catalog` | Server, Account | local label, Device, Replica locator, active or removal-intent lifecycle |

An entry in removal or wipe intent is never opened. Catalog writes do not mutate Replica content and
make no cross-Replica atomicity claim.

### Replica control

| Table | Primary key | Required content |
| --- | --- | --- |
| `replica_head` | singleton | Server, Account, schema version, commit sequence, active base generation and cursor |
| `base_generations` | generation | staging/completed marker, fixed snapshot cursor, bootstrap continuation and cleanup eligibility |
| `accepted_floors` | typed object path | greatest authenticated revision or generation this Device has accepted |
| `derived_sets` | kind, derivation version | source commit, snapshot identifier, complete/incomplete marker, and wrapped local key record |
| `derived_chunks` | kind, derivation version, snapshot identifier, chunk index | complete encrypted Search or Suggestion envelope chunk |
| `device_request_counters` | Device Session | next unreserved request counter for concurrent runtime hosts |

There is one active base pointer. A generation row does not become readable merely because all its
pages exist; only `replica_head` selects it.

### Immutable canonical objects and heads

The schema uses explicit typed tables, never a generic `(kind, path, bytes)` object heap. The initial
table families are:

| Immutable table | Primary key | Selecting/control table |
| --- | --- | --- |
| `vault_role_statements` | generation, Vault, membership revision | `vault_heads` by generation and Vault |
| `vault_epoch_statements` | generation, Vault, key epoch | `vault_heads` |
| `vault_key_grants` | generation, Vault, key epoch, recipient Account | `vault_heads` |
| `item_revisions` | generation, Vault, Item, revision | `item_heads` by generation, Vault and Item |
| `attachment_keys` | generation, Vault, Item, Attachment | `attachment_heads` |
| `attachment_chunks` | generation, Vault, Item, Attachment, chunk index | `attachment_heads` |
| `account_private_objects` | generation, object generation | `account_private_head` |
| `device_status_events` | generation, Device generation | `device_status_head` and optional roster checkpoint |
| `share_snapshots` | generation, Share-link | `share_heads` |

An accepted immutable row is never updated. A head moves or a retention transaction explicitly
deletes an old row. Later Domain tickets may add a typed table or field, but may not replace these
families with an opaque object heap or persist a context-free Envelope.

### Local operation overlay

`local_operations` is keyed by the random operation identifier and is uniquely ordered by an
Account-local accepted sequence. It stores the immutable request block, mutable lifecycle/outcome
block, predecessor identifiers, and typed overlay ownership defined by
[`operations.md`](operations.md). Its canonical command bytes and fingerprint never change across
attempts, while attempt and retry controls move only through the closed operation state machine.
Typed overlay-effect tables mirror the affected Domain head families and reference their owning
operation. They are independent of base-generation identifiers.

The visible unlocked Projection is the active remote base overlaid by local operation order. Accepting
a command commits its operation record, immutable local object bytes, affected overlay heads, and any
already-defined derived updates together. Bootstrap promotion changes the base pointer and cursor but
does not copy, merge, or delete the local overlay.

### Required indexes

Every adapter provides the logical equivalent of these indexes:

- a unique primary-key index for every table above;
- all generation-owned rows by `generation`, so incomplete or retired bases can be removed without a
  full-store scan;
- Vault heads and Item heads by `(generation, Vault)`;
- Item revisions by `(generation, Vault, Item, revision descending)`;
- Attachments by `(generation, Vault, Item)` and chunks by
  `(generation, Vault, Item, Attachment, chunk index)`;
- Vault grants and epoch statements by `(generation, Vault, key epoch)`;
- Device events by `(generation, Device generation)`;
- local operations uniquely by accepted sequence, and by `(state, accepted sequence)` for scheduling;
- overlay effects by typed target and owning operation; and
- derived sets by kind, derivation version, and source commit; and
- derived chunks by kind, derivation version, snapshot identifier, and chunk index.

No physical term, domain, posting, field, or Item row is admitted as Replica-visible plaintext. The
opaque chunk records above are the only persisted index shape and follow [`search-index.md`](search-index.md).

## Snapshot and guarded-commit interface

The logical adapter exposes four operations:

```text
open(account_scope, supported_schema_versions) -> StoreDescriptor
read_snapshot(query_plan) -> Snapshot { commit_sequence, rows }
commit(GuardedCommitPlan) -> Committed { new_commit_sequence, durability }
                              | StaleSnapshot { current_commit_sequence }
close()
```

`query_plan` and every mutation are a closed typed enum over the logical tables. No raw SQL, object-
store name, string collection, or arbitrary key crosses the interface. A `GuardedCommitPlan` contains
the snapshot commit sequence or narrower expected head values, typed inserts/updates/deletes, and the
requested Durability class. The adapter checks all guards and applies every mutation in one short
native transaction. A failed guard changes no row. Each successful write increments the Account's
`commit_sequence` exactly once.

Reads observe one consistent committed snapshot. Successful writes are serializable in an order
matching their commit sequences. The adapter, not an in-process mutex, is the authority for this
ordering. A constrained Credential Provider uses this same schema and interface through the closed
capability subset in `ARCH-ENGINE-007`.

Network I/O, cryptography, prompts, projection construction, and unbounded computation cannot occur
inside an adapter transaction. The engine prepares bytes before `commit` and recomputes a plan after
`StaleSnapshot` rather than continuing from stale values.

## Cross-process Replica Lease

Every native Account store has one sibling lease target whose identity derives from the resolved
Replica locator, never from untrusted Account text. Opening the Replica for ordinary snapshots,
guarded commits, or Sync acquires and holds an OS advisory shared file lock. Multiple main and
Credential Provider hosts may hold it concurrently. Their SQLite transactions and guarded commit
sequences remain the sole authority that orders reads and writes; the lease is not a transaction or
an in-process mutex.

Schema migration, corruption repair, physical-store replacement, Account removal, and Device wipe
acquire the same target exclusively before changing or deleting the store. An exclusive holder first
rechecks the durable lifecycle intent and schema after acquisition. Failure to acquire a required lock
is a typed retryable busy outcome. No host breaks a live lock, assumes expiry, falls back to a mirror,
or performs partial maintenance. The OS releases either lock class when its owning descriptor or
process ends, so correctness requires no cleanup message from a terminated Provider.

A Provider mutation uses the canonical local operation overlay. It reports success after the same
guarded commit and declared Durability barrier as the main host, then attempts ordinary Sync only
while its OS execution budget remains. Process termination leaves the operation queued; any later
main or Provider host resumes it by reading the shared operation state.

Before signing a Server request, either Mobile host reserves a non-empty counter range by guarded
commit against `device_request_counters`. It never signs outside its committed range and never returns
unused counters to the pool. A crash may create a gap but cannot create reuse. Session replacement
starts a distinct row and never carries an old range into the new Session.

## Bootstrap generations

Bootstrap captures one fixed Server snapshot cursor before accepting its first page. Page commits
write only to a fresh staging generation. Each page is idempotent by its canonical typed keys; a
changed snapshot cursor, malformed path, duplicate with different bytes, invalid Envelope shape, or
failed authenticated-object validation makes the generation unusable.

After every required page and control object is present, the engine marks the staging generation
complete. One guarded commit then checks the previously active generation and cursor and changes
`replica_head.active_generation` and its cursor together. Before that commit, readers see the old
base. After it, readers see the new base. A crash cannot expose a mixture or pair one generation with
the other's cursor.

The local operation overlay remains visible across promotion. Retired and incomplete generations are
garbage collected only after they are unreachable from `replica_head`; cleanup is idempotent and is
never part of the promotion commit.

## Durability classes

Durability is a closed adapter property, not an optional method:

| Class | Successful commit means |
| --- | --- |
| `native-crash-durable` | The backend completed its strongest supported atomic persistence barrier; conformance must survive forced process termination and reopen, and native configuration must not deliberately weaken the barrier. |
| `browser-transactional` | An IndexedDB transaction opened with `durability: "strict"` reported completion, so an extant Origin store must expose the whole old or whole new commit; there is no on-disk acknowledgement or protection from Origin eviction, user clearing, browser policy, Extension removal, or storage forensics. |

`browser-transactional` is the accepted Web and Extension floor. Web requests persistent storage as
best effort during enrollment, while the Extension requires `unlimitedStorage`; neither mechanism
upgrades the commit meaning. The host keeps locally accepted operations visibly pending until Server
Sync proves them committed and guards Bittery-controlled destructive removal as required by
`ARCH-STORE-025` and `SYNC-005`.

## Migration, corruption and removal

Schema versions increase monotonically. Supported forward migrations preserve canonical remote state,
the complete local overlay and control floors. Derived sets may be dropped. A small migration is one
guarded commit; a large migration writes an invisible shadow generation and promotes it only after
validation. A newer unknown schema version is left byte-for-byte untouched and fails closed.

Corrupt derived state is dropped. A corrupt or incomplete inactive generation is discarded. Corrupt
active remote-base state is never partially projected; the whole base is replaced by bootstrap while
the local overlay remains untouched. Corrupt local operations or overlay effects fail that Account
closed and are neither sent nor silently discarded. No failure in one Account prevents another
Replica from opening.

Lock changes no durable Replica row; it removes volatile keys and Projections. Local Account removal
first commits removal intent in `account_catalog`, which makes the Account unopenable, then
idempotently deletes every wrapper/credential, Replica store and catalog entry. Restart resumes an
unfinished removal. A requested Server Device revocation is claimed only after its online commit; a
local removal can proceed without falsely claiming it.

Device wipe first commits wipe intent in `installation_state`, making every Account unopenable, then
removes Accounts and installation secrets one by one. Restart resumes until the catalog and local
stores are empty. Neither removal path claims physical erasure from flash, filesystem snapshots,
browser backups or external backups.

## Adapter conformance

An adapter is supported only when the shared executable semantic core and its declared Durability
profile pass against its real backend. Both are release-blocking. The core includes:

- model histories for consistent snapshots, serial write order, stale guards, unique keys and
  relationship checks;
- failpoints before the first physical mutation, between every physical mutation, before commit,
  after commit and before acknowledgement;
- the shared old-or-new recovery classification around command acceptance and bootstrap promotion;
- migration from every supported released schema fixture and refusal of a newer unknown fixture;
- corruption in derived, staging, active-base, control and local-overlay classes;
- removal and wipe interruption at every external-store boundary.

The `native-crash-durable` profile adds forced termination and reopen across the backend's strongest
persistence barrier. The `browser-transactional` profile adds Worker or background-runtime
termination with the Origin intact, lost acknowledgement after commit, best-effort persistence
denial, and whole-Origin removal. Origin removal must yield an absent Replica, never a partial one or
a false recovery claim.

An in-memory fake may exercise the model but cannot certify an adapter. Platform-specific branches
may add evidence; they cannot skip a shared invariant.
