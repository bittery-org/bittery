# Rotation Operation outcomes and idempotency removal

Type: task
Status: resolved
Blocked by: 24
Spec: ../spec.md#server-operation-contract

## Outcome

Convert five Rotation response-cache call sites (six public routes) to retained semantic outcomes,
then remove the unused legacy response-cache table and wrapper.

## Decision frontier

The maintainer approved the closed payloads and rejection classifications below on 2026-09-07.
Preserve voluntary departure versus administrative removal identity even in their shared finalizer.
Full CI is waived for this run; required targeted acceptance and generation checks remain.

## Accepted decision

Use six distinct Operation kinds: `create_vault_member_removal_rotation_plans`,
`finalize_vault_member_removal_rotation_plans`, `create_team_leave_rotation_plans`,
`finalize_team_leave_rotation_plans`, `create_team_member_removal_rotation_plans`, and
`finalize_team_member_removal_rotation_plans`.

Creation applied payloads contain `plans`: closed records with `id`, `vaultId`,
`initiatorUserId`, `expectedKeyVersion`, `state: preparing`, `idleExpiresAt`, and
`absoluteExpiresAt`. Vault removal returns exactly one; Team departure may return none.
These are immutable creation snapshots: replay after expiry or cleanup returns the original
IDs and deadlines. Replacement plans require a new Operation ID.

Finalization applied payloads contain `rotations`: closed records with `planId`, `vaultId`,
`keyVersion`, and `rotationId`. Vault removal returns exactly one; Team departure additionally
returns required `personalTeamId` and may have no rotations. Retain no key material, prepared
ciphertext, arbitrary response bytes, or mutable plan state.

The following sets define the exact per-kind rejection union:

- V: `vault_access_denied`, `vault_member_not_found`, `self_removal_forbidden`,
  `vault_owner_protected`, `vault_admin_peer_protected`, `shared_vault_required`,
  `vault_sharing_entitlement_denied`.
- L: `team_member_not_found`, `personal_team_departure_forbidden`, `team_owner_leave_forbidden`.
- A: `team_member_not_found`, `personal_team_departure_forbidden`, `self_removal_forbidden`,
  `team_management_denied`, `team_owner_protected`, `team_management_entitlement_denied`,
  `vault_management_incomplete`.
- F: `rotation_plan_unavailable`, `rotation_plan_mismatch`, `rotation_plan_incomplete`,
  `rotation_plan_stale`.

| Kind | Allowed rejections |
| --- | --- |
| Vault removal creation | V |
| Vault removal finalization | V, replacing `vault_member_not_found` with `vault_membership_changed`, plus F |
| Voluntary Team leave creation | L |
| Voluntary Team leave finalization | L, replacing `team_member_not_found` with `team_membership_changed`, plus F and `rotation_plan_set_mismatch` |
| Administrative Team removal creation | A |
| Administrative Team removal finalization | A, replacing `team_member_not_found` with `team_membership_changed`, plus F and `rotation_plan_set_mismatch` |

Unavailable covers missing, expired, abandoned, completed, or already stale plans without
revealing another User's plan. Mismatch covers actor, target, Vault, reason, or departure intent.
Stale retains only closed details `{planId, reason}`, with the existing reason enum
`vault_version | member_set | item_state | attachment_state`; other rejections have no details.
Existing role and entitlement rules stay unchanged, including voluntary departure without a
paid entitlement. Incomplete staging is terminal for this finalization Operation; completing
staging afterward requires a new finalization Operation ID.

Malformed Operation IDs, transport/JSON/schema/body-limit failures, invalid plan-ID strings,
duplicate supplied IDs, and Vault finalization with other than one ID are not retained.
An empty Team set is valid when no Vault is affected; well-formed authoritative coverage
failure is retained `rotation_plan_set_mismatch`. Authentication, rate limiting, serialization,
deadlock, infrastructure, and audit/Sync/outcome write failures retain nothing. Authenticated
Domain authorization failures are retained. `OPERATION_ID_REUSED` leaves the prior outcome intact.

Implementation must put all plan snapshots in one caller-owned transaction and use savepoint
rollback for partial finalization effects before atomically retaining stale state and rejection.
Voluntary departure still revokes the caller's Session; recovery uses a fresh Session under the
same User. Billing remains best-effort after commit. Kind, route fingerprint, policy binding,
and audit reason preserve voluntary versus administrative identity.

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
cleanup; deletion replay still works afterward. Run affected generated/client checks. Full CI (`pnpm check:ci` and `pnpm check:ci:rust`)
is waived for this run and must not be reported as passed.

## Implementation

Six retained kinds now share a caller-owned SERIALIZABLE transaction with bounded transient retries.
Savepoints roll back partial finalization before stale state, rejection, audit, and resolution commit.
Exact request bytes and required Operation IDs preserve replay identity; malformed requests retain nothing.
Closed storage constraints enforce each rejection set, stale-only details, immutable creation snapshots,
and complete Team arrays without the former 4 KiB response-cache bound.

The executable inventory (`node scripts/check-no-response-cache.mjs`) found zero calls in 140 Server
Rust files before the forward table-drop migration. Legacy wrappers, claim machinery, obsolete error
codes and recovery instructions are removed; separate Account-deletion replay and secret refusal remain.

Targeted Server validation: 13 Rotation tests, 13 mechanism/policy tests, 14 Account-deletion tests,
16 Operation tests, 3 enum checks and 7 error checks passed. The final strengthened Rotation handler
suite passed 9 tests, including byte limits, every prospective write/commit fault, and failure of the
stale marker written after savepoint rollback. `pnpm check:server`, Server Clippy, formatting, inventory,
and diff checks passed. Client/API/Runtime generation and acceptance checks are recorded by its delegate.
Independent peer review of the separately authored client/API/Runtime/Desktop changes found no Standards
or Spec findings; 45 API/Web/Desktop tests (145 assertions) were independently rerun. Independent Server
review also passed and reran 13 Rotation tests plus the zero-call inventory and its regression.
Client validation passed 71 focused tests, ceremony/generator/Rust contract and Runtime regressions,
all 14 dependent type checks, and OpenAPI/API/Runtime generation checks. Migration checks, the refreshed
production WASM build, and Web binding drift/behavior checks passed (11 tests; one harness-only skip).
Full CI was not run.

## Simplification pass

Independent review approved shared empty-body extraction, named policy bindings, and removal of
redundant rejection checks. The six effects, exact bytes, authorization, and transaction boundaries
remain explicit. Rotation and policy tests (13 each), Account-deletion tests (14), Server checks,
Clippy, contract generation, formatting, and dependent types passed after the cleanup.
