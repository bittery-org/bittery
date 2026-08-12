# Bittery Security Audit — Phase 3: Authorization & Access Control

Date: 2026-03-10  
Scope: tRPC authorization boundaries, ownership checks, IDOR resistance, sync/SSE scoping, and related server-side access control paths.

> Note: `apps/server`, `packages/api`, `packages/auth`, and `packages/db` were removed after the Rust server cutover. Any references to those paths in this document are historical audit context, not current implementation guidance.

## 1. Summary

I reviewed all 104 tRPC procedures, the SSE sync endpoint, and the server-side CDN proxy used for stored blobs.

The good news: the authentication middleware ordering is correct for current protected tRPC routes, most vault/item CRUD paths are scoped through `vault_key.user_id = ctx.session.userId`, billing/audit/session-management routes derive their target resources from the authenticated session rather than trusting caller-supplied IDs, and sync event delivery is mostly membership-scoped.

The bad news: authorization is implemented ad hoc in handlers rather than through centralized resource loaders, and that drift has already produced several high-impact gaps:

- A public blob proxy can serve private attachment objects without authorization checks.
- Team invitation tokens are exposed to any team member, and invited signup trusts only a plaintext email match, enabling invite hijacking and role escalation.
- Team-level key-rotation routes bypass vault-level ACLs and expose encrypted vault contents outside explicit vault membership.
- Several metadata-heavy routes (`share.get`, `share.getAccessLogs`, `vault.members.lookupUser`, `sync.checkConflict`) authorize too broadly or leak foreign-resource existence.

Severity overview:

- Critical: 1
- High: 2
- Medium: 2
- Low: 1

## 2. Full Route Map

Status legend:

- `✅` Authorization check present and correctly scoped for the route’s purpose.
- `⚠️` Authenticated, but authorization is weaker than ideal or leaks existence/metadata.
- `❌` Missing or over-broad authorization for the data exposed or modified.

### App Router

| Procedure | Auth | Inputs | Ownership / authorization check | Status |
| --- | --- | --- | --- | --- |
| `healthCheck` | Public | None | Intentionally public health probe | ✅ |
| `privateData` | Protected | None | `protectedProcedure`; returns only current `ctx.session` | ✅ |

### Auth Router

| Procedure | Auth | Inputs | Ownership / authorization check | Status |
| --- | --- | --- | --- | --- |
| `auth.registrationStatus` | Public | None | Intentionally public bootstrap status | ✅ |
| `auth.signup` | Public | `userId?`, `vaultId?`, signup fields | New-account creation only; no foreign resource lookup | ✅ |
| `auth.signupWithInvitation` | Public | `token`, `userId?`, `vaultId?`, `email`, signup fields | Pending invite lookup + email-string match + pending-vault-key authorization helper | ⚠️ |
| `auth.startLogin` | Public | `email`, `clientPublicKey` | Public auth flow | ✅ |
| `auth.finishLogin` | Public | `userId`, SRP proof fields | Public auth flow | ✅ |
| `auth.quickUnlock` | Public | `email`, `userId`, SRP proof fields | Public auth flow | ✅ |
| `auth.checkEmail` | Public | `email` | Intentionally public; Phase 2 covers enumeration behavior | ✅ |
| `auth.requestRecoveryVerification` | Public | `email` | Public recovery flow | ✅ |
| `auth.verifyRecoveryCode` | Public | `email`, `code` | Public recovery flow | ✅ |
| `auth.getRecoveryData` | Public | `recoveryToken` | Token-bound recovery flow | ✅ |
| `auth.resetPassword` | Public | `recoveryToken`, reset payload | Token-bound recovery flow | ✅ |
| `auth.me` | Protected | None | `user.id = ctx.session.userId` | ✅ |
| `auth.logout` | Protected | None | Deletes current `ctx.session.sessionId` only | ✅ |
| `auth.refreshSession` | Protected | None | Rotates current `ctx.session.sessionId` only | ✅ |
| `auth.logoutAll` | Protected | None | Deletes sessions where `session.userId = ctx.session.userId` | ✅ |
| `auth.updateEmail` | Protected | `newEmail`, `encryptedVaultKeys[]` | Helper updates only `user.id = ctx.session.userId` and only that user’s `vault_key` rows | ✅ |
| `auth.changePassword` | Protected | `encryptedVaultKeys[]` | Helper updates only `user.id = ctx.session.userId` and only that user’s `vault_key` rows | ✅ |
| `auth.regenerateSecretKey` | Protected | `encryptedVaultKeys[]` | Helper updates only current user; invalidates other sessions for same user | ✅ |
| `auth.storeRecoveryKey` | Protected | Recovery metadata | `getUserById(ctx.session.userId)` | ✅ |
| `auth.deleteAccount` | Protected | `confirmEmail` | Deletes only current user after email confirmation | ✅ |
| `auth.listDevices` | Protected | None | `getUserSessions(ctx.session.userId)` | ✅ |
| `auth.revokeDevice` | Protected | `sessionId` | Helper deletes only `(session.id, session.userId)` for current user | ✅ |
| `auth.renameDevice` | Protected | `sessionId`, `deviceName` | Helper updates only `(session.id, session.userId)` for current user | ✅ |
| `auth.heartbeat` | Protected | None | Updates current `ctx.session.sessionId` only | ✅ |

### Billing Router

| Procedure | Auth | Inputs | Ownership / authorization check | Status |
| --- | --- | --- | --- | --- |
| `billing.status` | Protected | None | `getBillingActor(ctx.session.userId)` derives actor/team from session | ✅ |
| `billing.entitlements` | Protected | None | Same as above | ✅ |
| `billing.createCheckoutSession` | Protected | `plan?` | Own team only via `getBillingActor`; owner/admin only | ✅ |
| `billing.createPortalSession` | Protected | None | Own team only via `getBillingActor`; owner/admin only | ✅ |
| `billing.syncSeats` | Protected | `teamId?` | Target team must equal actor’s team; owner/admin only | ✅ |
| `billing.previewAdditionalTeamSeat` | Protected | None | Own team only via `getBillingActor`; owner/admin only | ✅ |

### Audit Router

| Procedure | Auth | Inputs | Ownership / authorization check | Status |
| --- | --- | --- | --- | --- |
| `audit.teamEvents` | Protected | Filters/pagination fields | Actor derived from `ctx.session.userId`; owner/admin only; results constrained to `memberIds` of actor’s team | ✅ |

### Team Router

| Procedure | Auth | Inputs | Ownership / authorization check | Status |
| --- | --- | --- | --- | --- |
| `team.list` | Protected | None | `user.id = ctx.session.userId`; returns only actor’s team | ✅ |
| `team.get` | Protected | `teamId` | Requires `user.teamId === input.teamId` | ✅ |
| `team.create` | Protected | `name`, `type?` | Deprecated no-op | ✅ |
| `team.update` | Protected | `teamId`, mutable fields | Requires `user.teamId === input.teamId`; owner/admin only | ✅ |
| `team.createImageUpload` | Protected | `teamId`, file metadata | Requires `user.teamId === input.teamId`; owner/admin only | ✅ |
| `team.delete` | Protected | `teamId` | Requires `user.teamId === input.teamId`; owner only | ✅ |
| `team.leave` | Protected | `teamId`, `vaultRotations[]`, `clientId?` | Requires actor be leaving self from own non-personal team; rotation enforced for actor-accessible vaults | ✅ |
| `team.getLeaveRotationData` | Protected | `teamId` | Requires actor be team member, but returns all team vaults without vault-level membership filtering | ❌ |
| `team.members.list` | Protected | `teamId` | Requires `user.teamId === input.teamId` | ✅ |
| `team.members.getTeamRotationData` | Protected | `teamId`, `excludeUserId` | Team role check only; no per-vault membership/admin check before returning all team-vault ciphertext | ❌ |
| `team.members.remove` | Protected | `teamId`, `userId`, `vaultRotations[]`, `clientId?` | Team role check only; mutates vault membership/key state across all team vaults without per-vault ACL check | ❌ |
| `team.members.deleteAccount` | Protected | `teamId`, `userId`, confirmation | Deprecated no-op | ✅ |
| `team.vaults` | Protected | `teamId` | Requires `user.teamId === input.teamId`; owner/admin only; returns caller’s own encrypted keys only | ✅ |
| `team.invitations.getByToken` | Public | `token` | Intentionally public invite-landing lookup | ✅ |
| `team.invitations.list` | Protected | `teamId` | Requires team membership, but not owner/admin; leaks pending invite emails/tokens to any member | ❌ |
| `team.invitations.send` | Protected | `teamId`, `email`, `role`, `pendingVaultKeys?` | Requires team owner/admin; pending vault grants constrained by helper | ✅ |
| `team.invitations.cancel` | Protected | `invitationId` | Current user must currently be owner/admin of invitation’s team | ✅ |
| `team.invitations.resend` | Protected | `invitationId` | Current user must currently be owner/admin of invitation’s team | ✅ |
| `team.invitations.pending` | Protected | None | Scoped to `user.email = ctx.session.userId.email` | ✅ |
| `team.invitations.accept` | Protected | `token` | Invite token + current user email must match invitation email; no mailbox proof required because account already exists | ✅ |
| `team.invitations.decline` | Protected | `token` | Current user email must match invitation email | ✅ |

### Vault Router

| Procedure | Auth | Inputs | Ownership / authorization check | Status |
| --- | --- | --- | --- | --- |
| `vault.get` | Protected | `vaultId` | `vault_key(vaultId, userId)` required | ✅ |
| `vault.list` | Protected | None | `vault_key.userId = ctx.session.userId` | ✅ |
| `vault.createImageUpload` | Protected | `vaultId?`, file metadata | If `vaultId` provided: `vault_key(vaultId, userId)` + owner/admin; otherwise namespaced to current user | ✅ |
| `vault.create` | Protected | New-vault fields | Creates new vault owned by current user; team vault uses current user’s team/entitlements | ✅ |
| `vault.update` | Protected | `vaultId`, mutable fields | `vault_key(vaultId, userId)` + owner/admin | ✅ |
| `vault.convertType` | Protected | `vaultId`, `targetType`, `personalEncryptedVaultKey?` | `vault_key(vaultId, userId)` with owner role required | ✅ |
| `vault.delete` | Protected | `vaultId`, `clientId?` | `vault_key(vaultId, userId)` with owner role required | ✅ |
| `vault.listItems` | Protected | `vaultId` | `vault_key(vaultId, userId)` required | ✅ |
| `vault.listAllItems` | Protected | None | Vault IDs derived from current user’s `vault_key` rows | ✅ |
| `vault.listAllDeletedItems` | Protected | None | Vault IDs derived from current user’s `vault_key` rows | ✅ |
| `vault.getItem` | Protected | `itemId` | `item.id -> item.vaultId -> vault_key(vaultId, userId)` | ✅ |
| `vault.createItem` | Protected | `vaultId`, item fields | `vault_key(vaultId, userId)` + non-`read-only` | ✅ |
| `vault.bulkImportItems` | Protected | `vaultId`, `items[]` | `vault_key(vaultId, userId)` + non-`read-only` | ✅ |
| `vault.updateItem` | Protected | `itemId`, mutable fields | `item.id -> item.vaultId -> vault_key(vaultId, userId)` + non-`read-only` | ✅ |
| `vault.toggleFavorite` | Protected | `itemId`, `favorite` | `item.id -> item.vaultId -> vault_key(vaultId, userId)` + non-`read-only` | ✅ |
| `vault.deleteItem` | Protected | `itemId`, `clientId?` | `item.id -> item.vaultId -> vault_key(vaultId, userId)` + non-`read-only` | ✅ |
| `vault.listDeletedItems` | Protected | `vaultId` | `vault_key(vaultId, userId)` required | ✅ |
| `vault.restoreItem` | Protected | `itemId`, `clientId?` | `item.id -> item.vaultId -> vault_key(vaultId, userId)` + non-`read-only` | ✅ |
| `vault.moveItem` | Protected | `itemId`, `sourceVaultId`, `targetVaultId`, ciphertext | Requires source `vault_key`; requires target `vault_key` + writable role | ✅ |
| `vault.permanentlyDeleteItem` | Protected | `itemId`, `clientId?` | `item.id -> item.vaultId -> vault_key(vaultId, userId)` + non-`read-only` | ✅ |
| `vault.stats` | Protected | None | Team/user/vaults derived from current session | ✅ |
| `vault.createAttachmentUpload` | Protected | `itemId`, file metadata | `item.id -> item.vaultId -> vault_key(vaultId, userId)` + non-`read-only` | ✅ |
| `vault.createAttachment` | Protected | `itemId`, `storageKey`, metadata | Same as above + signed upload-key validation binds storage key to current user/item | ✅ |
| `vault.listAttachments` | Protected | `itemId` | `item.id -> item.vaultId -> vault_key(vaultId, userId)` | ✅ |
| `vault.getAttachmentDownloadUrl` | Protected | `attachmentId` | `attachment.id -> attachment.vaultId -> vault_key(vaultId, userId)` | ✅ |
| `vault.updateAttachment` | Protected | `attachmentId`, new encrypted name | `attachment.id -> attachment.vaultId -> vault_key(vaultId, userId)` + non-`read-only` | ✅ |
| `vault.deleteAttachment` | Protected | `attachmentId` | `attachment.id -> attachment.vaultId -> vault_key(vaultId, userId)` + owner/admin or uploader-as-member | ✅ |
| `vault.members.list` | Protected | `vaultId` | Requires membership in vault via `vault_key(vaultId, userId)` | ✅ |
| `vault.members.availableTeamMembers` | Protected | `vaultId` | `vault_key(vaultId, userId)` + owner/admin; vault must be team vault | ✅ |
| `vault.members.updateRole` | Protected | `vaultId`, `userId`, `role` | `vault_key(vaultId, userId)` + owner/admin; target membership checked in same vault | ✅ |
| `vault.members.remove` | Protected | `vaultId`, `userId`, `keyRotation`, `clientId?` | `vault_key(vaultId, userId)` + owner/admin; target membership checked in same vault | ✅ |
| `vault.members.getRotationData` | Protected | `vaultId`, `excludeUserId` | `vault_key(vaultId, userId)` + owner/admin | ✅ |
| `vault.members.lookupUser` | Protected | `email` | Only entitlement check; no team/vault scoping before returning arbitrary account metadata/public key | ❌ |
| `vault.members.add` | Protected | `vaultId`, `userId`, `role`, `encryptedVaultKey`, `clientId?` | `vault_key(vaultId, userId)` + owner/admin; vault must be team vault; target user must be in same team | ✅ |

### Share Router

| Procedure | Auth | Inputs | Ownership / authorization check | Status |
| --- | --- | --- | --- | --- |
| `share.create` | Protected | `itemId`, share config, encrypted snapshot | `item.id -> item.vaultId -> vault_key(vaultId, userId)` + non-`read-only` | ✅ |
| `share.listByItem` | Protected | `itemId` | `item.id -> item.vaultId -> vault_key(vaultId, userId)`; owner/admin see all, others only own links | ✅ |
| `share.get` | Protected | `linkId` | `link.id -> item.vaultId -> any vault membership`; no creator/admin restriction on token/email visibility | ❌ |
| `share.revoke` | Protected | `linkId` | `link.id -> item.vaultId -> vault_key(vaultId, userId)` + creator/admin/owner rules | ✅ |
| `share.update` | Protected | `linkId`, mutable fields | `link.id -> item.vaultId -> vault_key(vaultId, userId)` + creator/admin/owner rules | ✅ |
| `share.getAccessLogs` | Protected | `linkId` | `link.id -> item.vaultId -> any vault membership`; no creator/admin restriction on log visibility | ❌ |
| `share.getPublicInfo` | Public | `token` | Public share-link landing data | ✅ |
| `share.requestEmailVerification` | Public | `token`, `email` | Token-bound public share flow | ✅ |
| `share.verifyEmailAndAccess` | Public | `token`, `email`, `code` | Token-bound public share flow | ✅ |
| `share.accessPublic` | Public | `token` | Token-bound public share flow | ✅ |

### Sync Router

| Procedure | Auth | Inputs | Ownership / authorization check | Status |
| --- | --- | --- | --- | --- |
| `sync.getEventsSince` | Protected | `sinceSeq`, `vaultIds?`, `limit` | Vault IDs derived/intersected from current user’s `vault_key` rows; control events filtered by `sync_event.userId` | ✅ |
| `sync.bootstrapItems` | Protected | `cursor?`, `limit` | Vaults derived from current user’s `vault_key` rows | ✅ |
| `sync.getSyncState` | Protected | `vaultIds[]` | Intersects requested vault IDs with current user’s `vault_key` rows | ✅ |
| `sync.acknowledgeEvents` | Protected | `eventIds[]`, `clientId` | Loads by event ID, then filters to accessible vaults before writing acks | ✅ |
| `sync.getLastAcknowledged` | Protected | `clientId` | `sync_event_ack.userId = ctx.session.userId` | ✅ |
| `sync.checkConflict` | Protected | `itemId`, `expectedVersion` | Looks up sync event by `entityId` before vault scoping; unauthorized existing items are distinguishable from nonexistent ones | ⚠️ |

## 3. Findings

### Finding 1 — Public CDN proxy bypasses attachment authorization and survives membership revocation

- Severity: Critical
- Resolution (2026-08-12): The private-object authorization fix remains required at the download
  seam, while the revocation half is now addressed cryptographically. Every Attachment has a
  random Attachment key; bytes, filename, and content type use that key, and only its authenticated
  envelope is wrapped under the Vault key. Member departure and Vault Member removal atomically
  rotate the Vault key and rewrap those envelopes, so a former Member's old Vault key cannot open
  current Attachment keys without rewriting object-storage blobs.
- Location:
  - `apps/server/src/index.ts:56-84`
  - `packages/api/src/routers/vault.ts:1924-1958`
  - `packages/api/src/routers/vault.ts:2355-2657`
  - `packages/api/src/routers/team.ts:802-1129`
  - `packages/db/src/schema/vault.ts:172-199`
- Description:
  - The `/cdn/*` endpoint accepts any storage key, creates a server-side presigned download, fetches the object, and streams it back without authentication or authorization checks.
  - Attachment objects live in the same storage namespace as public-looking assets and are keyed by `item_attachment.storageKey`.
  - Authorized users can retrieve those storage keys through `vault.listAttachments`.
  - When vault/team membership is revoked, the server rotates item ciphertext but does not rotate attachment object keys or attachment blob ciphertext.
  - Result: a former member who previously learned an attachment `storageKey` can continue downloading that object after their vault access has been revoked.
- Attack scenario:
  1. User A and User B share a vault that contains attachments.
  2. While still authorized, User B calls `vault.listAttachments` and records each attachment `storageKey`.
  3. User A removes User B from the vault or team.
  4. User B requests `GET /cdn/<recorded-storageKey>`.
  5. The server proxies the object without re-checking vault membership and returns the encrypted blob.
  6. Because attachment blobs are not rotated during member removal, User B can retain ongoing access to data that should have become inaccessible.
- Recommended fix:
  - Do not serve private attachment objects through unauthenticated `/cdn/*`.
  - Split storage into public and private namespaces. Team/vault avatars may stay public if desired, but `attachments/` keys should be denied at `/cdn/*`.
  - Force all attachment reads through `vault.getAttachmentDownloadUrl`, which already checks vault membership.
  - On vault-key rotation/removal, either rotate attachment object keys and ciphertext too, or encrypt attachments under per-attachment keys that can be rewrapped/revoked cleanly.

```ts
// Direction: fail closed for private prefixes
app.get("/cdn/*", async (c) => {
  const key = c.req.path.replace(/^\/cdn\//, "");
  if (key.startsWith("attachments/")) {
    return c.text("Not Found", 404);
  }
  // only allow explicitly public prefixes here
});
```

### Finding 2 — Any team member can steal pending invitation tokens and claim invited roles

- Severity: High
- Location:
  - `packages/api/src/routers/team.ts:1274-1311`
  - `packages/api/src/routers/auth.ts:328-419`
- Description:
  - `team.invitations.list` is available to any authenticated team member. It returns pending invitation `token`, invitee `email`, and invited `role`.
  - `auth.signupWithInvitation` treats the invitation token as the only bearer credential. It checks only that the supplied email string matches the invitation email; it does not verify mailbox ownership.
  - Combined, a regular team member can read a pending invite intended for someone else and immediately create a new account that consumes that invite, including an `admin` invite.
- Attack scenario:
  1. A team owner invites `alice@example.com` as `admin`.
  2. A normal team member calls `team.invitations.list({ teamId })`.
  3. The response includes Alice’s invite `token`, `email`, and `role`.
  4. The attacker calls `auth.signupWithInvitation` using that token and the plaintext email `alice@example.com`, plus attacker-controlled cryptographic material.
  5. The server accepts the signup because the email string matches the invitation and the invitation is still pending.
  6. The attacker now holds the invited role and any pending vault grants intended for Alice.
- Recommended fix:
  - Restrict `team.invitations.list` to team owner/admin only.
  - Do not return raw invitation tokens from administrative list endpoints after creation; treat them like bearer secrets.
  - For invited signup, require proof that the registrant controls the invited email address before consuming the invitation.

```ts
// Minimum server-side hardening
if (!["owner", "admin"].includes(userData.role)) {
  throw new TRPCError({ code: "FORBIDDEN", message: "Insufficient permissions" });
}

// Better: invitation claim should require verified email possession
// before update(user).set({ teamId: invitation.teamId, role: invitation.role })
```

### Finding 3 — Team rotation routes bypass vault-level ACLs and expose encrypted data across vault boundaries

- Severity: High
- Location:
  - `packages/api/src/routers/team.ts:624-676`
  - `packages/api/src/routers/team.ts:719-789`
  - `packages/api/src/routers/team.ts:802-1129`
- Description:
  - `team.getLeaveRotationData` returns every team vault’s members and encrypted items to any team member leaving the team; it does not restrict results to vaults that member currently belongs to.
  - `team.members.getTeamRotationData` returns every team vault’s members and encrypted items to any team owner/admin, even if that actor has no `vault_key` row for some of those vaults.
  - `team.members.remove` likewise mutates vault membership and key-rotation state across all team vaults based on team role alone, without checking per-vault admin/owner access.
  - Bittery’s data model clearly distinguishes team role from vault role. These routes effectively grant broader vault authority than the rest of the API.
- Attack scenario:
  1. User A is a regular member of Team T but belongs to only one shared vault inside T.
  2. Before leaving, User A calls `team.getLeaveRotationData({ teamId: T })`.
  3. The server returns ciphertext, item IDs, and member public keys for all team vaults, including vaults User A never joined.
  4. Separately, a team admin who is not a member of Vault X calls `team.members.getTeamRotationData` or `team.members.remove`.
  5. The server exposes Vault X ciphertext and permits rotation/removal operations against Vault X even though the admin lacks vault-level membership.
- Recommended fix:
  - Filter team-vault rotation routes through `vault_key.userId = ctx.session.userId` unless Bittery intentionally defines team admins as implicit admins of every team vault.
  - If team admins are meant to have global vault authority, encode that invariant explicitly in the authorization model and documentation rather than bypassing vault ACLs only in a few routes.
  - For leaving users, return rotation data only for vaults the leaving user currently belongs to.

```ts
const accessibleVaults = await db.query.vaultKey.findMany({
  where: (vk, { and, eq, inArray }) =>
    and(eq(vk.userId, ctx.session.userId), inArray(vk.vaultId, teamVaultIds)),
  columns: { vaultId: true },
});

const allowedVaultIds = new Set(accessibleVaults.map((vk) => vk.vaultId));
const filteredTeamVaults = teamVaults.filter((v) => allowedVaultIds.has(v.id));
```

### Finding 4 — Share management metadata is exposed too broadly inside shared vaults

- Severity: Medium
- Location:
  - `packages/api/src/routers/share.ts:283-295`
  - `packages/api/src/routers/share.ts:336-390`
  - `packages/api/src/routers/share.ts:607-656`
- Description:
  - `share.listByItem` implements a narrow visibility model: owners/admins see all links, while regular members see only links they created.
  - `share.get` and `share.getAccessLogs` do not enforce that same rule. They allow any vault member with basic vault access to read:
    - the share token,
    - allowed recipient emails,
    - access logs containing visitor emails, IP addresses, and user agents.
  - This is inconsistent with the rest of the share-management model and overexposes sensitive sharing metadata.
- Attack scenario:
  1. User A and User B share a vault; User A creates a share link.
  2. User B obtains the link ID from local logs, cached client state, or another internal reference.
  3. User B calls `share.get({ linkId })` and retrieves the token and allowed email list despite not being the creator/admin.
  4. User B calls `share.getAccessLogs({ linkId })` and retrieves access telemetry for a link they do not manage.
- Recommended fix:
  - Apply the same visibility rule used by `share.listByItem` to `share.get` and `share.getAccessLogs`.
  - For non-owner/admin members, restrict access to links where `link.createdById === ctx.session.userId`.
  - Consider returning `NOT_FOUND` rather than `FORBIDDEN` for foreign share links.

```ts
const canSeeLink =
  userVaultKey.role === "owner" ||
  userVaultKey.role === "admin" ||
  link.createdById === ctx.session.userId;

if (!canSeeLink) {
  throw new TRPCError({ code: "NOT_FOUND", message: "Share link not found" });
}
```

### Finding 5 — `sync.checkConflict` leaks foreign item existence through differential responses

- Severity: Medium
- Location:
  - `packages/api/src/routers/sync.ts:333-360`
- Description:
  - The route first looks up the latest sync event by `entityId = input.itemId` without any ownership filter.
  - If no event exists, it returns `{ hasConflict: false }`.
  - If an event exists for another user’s vault, it then performs a vault-membership check and throws `FORBIDDEN`.
  - This makes “existing but foreign” item IDs distinguishable from nonexistent item IDs.
- Attack scenario:
  1. User A learns or guesses an `itemId` used by User B.
  2. User A calls `sync.checkConflict({ itemId, expectedVersion: 1 })`.
  3. If the item never existed, the server returns `{ hasConflict: false }`.
  4. If the item exists in another user’s vault, the server returns `FORBIDDEN`.
  5. User A now has an item-existence oracle across tenant boundaries.
- Recommended fix:
  - Scope the initial lookup through the caller’s accessible vaults before deciding whether the item exists.
  - Return the same outward result for “not found” and “not owned”; `NOT_FOUND` is preferable for IDOR resistance.

```ts
const userVaultIds = await db.query.vaultKey.findMany({
  where: eq(vaultKey.userId, ctx.session.userId),
  columns: { vaultId: true },
});

const latestItemEvent = await db.query.syncEvent.findFirst({
  where: and(
    eq(syncEvent.entityId, input.itemId),
    eq(syncEvent.entityType, "item"),
    inArray(syncEvent.vaultId, userVaultIds.map((vk) => vk.vaultId)),
  ),
});
```

### Finding 6 — `vault.members.lookupUser` allows cross-tenant account enumeration and public-key harvesting

- Severity: Low
- Location:
  - `packages/api/src/routers/vault.ts:2741-2778`
- Description:
  - This route requires only the `vault_sharing` entitlement.
  - It does not require a `vaultId`, a `teamId`, or any proof that the looked-up account is in the caller’s team or otherwise eligible for sharing.
  - Any paid user can therefore test arbitrary email addresses and retrieve another Bittery account’s `id`, `name`, `email`, and `publicKey`.
- Attack scenario:
  1. A malicious paid user prepares a list of candidate email addresses.
  2. They call `vault.members.lookupUser` for each address.
  3. Existing accounts return canonical identity data and public keys; missing accounts return `NOT_FOUND`.
  4. The attacker builds a cross-tenant directory of Bittery users for phishing, social graphing, or future misuse.
- Recommended fix:
  - Require a concrete sharing context such as `vaultId` or `teamId`.
  - Restrict lookups to members of the same team as the caller, or to the result set already produced by `vault.members.availableTeamMembers`.
  - Return `NOT_FOUND` for addresses outside the caller’s allowed sharing scope.

## 4. Positive Findings

- Protected tRPC procedures do run authentication before handler logic.
  - `packages/api/src/index.ts:10-24`
  - `apps/server/src/index.ts:86-97`
  - `packages/api/src/context.ts:14-48`
- The main vault/item CRUD surface is consistently scoped through `vault_key` ownership.
  - Examples:
    - `packages/api/src/routers/vault.ts:99-141`
    - `packages/api/src/routers/vault.ts:769-803`
    - `packages/api/src/routers/vault.ts:963-1045`
    - `packages/api/src/routers/vault.ts:1184-1270`
    - `packages/api/src/routers/vault.ts:1535-1668`
- Session/device-management routes correctly scope `sessionId` operations to the authenticated user through helper functions in `@bittery/auth`.
  - `packages/api/src/routers/auth.ts:1281-1346`
  - `packages/auth/src/index.ts:948-1003`
- Billing and audit routes derive the target team from `ctx.session.userId` rather than trusting arbitrary caller-supplied team IDs.
  - `packages/api/src/routers/billing.ts:41-64`
  - `packages/api/src/routers/audit.ts:225-318`
- Sync fetch/SSE delivery is mostly membership-scoped.
  - `packages/api/src/routers/sync.ts:37-124`
  - `packages/api/src/routers/sync.ts:131-240`
  - `apps/server/src/sync/sse-handler.ts:167-174`
  - `apps/server/src/sync/sse-handler.ts:211-365`
  - `apps/server/src/sync/sse-handler.ts:427-562`
- Invitation-time vault grants are constrained to vaults inside the invited team and only vaults the inviter/admin actually administers.
  - `packages/api/src/utils/pending-vault-keys.ts:81-128`
  - `packages/api/src/routers/team.ts:1418-1425`
  - `packages/api/src/routers/auth.ts:394-399`
- Attachment upload keys are signed and bound to `userId + itemId + expiry`, which is good defense in depth on the upload path.
  - `packages/api/src/storage/s3.ts:111-154`

## 5. Open Questions

1. Is a team `owner`/`admin` intended to be an implicit administrator of every team vault, even without a `vault_key` row? If yes, that authority should be encoded consistently across the product; if no, Finding 3 is a clear privilege-escalation bug.
2. Are `/cdn/*` and `BITTERY_STORAGE_PUBLIC_URL` intended only for public avatar assets? If so, private attachment objects need a separate non-public namespace immediately.
3. Do you want foreign-resource requests to be fully non-enumerating (`404` for both not-found and not-owned)? Current code frequently returns `403` or generic `Error`, so the API does not currently enforce that policy consistently.

## 6. Cross-References

- Phase 2 confirmed that server sessions are opaque bearer tokens hashed server-side and resolved into `ctx.session.userId` in `createContext`. That means the issues in this phase are not token-forgery problems; they are post-auth authorization mistakes.
  - `docs/security-audit/phase-2-authentication-session-security.md`, Positive Findings section
- Phase 2 Finding 4 covered account enumeration on auth endpoints. The `sync.checkConflict` issue in this phase is the same class of problem applied to resource identifiers rather than emails.
  - `docs/security-audit/phase-2-authentication-session-security.md:124-145`
- Phase 1 Findings 1-3 increase the impact of the team-rotation and attachment findings here: encrypted vault data, wrapped vault keys, and rotation outputs are security-critical objects, so exposing or mutating them outside the intended ACL is still high impact even in a zero-knowledge design.
  - `docs/security-audit/phase-1-cryptographic-review.md:19-105`
