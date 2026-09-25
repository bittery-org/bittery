# Populated Account deletion

## Corrective frontier and answer

The actual native source acceptance reached two real personal Accounts, but authenticated
`DELETE /api/v1/users/me` returned 500 during cleanup. The existing isolated Server router/database
reproducer creates one personal Team, an owned personal Vault/key and a Login Item. It returns 500;
a scoped test diagnostic identifies PostgreSQL `item_last_modified_by_user_id_fk` while deleting
`user`. The older success fixture lacked populated personal ownership.

The existing contract is [ticket 48's retained authenticated Server deletion](../issues/48-runtime-account-removal-and-wipe.md#authenticated-server-deletion).
The User's owned Vaults are already in the User foreign-key cascade target set. The routine correction
is to delete those exact owned Vaults explicitly inside the existing deletion transaction, before
removing the User. Their Item/Attachment cascade then finishes while the referenced User still exists.
This orders the existing effects; it does not enlarge the target set or weaken author foreign keys.

Keep request-ID locking, live Session/User and Team authority locks, confirmation/blocked decisions,
retained proof/fingerprint/outcome insertion, audit and commit in their current owner. An early
Vault deletion is part of that same transaction: any subsequent error or failed commit must roll back
the owned data, User and retained outcome together. Do not create another deletion runner, request
kind, retry ledger or host cleanup policy. Preserve the exact public route, request/response schema,
cryptographic proof and idempotent replay after User/Session removal.

Foreign data that merely references this User is not a newly authorized deletion target. This fix
must neither delete another User's Vaults nor weaken surviving Item author references. Existing
non-personal Team blocking policy remains unchanged. Any separate behavior for surviving foreign
references requires its own inventory/contract, rather than silently broadening this correction.

## Acceptance

The original isolated PostgreSQL/router reproduction must return 200 and remove only the expected
User, personal Team, owned Vault/key, Items and Sessions. An exact original request/bearer replay
must return the retained result after those rows disappear. Include an unrelated populated Account
to prove isolation, and retain the existing blocked-Team, rollback and exact replay regressions.
Exercise Attachment and Item author edges in owned Vaults without changing their persisted format.

Then rerun the opt-in real native two-Account source path and require actual Server deletion plus
local Runtime teardown to finish. That result is still native composition/transport acceptance,
not production Tauri UI or Chrome. Run targeted Server tests, `pnpm check:server`, Server format and
Clippy, and the required full phase `pnpm check:ci`/`pnpm check:ci:rust` through the parent orchestration.
