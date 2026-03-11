# Bittery Security Audit - Phase 4: Data Isolation & Multi-Tenancy

## Summary

Bittery's current multi-tenant isolation model is mostly application-enforced rather than database-enforced. The good news is that the main online data paths are generally derived from `ctx.session.userId`, vault membership is usually checked through `vault_key`, sync catch-up queries are membership-filtered, attachment upload keys are bound to `userId + itemId`, and the Phase 3 public-blob issue appears remediated because `/cdn/*` now allows only `teams/` and `vaults/` keys.

The main weaknesses in Phase 4 were systemic rather than per-route:

- Team deletion previously did not actually dismantle the deleted tenant. This is now blocked by real `user.teamId` / `vault.teamId` foreign keys plus a conservative transactional teardown that requires the team to be empty before deletion and moves the owner onto a fresh personal team.
- Sync sequencing previously exposed a global `sync_event.seq`. The public protocol now uses opaque event ids as cursors, while `seq` remains internal for database ordering only.
- SSE delivery previously relied on a cached membership map, so membership revocation could race with later vault events. The server now applies an immediate deny map keyed by `(userId, vaultId)` and emits revocation before member-removal/key-rotation fan-out.
- Attachment storage previously had no plan-based file-size or quota enforcement. Uploads now reserve storage against plan-defined limits, verify object size on finalize, and clean up expired orphaned reservations.
- Several endpoints previously exposed existence oracles through `NOT_FOUND` vs `FORBIDDEN` behavior. The remaining attachment and share-management routes now use scoped lookups so foreign and nonexistent ids collapse to `NOT_FOUND`.

No explicit checkpoint table or checkpoint-creation flow exists in the current server code. Sync resumption now uses opaque event-id cursors plus `sync_event_ack`.

## Isolation Map

| Table | Has `userId` Scope | Isolation Mechanism | Risk |
| --- | --- | --- | --- |
| `user` | Root tenant row | Primary key `user.id`; team linkage via `teamId -> team.id` FK | Low |
| `session` | Direct | `session.userId -> user.id` FK; all auth/session code filters by `userId` | Low |
| `recovery_verification` | Indirect | Scoped by normalized email, not FK-backed | Medium |
| `signup_verification` | Indirect | Scoped by normalized email + optional invitation token, not FK-backed | Medium |
| `login_attempt` | Mixed | Optional `userId` FK for real users; otherwise `normalizedEmailHash` only | Medium |
| `audit_log` | Direct | Plain `userId` column plus audit router filters to team member IDs | Medium |
| `vault` | Indirect | Ownership and membership derived from `vault.createdById` and `vault_key`; `teamId -> team.id` FK prevents orphaned team vaults | Medium |
| `vault_key` | Direct | `vaultId` + `userId` FKs; used as primary membership table | Medium |
| `item` | Indirect | `item.vaultId -> vault.id`; access derived through `vault_key` | Low |
| `folder` | Indirect | `folder.vaultId -> vault.id`; no separate tenant key | Low |
| `vault_key_rotation` | Indirect | `vaultId` + `initiatedById` FKs | Low |
| `item_attachment` | Indirect | `itemId` + `vaultId` FKs; access checked through `attachment.vaultId`; committed `storageSize` now participates in team quota enforcement | Low |
| `pending_attachment_upload` | Indirect | Reservation table scoped by `teamId`, `vaultId`, `itemId`, and `createdBy`; used for quota reservation and orphan cleanup | Low |
| `sync_event` | Direct and indirect | `userId` FK plus optional `vaultId`; delivery filtered by membership, with opaque event-id cursors for clients | Medium |
| `sync_event_ack` | Direct | `userId` + `eventId` FKs; queried by current user | Medium |
| `share_link` | Direct and indirect | `createdById` FK plus `itemId -> item -> vault` | Medium |
| `share_link_allowed_email` | Indirect | `shareLinkId -> share_link.id` FK | Low |
| `share_email_verification` | Indirect | `shareLinkId -> share_link.id` FK | Low |
| `share_access_log` | Indirect | `shareLinkId -> share_link.id` FK | Low |
| `team` | Indirect | `ownerId -> user.id` FK; reverse membership enforced through `user.teamId -> team.id` | Medium |
| `team_invitation` | Indirect | `teamId` FK + `invitedById` FK | Medium |
| `stripe_event_log` | None, global | Operational deduplication table only | Low |
| `rate_limit_state` | None, global | Shared operational table keyed by `(scope, key)` | Low |

## Findings

### Finding 1: Team deletion leaves orphaned shared vaults and active member access behind

- Severity: High
- Location:
  - `packages/api/src/routers/team.ts:361-403`
  - `packages/db/src/schema/auth.ts:29-38`
  - `packages/db/src/schema/vault.ts:33-50`
- Description:
  - `team.delete` deletes only the `team` row.
  - `user.teamId` and `vault.teamId` are plain text columns, not foreign keys. Deleting a team therefore does not cascade into users or team vaults.
  - Existing `vault_key` rows survive, and ordinary vault access is authorized from `vault_key`, not from team existence. That meant a deleted team could leave its shared vaults fully accessible to former members.
- Attack scenario:
  1. Team owner creates a shared vault and adds User B.
  2. The owner calls `team.delete`.
  3. The server deletes only the `team` row.
  4. User B's `vault_key` rows still exist, and the shared vault rows still exist with the old `teamId`.
  5. User B continues using `vault.list`, `vault.getItem`, `sync.getEventsSince`, and other vault routes against data that should have been decommissioned with the team.
- Recommended fix:
  - Do not allow raw team deletion while dependent users or team vaults still exist.
  - Add real foreign keys for `user.teamId -> team.id` and `vault.teamId -> team.id`.
  - Replace `team.delete` with a transactional teardown that either:
    - refuses deletion until every member is removed and every team vault is deleted, or
    - explicitly rotates/removes all team vault memberships, migrates users to fresh personal teams, and only then deletes the team.

```ts
// Example hard fail until teardown is explicit.
const dependentUsers = await db.query.user.findMany({
  where: (u, { eq }) => eq(u.teamId, input.teamId),
  columns: { id: true },
});
const dependentVaults = await db.query.vault.findMany({
  where: (v, { eq }) => eq(v.teamId, input.teamId),
  columns: { id: true },
});

if (dependentUsers.length > 1 || dependentVaults.length > 0) {
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: "Delete all team vaults and remove all members before deleting the team",
  });
}
```

### Finding 2: Global `sync_event.seq` leaks cross-tenant activity volume

- Severity: Medium
- Location:
  - `packages/db/src/schema/sync.ts:40-69`
  - `packages/api/src/routers/sync.ts:107-124`
  - `apps/server/src/sync/sse-handler.ts:14-39`
- Description:
  - `sync_event.seq` is a single global `bigserial` shared by every user and vault.
  - That global counter is returned to clients in `sync.getEventsSince` and included in SSE event payloads.
  - A legitimate user can therefore observe gaps between sequence numbers and infer how much activity other tenants generated while they were idle.
- Attack scenario:
  1. Attacker keeps one account logged in and records their latest visible sync `seq`.
  2. The attacker waits without making changes.
  3. When their next event arrives, the attacker compares the new `seq` with the previous one.
  4. The gap reveals how many sync events other users generated in the meantime.
  5. Repeating this over time exposes service-wide activity patterns, busy hours, and incident-related spikes.
- Recommended fix:
  - Stop exposing a global shared sequence to clients.
  - Replace it with an opaque cursor or a per-user/per-membership sequence.
  - One practical model is a per-user sync mailbox table populated at write time, with a user-local monotonic cursor:

```ts
export const userSyncEvent = pgTable("user_sync_event", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  localSeq: bigserial("local_seq", { mode: "number" }).notNull(),
  syncEventId: text("sync_event_id").notNull().references(() => syncEvent.id, { onDelete: "cascade" }),
});
```

Status:
- Remediated by removing `seq` from the public sync API, SSE payloads, `packages/sync`, and extension/background cursor storage.
- `sync.getEventsSince` now accepts `{ sinceId?: string | null }` and returns `cursor: { id: string } | null`.

### Finding 3: SSE fan-out uses cached membership and can leak post-revocation metadata during races

- Severity: Medium
- Location:
  - `apps/server/src/sync/sse-handler.ts:145-173`
  - `apps/server/src/sync/sse-handler.ts:291-347`
  - `packages/api/src/routers/team.ts:1131-1196`
  - `packages/api/src/routers/vault.ts:2554-2616`
- Description:
  - SSE delivery was based on the in-memory `userVaults` cache, not a fresh authorization check at send time.
  - Membership revocation routes deleted DB membership first and then published revocation/control events afterward.
  - Until the local cache was updated on every node, `deliverToConnections` could still believe the removed user belonged to the vault and forward later sync events.
  - The leaked data was metadata, not full plaintext vault contents, but it still included event type, `entityId`, `vaultId`, `version`, actor `userId`, and timestamps after revocation should already have taken effect.
- Attack scenario:
  1. User A keeps an SSE connection open.
  2. Admin/User B removes User A from a shared vault.
  3. The membership row is deleted in the database, but User A's node still has stale `userVaults` cache state.
  4. Before the revocation event is processed on that node, User B updates an item in the same vault.
  5. `deliverToConnections` sees the stale cached membership and forwards the event to User A.
  6. User A learns post-revocation metadata about the vault they should no longer observe.
- Recommended fix:
  - Treat revocation as a hard deny at delivery time, not only as a cache mutation.
  - Either:
    - maintain a revocation-aware per-user deny set that is applied immediately when revocation is published, or
    - re-check vault membership from the database before sending events for sensitive membership-changing windows.
  - At minimum, process `vault_access_revoked` first and block later vault events for that `(userId, vaultId)` pair until the cache is refreshed.

```ts
const revokedVaultsByUser = new Map<string, Set<string>>();

function isExplicitlyRevoked(userId: string, vaultId: string): boolean {
  return revokedVaultsByUser.get(userId)?.has(vaultId) ?? false;
}

// Before fan-out
if (vaultId && isExplicitlyRevoked(userId, vaultId)) {
  continue;
}
```

Status:
- Remediated by an in-memory deny map keyed by `(userId, vaultId)` inside the SSE handler.
- `vault_access_revoked` is now delivered only to the revoked user, clears cached membership immediately, and blocks later vault-scoped fan-out until access is restored.

### Finding 4: Attachment uploads have no enforced size ceiling, enabling tenant-to-tenant storage exhaustion

- Severity: Medium
- Location:
  - `packages/api/src/routers/vault.ts:1785-1827`
  - `packages/api/src/routers/vault.ts:1833-1918`
  - `packages/api/src/storage/s3.ts:169-191`
- Description:
  - Attachment uploads previously used presigned `PutObject` URLs with no content-length cap.
  - The API validated only that `fileSize` was a positive integer when persisting metadata; it did not enforce a maximum, and the presigned upload itself had no quota reservation.
  - This allowed a legitimate user to upload arbitrarily large objects into the shared storage bucket, including orphaned objects if they never called `createAttachment`.
- Attack scenario:
  1. Attacker requests `vault.createAttachmentUpload`.
  2. The attacker uploads a very large object directly to S3 using the presigned URL.
  3. The server does not reject it based on size.
  4. The attacker repeats this or abandons uploads without storing metadata.
  5. Shared storage cost and capacity are consumed by one tenant, degrading service for others.
- Recommended fix:
  - Enforce plan-defined max attachment size and storage quota in API input and reservation logic.
  - Validate actual object size before persisting metadata.
  - Add cleanup for orphaned uploads that never get a matching `item_attachment` row.

```ts
const limits = planAttachmentLimits.personal;
fileSize: z.number().int().positive().max(
  limits.attachment_max_file_size_bytes,
)
```

Status:
- Remediated with plan-defined attachment limits, team-scoped storage reservations in `pending_attachment_upload`, verified `storageSize` accounting on `item_attachment`, and a cleanup job for expired unconsumed uploads.

### Finding 5: Several endpoints still expose resource-existence oracles across tenant boundaries

- Severity: Low
- Location:
  - `packages/api/src/routers/vault.ts:1800-1819`
  - `packages/api/src/routers/vault.ts:1853-1870`
  - `packages/api/src/routers/vault.ts:1933-1950`
  - `packages/api/src/routers/vault.ts:1973-1994`
  - `packages/api/src/routers/share.ts:111-144`
  - `packages/api/src/routers/share.ts:293-316`
- Description:
  - Multiple routes previously loaded a resource by ID and then returned `FORBIDDEN` if the caller lacked membership.
  - That made `nonexistent` and `exists-but-foreign` distinguishable by status code, error text, and likely timing.
  - The IDs are mostly random `nanoid`s, so this is not trivial blind enumeration, but it is still a cross-tenant existence oracle once an attacker learns candidate IDs from logs, screenshots, client-side artifacts, or other leaks.
- Attack scenario:
  1. Attacker obtains candidate `itemId` or `attachmentId` values.
  2. The attacker calls attachment or share routes with each candidate.
  3. A nonexistent ID returns `NOT_FOUND`, while an existing foreign resource returns `FORBIDDEN` / `Access denied`.
  4. The attacker confirms which foreign resources actually exist.
- Recommended fix:
  - Resolve authorization and existence in one scoped query whenever possible.
  - Return the same outward result for both cases, ideally `NOT_FOUND`.

```ts
const attachment = await db
  .select({ id: itemAttachment.id, storageKey: itemAttachment.storageKey })
  .from(itemAttachment)
  .innerJoin(
    vaultKey,
    and(
      eq(vaultKey.vaultId, itemAttachment.vaultId),
      eq(vaultKey.userId, ctx.session.userId),
    ),
  )
  .where(eq(itemAttachment.id, input.attachmentId))
  .limit(1);

if (!attachment[0]) {
  throw new TRPCError({ code: "NOT_FOUND", message: "Attachment not found" });
}
```

Status:
- Remediated for the remaining attachment and share-management routes by moving lookups behind scoped helper queries and collapsing nonexistent and foreign ids to `NOT_FOUND`.

### Finding 6: Dev auth stubs log signup and recovery codes for all users into shared server logs

- Severity: Low
- Location:
  - `packages/api/src/routers/auth.ts:121-136`
- Description:
  - The current email stubs logged normalized email addresses and one-time verification codes to server logs.
  - Those logs are shared operational data across all users. If log access is broad in development or staging, one user's auth and recovery material becomes visible to other operators or anyone with log access.
- Attack scenario:
  1. User A requests signup verification or recovery verification.
  2. The server logs User A's normalized email and code.
  3. Another person with log access reads the code.
  4. That person can complete flows for another user.
- Recommended fix:
  - Never log live verification codes.
  - Gate the stub behind an explicit local-only environment flag and redact email values.

```ts
console.info("[recovery-code] issued dev stub code");
```

Status:
- Remediated by requiring `BITTERY_ENABLE_DEV_AUTH_STUBS=true` and `NODE_ENV !== "production"` for local stubs, logging only redacted operational messages, and failing closed when no real provider is configured.

## Positive Findings

- SSE subscriptions are authenticated entirely from the bearer token, with no user-controlled topic or channel selector. A client cannot ask to subscribe to another user's channel by passing a different parameter.
  - `apps/server/src/sync/sse-handler.ts:427-454`
- Sync catch-up queries intersect requested vault IDs with the caller's current `vault_key` memberships, and `vault_access_revoked` control events are additionally filtered by `sync_event.userId = ctx.session.userId`.
  - `packages/api/src/routers/sync.ts:45-75`
- The current public CDN proxy no longer serves `attachments/` objects. Only `teams/` and `vaults/` keys are allowlisted, which appears to remediate the Phase 3 public-blob exposure.
  - `packages/api/src/storage/public-access.ts:1-12`
  - `apps/server/src/cdn.ts:3-37`
- Attachment upload keys are namespaced under `attachments/<userId>/<itemId>/...` and signed over `userId + itemId + uploadId + expiry`, then re-validated before metadata is created. That prevents straightforward cross-user key forgery.
  - `packages/api/src/storage/s3.ts:26-159`
  - `packages/api/src/routers/vault.ts:1873-1884`
- Invitation-bound vault keys are explicitly constrained to the inviter's team and to vaults where the inviter is `owner` or `admin`, which is good defense against cross-team vault grants.
  - `packages/api/src/utils/pending-vault-keys.ts:81-128`
- Team-member removal and team-rotation flows now enforce per-vault removable scope rather than assuming every team admin implicitly controls every team vault.
  - `packages/api/src/routers/team.ts:101-152`
  - `packages/api/src/routers/team.ts:825-837`
  - `packages/api/src/routers/team.ts:963-1004`
- Billing and audit routes derive the acting team from the authenticated session rather than trusting caller-supplied team IDs for primary scoping.
  - `packages/api/src/routers/billing.ts:41-64`
  - `packages/api/src/routers/audit.ts:225-277`
- Resource IDs are mostly random `nanoid` values rather than sequential integers. The main exception is the global sync sequence counter discussed above.
  - Representative creation sites: `packages/api/src/routers/vault.ts:231`, `packages/api/src/routers/share.ts:181`, `packages/api/src/routers/team.ts:1526`

## Open Questions

- No explicit checkpoint table or checkpoint-creation API exists in the current server code. If a checkpoint mechanism is planned later, it needs a per-user or per-membership design from the start.
- `team_member` is marked deprecated, but still exists in the schema. Confirm whether it is still needed; dual membership representations (`user.teamId` and `team_member`) are easy to drift out of sync.
  - `packages/db/src/schema/team.ts:45-64`
- I did not find a dedicated server-side "export vault" feature. Current import/export references appear client-side import logic only, so the checklist item does not currently apply.

## Cross-References

- Phase 3 identified the earlier public attachment blob exposure through `/cdn/*`. The current `public-access` allowlist suggests that issue has been addressed, but it is worth preserving the Phase 3 regression tests so `attachments/` cannot become public again.
  - `docs/security-audit/phase-3-authorization-access-control.md`
  - `packages/api/src/storage/public-access.ts:1-12`
- Phase 3 also called out team-wide removal logic that relied on overly broad team-admin authority. The current `getTeamRemovalScope(...)` checks are an improvement and materially strengthen tenant separation inside shared-vault flows.
  - `docs/security-audit/phase-3-authorization-access-control.md`
  - `packages/api/src/routers/team.ts:101-152`
- Phase 2 established that sessions are opaque bearer tokens hashed server-side and resolved into `ctx.session.userId`. The issues in this phase are therefore post-auth isolation failures, not authentication bypasses.
  - `docs/security-audit/phase-2-authentication-session-security.md`
- Phase 1's review of encryption context binding remains relevant here: even when metadata leaks through sync or storage paths, item ciphertext is still protected by the zero-knowledge cryptographic design.
  - `docs/security-audit/phase-1-cryptographic-review.md`
