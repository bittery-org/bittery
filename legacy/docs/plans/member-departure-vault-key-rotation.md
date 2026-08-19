# Member Departure and Vault Key Rotation: Implementation Plan

## Outcome

Deepen two related areas without merging their policies:

- A **Member departure module** owns voluntary and administrative departure from a Team: authorization, complete affected-Vault scope, all-or-nothing rotation finalization, personal-Team reassignment, Session revocation, audit and Sync events.
- A **Vault key rotation module** owns the reusable rotation ceremony: durable Rotation plans, bounded preparation and staging, fail-closed revalidation, atomic key/ciphertext replacement, rotation history and cleanup.

A shared client module in `packages/core` owns local cryptographic preparation for web, desktop, mobile and extension. The generated HTTP client is the adapter at the network seam. See [ADR-0013](../adr/0013-rotation-plans-coordinate-vault-key-rotation.md).

## Scope

Included:

- Voluntary Team departure and administrative Team Member departure.
- Single-Vault Member removal migrated onto the same rotation machinery.
- Per-Attachment encryption keys wrapped by the Vault key.
- Paginated Rotation-plan reads and idempotent staged uploads.
- Atomic finalization, structured stale reasons, command idempotency and bounded cleanup.
- Shared client orchestration, lock cancellation and fail-closed local refresh.

Excluded:

- User-triggered manual Key rotation. The module must admit it as a future policy caller, but this change adds no route, UI or speculative behavior for it.
- Scheduled or security-breach-triggered rotation.
- Legacy Attachment ciphertext compatibility or data migration; there are no deployed users or Attachments.
- A repository adapter in the Rust server. Server modules continue to own their SQL under ADR-0002.

## Invariants

1. A Member departure either commits every affected Vault rotation and every durable departure effect, or commits none of them.
2. A Rotation plan belongs to exactly one Vault, one initiating User and one reason.
3. A plan is single-use, expires after 30 minutes of inactivity and has a 24-hour absolute lifetime.
4. Fetching a valid preparation page or uploading a valid staged page refreshes only the inactivity deadline.
5. Preparation never locks ordinary Vault writes.
6. Finalization revalidates authorization, complete Vault coverage, Vault key versions, Member sets, Item IDs/versions and Attachment IDs/envelope versions.
7. Staged output never changes live Vault state before finalization.
8. Multi-Vault finalization consumes all plans in one database transaction.
9. The new Vault key exists client-side only as a live opaque `KeyRef`; lock, failure, success or abandonment destroys it.
10. Attachment bytes, filename and content type use a per-Attachment key. The Vault key wraps that key; rotation rewraps the envelope only.
11. Server commit is authoritative. A failed local refresh makes the Vault unavailable until authoritative state reloads; it does not turn success into failure.
12. Billing seat synchronization is the only best-effort post-commit departure effect.

## Target Module Shape

### Server

- `services/vault_key_rotation.rs`: plan lifecycle, paginated preparation, staged result validation, transactional application, completed rotation records, Sync events and cleanup queries.
- `services/member_departure.rs`: two intention-specific operations—voluntary and administrative—over one internal departure implementation.
- `services/vault_membership.rs`: Vault Member authorization and removal policy, calling Vault key rotation for the state transition.
- Existing `services/team.rs` and `services/vault.rs`: transport-independent Team/Vault behavior that is not departure or membership-rotation policy; their departure/removal exports become thin delegations or move entirely.
- `http/api/*`: request/response mapping, idempotency headers and `.notify_sync`; no domain policy.

The module interfaces should expose intentions and outcomes, not transaction helpers, SQL records or arbitrary combinations of actor/reason/departing Member. Internal seams are allowed for tests, but Postgres is the test adapter and no public repository seam is introduced.

### Client

- `packages/core/src/services/vault-key-rotation.ts`: start/fetch/stage/finalize orchestration, opaque key lifetime, bounded paging, lock cancellation and authoritative refresh.
- Team departure and Vault membership callers provide policy intent and consume outcomes; React modules only present progress/errors and initiate/cancel the ceremony.
- `CryptoPort` exposes page-capable primitives over caller-owned `KeyRef`s. Remove `performKeyRotation` after all production callers move.

## Delivery Slices

Each slice is independently testable and keeps production behavior coherent. Prefer failing tests before implementation.

### Slice 1 — Attachment-key storage format

Create the pre-launch Attachment format that later rotation relies on.

- Generate a fresh Attachment key during Attachment creation.
- Encrypt bytes, filename and content type under the Attachment key.
- Store an authenticated envelope wrapping the Attachment key under its Vault key, including explicit Vault/Attachment context.
- Update Attachment reads, metadata changes, downloads and cross-Vault Item moves.
- Make cache, sync and generated wire shapes carry the envelope from one Rust definition per ADR-0012.
- Remove direct-under-Vault-key Attachment behavior; add no legacy branch.

Tests:

- One Attachment key cannot open another Attachment.
- An envelope cannot move across Vaults or Attachments.
- Cross-Vault moves rewrap/re-encrypt correctly.
- Failed creation retires every fresh `KeyRef` and leaves no committed Attachment.
- Rust serialization/schema fixtures and TypeScript drift checks cover the new shape.

Verification while working:

- Focused core tests with Bun.
- Focused server Attachment tests with the running Postgres database.
- `pnpm exec turbo -F '...@bittery/core' check-types` and affected app equivalents.
- `pnpm check:server`.

### Slice 2 — Rotation-plan persistence and read path

- Add plan, expected-state manifest and staged-output tables using `pnpm run db:create -- <name>`.
- Model plan states such as preparing, ready, completed, stale, failed, abandoned and expired as Rust-owned closed sets.
- Store initiator, reason, Vault, expected key version, Member manifest, Item IDs/versions, Attachment IDs/envelope versions, idle deadline and absolute deadline.
- Add bounded cursor-paginated preparation endpoints for Members, Items and Attachment envelopes.
- Enforce authorization in the policy caller before plan creation; bind that authorization context into the plan.
- Return stable, generated plan/status types.

Tests:

- Page bounds by record count and serialized bytes.
- Snapshot manifests are complete and deterministically ordered.
- Unauthorized callers cannot create or read a plan.
- Idle extension never exceeds the absolute deadline.
- Expired and consumed plans cannot be revived.

Generation steps:

- Run `write-openapi`.
- Run `@bittery/api-contract generate`.
- Update route/schema count assertions.
- Run `pnpm i18n:generate` only if this slice adds user-facing copy.

### Slice 3 — Page-capable client cryptography

- Replace the all-at-once `CryptoPort.performKeyRotation` member with primitives that operate on a caller-owned new Vault-key `KeyRef` across pages.
- Wrap that key for the exact remaining Member set.
- Re-encrypt Item pages while retaining each Item’s existing encryption context.
- Rewrap Attachment-key envelopes without reading or rewriting object-storage blobs.
- Extend shared adapter conformance across WASM worker, WASM, React Native and in-memory adapters.
- Build the non-React shared-core rotation module over those primitives and generated HTTP types.
- Destroy owned refs on every success/failure/cancellation path.

Tests:

- Multiple pages use one new Vault key.
- Item context and Attachment envelope context survive correctly.
- Lock aborts immediately and retires both old and new owned refs.
- Restart has no resume state; a new ceremony creates a new plan/key.
- Port conformance covers foreign/destroyed refs and partial failures.

### Slice 4 — Idempotent staging and single-Vault finalization

- Upload Member keys, Item ciphertext and Attachment envelopes in bounded chunks.
- Make each chunk idempotent and reject reuse with different bytes.
- Require completeness before finalization.
- In one transaction, lock/reload authoritative state, classify staleness, apply all staged results, increment the Vault key version, consume the plan, write the completed rotation record and emit Sync events.
- Return structured stale categories: Vault version, Member set, Item state or Attachment state.
- Wrap finalization in the existing HTTP idempotency machinery and replay the original committed response.

Tests:

- Out-of-order and repeated identical chunks succeed.
- Conflicting chunks fail without changing staged or live state.
- Missing chunks cannot finalize.
- Each stale category rolls back completely.
- Lost-response replay returns the original rotation result.
- Failed plans remain diagnostic; no completed security event is written.

### Slice 5 — Vault Member removal migration

- Move authorization and target-role rules from `vault.rs` into the Vault membership module.
- Create a removal Rotation plan, use the shared client ceremony, and finalize removal plus rotation atomically.
- Put the Vault audit event inside the final transaction.
- Remove the duplicated SQL and rotation-record implementation from `vault.rs`.
- Replace web UI orchestration in `vault-member-list.tsx` with the shared-core module.

Tests:

- Owner/Admin authorization matrix, including Admin-versus-Admin and self-removal.
- Member removal and rotation are atomic.
- Removed Member loses access; remaining Members open the new Vault key.
- Attachment keys open with the new key and not the old key.
- UI tests assert visible progress/outcomes, not crypto call order.

### Slice 6 — Atomic multi-Vault Member departure

- Implement voluntary and administrative operations in the Member departure module.
- Preparation creates exactly one Rotation plan per affected Vault.
- Finalization locks and revalidates the full plan set, then atomically applies every rotation, moves the departing Member to a personal Team, revokes and records all Sessions, writes audit data and emits Sync events.
- Require exact affected-Vault coverage; reject duplicates, omissions and extras.
- Add command idempotency to both departure routes.
- Run billing seat synchronization best-effort only after commit.
- Replace duplicated orchestration and helpers in `team.rs`.

Tests:

- Owner cannot depart; administrative self-removal is rejected; only authorized Members remove others.
- A Member cannot be removed from only part of their affected Vault set.
- One stale or failed Vault rolls back every Vault and the Team reassignment.
- Session revocation, audit and Sync events commit with departure.
- Billing failure does not reverse a committed departure.
- Same-key replay returns the same plan/rotation IDs; conflicting reuse fails.

### Slice 7 — Cross-client adoption and fail-closed refresh

- Replace Team leave and Team Member removal orchestration in web UI with shared-core calls.
- Wire desktop, mobile and extension capability where their existing Team/Vault screens expose the actions; do not add unrelated UI.
- Subscribe ceremonies to Account lock and cancel immediately.
- After finalization, discard stale local Vault state and refresh keys, Items and Attachment envelopes from the server.
- Keep the Vault unavailable until refresh succeeds; surface a retryable refresh state without claiming rotation failed.
- Add i18n keys to both `en.json` and `de.json`, then regenerate Paraglide output.

Tests:

- Shared client outcome tests cover every caller intent.
- Lost final response recovers through idempotent replay.
- Local persistence failure triggers fail-closed refresh.
- App lock cancels; app restart never resumes.
- Relevant web E2E verifies a real departure across more than one Vault with an Attachment.

### Slice 8 — Cleanup, deletion test and documentation

- Add bounded asynchronous cleanup for expired plans and cascading staged data.
- Integrate with the existing recurring maintenance mechanism; cleanup never controls request correctness.
- Delete obsolete rotation helpers, duplicated UI orchestration and tests that reach past the new interfaces.
- Reapply the deletion test: removing either deep module must redistribute meaningful policy across its callers.
- Update security documentation and any package-local `CONTEXT.md` needed for key ownership or storage invariants.
- Confirm manual Key rotation remains an unimplemented future caller.

Tests:

- Expiry is enforced before cleanup runs.
- Cleanup is bounded, resumable and cannot remove live plans.
- Cascading cleanup removes staged payloads.
- No production caller uses removed crypto or server helpers.

## Schema and Contract Notes

- Use Rust enums in `apps/server/src/db/enums.rs` for all new closed sets and generate TypeScript definitions under ADR-0012.
- Plan manifests and staged payloads may be normalized into child tables; do not place unbounded JSON arrays in one row or response.
- Use strong expected versions rather than timestamps for finalization checks.
- Keep one completed `vault_key_rotation` record per Vault; Rotation plans are separate history.
- Idempotency fingerprints must cover the plan ID(s), staged manifest identity and policy intent. Reuse with different input fails.
- Responses disclose stale categories but not Member, Item or Attachment details after authorization is lost.

## Verification Matrix

During each slice:

- Run the smallest focused Bun or Rust test first.
- Run `pnpm exec biome check --write <changed files>` for changed TypeScript/JSON files.
- Run the affected Turbo `check-types` target, including dependents where cross-package types changed.
- Run `pnpm check:server` for Rust changes.

Before completion:

- `pnpm check:ci`
- `pnpm check:ci:rust`
- Generated artifact and OpenAPI breaking-change checks.
- A focused E2E covering multi-Vault Member departure, Attachment access revocation and idempotent response recovery.

## Completion Criteria

- Team departure and Vault Member removal contain no duplicate rotation SQL or client crypto orchestration.
- Callers cross the Member departure, Vault membership or Vault key rotation module interface; they do not reach transaction helpers.
- Old Vault keys cannot decrypt new Items or Attachment keys after departure.
- No partial multi-Vault departure is observable.
- Every fresh `KeyRef` has an auditable lifetime and is destroyed on all terminal paths.
- Rotation plans and staged data are bounded, expiring and cleaned asynchronously.
- Manual rotation remains possible as a future policy caller without changing the rotation module seam.
