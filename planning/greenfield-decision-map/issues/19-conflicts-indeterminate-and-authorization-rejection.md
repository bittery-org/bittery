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
- Indeterminate outcomes: how a client resolves "committed but response lost" without duplicating.
- The superseded-epoch case handed over from [vault key rotation](11-vault-key-rotation-and-epochs.md).
- What the UI says in each case, in plain words.

Produces: `SYNC-004`, `OFFLINE-003`, and `ITEM-004` refinement, plus seed scenarios 3, 4, and 6.

## Comments

### Inherited from ticket 04, threat model and server-visible plaintext

`PRIVACY-004` adds a per-Item revision chain. Decide how the chain survives an offline edit that lands
after a remote revision, and what a Conflict copy does to it: a Conflict copy either forks the chain
or starts a new one, and the choice decides whether tampering stays Detectable across a fork.

`PRIVACY-003` demotes Server-side authorization to an availability control, so an authorization
rejection never protects secrecy. A rejected operation is a lost write, not a leak.
