# Rust backend architecture review — August 2026

Scope: `apps/server` only. The monorepo-wide review and its refactors are done and are not revisited here.

Method: eight parallel research agents over the full crate, plus direct inspection. Every claim below
carries a `file:line`. Where a claim is inference rather than measurement, it says so.

Baseline: 52,834 LOC of Rust in `apps/server/src`, of which roughly **31,000 is production code and
21,800 is test code and test infrastructure** (15,844 in `*_tests.rs`, ~4,900 in inline `#[cfg(test)]`
blocks, 1,045 in `test_support.rs`). By directory: `services/` 18.6k, `http/` 10.4k,
`integrations/` 2.4k, `repo/` 1.1k, `db/` 1.0k, `shapes/` 1.0k, `jobs/` 0.5k.

---

## 1. Executive summary

**Keep SQLx. Do not adopt SeaORM or Diesel.** The pain in this codebase is not the database library.
Row mapping is already declarative (87 `#[derive(FromRow)]`, zero manual `row.get`), the hard queries
are byte-budgeted window-function CTEs and advisory-lock quota checks that no ORM query builder
expresses well, and a zero-knowledge password manager has almost no rich relation graph for an ORM's
main selling point to bite on. An ORM migration would touch ~254 query sites and ~5,000 LOC of service
code to fix problems that four mechanical refactors fix for a fraction of the cost. Details in §9.

**The backend is in better shape than the brief assumes.** Three of the review's starting premises
turned out not to hold:

- Server DB test isolation is **already solved**, and solved well: one ephemeral Postgres database per
  test, migrated fresh, dropped even on panic (`test_support.rs:859-948`). There is no shared-database
  coupling to fix.
- `http/api/vault.rs` (1,936 LOC) contains **zero SQL and zero transactions**. It is 31 thin handlers
  plus ~350 lines of DTOs. The layering it was flagged for violating is intact.
- **No transaction anywhere crosses into HTTP code.** Every `pool.begin()` in the crate opens and
  commits inside a single service function.

**The real problems are duplication and plumbing, not architecture.** The same authorization query is
copy-pasted 3 times across the vault package and 7 times inside `team.rs`. A shared error helper exists
(`transaction::database_error`) and is used by 3 of ~30 service modules; everywhere else the same
three-line `tracing::error!` + `AppError::internal` closure is retyped per query, which is why 383 of
671 `AppError` construction sites (57%) are `internal`. One module skipped the shared helper and thereby
lost retryable-conflict classification (`vault_key_rotation.rs:148`) — that is a live defect, not a style
issue.

**Two correctness gaps warrant fixing regardless of any restructuring:**

1. Audit rows are written **after** the transaction commits at ~10 sites in `vault/catalog.rs` and
   `vault/items.rs`. A crash in that window loses the audit trail for a write that actually happened.
2. `POST /webhooks/stripe` has **no integration test at all** — the only tests cover HMAC signature math
   (`billing/webhook.rs:510-548`). Every billing state transition driven by Stripe is unverified.

**Recommended direction:** four low-risk mechanical phases (dedup → plumbing → correctness → targeted
splits), then an optional fifth phase moving to a `domains/` tree. Net expected change is roughly
**−900 production LOC** with no behaviour change, plus ~+400 LOC of new tests. Phases 1–3 are worth doing
independently of whether the `domains/` move ever happens.

---

## 2. Current backend architecture

### Module tree as it exists

```
apps/server/src/
├── main.rs                 tracing init, bind address, axum::serve
├── lib.rs                  AppState (10 fields), NotifySyncExt, public re-exports
├── runtime.rs              ServerRuntime::from_env — the real composition root
├── app.rs                  create_app: router + layer composition
├── config.rs               6 env-backed mode/flag helpers (BITTERY_MODE, TRUST_PROXY_MODE, …)
├── error.rs                AppErrorCode (13 variants) + AppError { code, message }
├── test_support.rs         per-test Postgres, ApiTestApp, OpenAPI response validation
├── bin/{migrate,write-openapi}.rs
│
├── http/
│   ├── mod.rs
│   ├── middleware.rs       trace layer, edge (CORS + security headers), catch-panic
│   ├── public.rs           /cdn/*, /favicon/*, /waitlist, /webhooks/stripe  (outside OpenAPI)
│   ├── sync_sse.rs         SSE event loop
│   └── api/
│       ├── mod.rs          ApiDoc, openapi_router(), contract tests
│       ├── error.rs        ApiError + ProblemDetails (RFC 9457)
│       ├── error_code.rs   ErrorCode — 34 stable wire codes
│       ├── extract.rs      ApiJson/ApiQuery/ApiMergePatch/AuthenticatedRequest/PublicRequest
│       ├── pagination.rs   HMAC-signed cursors + byte-budgeted paging
│       ├── dto.rs          request_dto!/response_dto! macros + shared wire types
│       ├── limits.rs, security.rs, idempotency.rs
│       └── auth|vault|team|share|sync|billing|audit|travel_mode|vault_key_rotation.rs
│
├── services/               26 modules — the actual domain layer, owns all SQL (ADR 0002)
│   ├── auth/               mod, login, registration, credentials, recovery, devices, request_context
│   ├── vault/              mod, catalog, items, attachments, pagination
│   ├── billing/            mod, webhook
│   └── session, team, share, sync, audit, access, travel_mode, rate_limit, verification_code,
│       vault_key_rotation, vault_membership, member_departure, team_admin, team_billing,
│       idempotency, transaction, sync_pubsub, connection_registry, redis, auth_email, waitlist,
│       session_control, vault_key
│
├── repo/                   partial, ~18% of queries: access, audit, billing, common, share, sync,
│                           travel_mode   (ADR 0002 declares this asymmetry intentional)
├── db/
│   ├── mod.rs              pool, run_migrations, DATABASE_URL handling
│   ├── enums.rs            closed_enum! — hand-written Type/Encode/Decode for 14 DB enums
│   └── models/             auth, billing, share, sync, team, vault row structs
├── shapes/                 macro DSL: one field list → service struct + wire struct + From impl
├── integrations/           favicon (498), storage (1071), stripe (803) — all behind traits
├── jobs/                   runner (7 cron jobs) + sql
└── migrations/             19 files, two naming schemes
```

### How it is actually organized

The crate is **layer-first at the top level, domain-first inside each layer**. `http/api/` and
`services/` each contain one module per business capability, and those names line up almost exactly.
It is roughly 80% of the way to the domain-oriented target already — the remaining distance is that a
vault change touches `http/api/vault.rs`, `services/vault/*.rs`, `db/models/vault.rs` and
`shapes/vault.rs` across four top-level directories.

---

## 3. Request / data flow

The actual flow, verified against `app.rs:9-35`, `middleware.rs`, `request_context.rs:20-58` and
`extract.rs:168-224`:

```
TCP  →  axum::serve  (main.rs:33, ConnectInfo<SocketAddr> preserved)
  ↓
http_trace_layer                      middleware.rs:33 — span start, W3C traceparent parsed & validated
  ↓
edge_http_middleware                  middleware.rs:249 — exact-origin CORS allowlist,
                                      OPTIONS short-circuits to 204, security headers, no-store
  ↓
catch_panic_layer                     middleware.rs:58 — panic → 500 (guards a real rand 0.10 reseed panic)
  ↓
route match
  ├── /  /healthz                     app.rs:20-24
  ├── public router                   public.rs — /cdn/*, /favicon/*, /waitlist, /webhooks/stripe
  │                                   NO session middleware, NO ProblemDetails, own {"error": …} shape
  └── /api/v1 router
        ↓
      request_context_middleware      request_context.rs:20 — parse bearer, sessions.verify_token(),
                                      insert RequestMetadata + VerifiedSession into extensions,
                                      set bittery-session-expires on the way out
        ↓
      api_response_headers            mod.rs:123 — bittery-api-version, bittery-request-id if absent
        ↓
      DefaultBodyLimit                per route group: 1 MiB ordinary, ~1.06 MiB items, 16 MiB bulk
        ↓
      handler                         extractors run here:
                                        AuthenticatedRequest  → reads extensions, 401 if no session
                                        ApiJson / ApiMergePatch / ApiQuery / ApiPageQuery
        ↓
      services::<domain>::fn(&pool, user_id, input)
        ├─ authorization: load_vault_access(…) / ensure_team_admin(…) / SQL WHERE-clause join
        ├─ pool.begin()
        ├─ sqlx::query_as::<_, DbXRow>("…").bind(…)         ← runtime-checked, no macros
        ├─ insert_sync_event(&mut *tx, …)                   repo/common.rs — inside the transaction
        ├─ tx.commit()
        ├─ insert_audit_event(pool, …)                      ← AFTER commit. See §5.1
        └─ sync_pubsub.notify_sync() / .notify_sync(&state)
        ↓
      From<service::X> for wire::X    shapes/*.rs (generated) or hand-written From impl
        ↓
      Json<T> / CursorPage<T>

on error at any depth:
      AppError { code, message }
        → From<AppError> for ApiError            http/api/error.rs:192 — logs internal errors a 2nd time
        → ProblemDetails (RFC 9457)
        → IntoResponse                           error.rs:300 — application/problem+json,
                                                 bittery-request-id, optional retry-after
```

Two documented deviations from this flow:

- **SSE** bypasses the handler shape entirely. `sync.rs:330` is a two-line bridge into
  `sync_sse::sync_events` (`sync_sse.rs:33-249`), which runs its own `tokio::select!` loop and touches
  five of ten `AppState` fields directly.
- **Public routes** never enter `request_context_middleware` and produce a second, parallel error shape
  (`public.rs:59-61`, 13 call sites) that is outside the `ErrorCode` contract.

---

## 4. What is already well designed

These are load-bearing and should be protected from any refactor.

**→ Layer discipline is genuinely clean.** `http/api/**` contains zero SQL and zero `pool.begin()`.
`services/**` imports `axum` in exactly two files, both deliberately (`request_context.rs`, and
`sync.rs:1` for SSE `Event`). No `Db*Row` struct ever reaches an HTTP response; no wire DTO reaches a
service. For a 37k-LOC crate that is unusual and worth saying out loud.

**→ Transaction boundaries are correct everywhere.** All ~60 `.begin()` sites open and commit inside one
service function. None is held across an HTTP concern or an external call.

**→ Per-test database isolation.** `TestDatabase::create` (`test_support.rs:859`) issues
`CREATE DATABASE bittery_test_<name>_<millis>_<seq>`, runs all 19 migrations into it, and drops it in a
`catch_unwind` so a panicking test still cleans up — with a self-test proving it
(`test_support.rs:1014-1029`). ~145 tests use it. This is the strongest thing in the codebase.

**→ Tests drive the real router.** `create_test_router` is literally `create_app(state, …)`
(`test_support.rs:152`), driven via `tower::oneshot`. Requests traverse the true middleware stack into
real Postgres, and **every response is validated against the generated OpenAPI document**
(`test_support.rs:301-389`).

**→ The OpenAPI contract is defended by four independent CI gates**: `write-openapi --check`
(`ci.yml:651`), `openapi-typescript --check` (`ci.yml:277`), `oasdiff breaking --fail-on ERR`
(`ci.yml:319-359`), and in-crate count assertions (`http/api/mod.rs:191`, `:397`). The count assertions
look like magic numbers but catch a real class of silent bug: utoipa keys schemas by short type name, so
two same-named `ToSchema` types overwrite each other with no error.

**→ `shapes/`** solves the DTO-duplication problem properly: one canonical field list generates the
service struct, the wire struct with its utoipa bounds, and the `From` impl. 42 `shape_from!` sites.

**→ `db/enums.rs`'s `closed_enum!`** hand-writes `Type`/`Encode`/`Decode` so a Rust enum decodes from both
a native Postgres enum and a `::text` cast. This is more capable than any ORM's enum mapping and is why
the existing `::text` casts in queries did not have to change.

**→ Injectable integration seams that actually have second implementations.** `ObjectStorage`
(S3Compatible / Unavailable / Recording), `BillingGateway` (Stripe / Test), `RemoteDocumentFetcher`
(Reqwest / Stub), `RateLimiter` (Postgres / Redis / Noop / Panicking). No speculative traits.

**→ Middleware ordering is deliberate and tested.** Panic-catch sits inside the edge layer so a 500 still
carries CORS and security headers, asserted by `panic_responses_keep_edge_headers` (`app.rs:238`).

**→ `pagination.rs`** implements HMAC-signed cursors bound to `(principal, scope, filters)`, so a cursor
cannot be replayed against another user or endpoint, plus a serialized-byte budget on top of item counts.

---

## 5. Architecture problems

Ordered by severity, not by size.

### 5.1 Audit rows are written outside the transaction — correctness

At roughly 10 sites the sync event is inserted **inside** the transaction and the audit row **after**
`commit()`. `create_vault` commits at `vault/catalog.rs:353` and audit-logs at `:358`. Same shape in
`update_vault`, `convert_vault_type`, `delete_vault`, `add_vault_member`, and in `items.rs` for
`create_vault_item`, `delete_vault_item`, `restore_vault_item`, `move_vault_item`,
`permanently_delete_vault_item` (e.g. `items.rs:410-421`).

A process death or connection failure between the two leaves a committed mutation with no audit record.
For a password manager whose team-admin console is built on that audit feed (`services/audit.rs`), a
silently incomplete audit trail is a security-relevant defect, not a tidiness issue.

`insert_audit_event` is already generic over `impl Executor` (`repo/common.rs`), so moving these calls
inside the transaction is mechanical.

### 5.2 `vault_key_rotation.rs` lost retryable-conflict classification — correctness

`transaction::database_error` (`transaction.rs:10-19`) inspects SQLSTATE `40001`/`40P01` and maps
serialization failures and deadlocks to a **retryable** conflict. `member_departure.rs:352` and
`vault_membership.rs:200` delegate to it correctly.

`vault_key_rotation.rs:148-151` reimplements it and drops the classification:

```rust
fn database(error: sqlx::Error) -> AppError {
    tracing::error!(%error, "Vault key rotation database operation failed");
    AppError::internal("Vault key rotation operation failed")
}
```

Key rotation is the most transaction-heavy, most contended path in the system (ADR 0013 — rotation plans
are finalized in the same transaction as team reassignment, session revocation, audit and sync events).
Deadlocks there surface to clients as opaque 500s instead of retryable conflicts. `idempotency.rs:172-175`
has the same defect on a less critical path.

### 5.3 The same query is copy-pasted instead of shared — maintenance and drift risk

The single largest source of avoidable LOC and the most likely origin of a future authorization bug.

| Duplicated thing | Copies | Locations |
|---|---|---|
| `load_vault_access` (vault role lookup + forbidden) | **3, byte-identical** | `vault/catalog.rs:1395`, `vault/items.rs:1093`, `vault/attachments.rs:638` |
| "load user, check team membership" SQL + check | **7, verbatim** | `team.rs:227, 297, 417, 504, 857, 988, 1117` |
| `load_item_row` | 2 | `vault/items.rs:1079`, `vault/attachments.rs:623` |
| `insert_item_sync_event` | 2 | `vault/items.rs:978`, `vault/attachments.rs:600` |
| `assert_item_write_access` | 2 | `vault/items.rs:930`, `vault/attachments.rs:592` |
| `attachments_enabled_for_user` | 2 | `sync.rs:355-373`, `vault/attachments.rs:467-487` |
| `generate_secure_token` | 2 | `team.rs:1391`, `share.rs:1062` |
| `validate_resource_id` (+ its `LazyLock<Regex>`) | 2 | `sync.rs:291`, `auth/mod.rs:524` |
| `team_management_enabled` | 2 | `team_billing.rs:55` (canonical) vs a private copy at `auth/registration.rs:976` |
| pending-vault-key parse + authorize | 2 | `team.rs:1249-1352`, `auth/registration.rs:877-963` |
| short-lived JWT issuance | 2 | `auth/registration.rs:993`, `auth/recovery.rs:420` |
| advisory-lock + count quota check | 3 | `vault/catalog.rs:303`, `:517`, `share.rs:204` |

`team.rs` is the sharpest case: a proper helper, `load_team_membership_actor` (`team.rs:1402`), already
exists and is used by four functions, while seven others inline a weaker copy of the same query.

### 5.4 Authorization rules exist in two independent implementations

The vault member role matrix — self-removal blocked, `can_manage` required, owner immune, admin cannot
act on admin — is written twice with different error messages: `vault_membership.rs:30-44`
(used for removal) and inline at `vault/catalog.rs:875-880` (used for role change). Two copies of one
security rule is the condition under which they eventually disagree.

Authorization is otherwise consistently **fail-closed**: every membership query either joins the auth
table so unauthorized rows are invisible, or uses `fetch_optional().ok_or_else(forbidden)`. No
`fetch_one` and no `LEFT JOIN` gate was found. The risk is drift across copies, not a present hole.

### 5.5 Error plumbing is retyped per query

`transaction::database_error` is used by **3 of ~30** service modules. Everywhere else — `team.rs`,
`vault/*`, `share.rs`, `auth/*` — the same three-line closure is written per query site. Five distinct
local `fn database(...)`/`fn database_error(...)` shims exist (`transaction.rs:10`,
`vault_key_rotation.rs:148`, `member_departure.rs:352`, `vault_membership.rs:200`, `idempotency.rs:172`).

Consequence: **383 of 671** `AppError` construction sites (57%) are `AppError::internal`. Combined with
the second log emitted by `From<AppError> for ApiError` (`http/api/error.rs:196`), every internal failure
is logged twice, the second time with strictly less information, because `AppError` carries only a
`String` and no source chain.

### 5.6 Executor typing is inconsistent, which forces the duplication in 5.3

Three incompatible conventions coexist:

- generic `impl sqlx::Executor<'e, Database = Postgres>` — correct, but only in `repo/common.rs` (3 fns),
  `repo/travel_mode.rs` (1) and `vault_key_rotation.rs:201`;
- hardcoded `&mut Transaction<'_, Postgres>` — 20+ functions across `catalog.rs`, `items.rs`,
  `attachments.rs`, `registration.rs`, `credentials.rs`, `team.rs`, `verification_code.rs`. These cannot
  be called standalone;
- hardcoded `&PgPool` — most read helpers. These cannot be called inside a transaction needing
  read-your-writes.

That is the mechanical reason `load_vault_access` exists three times: a `&PgPool` copy in one module
cannot serve a transaction-bound caller in another.

### 5.7 `integrations/` holds domain logic

`storage.rs` is 1,071 lines, of which only ~300-400 are S3/SigV4 wire protocol. The rest is domain
policy: the object-key naming convention (`storage.rs:123-135`), the "which keys are publicly servable"
rule (`resolve_public_url:100-106`), and — most significantly — a **self-signed capability token embedded
in the S3 key**: `sign_attachment_upload_intent` / `verify_attachment_upload_intent`
(`storage.rs:622-637`) HMAC-sign `user_id:item_id:upload_id:expires_at_ms` and the key is parsed back and
re-verified to authorize an upload (`storage.rs:137-194`). That is an authorization decision with an
expiry, living in an integration adapter.

Inversely, `integrations/favicon.rs:99-153` runs SQL directly against the `favicon` table, which conflicts
with ADR 0002's "services own their SQL".

### 5.8 Missing edge protections

- **No request timeout anywhere.** No `tower_http::timeout::TimeoutLayer` in the crate. A slow Postgres,
  Stripe, Redis or favicon `reqwest` call hangs a connection indefinitely. Given `DATABASE_MAX_CONNECTIONS`
  defaults to **5** (`db/mod.rs:12`), a handful of stuck requests can exhaust the pool.
- **No compression layer**, so every JSON list response ships uncompressed.
- **`vault_key_rotation.rs`'s router has no `DefaultBodyLimit`**, unlike all five sibling routers, so it
  silently falls back to axum's 2 MiB default rather than the 1 MiB convention.

### 5.9 Config sprawl

`config.rs` owns 6 helpers. **~35 production `env::var` call sites read configuration directly at call
time**, including secrets: `JWT_SECRET` (`auth/mod.rs:494`, `http/api/pagination.rs:83`),
`STRIPE_SECRET_KEY` (`stripe.rs:83`, `billing/webhook.rs:438`), `STRIPE_WEBHOOK_SECRET`
(`webhook.rs:431`), storage credentials (`storage.rs:85, 303-307, 608`), plus tunables like
`SHARE_LINK_DAILY_LIMIT` (`share.rs:1074`) and `RATE_LIMIT_ADAPTER` (`rate_limit.rs:67`).

Because these are read at call time rather than at startup, they are process-global mutable state during
tests — which is exactly why `test_support.rs` needs `acquire_env_lock` and `EnvVarGuard` at all (§17).
It also means a missing or malformed secret surfaces as a runtime 500 on first use rather than a startup
failure.

### 5.10 Hidden side effects

Several operations touch three to five subsystems with nothing in the signature to say so.
`auth/devices.rs:63-138` (`revoke_device`) revokes the session, notifies pubsub, records session-control
rows, and inserts an audit event. `auth/recovery.rs:207-270` (`reset_password`) does five. Four different
domains fire a best-effort Stripe seat sync as a tail effect of an unrelated write (`team.rs:947`,
`registration.rs:486`, `member_departure.rs:328, 348`). `connection_registry.rs:205` mutates a Redis cache
inside what reads as a read-only `resolve_connection_limit`.

This is not wrong — the effects are wanted — but it is undocumented, and it interacts with 5.1: the parts
that run after commit are the ones that can be silently lost.

---

## 6. Large-module assessment

The instruction was to split only where ownership improves. Here is the honest per-file verdict.

### `http/api/vault.rs` — 1,936 LOC — **split, low priority**

Contents: 48-341 DTOs, 342-452 `From` impls, 453-546 protocol helpers (If-Match/ETag parsing, merge-patch
tri-state, ciphertext bounds), 624-1627 **31 handlers**, 1628-1936 tests. Zero SQL, zero transactions.

Mean handler is ~30 lines. Only three are fat: `list_all_items` (78 LOC, `:830`, branches on an
`active`/`trashed` query param with two near-duplicated blocks), `update_item` (52 LOC, `:1065`) and
`set_favorite` (42 LOC, `:1117`), the latter two mostly from repeated If-Match + idempotency wrapper
boilerplate.

Four clean seams with no cross-coupling: vaults (624-795), items (795-1315), attachments (1329-1483),
members (1484-1627). Splitting mirrors the service-layer package that already exists. **Worth doing, but
it buys navigation only — this file has no design problem.** Do it in phase 3 or not at all.

### `services/session.rs` — 1,619 LOC — **extract one block; keep the rest**

- 389-923 `PostgresSessionStore` (~535 LOC): the real product logic — token issuance, verification,
  refresh, device grouping by `(user_id, platform, client_id)`, revocation. **One cohesive subject. Keep.**
- 925-1230 (~305 LOC): a full in-memory backend mirroring the Postgres one, reached only via
  `with_dev_seed()` and `issue_session_for_tests`. Dev/test tooling inside the production module.
  Optional extraction; it is coupled to types declared at the top of the file.
- **1392-1618 (~226 LOC): a complete User-Agent parsing library** — `parse_user_agent`, `detect_os`,
  `detect_browser`, `detect_platform`, `build_device_name`. Pure `&str` → struct. Zero session semantics.
  **Extract to `user_agent.rs`.** Free, and it makes the parsing independently testable.

No rate limiting and no authorization live in this file, contrary to what its size suggests.

### `services/team.rs` — 1,420 LOC — **split invitations; fix the 7× query first**

Two subjects: team CRUD (187-650) and the invitation lifecycle (652-1106 plus `invitation_handlers`
1155-1212). The invitation state machine already has its own DTOs and its own inline submodule — the seam
half-exists.

Fattest functions: `send_invitation` 128 LOC (`:652`), `accept_loaded_invitation` 126 LOC (`:835`),
`delete_team` 117 LOC (`:535`). Their size is driven substantially by the inlined actor query and
per-query error closures, so **the dedup in §5.3 should land before any split** — otherwise the split
just distributes seven copies across two files.

### `services/vault/` — 3,624 LOC across 5 files

- `mod.rs` (379) and `pagination.rs` (40): **keep**. Manifest + shared input types, and a single-purpose
  byte-budget helper.
- `attachments.rs` (655): **keep**. One subject, correctly sized.
- `catalog.rs` (1,412): **split**. `mod member_handlers` (749-1174, ~425 LOC) already has its own imports
  and row types and is re-exported at `:1174` — promoting it to `vault/members.rs` is near-mechanical and
  separates "how vault settings work" from "who may access a vault".
- `items.rs` (1,138): **split only after the dedup**. The seams are real (CRUD / trash lifecycle / bulk
  import) but the three groups share `load_vault_access`, `load_item_row` and `insert_item_sync_event` —
  splitting first would turn intra-file duplication into cross-file duplication.

### `http/api/auth.rs` (1,118) and `http/api/team.rs` (771) — **keep both**

24 and 19 thin handlers respectively, no business logic, no duplication against each other. `team.rs`
already delegates across four separate service modules (`team`, `invitation_handlers`, `member_handlers`,
`access`) while staying flat — direct evidence that once the service layer is split correctly, the HTTP
file does not need to be.

### `services/auth/registration.rs` — 1,080 LOC — **deduplicate, do not split**

`signup` (168 LOC, `:184`) and `signup_with_invitation` (172 LOC, `:352`) share ~80% of their bodies. More
importantly the file reimplements invitation logic that already exists in `team.rs`: pending-invitation
lookup (`:581`, `:650` vs `team.rs:780`), pending-vault-key parse and authorize (`:877`, `:912` vs
`team.rs:1285`, `:1300`), and its own private `team_management_enabled` (`:976`) shadowing the canonical
one. Fix the sharing; the file size is a symptom.

---

## 7. SQLx usage analysis

**Configuration.** `Cargo.toml:23`: `sqlx = { version = "0.8", features = ["postgres",
"runtime-tokio-rustls", "time"] }`. No `macros`, no `uuid`, no `chrono`. No `.sqlx` offline directory.
No `SQLX_OFFLINE` anywhere in CI.

**Consequence: zero compile-time query checking.** All queries use the runtime API — 145 `query_as::<`,
100 `query_scalar::<`, ~9 `sqlx::query_as(`, 3 `sqlx::query(`. **Zero** `query!` / `query_as!` /
`query_scalar!` macro uses. A column rename in a migration is caught only when a live-Postgres test or
production hits that code path.

**Where SQL lives.**

| Location | Query sites | Share |
|---|---|---|
| `services/**` | 154 | **80.2%** |
| `repo/**` | 35 | 18.2% |
| `jobs/sql.rs` | 3 | 1.5% |
| `http/**` | 0 | 0% |

Heaviest: `team.rs` 32, `vault/items.rs` 20, `vault/catalog.rs` 20, `session.rs` 12, `repo/sync.rs` 11,
`verification_code.rs` 11.

**Row mapping is already declarative.** 87 non-test `#[derive(FromRow)]`, and **zero** `row.get` /
`row.try_get` in production code. (An earlier count of 181 `.get(` calls was `serde_json::Value::get`,
`HeaderMap::get` and regex captures — not row mapping.) Roughly half the derives are centralized in
`db/models/*.rs`; the rest are function-local `Db…Row` structs declared next to their query, which is a
reasonable pattern for single-use projections.

**Types.** IDs are `String` everywhere, produced by `repo/common.rs:16-18`
(`format!("{prefix}_{:016x}", random::<u64>())`) — prefixed opaque strings, not native `uuid` columns, so
no `uuid` feature is needed. Timestamps are `time::OffsetDateTime`, matching the one enabled feature. JSON
binds as `serde_json::Value`. Enums go through `closed_enum!` (`db/enums.rs`), ~130 LOC of macro plus ~375
LOC of per-enum declarations for 14 enums.

**Relations.** No `json_agg` anywhere. 1:N loading is deliberately batched, not N+1: fetch a page of IDs
with a weighted CTE, then `WHERE id = ANY($1) ORDER BY array_position(…)`, then a second query for
children merged in memory via `HashMap` (`vault/items.rs:32-131`, `:133-207`; `repo/sync.rs:206`, `:279`).
Team queries use plain `INNER JOIN` (`team.rs:315`, `vault/catalog.rs:803`).

**Pagination.** Keyset, byte-budgeted. The Rust side is shared (`http/api/pagination.rs`, 48 call sites),
but **the SQL predicate is hand-copied per query** — `($2::timestamptz IS NULL OR (i.updated_at, i.id) <
($2, $3))` appears near-identically at `vault/items.rs:71` and `:167` and in ~8 other places. The generic
Rust layer cannot generate it, because the SQL is an opaque string.

**Partial updates.** 15 `COALESCE($n, column)` sites. No `sqlx::QueryBuilder` anywhere. Each optional
field means editing the SQL text, the bind order and the caller in lockstep with no compiler check.

**Injection risk: none.** All user-influenced values bind via `$n`. The only `format!`-into-SQL sites
interpolate the compile-time constant `BOOTSTRAP_ITEM_COLUMNS` (8 sites) or internally generated test/DDL
database names (`test_support.rs:871`, `bin/migrate.rs:54`), where Postgres does not permit parameters.

---

## 8. SQLx pain points specific to Bittery

Not generic complaints — each is measured in this repo.

1. **No compile-time checking, by configuration.** 254 query sites verified only at runtime. This is one
   Cargo feature away from being different and is the single largest missed guarantee.
2. **Positional tuple rows.** `vault_key_rotation.rs:100-108` types a 7-field `PlanRow` as a tuple, then
   reads it as `row.4`, `plan.5 <= now` at `:213, 216, 259, 312, 338`. Reordering the `SELECT` list
   silently reorders the fields with no warning. This is the one place `FromRow` was skipped, and it is in
   the most safety-critical module.
3. **Nothing nudges toward sharing a query.** Hence `load_vault_access` ×3, the team actor query ×7, and
   four independent declarations of the identical page-weight row shape (`ItemPageWeight`,
   `BootstrapPageWeight`, `SyncEventPageWeight`, `AuthVaultKeyPageWeight`).
4. **Inconsistent executor typing fragments the call graph** and causes (3). See §5.6.
5. **No enforced error-mapping entry point**, which produced the live `vault_key_rotation.rs:148` defect.
6. **The keyset predicate cannot be factored**, so ~10 paginated queries repeat it by hand.
7. **`format!`-composed column lists** at 8 sites because runtime `query_as` cannot compose fragments.
8. **`repo/` looks like a data-access layer but covers 18% of queries**, so the directory listing actively
   misleads a newcomer about where SQL lives.
9. **Enum variants are spelled twice** — once in the `serde` derive block, once in the `closed_enum!`
   invocation (`db/enums.rs:131-148` pattern) — a manual-sync hazard on every variant addition.

Of these, **1, 2, 3, 4, 5 and 8 are fixed by configuration and refactoring inside SQLx.** Only 6, 7 and 9
are things a query builder or ORM would structurally improve — and see §9 for what they would cost.

---

## 9. SQLx vs SeaORM vs Diesel — recommendation

### Should Bittery keep SQLx? **Yes.**

### Should Bittery adopt SeaORM? **No.**

### Would a hybrid make sense? **No.**

The comparison, against this codebase:

| Dimension | SQLx (today) | SQLx + macros | SeaORM | Diesel / diesel-async |
|---|---|---|---|---|
| Compile-time query checking | none | **full, against live schema** | none for `find_by_sql`; entity-level typing only | full, schema-derived |
| Row mapping boilerplate | already zero (87 `FromRow`) | zero | zero (entities) | zero |
| Window-function CTEs (`items.rs:53-84`) | native | native | raw-SQL escape hatch | raw-SQL escape hatch |
| `pg_advisory_xact_lock` quota checks (×3) | native | native | raw SQL | raw SQL |
| `::text` enum casts + dual decode (`closed_enum!`) | works today | needs `as "role!: VaultRole"` overrides | must re-model 14 enums as SeaORM `ActiveEnum` | must re-model |
| Partial update ergonomics | 15 hand-written `COALESCE` | same | **better** (`ActiveModel` `Set`/`NotSet`) | good |
| Keyset pagination predicate | hand-copied ×10 | hand-copied ×10 | **composable** | **composable** |
| async support | native | native | native | via `diesel-async`, less mature |
| Migration workflow | 19 raw `.sql`, CI-guarded | unchanged | Rust DSL migrations — would replace a working system | raw SQL, similar |
| Build time | fastest | +DB dependency at build, `.sqlx` cache offline | slowest of the three | heavy proc macros |
| Migration cost from today | — | ~0 for existing code | **~254 query sites, ~5k LOC service rewrite** | comparable, plus async risk |

**Why an ORM does not pay here, concretely:**

**→ The boilerplate an ORM removes is already absent.** ORMs earn their keep by killing manual row
mapping and hand-written CRUD. This codebase has zero manual row mapping and its CRUD is already terse.
The measured duplication (§5.3) is *copy-pasted helper functions*, which an ORM does not fix — you can
copy-paste a SeaORM query as easily as a SQL string.

**→ The hardest queries are exactly the ones an ORM cannot express.** `vault/items.rs:53-84` is a CTE with
`ROW_NUMBER()` plus a running `SUM() OVER (ORDER BY position)` used to fit a page inside a serialized-byte
budget. The quota checks take `pg_advisory_xact_lock(hashtext($1))` before counting. `array_position()`
preserves ID order across a second query. All three would go through SeaORM's raw-SQL escape hatch,
meaning the two paradigms would coexist permanently in the *same* module — the worst outcome, and the
reason the hybrid option is also a no.

**→ Zero-knowledge design removes the ORM's main advantage.** Relation loading and eager/lazy graph
hydration are what SeaORM is genuinely good at. Bittery's payloads are opaque ciphertext with shallow
relations — item→attachments, vault→members — already handled by an intentional two-query batch. There is
no N+1 problem to solve.

**→ It would fight two settled ADRs.** ADR 0002 deleted `repo/auth.rs`, `repo/team.rs`, `repo/vault.rs`
and states that reintroducing a repository tier "would be a re-litigation of this decision, not a fix."
SeaORM entities plus `ActiveModel` are a repository tier with extra steps. ADR 0012 requires one generated
definition per cross-language type; SeaORM's entity generation would add a third generator alongside
utoipa and `openapi-typescript`.

**→ Migration cost is not recoverable.** 254 query sites, 14 enums to re-model, 19 migrations to either
keep (dual system) or port, and a rewrite of the 3,624-LOC vault service package — to fix three problems
(6, 7, 9 in §8) worth maybe 200 LOC.

**Diesel** is rejected on the same grounds plus a worse async story: `diesel-async` is less mature than
SQLx's native async, and the crate is fully `tokio`-based with SSE streaming and a background job runner.

### What to do instead

**→ Enable compile-time checking, incrementally.** Add `macros` to the sqlx features, commit a `.sqlx`
offline cache, and add `cargo sqlx prepare --check` to CI next to the existing `write-openapi --check`.
Then convert queries to `query_as!` **only as they are touched**, plus all of `vault_key_rotation.rs`
first (it has both the tuple-index hazard and the highest contention).

One honest caveat: the `closed_enum!` types decode from both a native PG enum and a `::text` cast, and the
macros need `as "role!: VaultRole"` type overrides to agree. That should work — `closed_enum!` does
implement `Type<Postgres>` — but it has not been proven here. **Spike this on three queries before
committing to it**, and if the overrides turn out to be noisier than the safety is worth, stop; nothing
else in this plan depends on it.

**→ Standardize the executor.** Adopt `impl sqlx::Executor<'e, Database = Postgres>` — the pattern
`repo/common.rs` already proves works — for every shared read helper. This is what makes one
`load_vault_access` serve all three call sites.

**→ Make one `db_error` mandatory.** Delete the five local shims; route everything through
`transaction::database_error`. Fixes §5.2 as a side effect.

**→ Share the keyset predicate as a `const &str` fragment** interpolated the same way
`BOOTSTRAP_ITEM_COLUMNS` already is, rather than retyping it in ten queries.

**→ Generate the enum variant strings once.** Extend `closed_enum!` to emit the serde renames rather than
requiring both lists (`db/enums.rs:131-148`).

---

## 10. Recommended DB architecture

Keep the shape ADR 0002 chose. Adjust three things.

```
services/<domain>/            owns its SQL — unchanged, ADR 0002
  ├─ service fns              authorization + business rules + transactions
  └─ shared query helpers     generic over `impl Executor`, one copy per query

db/
  ├─ mod.rs                   pool, migrations
  ├─ enums.rs                 closed_enum! (extended to emit serde renames)
  ├─ models/                  row structs used by 2+ modules
  └─ sql.rs        [new]      shared SQL fragments: keyset predicate, column lists

repo/                         [rename to db/queries/ or fold into domains]
  common.rs                   generate_resource_id, hash_token, insert_audit_event,
                              insert_sync_event — the genuine cross-domain kernel
```

Three changes:

**1.** `repo/` should stop existing under that name. It covers 18% of queries and its contents are not a
repository — they are cross-domain shared queries (`audit`, `access`, `billing`, `sync`, `share`,
`travel_mode`) plus a real kernel (`common.rs`). Under a `domains/` tree (§20) most of it moves into the
domain that owns it; `common.rs` becomes `db/events.rs` or `shared/`.

**2.** Every shared read helper becomes executor-generic.

**3.** No repository traits. Not for mocking — tests already run against real Postgres per test, which is
strictly better fidelity than a mock. ADR 0002 pre-rejected this and the test infrastructure vindicates it.

---

## 11. DTO / model assessment

Three representations exist per entity: `Db…Row` → service struct → wire DTO. Whether that is earned
varies by module, and the split is sharp.

**Earned, and well implemented — vault, item, share, sync, most of team and billing.** These use the
`shapes/` macro DSL: one field list generates the service struct, the wire struct with its utoipa bounds,
and the `From`. The separation does real work: `image_key` (a private storage key) becomes `image_url` via
`object_storage.public_url()` at `vault/catalog.rs:158-171`; counts become `DecimalString` for JS-safe
integers; `share_link.token_hash` never reaches any response struct.

**Not earned — `auth.rs` and half of `team.rs`.** `auth.rs` uses neither `shapes!` nor
`response_dto!(X from Y)`. It hand-writes ~9 `From` impls (`auth.rs:296, 813, 902, 923, 958, 978, 996`)
copying every field verbatim. `MeResponse`, `SessionResponse` and `RefreshSessionResponse` are
field-for-field identical to `session.rs:110-129`, with no field hidden, renamed or retyped. Same for
`TeamMemberResponse` and friends via `response_dto!` with identical lists (`http/api/team.rs:81-133`).

Totals: 42 `shape_from!` + 52 `request_dto!`/`response_dto!` + **40 hand-written `impl From<>`**, ~82
explicit conversions. `auth.rs` alone accounts for roughly a third of the fully manual mapping.

**Leaks: none.** No `Db*Row` reaches HTTP (`grep "body = Db\|Json<Db"` → nothing). No `http::api` import
in `services/`, `db/`, `repo/`, `jobs/` or `integrations/` outside three test files that legitimately
build `axum::Request`s.

**Recommendation:** migrate `auth.rs`'s and `team.rs`'s identical pairs onto the existing `shapes!` DSL.
Roughly **−250 LOC** and one fewer place for field drift. Do **not** collapse the three layers where they
differ — the `image_key`/`image_url` and `token_hash` cases are exactly the security-motivated separation
ADR 0011 mandates.

---

## 12. Error architecture assessment

**Shape.** Three layers, correctly chosen, not an over-deep chain:

- `AppError { code: AppErrorCode, message: String }` (`error.rs:29`) — `AppErrorCode` has 13 variants.
- `ApiError { StatusCode, Box<ProblemDetails>, Option<RetryAfter> }` (`http/api/error.rs:33`).
- `ErrorCode` — 34 stable wire codes (`error_code.rs:18-94`), published in `openapi.v1.json`, consumed by
  `packages/api-contract/src/errors.drift-guard.ts`, and pinned by `ErrorCode::ALL`.

One conversion, `From<AppError> for ApiError` (`error.rs:192-298`). No `SqlxError → RepositoryError →
ServiceError → ApplicationError → ApiError` chain. **This part is right and should not be restructured.**

**Problems:**

**→ `AppError` carries no source.** Only a `String`. Once `sqlx::Error` is converted, SQLSTATE, constraint
name and error variant are gone. Neither `thiserror` nor `anyhow` is in `Cargo.toml`.

**→ Double logging.** Every internal error logs at the failure site with full context, then again at
`http/api/error.rs:196` with strictly less. 375 `tracing::error!` sites crate-wide, 1 `warn!`, **0
`info!`**.

**→ Callers match on `AppErrorCode` because there is no richer type.** `http/api/vault.rs:526` checks
`error.code == Conflict` to produce a version conflict; `vault/catalog.rs:866` remaps `Forbidden` to
`NotFound` for info-hiding; `public.rs:71-78` matches three variants and falls back to 500 with its own
`{"error": …}` body. Only one real domain error enum exists — `FinalizeError`
(`vault_key_rotation.rs:82-88`) — and its two consumers each maintain a duplicate `finalize_error` match
(`member_departure.rs:355`, `vault_membership.rs:203`).

**→ `public.rs` is outside the contract.** 13 call sites emit `{"error": message}` with hand-picked status
codes — no `code`, no `problem+json`, no request ID.

**Verdict: too flat in one specific place, otherwise correct.** Recommended, in order:

1. Route every DB error through `transaction::database_error` (fixes §5.2, removes hundreds of retyped
   closures).
2. Drop the second log in `From<AppError> for ApiError`, or reduce it to `debug!`.
3. Add a `source: Option<Box<dyn Error + Send + Sync>>` to `AppError`, or adopt `thiserror`, so SQLSTATE
   survives to the log line.
4. Move `public.rs` onto `ProblemDetails`. This is a wire change for `/waitlist`, `/cdn/*`, `/favicon/*` —
   route it through `docs/openapi-breaking-changes.md` even though those paths are not in the spec.

Do **not** add per-domain error enums broadly. Only two places need callers to branch, and both already
have what they need.

---

## 13. AppState assessment

10 fields (`lib.rs:52-63`). Field-by-field:

| Field | Uses | Second impl? |
|---|---|---|
| `db_pool: PgPool` | 104 | concrete, correct |
| `redis: Option<RedisPool>` | 8 | `Option` is the seam |
| `sessions: SessionService` | 6 | concrete; internal Memory/Postgres enum |
| `connection_registry` | 6 | `ConnectionRegistry::none()` for tests |
| `sync_pubsub` | 5 | in-process default |
| `instance_id: String` | 1 | multi-node SSE identity — legitimate |
| `rate_limiter: Arc<dyn RateLimiter>` | 16 | **4 impls**: Postgres, Redis, Noop, Panicking(test) |
| `object_storage: Arc<dyn ObjectStorage>` | 26 | **3 impls**: S3Compatible, Unavailable, Recording |
| `remote_documents: Arc<dyn RemoteDocumentFetcher>` | 3 | **2 impls**: Reqwest, Stub |
| `billing_gateway: Option<Arc<dyn BillingGateway>>` | 9 | **2 impls**: Stripe, Test |

**Verdict: leave it alone.** Every `Arc<dyn Trait>` has a real second implementation actually compiled and
used — no speculative generality. The concrete fields have nothing to swap. `FromRef`/substate is unused
and would add ceremony for no benefit at 10 cheaply-cloneable fields. Tests build a minimal state in one
line (`AppState::database_free_test()`, `lib.rs:119`).

Composition root is `runtime.rs:24-65`, correctly ordered and order-sensitive: `with_redis` must run
before `connection_registry.load_scripts()` because the former seeds the latter (`lib.rs:86-92`). Worth a
comment; it is currently implicit.

One gap: `_job_runner` is retained only to keep the task alive, with no graceful-shutdown signal
(`runtime.rs:72-78` aborts only the Redis dispatch task on `Drop`).

**Do not introduce a DI container.** Nothing here asks for one.

---

## 14. Authentication / authorization assessment

**Flow.** `request_context_middleware` (`request_context.rs:20-58`) runs as a `route_layer` on all
`/api/v1` routes, parses the bearer token once, calls `sessions.verify_token`, and inserts
`RequestMetadata` + `VerifiedSession` into extensions. The `AuthenticatedRequest` extractor
(`extract.rs:168-224`) reads them and 401s if absent; `PublicRequest` (`:182`) is the infallible variant.
Auth verification happens exactly once per request, not per handler. **This design is correct.**

A second, non-runtime gate: `security.rs`'s `OPERATION_SECURITY` table (`:18-138`) classifies every
operationId Public/Bearer, and `mod.rs:366-428` asserts the counts (17 public, 87 bearer). It enforces
nothing at runtime but fails the build if a new operation is left unclassified.

**IP trust is handled correctly.** `X-Forwarded-For` / `CF-Connecting-IP` are honoured only under an
explicit `TrustProxyMode` (`request_context.rs:85-108`), so a caller cannot spoof an IP to evade per-IP
rate limiting.

**Authorization is fail-closed but duplicated.** Every check either joins the auth table so unauthorized
rows are invisible (`vault/catalog.rs:149`, `auth/login.rs:287`, `repo/access.rs:52`) or uses
`fetch_optional().ok_or_else(forbidden)`. No `fetch_one` gate, no `LEFT JOIN` gate. The privacy rule "a
member's personal vaults are invisible to admins" exists **only** as a SQL `WHERE` clause
(`repo/access.rs:51-77`) — correct today, but that means the rule cannot be unit-tested apart from the
query.

`team_admin::authorize_team_admin` (`team_admin.rs:24-57`) is the model to copy: one named gate,
documented as "the single place that decides who may look", reused by `access.rs:83` and `audit.rs:147`.

**Risks, in order:**

1. **The vault member role matrix exists twice** — `vault_membership.rs:30-44` vs inline
   `vault/catalog.rs:875-880` (§5.4).
2. **No type-level proof of authorization.** Service functions take `user_id: &str`. Discipline holds
   today — every call site in `http/api/vault.rs` passes `auth.session.user_id` — but a future handler
   threading a body field named `user_id` would compile and run. A newtype (`AuthenticatedUserId`) that
   only the extractor can construct would close this at near-zero cost.
3. **`vault_membership.rs` two-step authorization.** `roles()` (`:119`) then `authorize_managed_vault()`
   (`:121`) must both be called, in order, with nothing enforcing it.
4. **Authenticated high-blast-radius operations have no rate limit.** `change_password`,
   `regenerate_secret_key`, `update_email`, `delete_account` (`auth/credentials.rs`) and device management
   (`auth/devices.rs`) call the rate limiter zero times — verified by grep. All of the first three revoke
   every other session on success (`credentials.rs:55, 97, 142`). Pre-auth endpoints are comprehensively
   limited (11 distinct scopes); post-auth destructive ones are not. That is a product decision to
   confirm, not necessarily a defect.
5. **Naming trap.** `vault_membership.rs` does *not* own vault membership — it owns member *removal* via
   key rotation. Add/list/role-change live in `vault/catalog.rs:856-1040`. A reader looking for "where is
   vault membership authorized" opens the wrong file first.

**Layering:** clean, with one inversion — `request_context.rs` is an axum middleware living under
`services/auth/`, making it the only non-test service file importing `axum` besides `sync.rs:1`.

---

## 15. Middleware assessment

Effective order (outer → inner), from `app.rs:9-35`:

```
http_trace_layer  →  edge_http_middleware  →  catch_panic_layer  →  [route]
   →  request_context_middleware  →  api_response_headers  →  DefaultBodyLimit  →  handler
```

**Ordering is correct and deliberate**, with the rationale in a comment (`middleware.rs:27-29`) and an
assertion (`app.rs:238`): panic-catch sits inside the edge layer so a panic 500 still receives CORS and
security headers, and the trace layer records the finished response.

**Inventory:**

| Concern | Status |
|---|---|
| Request ID | present, generated lazily in `api::response_headers` (`mod.rs:123`) |
| Tracing | `TraceLayer` + strict W3C traceparent validation (`middleware.rs:125-204`) |
| CORS | hand-rolled exact-origin allowlist, no wildcard, OPTIONS → 204 (`middleware.rs:249`) |
| Security headers | full set + `no-store` on sensitive paths; `/cdn/*` deliberately excluded |
| Panic isolation | present, guards a real `rand` 0.10 reseed panic |
| Auth | `route_layer` on `/api/v1` only |
| Body limits | per route group — **but missing on `vault_key_rotation.rs`'s router** |
| Rate limiting | service layer, not middleware — deliberate and consistent |
| **Timeout** | **absent** |
| **Compression** | **absent** |

**Recommendations, in priority order:**

1. **Add `tower_http::timeout::TimeoutLayer`.** This is the one genuine gap. With
   `DATABASE_MAX_CONNECTIONS` defaulting to 5 (`db/mod.rs:12`), a few stuck requests exhaust the pool.
   Place it inside the panic layer so a timeout still gets edge headers, and exempt the SSE route, which
   is long-lived by design.
2. **Add `DefaultBodyLimit::max(ORDINARY_API_BODY_LIMIT_BYTES)`** to the `vault_key_rotation` router —
   a one-line consistency fix.
3. **Compression** — optional. Worth it for large paginated list responses; measure first.

Do not add anything else. Rate limiting as a service concern rather than middleware is a defensible,
consistently applied choice.

---

## 16. OpenAPI assessment

**Generation is real, not manual.** `openapi_router()` (`http/api/mod.rs:87-105`) merges 9
`utoipa_axum::OpenApiRouter`s, each built with `routes!(handler)` so a route and its operation are
registered in one call. Forgetting a single route is structurally impossible; forgetting to `.merge()` a
whole module is caught by the count assertions. Output: `packages/api-contract/openapi.v1.json`, 478 KB,
90 paths, 104 operations, 182 schemas.

**Four CI gates** (§4). The `assert_eq!` counts are a deliberate tripwire for utoipa's short-name schema
collision, documented in ADR 0012 as an accepted checkpoint. **Keep them.**

**operationId inconsistency — real, and worth fixing now.** Every module except `auth.rs` sets explicit
camelCase. `auth.rs` sets it on **2 of 22** endpoints (`getRegistrationStatus:329`,
`listCurrentUserVaultKeys:486`); the other **20 fall back to the Rust fn name in snake_case** — `me`,
`start_login`, `finish_login`, `check_email`, `delete_account`, `change_password`, `reset_password`,
`revoke_session`, `refresh_session`, and 11 more.

These are not internal. They are baked into `openapi.v1.json`, the generated TypeScript, the
`OPERATION_SECURITY` table (`security.rs:48-118`) and test assertions (`mod.rs:401-426`). The published
contract therefore exposes `me` and `start_login` next to `getCurrentTeam` and `createVault`.

**Recommendation: fix it, in one PR, now.** Renaming an operationId changes generated client method names
— a breaking change for consumers, though not for the wire protocol. But ADR 0011 states there are "no
users or deployed compatibility obligations", the migration timeline runs through 2026-08-12 with
destructive migrations still landing, and the project has a working mechanism for exactly this:
`docs/openapi-breaking-changes.md`, already carrying 12 approved entries consumed by
`oasdiff --err-ignore`. **This is the cheapest it will ever be.** After launch it becomes permanent.

Concretely: add explicit camelCase `operation_id` to all 20, regenerate both artifacts, update
`security.rs` and the two assertions in `mod.rs`, and add one ledger entry. Also worth normalizing
`vault_key_rotation.rs`'s `operation_id="…"` spacing while there.

**Schema duplication** — see §11: the `auth.rs`/`team.rs` hand-written mapping, not the OpenAPI layer.

---

## 17. DB test isolation analysis

**The premise that this is unresolved is wrong. It is solved, and it is the strongest part of the crate.**

**Mechanism.** `TestDatabase::create(test_name)` (`test_support.rs:859-881`) connects to the admin
`postgres` database (path-rewritten from `DATABASE_URL`, `:903-907`) and issues
`CREATE DATABASE bittery_test_<sanitized_name>_<epoch_millis_hex>_<atomic_seq_hex>` (`:928-948`, truncated
to Postgres's 63-char limit). `with_api_test_app_state` (`:811-851`) connects to it and runs **all 19
migrations fresh** (`:825`). On completion — including panic, via `AssertUnwindSafe(...).catch_unwind()`
(`:837-843`) — `cleanup()` reconnects on the admin URL, `pg_terminate_backend`s stragglers, and
`DROP DATABASE IF EXISTS` (`:883-900`). Proven by `with_api_test_app_drops_database_after_panic`
(`:1014-1029`).

**Answers to the specific questions:**

- Shared database? **No.** One per test, ~145 call sites.
- Parallel? **Yes**, default cargo threads — no `--test-threads=1` anywhere, confirmed in
  `ci.yml:664-671`.
- Migrations? **Per test, fresh.**
- Cleanup? **`DROP DATABASE`.** No `TRUNCATE`/`DELETE` needed anywhere.
- Unique IDs hiding shared state? **No.** Tests reuse literal IDs (`"vault_test"`, `"user_test"`) freely
  precisely because isolation is real. Where UUIDs *are* used it is for genuinely shared resources —
  `rate_limit_tests.rs:130` explicitly notes "unique keys per run so shared Redis instances do not
  collide" (that test is skipped in CI).
- Rate-limit state? Isolated — `PostgresRateLimiter` writes to each test's own `rate_limit_state` table.

**Three real interference vectors remain, all outside the database:**

**1. `emailed_code_capture` — a process-global `HashMap`.** `auth_email.rs:172-214` is a
`static OnceLock<Mutex<HashMap<String, String>>>` keyed only by `purpose|email[|token]` — not by test,
database or thread. It is how ~38 tests in `auth_tests.rs` and several in `share_tests.rs` retrieve
verification codes. Two concurrent tests using the same literal email collide, last writer wins, and the
loser gets the wrong code or panics on `.expect(...)`. Safety today rests entirely on the convention of
distinct literal emails per scenario. **This is the one place the otherwise-excellent isolation design
does not reach.**

**2. Env vars are process-global; the lock is opt-in on writers only.** Production code reads
`env::var` at call time (`config.rs:6-18` on nearly every request path, `auth/mod.rs:494` for
`JWT_SECRET`, and ~33 others — §5.9). Tests that mutate them correctly take `acquire_env_lock_async` and
restore on drop, holding the guard across the whole future. But that only serializes them against *other
lock-taking tests*. A concurrent test that never touches `BITTERY_MODE` yet hits a route calling
`is_self_hosted_mode()` can observe the mutated value. Not yet observed as flaky, because CI sets these
once and only a handful of tests mutate them.

**3. A 10 ms `sleep` as a synchronization primitive.** `sync_tests.rs:158-176` sleeps 10 ms and then
`try_recv()`s. Under CI load this is a classic flake.

---

## 18. Recommended testing architecture

**Keep per-test databases. Do not adopt Testcontainers, per-test transactions or per-test schemas.** The
existing mechanism already gives full isolation with real migrations, and CI's `postgres:17-alpine`
service container is simpler than Testcontainers. Per-test-transaction rollback would actively *lose*
fidelity — it cannot test the crate's own `pool.begin()`/`commit()` boundaries, which is exactly what the
vault and rotation paths need verified.

Five targeted changes:

**→ Scope `emailed_code_capture` per test.** Cheapest correct fix: make the capture key include the test's
database name, which `ApiTestApp` already knows. Alternative: move the capture behind the existing
`AppState` seam so it becomes per-state rather than per-process. Either removes the last shared-state
coupling in the suite.

**→ Add integration coverage for `POST /webhooks/stripe`.** The highest-value missing test in the crate.
Today only HMAC math is tested (`billing/webhook.rs:510-548`); `process_stripe_webhook_event`,
`apply_checkout_session_completed:141`, `apply_subscription_update:181`, `apply_invoice_status:269` and
`find_team_for_event:302` have **zero** integration tests — grep across all `*_tests.rs` returns nothing.
Every billing state transition driven by Stripe is unverified. `TestBillingGateway`
(`integrations/stripe.rs:721`) and the router harness both already exist; this is signing a fixture
payload and asserting DB state.

**→ Add coverage for `jobs/`.** `jobs/runner.rs` and `jobs/sql.rs` have **zero** `#[cfg(test)]` and no
external callers. Seven scheduled cleanup jobs — expired sessions, sync-event pruning, tombstone cleanup,
rate-limit pruning, rotation-plan cleanup — delete production data on a schedule and are entirely
unverified. Test the SQL functions directly against a per-test DB; the cron expressions can be asserted
as pure parses.

**→ Replace the 10 ms sleep** with a bounded `tokio::time::timeout` on a receiver await.

**→ Introduce a startup-time config struct** (§19) so tests stop needing a global env lock at all. That
removes interference vector 2 at the root rather than mitigating it.

**Critical flows already covered end-to-end** (router → middleware → handler → service → Postgres, via
`tower::oneshot`, with every response validated against the OpenAPI doc): login/signup/logout
(`auth_tests.rs:78`), self-hosted bootstrap (`:439`), invited signup (`:531`), rate limiting
(`:2159-2397`), vault lifecycle (`vault_tests.rs:2368`), item CRUD + idempotency (`:1152-2272`), share
links including public access and email verification (`share_tests.rs:412-899`), key rotation
(`team_tests.rs:482`, `vault_tests.rs:652`, `vault_key_rotation.rs:568-705`), sync bootstrap/cursor/SSE
(`sync_tests.rs:551-1423`). **This is a strong suite.** Only billing webhooks and jobs are missing.

**Testability obstacles worth fixing:** env reads at call time (root cause of the env lock);
98 direct `now()` call sites with no `Clock` seam — tests work around it by seeding computed timestamps,
which is acceptable; the raw `static reqwest::Client` in `public.rs:40-42` for the CDN path, where
`favicon.rs` already demonstrates the `RemoteDocumentFetcher` trait pattern.

---

## 19. Complexity / LOC reduction opportunities

| # | Location | Responsibility | LOC | Why it's hard | Change | LOC impact | Risk |
|---|---|---|---|---|---|---|---|
| 1 | `vault/{catalog,items,attachments}.rs` | vault access, item row load, sync event insert | ~60 ×3 copies | 3 byte-identical copies; `&PgPool` vs `&mut Transaction` blocks sharing | one executor-generic `vault/access.rs` | **−120** | very low |
| 2 | `team.rs:227,297,417,504,857,988,1117` | "load actor, check team membership" | ~25 ×7 | better helper already exists at `:1402`, unused by these | route all 7 through `load_team_membership_actor` | **−150** | very low |
| 3 | `team.rs`, `vault/*`, `share.rs`, `auth/*` | per-query error mapping | ~3 × several hundred | shared helper used by 3 of ~30 modules | mandate `transaction::database_error`; delete 4 local shims | **−300** | low — *also fixes §5.2* |
| 4 | `session.rs:1392-1618` | User-Agent parsing | 226 | pure string logic inside a session store | move to `user_agent.rs` | 0 net, −226 from session.rs | very low |
| 5 | `http/api/auth.rs:958-996` + `team.rs:81-133` | identical service↔wire mapping | ~250 | neither module adopted `shapes!` | migrate onto `shapes!` | **−250** | low |
| 6 | `auth/registration.rs:581-963` vs `team.rs:1249-1352` | invitation + pending-vault-key logic | ~180 ×2 | same SQL and rules written twice | one owner, other calls it | **−150** | medium — touches signup |
| 7 | `vault/catalog.rs:303,517` + `share.rs:204` | advisory-lock quota check | ~27 ×3 | same shape, three copies | one `quota_check` helper | **−55** | low |
| 8 | `auth/registration.rs:184-524` | `signup` / `signup_with_invitation` | 340 | ~80% shared body | extract common path | **−120** | medium — auth |
| 9 | `db/enums.rs:131-…` | 14 enums, variant strings twice | ~375 | serde renames + `closed_enum!` list must agree | emit renames from the macro | **−120** | low |
| 10 | `http/api/vault.rs:830-907` | `list_all_items` | 78 | two near-duplicate branches on a state param | collapse to one path | **−35** | low |
| 11 | `integrations/storage.rs:137-194, 622-637` | attachment upload capability token | ~90 | authorization logic in an adapter | move to `services/vault/attachments.rs` | 0 net | **medium — security code, move only, no logic change** |
| 12 | `session.rs:925-1230` | in-memory dev backend | 305 | dev tooling in the production module | optional `session_memory.rs` | 0 net | low |

**Net for items 1-3, 5, 7, 9, 10 (the low-risk set): roughly −1,030 production LOC** with no behaviour
change, plus one live defect fixed. Items 6, 8 and 11 are worth doing but need more care.

**Do not size-optimize:** `vault_key_rotation.rs`, `member_departure.rs`, `vault_membership.rs`,
`billing/webhook.rs`, `verification_code.rs`, `rate_limit.rs`, or anything in `packages/crypto`. Their
length is inherent to fail-closed multi-step security logic.

---

## 20. Target backend structure

**First, the honest framing.** The proposed `domains/` tree is a **worthwhile but optional phase 5**. The
crate is already domain-organized inside each layer; the gain is navigation (one folder per capability
instead of four directories), not correctness. Phases 1-4 deliver most of the value and are independent
of it. If the move is made, it should be a mechanical `git mv` + `mod` rewiring in one PR with zero logic
changes, so it stays reviewable.

Some things in the reference tree should **not** be built here:

- **No `queries.rs` per domain.** ADR 0002 settled that services own their SQL. Splitting SQL back out per
  domain is the repository tier under a new name.
- **No `error.rs` per domain.** Only two places need callers to branch (§12).
- **No `dto.rs` + `models.rs` + `service.rs` skeleton for small domains.** `travel_mode`, `waitlist`,
  `audit` need one file each.
- **`db/migrations/`** — leave migrations at `apps/server/migrations/`. `scripts/check-migrations.mjs` and
  `MIGRATIONS_FOLDER` resolution (`db/mod.rs:60`) depend on the current path.

### Proposed tree

```
apps/server/src/
├── main.rs
├── lib.rs                      re-exports only
│
├── app/
│   ├── mod.rs
│   ├── router.rs               ← from app.rs
│   ├── state.rs                ← AppState from lib.rs
│   └── startup.rs              ← from runtime.rs
│
├── config/
│   └── mod.rs                  existing config.rs + a startup-parsed Config struct (§5.9)
│
├── db/
│   ├── mod.rs                  pool, run_migrations
│   ├── enums.rs                closed_enum!
│   ├── events.rs               ← repo/common.rs (insert_sync_event / insert_audit_event / ids)
│   ├── sql.rs          [new]   shared fragments: keyset predicate, column lists
│   └── models/                 only rows used by 2+ domains
│
├── http/
│   ├── mod.rs
│   ├── error.rs                ← http/api/error.rs + error_code.rs
│   ├── extractors.rs           ← http/api/extract.rs
│   ├── middleware.rs
│   ├── pagination.rs
│   ├── public.rs
│   └── openapi.rs              ← ApiDoc, openapi_router(), security.rs, contract tests
│
├── domains/
│   ├── auth/                   routes.rs handlers.rs shape.rs
│   │   ├── login.rs  registration.rs  credentials.rs  recovery.rs
│   │   ├── verification_code.rs        ← services/verification_code.rs
│   │   ├── email.rs                    ← services/auth_email.rs
│   │   └── request_context.rs
│   │
│   ├── sessions/               routes are served by auth's HTTP file — see note below
│   │   ├── service.rs                  ← services/session.rs (Postgres store)
│   │   ├── user_agent.rs               ← session.rs:1392-1618
│   │   ├── memory.rs                   ← session.rs:925-1230 (dev/test backend)
│   │   └── control.rs                  ← services/session_control.rs
│   │
│   ├── vaults/
│   │   ├── routes.rs handlers.rs shape.rs      ← http/api/vault.rs, split 4 ways
│   │   ├── catalog.rs                          vault CRUD, stats, type conversion
│   │   ├── members.rs                          ← catalog.rs:749-1174 (mod member_handlers)
│   │   ├── access.rs                   [new]   the one load_vault_access + write assert
│   │   ├── items.rs  attachments.rs  pagination.rs
│   │   ├── travel_mode.rs                      ← services/ + repo/travel_mode.rs
│   │   └── rotation/
│   │       ├── plans.rs                        ← services/vault_key_rotation.rs
│   │       ├── membership.rs                   ← services/vault_membership.rs (member removal)
│   │       └── departure.rs                    ← services/member_departure.rs
│   │
│   ├── teams/
│   │   ├── routes.rs handlers.rs shape.rs
│   │   ├── service.rs                          team CRUD
│   │   ├── invitations.rs                      ← team.rs:652-1212
│   │   ├── admin.rs                            ← team_admin.rs + access.rs + repo/access.rs
│   │   └── audit.rs                            ← services/audit.rs + repo/audit.rs
│   │
│   ├── shares/                 routes.rs handlers.rs service.rs  ← + repo/share.rs
│   ├── billing/                routes.rs handlers.rs service.rs webhook.rs entitlements.rs
│   │                                           ← + team_billing.rs + repo/billing.rs
│   ├── sync/                   routes.rs handlers.rs sse.rs service.rs pubsub.rs
│   │                                           ← + repo/sync.rs + http/sync_sse.rs
│   └── waitlist.rs             one file
│
├── integrations/
│   ├── storage.rs              S3 + SigV4 only; capability token moves to vaults/attachments.rs
│   ├── stripe.rs
│   └── favicon.rs              SQL moves out (ADR 0002)
│
├── jobs/                       runner.rs + sql.rs  (+ tests)
│
└── shared/
    ├── idempotency.rs          ← services/idempotency.rs
    ├── rate_limit.rs           ← services/rate_limit.rs
    ├── transaction.rs          ← the one db_error helper
    ├── redis.rs  connection_registry.rs
```

**Note on sessions:** session HTTP routes are currently served from `http/api/auth.rs` (`list_sessions`,
`revoke_session`, `rename_session`, `refresh_session`, `auth.rs:609-811`). Keep them there — they are part
of the auth surface from a client's perspective — and let `domains/sessions/` be a service-only domain.
Forcing a `routes.rs` on it would be layering for its own sake.

### Per-domain records

```
Domain:        vaults
Current files: http/api/vault.rs (1936), services/vault/{mod,catalog,items,attachments,pagination}.rs
               (3624), services/{vault_key,vault_key_rotation,vault_membership,member_departure,
               travel_mode}.rs (2253), db/models/vault.rs, shapes/{vault,item}.rs, repo/travel_mode.rs
Target:        domains/vaults/
Responsibility: vault lifecycle, membership, items, attachments, key rotation, travel mode
Public API:    routes(), and for cross-domain callers: load_vault_access, resolve_vault_sharing_entitlement
Internal:      catalog, items, attachments, access, pagination, rotation/*  — all private
Depends on:    billing (entitlements), teams (team membership), db, integrations::storage
Reason:        largest domain by far (~7.8k LOC); currently spread over 12 files in 5 directories.
               Sub-modules earn their place — items/attachments/rotation have genuinely different
               lifecycles. Rotation is nested because ADR 0013 makes plans a vault mechanism with
               team-level policy callers.
```

```
Domain:        auth
Current files: http/api/auth.rs (1118), services/auth/** (3293), services/{verification_code,
               auth_email}.rs (918), shapes — none (hand-mapped)
Target:        domains/auth/
Responsibility: signup, login, recovery, credential change, account deletion, verification codes
Public API:    routes(), request_context_middleware, is_dev_auth_stub_enabled
Internal:      login, registration, credentials, recovery, verification_code, email
Depends on:    sessions, billing (signup plan), teams (invited signup), shared::rate_limit
Reason:        one ceremony family with a single security model. It is large because the flows are
               genuinely many, not because concerns are mixed. Fix the duplication (§5.3), not the shape.
```

```
Domain:        sessions
Current files: services/session.rs (1619), services/session_control.rs (102)
Target:        domains/sessions/  — service-only, HTTP stays in auth
Responsibility: token issuance, verification, refresh, device grouping, revocation records
Public API:    SessionService
Internal:      service (Postgres), memory (dev/test), user_agent, control
Depends on:    db only
Reason:        the Postgres store is one cohesive 535-LOC subject and should stay whole. The split is
               specifically to lift out 226 LOC of UA parsing and 305 LOC of dev-only backend that are
               not session-persistence concerns.
```

```
Domain:        teams
Current files: http/api/team.rs (771), services/team.rs (1420), services/{team_admin,access,audit}.rs
               (744), repo/{access,audit}.rs (~500), db/models/team.rs, shapes/team.rs
Target:        domains/teams/
Responsibility: team CRUD, invitation lifecycle, admin console (member access + audit feed)
Public API:    routes(), authorize_team_admin, load_team_membership_actor, is_team_member
Internal:      service, invitations, admin, audit
Depends on:    billing (entitlements), vaults (pending vault keys on invite), sessions (device listing)
Reason:        invitations are a distinct state machine that already has an inline submodule seam. The
               admin console (access + audit) belongs here because authorize_team_admin is its only gate.
```

```
Domain:        billing
Current files: http/api/billing.rs (313), services/billing/{mod,webhook}.rs (1271),
               services/team_billing.rs (264), repo/billing.rs, shapes/billing.rs
Target:        domains/billing/
Responsibility: subscription status, checkout/portal, Stripe webhooks, entitlement resolution
Public API:    entitlements::{team_management_enabled, resolve_share_links_policy,
               resolve_vault_sharing_entitlement, resolve_attachment_entitlement}, sync_team_seats_best_effort
Internal:      service, webhook
Depends on:    integrations::stripe, teams (team lookup)
Reason:        entitlements are consumed by five other domains (vaults, teams, shares, sync,
               connection_registry) and must be one narrow, obvious public API rather than something
               each caller re-derives — which is exactly what auth/registration.rs:976 does today.
```

```
Domain:        sync
Current files: http/api/sync.rs (587), http/sync_sse.rs (294), services/{sync,sync_pubsub}.rs (645),
               repo/sync.rs (290), shapes/sync.rs
Target:        domains/sync/
Responsibility: cursor-paginated bootstrap and change feed, SSE notification transport
Public API:    routes(), SyncPubSub, notify_sync
Internal:      service, sse, pubsub
Depends on:    vaults (item shapes), sessions (revocation events), billing (attachment entitlement)
Reason:        bootstrap paging and SSE fan-out are one subject split across four directories today.
               Co-locating also makes it obvious that sse.rs is the file needing the AppState cleanup.
```

```
Domain:        shares
Current files: http/api/share.rs (473), services/share.rs (1090), repo/share.rs, shapes/share.rs
Target:        domains/shares/
Responsibility: share-link lifecycle, anonymous public access, email-restricted verification
Public API:    routes()
Internal:      service — and consider splitting public access + email verification, which is 340 LOC
               with its own state machine
Depends on:    vaults (role check), billing (share-link policy), auth (verification codes)
Reason:        one cohesive capability that is already a single service; mostly a relocation.
```

**Answers to the eleven structural questions** (§20 references the evidence above):

1. **Actual domains:** auth, sessions, vaults (incl. items, attachments, rotation, travel mode), teams
   (incl. invitations, admin console, audit), shares, billing, sync, waitlist. Plus infrastructure: jobs,
   rate limiting, idempotency, integrations.
2. **Already clean:** `services/auth/`, `services/vault/`, `services/billing/`, and every `http/api/*.rs`.
   The service and HTTP module names already line up almost 1:1.
3. **Combine multiple domains:** `services/team.rs` (team + invitations), `services/vault/catalog.rs`
   (vault settings + membership), `services/session.rs` (sessions + UA parsing + dev backend),
   `integrations/storage.rs` (S3 + attachment authorization).
4. **Organized by technical layer rather than ownership:** `repo/` (7 domains), `db/models/` (6 domains),
   `shapes/` (6 domains). Each forces a cross-directory hop for a single-domain change.
5. **Should become domain folders:** `services/team.rs`, `services/vault/catalog.rs`,
   `http/api/vault.rs`, `services/session.rs`.
6. **Should stay large:** `services/vault/attachments.rs` (655, one subject),
   `services/vault/items.rs` (after dedup), `session.rs`'s Postgres store (535),
   `http/api/auth.rs` (1118, 24 thin handlers), `http/api/team.rs` (771),
   `services/vault_key_rotation.rs` (738, cohesive fail-closed state machine).
7. **Shared helpers that should move into a domain:** all of `repo/` except `common.rs`;
   `shapes/*` into their domains; `db/models/*` rows used by only one domain;
   `storage.rs`'s attachment capability token into `vaults/attachments.rs`.
8. **Pass-through services to delete:** `auth/devices.rs:53-61` (`list_devices`),
   `auth/devices.rs:163-168` (`do_refresh_session`), `billing/webhook.rs:62-64` (`is_self_hosted_mode`),
   `share.rs:863-865` (`has_share_links_entitlement`), `auth/registration.rs:976-984`
   (duplicate `team_management_enabled`). `SessionService`'s enum dispatchers are a deliberate Strategy
   pattern — **keep**.
9. **Query functions that should move closer to their domain:** `repo/access.rs` → teams/admin,
   `repo/audit.rs` → teams/audit, `repo/billing.rs` → billing, `repo/share.rs` → shares,
   `repo/sync.rs` → sync, `repo/travel_mode.rs` → vaults. `repo/common.rs` → `db/events.rs`.
10. **Public modules that can become private:** `repo/*` is `pub mod` throughout (`repo/mod.rs`) despite
    being crate-internal — all should be `pub(crate)` at most, then private to their domain.
    `db::models::*` re-exports everything with `pub use auth::*` glob (`db/models/mod.rs`); narrow it.
    `integrations::{favicon, storage}` are `pub mod`; only `stripe` is correctly `pub(crate)`.
11. **Final tree:** above.

---

## 21. Incremental refactoring plan

Each phase is independently shippable and independently valuable. Stop after any of them.

### Phase 1 — Deduplicate (1 PR per group, ~4 PRs)

- Create `services/vault/access.rs` with one executor-generic `load_vault_access`,
  `assert_item_write_access`, `load_item_row`, `insert_item_sync_event`. Delete 8 copies.
- Route `team.rs`'s 7 inlined actor queries through `load_team_membership_actor:1402`.
- Extract `attachments_enabled_for_user`, `generate_secure_token`, `validate_resource_id`,
  `team_management_enabled` to single owners.
- One `quota_check` helper for the 3 advisory-lock count sites.

Risk: **very low** (pure extraction, tests unchanged). Impact: **−450 LOC**.
Success: `cargo test` green, `git grep -c "load_vault_access"` returns 1.

### Phase 2 — Plumbing and the live defect (2 PRs)

- Mandate `transaction::database_error`; delete `vault_key_rotation.rs:148`,
  `idempotency.rs:172` and the inline closures. **This fixes the lost retryable-conflict classification.**
- Drop or downgrade the duplicate log at `http/api/error.rs:196`.
- Add `source` to `AppError` (or adopt `thiserror`) so SQLSTATE survives.
- Standardize on `impl Executor` for shared helpers.

Risk: **low**, but touches every service file — land it as a mechanical PR with no other changes.
Impact: **−300 LOC**, one defect fixed.
Success: `git grep "fn database"` in `services/` returns only `transaction.rs`.

### Phase 3 — Correctness and safety (3 PRs)

- **Move audit inserts inside their transactions** (~10 sites, §5.1). `insert_audit_event` is already
  executor-generic. Add a test asserting audit + mutation commit atomically.
- **Add `TimeoutLayer`**, exempting SSE. Add the missing `DefaultBodyLimit` on the rotation router.
- **Add Stripe webhook integration tests** and **`jobs/` tests**.
- **Scope `emailed_code_capture` per test database.**
- Replace the 10 ms sleep in `sync_tests.rs:158`.

Risk: **low to medium** (the audit change alters transaction contents — small, but real).
Impact: **+400 test LOC**, two real gaps closed.

### Phase 4 — Targeted splits and the operationId fix (4 PRs)

- Extract `session.rs:1392-1618` → `user_agent.rs`.
- Promote `catalog.rs`'s `mod member_handlers` → `vault/members.rs`.
- Split `team.rs`'s invitations into `team/invitations.rs`.
- Split `http/api/vault.rs` into 4 handler files.
- Migrate `auth.rs` and `team.rs` mapping onto `shapes!` (**−250 LOC**).
- **Fix the 20 snake_case operationIds** — one PR, with the `docs/openapi-breaking-changes.md` entry
  (§16). Do this before launch or not at all.

Risk: **low** (mechanical), except the operationId PR which is a deliberate contract change.
Impact: **−250 LOC**, four large files become navigable.

### Phase 5 — `domains/` move (1 large mechanical PR) — optional

`git mv` + `mod`/`use` rewiring only. **Zero logic changes**, so the diff is reviewable by inspection and
`cargo test` is the proof. Do it after phases 1-4 so the moved code is already deduplicated, and do it in
one PR rather than several, because a half-migrated tree is worse than either endpoint.

Risk: **medium** (merge conflicts with any in-flight work; coordinate timing). Impact: **0 LOC**, pure
navigation.

### Phase 6 — SQLx compile-time checking — ongoing

Spike `query_as!` with `as "role!: VaultRole"` overrides on three queries first (§9 caveat). If it works:
add `macros`, commit `.sqlx`, add `cargo sqlx prepare --check` to CI, convert `vault_key_rotation.rs`
(highest value — it has the tuple-index hazard), then convert opportunistically. **If the spike is
awkward, abandon it** — nothing else depends on it.

---

## 22. Changes that should explicitly NOT be made

**→ Do not migrate to SeaORM or Diesel, and do not run a hybrid.** §9. The hybrid is the worst option: the
complex queries would stay raw SQL inside the same modules as ORM calls, so the codebase would carry two
paradigms permanently in exchange for less benefit than either alone.

**→ Do not introduce repository traits, for any reason including mocking.** ADR 0002 pre-rejected this,
and the per-test-database infrastructure (§17) makes mock-based unit tests strictly worse than what
exists.

**→ Do not change DB test isolation.** No Testcontainers, no per-test transactions, no per-test schemas.
It is already correct, and per-test-transaction rollback would lose the ability to test the crate's own
transaction boundaries.

**→ Do not split `services/vault/attachments.rs` (655), `http/api/auth.rs` (1118), `http/api/team.rs`
(771), or `session.rs`'s Postgres store (535).** Each is one cohesive subject at a workable size.

**→ Do not split the crate into multiple crates.** No boundary here justifies the compile-time and
dependency cost.

**→ Do not add a DI container or wrap concrete dependencies in traits.** Every existing `Arc<dyn Trait>`
has a real second implementation; the concrete fields have nothing to swap (§13).

**→ Do not remove the `assert_eq!` count assertions in `http/api/mod.rs`.** They look like friction but
are the only guard against utoipa silently merging two same-named schemas (§16).

**→ Do not delete `SessionService`'s enum dispatchers** as "pass-through". They are a deliberate
Memory/Postgres Strategy split.

**→ Do not size-optimize security logic**: `vault_key_rotation.rs`, `member_departure.rs`,
`vault_membership.rs`, `verification_code.rs`, `billing/webhook.rs`, `rate_limit.rs`.

**→ Do not add middleware beyond a timeout** (and possibly compression). No rate-limit middleware — the
service-layer placement is deliberate and consistent.

**→ Do not "fix" implicit SQL authorization** by adding redundant application-level filters. The
join-based fail-closed pattern is correct; the fix is sharing one query, not adding a second check.

**→ Do not change any crypto or key-rotation semantics** as part of database or structural cleanup.
`storage.rs`'s capability token should **move**, unchanged.

---

## 23. Open questions

1. **Launch timing for the operationId fix.** §16 recommends renaming 20 auth operationIds now, while
   `docs/openapi-breaking-changes.md` makes it cheap. If a client is already pinned to `me` /
   `start_login`, this changes. **Is the API deployed to anyone yet?**

   - Anwer: no, its not deployed to anyone yet. But i'm not sure if we need to change it.

2. **Post-auth rate limiting.** `change_password`, `regenerate_secret_key`, `update_email` and
   `delete_account` have no limit and each revokes every other session on success. Deliberate, or a gap?

   -  Answer: I think we should add rate limiting to these endpoints. It seems like a gap.

3. **Migration policy after launch.** ADR 0011 says migrations become additive-only after the first REST
   release. Four committed migrations are destructive (`DROP TABLE "folder"`, two column renames, a
   `DELETE FROM` on three tables). Nothing in CI distinguishes pre- from post-launch. **Should
   `scripts/check-migrations.mjs` gain an additive-only mode, triggered by a flag file or a release tag?**

   - Anwer: No rephrase of the adr is needed.

4. **Boot-time migrations under rolling deploys.** `runtime.rs:27` runs migrations on every instance
   start. sqlx's advisory lock makes that concurrency-safe, but during a rollout old-code instances run
   against the new schema. Fine today; incompatible with rolling deploys once migrations stop being
   additive. **Should the server stop migrating at boot and rely on `bin/migrate` in the deploy pipeline?**

   - Anwer: I think we should stop migrating at boot and rely on bin/migrate in the deploy pipeline.
   - The issue is probably that railway deploys i think don't have access to internal network so the migrate command will probably fail.

5. **`DATABASE_MAX_CONNECTIONS` default of 5** (`db/mod.rs:12`) with no request timeout. What is it set to
   in production, and what is the expected concurrency?

   - Answer: I think they are not set in prod ad att right now we should probably set it to 20 or 30. I think we should also add a request timeout.

6. **Is the `cargo run --bin migrate` step in CI (`ci.yml:629-636`) still needed?** It migrates the base
   `bittery_test` database, which tests do not query — they only use its URL to derive the admin
   connection. It looks like leftover setup.

   - Answer: I'm not sure please investigate on this further.

7. **Graceful shutdown.** `ServerRuntime::Drop` aborts the Redis dispatch task but sends no signal to
   `JobRunner`. Is in-flight job completion on shutdown a requirement?

   - Answer: I think we should add a graceful shutdown to the job runner. It seems like a good idea.

8. **Phase 5 timing.** The `domains/` move is one large mechanical PR. **When is the branch queue quiet
   enough** to land it without painful conflicts?

   - Answer: It is already quiet, no others are working on it. We can do it directly.

---

## Most important question

> **If you were responsible for maintaining Bittery's backend for the next five years, would you keep
> SQLx, migrate to SeaORM, use a hybrid, or choose something else?**

**Keep SQLx.** Not as a default, and not because migration is expensive — because the specific things that
make this codebase harder to work in than it should be are, without exception, things an ORM does not fix.

Take the three worst days a maintainer will have in this crate.

**The first** is the day someone changes the vault member role rules and misses one of the two
implementations — `vault_membership.rs:30-44` or `vault/catalog.rs:875-880`. SeaORM has nothing to say
about that. Two copies of a security rule is a Rust-code problem.

**The second** is the day a deadlock in key rotation shows up as an opaque 500 instead of a retryable
conflict, because `vault_key_rotation.rs:148` reimplemented `transaction::database_error` and dropped the
SQLSTATE check. That is a missing shared helper — the same class of bug in any data layer.

**The third** is the day a migration renames a column and nothing catches it until a live-Postgres test
run, or production. **That one is real, and it is the strongest argument in the ORM's favour.** But
SeaORM's answer is weaker than SQLx's: SeaORM checks entity definitions, not queries, and every one of
this codebase's genuinely dangerous queries — the byte-budgeted `ROW_NUMBER()`/`SUM() OVER` CTEs at
`vault/items.rs:53-84`, the `pg_advisory_xact_lock(hashtext($1))` quota checks, the
`array_position()`-ordered `WHERE id = ANY($1)` re-fetches — would run through `find_by_sql` and get no
checking at all. SQLx's own `query_as!` macros check *the actual SQL against the actual schema*, which is
strictly more than SeaORM offers here, and they are a Cargo feature away.

Then look at what the ORM would cost. Fourteen enums re-modelled as `ActiveEnum`, discarding a
`closed_enum!` implementation (`db/enums.rs`) that decodes from both a native Postgres enum and a `::text`
cast and was specifically built so existing queries did not have to change. Nineteen migrations either
kept as a parallel system or ported to a Rust DSL, replacing a workflow that already has CI hygiene checks
and a create-script. A rewrite of the 3,624-LOC vault service package. And a direct collision with ADR
0002, which deleted a repository tier eighteen months of commits ago and recorded that reintroducing one
"would be a re-litigation of this decision, not a fix" — SeaORM entities plus `ActiveModel` are that tier
with a vendor attached.

The hybrid is worse than either. The complex queries would remain raw SQL **inside the same modules** as
the ORM calls, so `vault/items.rs` would carry two paradigms forever, and every maintainer would face a
per-query judgement call about which one to reach for.

And there is a domain-specific reason that outranks all of the above. **Bittery is zero-knowledge.** The
server stores opaque ciphertext. There is no rich object graph to hydrate, no deep relation tree, no
lazy-loading problem — item→attachments and vault→members, both already handled by a deliberate two-query
batch that is faster than what an ORM would generate. The single capability SeaORM is genuinely best at is
the one this product has least use for.

What I would do instead, in the order I would do it: collapse the eleven duplicated helpers into one copy
each; make `transaction::database_error` the only way a `sqlx::Error` becomes an `AppError`; move the ten
audit inserts inside their transactions; standardize on `impl Executor` so a helper can serve both a pool
and a transaction; and then spike `query_as!` on three queries to see whether the enum type-overrides are
tolerable. That sequence removes about a thousand lines, fixes a live defect, closes a correctness gap, and
buys the compile-time guarantee that is the only thing an ORM was ever going to offer here — at a fraction
of the cost, without a rewrite, and without re-litigating a settled decision.

The database library is not what makes this codebase harder than it needs to be. Eleven copy-pasted
helpers and one unshared error function are.
