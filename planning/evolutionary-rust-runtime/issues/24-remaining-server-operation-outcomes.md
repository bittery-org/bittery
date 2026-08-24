# Remaining Server Operation outcomes: Item routes

Type: task
Status: ready-for-agent
Blocked by: 17
Spec: ../spec.md#server-operation-contract

## Outcome

Convert every remaining legacy response-cache idempotency caller to the retained User-lifetime
semantic Operation-outcome contract established by ticket 17. Remove the old response-cache table,
claim lifecycle, replay surface, and recovery path only after the caller inventory is demonstrably
zero.

## Current inventory

The baseline has exactly eleven `idempotency::execute` call sites across twelve public routes. The
shared `finalize_departure` handler accounts for both team finalization routes.

| # | Public route | Handler | Current call site |
| --- | --- | --- | --- |
| 1 | `PATCH /api/v1/items/{itemId}` | `update_item` | `apps/server/src/domains/vaults/http/items.rs:359` |
| 2 | `PATCH /api/v1/items/{itemId}/favorite` | `set_favorite` | `apps/server/src/domains/vaults/http/items.rs:404` |
| 3 | `DELETE /api/v1/items/{itemId}` | `delete_item` | `apps/server/src/domains/vaults/http/items.rs:442` |
| 4 | `POST /api/v1/items/{itemId}/restore` | `restore_item` | `apps/server/src/domains/vaults/http/items.rs:479` |
| 5 | `POST /api/v1/items/{itemId}/moves` | `move_item` | `apps/server/src/domains/vaults/http/items.rs:518` |
| 6 | `DELETE /api/v1/items/{itemId}/permanent` | `permanently_delete_item` | `apps/server/src/domains/vaults/http/items.rs:561` |
| 7 | `POST /api/v1/vaults/{vaultId}/members/{userId}/removal-rotation-plans` | `start_vault_member_removal` | `apps/server/src/domains/vaults/http/rotation.rs:231` |
| 8 | `POST /api/v1/vaults/{vaultId}/members/{userId}/removal-rotation-plans/finalize` | `finalize_vault_member_removal` | `apps/server/src/domains/vaults/http/rotation.rs:273` |
| 9 | `POST /api/v1/teams/{teamId}/leave-rotation-plans` | `start_team_leave` | `apps/server/src/domains/vaults/http/rotation.rs:312` |
| 10 | `POST /api/v1/teams/{teamId}/members/{userId}/removal-rotation-plans` | `start_team_member_removal` | `apps/server/src/domains/vaults/http/rotation.rs:342` |
| 11 | `POST /api/v1/teams/{teamId}/leave-rotation-plans/finalize` and `POST /api/v1/teams/{teamId}/members/{userId}/removal-rotation-plans/finalize` | `finalize_departure`, reached through `finalize_team_leave` and `finalize_team_member_removal` | `apps/server/src/domains/vaults/http/rotation.rs:385` |

Line numbers describe the inventory when this ticket was written; the route and handler identities
are the durable checklist if intervening edits move them.

## Unresolved contract frontier

Ticket 17 deliberately defines a closed `CreateItemOperationOutcome`, a create-Item rejection enum,
and a lookup response containing that one outcome type. Before this ticket can become
`ready-for-agent`, maintainers must decide the closed wire contract for the additional Item and
Rotation Operation kinds:

- whether lookup returns one generated cross-kind outcome union or another closed projection;
- the applied payload retained for each Item mutation, Rotation-plan creation, and Rotation
  finalization; and
- which existing failures are terminal semantic rejections for each kind, including their closed
  safe details, versus transport, authentication, or infrastructure failures that retain no outcome.

Those answers must preserve the fixed identity, fingerprint, atomicity, retention,
`OPERATION_ID_REUSED`, `operation_resolved`, bounded Sync, and hint-only SSE rules in the accepted
specification. They must not introduce parallel routes or a second protocol version.

## Work

- Record the resolved route-wide outcome and lookup shapes in the specification and generate their
  Rust/OpenAPI/client representations under ADR 0012.
- Extend the deep Operation module and frozen-forward persistence schema only as required by the
  resolved closed kinds and results; do not retain arbitrary HTTP response bytes.
- Convert the six Item call sites. For each route, require the stable Operation ID, fingerprint exact
  raw bytes plus canonical path and normalized `If-Match`, and commit effect or proved rejection,
  audit, existing entity Sync event, retained outcome, and `operation_resolved` in one transaction.
- Convert the five Rotation call sites with the same guarded transaction and retained-outcome rules.
  Preserve the distinction between voluntary and administrative finalization even though their HTTP
  handlers share one function.
- Change Server schema, OpenAPI, generated clients, Runtime contract consumers, and current callers
  together in place. No compatibility endpoint or temporary shippable dual protocol is allowed.
- Add an executable inventory assertion that fails unless
  `rg -n 'idempotency::execute' apps/server/src --glob '*.rs'` returns no call sites.
- Only after that zero assertion passes, add a forward migration dropping `idempotency_record` and
  remove the old shared/HTTP idempotency modules, claim expiry and indeterminate-response errors,
  `Idempotency-Replayed` responses and CORS exposure, obsolete tests, and
  `docs/idempotency-recovery.md`. Preserve the separate rejection of idempotency headers on routes
  that return one-time secrets unless a later explicit decision changes it.

## Verification

- For every inventory row, tests cover identical replay, changed-fingerprint ID reuse, concurrent
  duplicate execution, response loss plus authenticated lookup, renewed Session replay, User
  isolation, retained applied and rejected outcomes, and no outcome for malformed transport,
  authentication, or rolled-back infrastructure failure.
- Fault injection proves each Domain effect, audit, existing entity Sync event, outcome, and
  `operation_resolved` event commits all-or-nothing. Rotation tests cover both routes through the
  shared finalizer and verify that route identity cannot replay one kind as the other.
- Changes and Bootstrap retain their current bounds; `operation_resolved` remains User-scoped and
  Bootstrap does not enumerate lifetime outcome history. SSE wakes only for newly committed events.
- The zero-call-site assertion passes before cleanup, no query or code reference to
  `idempotency_record` remains after cleanup, and generated contracts have no drift.
- Run targeted Server tests while iterating, then `pnpm check:server`, `pnpm check:ci:rust`, and
  `pnpm check:ci` before resolving the ticket.

## Comments

- This ticket is intentionally `needs-info`: the create-Item-only persisted/result/lookup model does
  not determine safe closed results and semantic rejection sets for the eleven remaining call sites.
  Implementation must not infer those product protocol choices.

### 2026-08-24 — frontier resolved, and the ticket narrows to the Item routes

Three decisions close the contract frontier. They govern every kind, including the Rotation routes
that ticket 29 now carries.

**Lookup returns one union tagged on `kind`.** `GET /api/v1/operations/{operationId}` answers a
single `OperationOutcome` discriminated by the `kind` field the outcome already carries, not one
route per kind and not a shared shape with a free JSON payload. Response-loss recovery is precisely
the caller that does not yet know what happened, so it cannot choose a per-kind route; and the
specification requires closed types and forbids retaining arbitrary response bytes. A client reads
`kind`, checks it against its own durable record, and only then reads the result. An unknown `kind`
is therefore detectable rather than silently misread.

**Rejections share a core and add only what is genuinely new.** `access_denied`, `read_only`, and
`invalid_ciphertext` are common to every kind and are shared. Each kind adds only its own real
failures: a stale version on update, a missing Item on delete, restore, move, and permanent delete,
and a non-writable destination on move. One fact keeps one name, so the interface translates it
once. A single generic rejection code was rejected: the client could no longer tell whether to
re-authenticate, reload, or stop, and that distinction is the whole reason semantic outcomes exist.

**Items convert first; Rotation follows in ticket 29.** The six Item routes are what block the Web
host — update, delete, and favorite currently write where nothing reads. The five Rotation routes are
multi-stage plans carrying key material and are the harder half. `idempotency_record` therefore
survives this ticket, used only by Rotation, and ticket 29 removes it. The zero-call-site assertion
and the migration dropping the table move to ticket 29 with it; this ticket asserts only that no
Item route reaches `idempotency::execute`.
