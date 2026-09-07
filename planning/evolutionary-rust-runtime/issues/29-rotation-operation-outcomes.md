# Rotation Operation outcomes and idempotency removal

Type: task
Status: needs-info
Blocked by: 24
Spec: ../spec.md#server-operation-contract

## Outcome

Convert five Rotation response-cache call sites (six public routes) to retained semantic outcomes,
then remove the unused legacy response-cache table and wrapper.

## Decision frontier

The shared tagged outcome union, fingerprints, retention, and atomic transaction rules are decided.
Plan creation/finalization applied payloads and Rotation-specific terminal rejection sets are not.
Record those closed payloads and failure classifications before marking this ticket ready.
Preserve voluntary departure versus administrative removal identity even in their shared finalizer.

## Inventory

| # | Public route | Handler | Call site |
| --- | --- | --- | --- |
| 1 | `POST /api/v1/vaults/{vaultId}/members/{userId}/removal-rotation-plans` | `start_vault_member_removal` | `apps/server/src/domains/vaults/http/rotation.rs` |
| 2 | `POST /api/v1/vaults/{vaultId}/members/{userId}/removal-rotation-plans/finalize` | `finalize_vault_member_removal` | same file |
| 3 | `POST /api/v1/teams/{teamId}/leave-rotation-plans` | `start_team_leave` | same file |
| 4 | `POST /api/v1/teams/{teamId}/members/{userId}/removal-rotation-plans` | `start_team_member_removal` | same file |
| 5 | `POST /api/v1/teams/{teamId}/leave-rotation-plans/finalize` and `POST /api/v1/teams/{teamId}/members/{userId}/removal-rotation-plans/finalize` | `finalize_departure`, reached through `finalize_team_leave` and `finalize_team_member_removal` | same file |

Route and handler identity is the durable checklist; line numbers move.

## Work after the decision

- Extend the one generated `OperationOutcome` union and closed schema constraints. Preserve current
  key hierarchy, Rotation plans, and crypto formats under ADR 0013/0014.
- Convert each call site so effect or proved rejection, audit, applicable entity Sync event,
  retained outcome, and `operation_resolved` commit atomically.
- Change Server/OpenAPI/Runtime and still-reachable client callers together. Add no parallel routes,
  arbitrary retained response bytes, or compatibility writer.
- Add an executable inventory proving zero production calls to `idempotency::execute`. Distinguish
  real calls from test assertions that mention the symbol.
- After zero callers, add a forward migration dropping `idempotency_record` and remove its wrapper,
  claim/expiry/indeterminate machinery, obsolete tests, and recovery documentation. Preserve frozen
  historical migrations; the zero-reference gate applies to active code/schema.
- Preserve the separate `account_deletion_outcome` protocol from
  [ticket 48](48-runtime-account-removal-and-wipe.md#retained-server-proof), including its
  `Idempotency-Replayed` header and CORS exposure. Remove only Rotation's obsolete replay plumbing.
  Keep idempotency-header refusal on routes returning one-time secrets.

## Verification

For every call site: identical/concurrent replay, changed fingerprint, lost response plus lookup,
renewed Session, User isolation, retained applied/rejected results, and rollback with no outcome for
malformed transport/authentication/infrastructure failure. Exercise both shared finalization routes
and prove their identities cannot replay each other.

Fault injection proves all-or-nothing effect/audit/Sync/outcome. The inventory reaches zero before
cleanup; deletion replay still works afterward. Run affected generated/client checks, `pnpm check:ci`,
and `pnpm check:ci:rust`.
