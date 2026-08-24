# Rotation Operation outcomes and idempotency removal

Type: task
Status: ready-for-agent
Blocked by: 24
Spec: ../spec.md#server-operation-contract

## Outcome

The five Rotation routes commit retained User-lifetime semantic Operation outcomes like every other
kind, the legacy response-cache idempotency table has no callers left, and it is dropped.

## Why this is separate from ticket 24

The Item routes block the Web host: update, delete, and favorite currently write where nothing reads.
Rotation does not block it. Rotation is also the harder half, because a removal or departure is a
multi-stage plan carrying key material rather than a single entity mutation. Ticket 24 therefore
converts the six Item routes first and leaves `idempotency_record` in place, used only by Rotation.

## Inventory

| # | Public route | Handler | Call site |
| --- | --- | --- | --- |
| 1 | `POST /api/v1/vaults/{vaultId}/members/{userId}/removal-rotation-plans` | `start_vault_member_removal` | `apps/server/src/domains/vaults/http/rotation.rs` |
| 2 | `POST /api/v1/vaults/{vaultId}/members/{userId}/removal-rotation-plans/finalize` | `finalize_vault_member_removal` | same file |
| 3 | `POST /api/v1/teams/{teamId}/leave-rotation-plans` | `start_team_leave` | same file |
| 4 | `POST /api/v1/teams/{teamId}/members/{userId}/removal-rotation-plans` | `start_team_member_removal` | same file |
| 5 | `POST /api/v1/teams/{teamId}/leave-rotation-plans/finalize` and `POST /api/v1/teams/{teamId}/members/{userId}/removal-rotation-plans/finalize` | `finalize_departure`, reached through `finalize_team_leave` and `finalize_team_member_removal` | same file |

Route and handler identity is the durable checklist; line numbers move.

## Decided contract, inherited from ticket 24

- Lookup answers one `OperationOutcome` union tagged on `kind`. Rotation kinds join that union; they
  do not get their own route or their own lookup shape.
- Rejections share the common core (`access_denied`, `read_only`, `invalid_ciphertext`) and add only
  genuinely new Rotation failures.
- No arbitrary retained response bytes, no parallel route, no second protocol version.

## Work

- Decide and record the retained applied payload for plan creation and for finalization. A plan
  identifier and its stage are the obvious candidates; whatever is chosen must let a client that lost
  the response tell an applied plan from a rejected one without replaying the effect.
- Name the Rotation-specific rejections. Likely candidates to confirm against the handlers: the
  member or team is already gone, the plan is missing or already finalized, the submitted rotation
  material does not match the plan, and the caller is not permitted to finalize.
- Preserve the distinction between voluntary departure and administrative removal even though both
  finalization routes share one handler. Route identity must not let one kind replay as the other.
- Convert all five call sites with the same guarded transaction rules: effect or proved rejection,
  audit, entity Sync event, retained outcome, and `operation_resolved` in one transaction.
- Add the executable assertion that `idempotency::execute` has no call sites in `apps/server/src`.
- Only once that passes: add a forward migration dropping `idempotency_record`, and remove the shared
  and HTTP idempotency modules, claim expiry and indeterminate-response errors, the
  `Idempotency-Replayed` response header and its CORS exposure, the obsolete tests, and
  `docs/idempotency-recovery.md`. Keep the separate refusal of idempotency headers on routes that
  return one-time secrets unless a later explicit decision changes it.

## Verification

Every row covers identical replay, changed-fingerprint ID reuse, concurrent duplicate execution,
response loss plus authenticated lookup, renewed Session replay, User isolation, retained applied and
rejected outcomes, and no retained outcome for malformed transport, authentication, or rolled-back
infrastructure failure. Fault injection proves the effect, audit, Sync event, outcome, and
`operation_resolved` commit all-or-nothing. Both finalization routes are tested through the shared
handler, including that one kind cannot replay as the other. The zero-call-site assertion passes
before cleanup and no reference to `idempotency_record` survives after it. `pnpm check:ci` and
`pnpm check:ci:rust` pass.
