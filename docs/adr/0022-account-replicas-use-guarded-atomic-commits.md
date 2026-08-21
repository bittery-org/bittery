# Account Replicas use guarded atomic commits

Status: accepted

Bittery keeps one logical Replica per Account, separates a replaceable Server base from a durable
local-operation overlay, and writes every completed state transition through one guarded Account-wide
commit. This makes local acceptance, bootstrap promotion and removal independently crash-safe without
requiring any adapter to provide cross-Account transactions or keep an asynchronous storage
transaction open during crypto, network or policy work.

## Considered options

A shared multi-Account database transaction was rejected because Account and Server boundaries do not
need joint atomicity, while browser and later credential-provider adapters would all have to implement
it. Per-subsystem transactions were rejected because object, operation and derived-state writes could
split across a crash and recreate the legacy caller-owned invariant. Merging concurrent local changes
into a staging generation at promotion was rejected in favor of keeping local operations as an
independent overlay. Open async transaction callbacks were rejected because IndexedDB may auto-commit
while code awaits unrelated work.

## Consequences

Adapters execute typed Snapshot reads and declarative guarded commit plans against the same logical
schema. Concurrent writers retry from `StaleSnapshot`; they never overwrite unseen state. Bootstrap
promotion changes only the active base pointer and cursor, while local operations survive unchanged.
Multi-Account and cross-Server features coordinate committed operations and must never claim atomic
movement across Replicas.
