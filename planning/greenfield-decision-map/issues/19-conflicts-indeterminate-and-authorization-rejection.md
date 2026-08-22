# Conflicts, indeterminate outcomes, and authorization rejection

Type: grilling
Status: ready-for-human
Blocked by: 11, 18

## Question

`SYNC-001` durably accepts local mutations before the Server sees them, but every authorization decision belongs to the Server. No requirement says what the user keeps when a durably-accepted, locally-visible edit is permanently rejected for authorization reasons. `OFFLINE-003` is only a `SHOULD` and permits indefinite offline access, so a conformant build can make `AUTH-008` revocation and `ADMIN-001` suspension unenforceable against exactly the device they target. See [corpus review, Significant #3](../research/corpus-review.md).

Decide:

- What happens to a durably-accepted operation rejected for authorization: preserved as a local-only artifact the user can copy out, discarded with an audit entry, or converted to a Conflict copy.
- Whether `OFFLINE-003` becomes a `MUST` with a mandatory maximum revalidation window.
- Conflict-copy semantics: how it is named, where it appears, and how a user resolves it.
- Domain reconciliation after the generic byte-identical lost-response retry has recovered its
  canonical outcome.
- The superseded-epoch case handed over from [vault key rotation](11-vault-key-rotation-and-epochs.md).
- What the UI says in each case, in plain words.

Produces: `SYNC-004`, `OFFLINE-003`, and `ITEM-004` refinement, plus seed scenarios 4 and 6 and any
Domain-specific refinement of the accepted seed scenario 3.

## Comments

### Superseded by ticket 04's reopened answer

There is no mandatory per-Item revision chain. Each client remembers the highest authenticated
revision it accepted. This ticket owns conflict behavior but no longer needs to preserve a hash chain.

### Inherited from ticket 04, threat model and server-visible plaintext

`PRIVACY-004` adds a per-Item revision chain. Decide how the chain survives an offline edit that lands
after a remote revision, and what a Conflict copy does to it: a Conflict copy either forks the chain
or starts a new one, and the choice decides whether tampering stays Detectable across a fork.

`PRIVACY-003` demotes Server-side authorization to an availability control, so an authorization
rejection never protects secrecy. A rejected operation is a lost write, not a leak.

### Inherited from Vault key rotation and epochs

`VAULT-ROTATION-008` settles the still-authorized case: a superseded-epoch operation is opened and
re-sealed under the current epoch without becoming a Conflict copy. This ticket owns only the case in
which the Device cannot obtain the new grant because authorization was removed, including how its
already-durable local edit remains visible or exportable.

Rotation finalization itself already resolves a lost response by querying the signed epoch statement
and byte-identically retrying one idempotency identifier. This ticket should use the same semantic
shape for ordinary operations without reopening the rotation decision.

### Inherited from Operation state machine and crash safety

[`operations.md`](../../../docs/greenfield/target/operations.md) now fixes `queued`, `indeterminate`,
`committed`, `rejected`, `conflicted`, `failed`, and `discarded`; the durable pre-send intent;
byte-identical automatic retry; Account-lifetime exactly-once outcomes; dependency blocking; and the
generic user phrases. A lost response therefore needs no manual recovery and seed scenario 3 is
accepted. This ticket still owns the registered rejection/conflict outcome bodies, what unique local
work becomes, export and Conflict-copy flows, dependent-operation reconciliation, and the exact
object-level explanatory copy. It may not add a second operation identity or weaken automatic retry.

### Inherited from Sync protocol: cursor, bootstrap, and retention windows

[`sync-protocol.md`](../../../docs/greenfield/target/sync-protocol.md) fixes one registered
`permanently_deleted` rejection: the Server returns the exact signed-Tombstone Deletion Fence even
when the deletion event has aged out. The client validates and retains that authenticated Item floor,
keeps the rejected Operation and its unique overlay work, and never converts the same Item identifier
into a create. This ticket owns the final user-visible artifact, export/copy action, dependent
reconciliation and explanatory copy; it may not silently discard that work or weaken the Fence.
