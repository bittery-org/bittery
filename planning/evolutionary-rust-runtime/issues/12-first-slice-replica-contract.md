# First-slice Replica contract

Type: research
Status: resolved
Blocked by: 04, 07, 08, 09, 10, 11

## Question

Which Account-scoped records and guarded commits prove the first slice across both storage engines?

## Answer

One deep Rust `AccountReplica` owns the logical schema and closed `GuardedCommitPlan` variants. Every
visible plan is guarded by Account incarnation and Replica revision and increments the revision once.
Web executes a plan in one IndexedDB transaction; native Rust executes it in one SQLite transaction.
A stale guard causes reread and recomputation, never a partial write.

The first schema contains Account and restorable Session state using existing storage classifications
and cryptographic formats, tagged Cursor state, staged Bootstrap generations, authoritative encrypted
Vault and Item records, encrypted optimistic Item overlays, immutable Operations, observed semantic
outcomes, and compact completed Operation receipts. It persists no decrypted Item field, password,
raw live key, master password, or bearer token outside its existing protected Session representation.

An offline create uses its client-created Item ID as the canonical Server ID. `AcceptCreateLoginItem`
atomically inserts immutable request bytes plus fingerprint, the pending Operation, and its encrypted
optimistic overlay, then returns `Accepted`. Retry leases suppress duplicate work but do not provide
correctness. Applied reconciliation atomically writes authoritative ciphertext, removes the overlay
and active Operation, inserts the compact receipt, and leaves Sync page advancement to the guarded
page commit after all events reconcile (see [ticket 28](28-remaining-item-write-kinds.md#item-operations)).

Bootstrap pages remain invisible until one promotion plan swaps the active generation and tagged
watermark. A change Cursor advances only with every authoritative effect it covers. Account
incarnation rejects late work after remove-and-readd; lock epoch rejects decrypted projections built
across a lock. Account removal deletes the local Replica but does not claim to cancel a Server effect.

[Ticket 31](31-shared-replica-adapter-conformance.md) delivered the shared conformance suite for
failure, restart, replay, stale guards, lock/removal races, and IndexedDB/SQLite equivalence.
