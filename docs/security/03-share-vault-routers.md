# Plan 03: Share & Vault Routers

**Scope:** `packages/api/src/routers/share.ts`, `packages/api/src/routers/vault.ts`
**Findings:** 7 (1 High, 6 Medium)

---

## #13 — HIGH: Console Logging of Verification Codes

**File:** `packages/api/src/routers/share.ts:656`

**Problem:** Verification codes are logged in plaintext to server output. If server logs are compromised, collected by a logging service, or visible to ops personnel, all verification codes are exposed.

```typescript
// CURRENT — plaintext code in logs
console.log(`[SHARE] Verification code for ${normalizedEmail}: ${code}`);
```

**Fix:** Remove the line entirely. When an email service is integrated, send the code via email instead.

```typescript
// REMOVED: console.log of verification code

// TODO: Send via email service
// await emailService.sendVerificationCode(normalizedEmail, code);
```

**Testing:** Verify share email verification flow still works. Confirm server logs no longer contain verification codes.

---

## #15 — MEDIUM: Share Link Non-Atomic Access Counting

**File:** `packages/api/src/routers/share.ts:803-913`

**Problem:** The access count check and increment are separate operations. For one-time use links (`maxAccessCount: 1`), two concurrent requests can both read `accessCount: 0`, both pass the check, and both access the shared data before either increments the counter.

```typescript
// CURRENT — read-then-write race condition
// Step 1: Read link (includes accessCount)
const link = await db.query.shareLink.findFirst({ ... });

// Step 2: Check if under limit
if (link.maxAccessCount && link.accessCount >= link.maxAccessCount) {
    throw new TRPCError({ code: "GONE", message: "Link has expired" });
}

// Step 3: Increment (race window between step 1 and here)
await db.update(shareLink).set({
    accessCount: link.accessCount + 1,
    // ...
}).where(eq(shareLink.id, link.id));
```

**Fix:** Use an atomic SQL `UPDATE ... SET accessCount = accessCount + 1 WHERE accessCount < maxAccessCount` and check the affected row count.

```typescript
// Atomic access count increment with limit check
const result = await db
    .update(shareLink)
    .set({
        accessCount: sql`${shareLink.accessCount} + 1`,
        lastAccessedAt: now,
        status: sql`CASE
            WHEN ${shareLink.maxAccessCount} IS NOT NULL
                AND ${shareLink.accessCount} + 1 >= ${shareLink.maxAccessCount}
            THEN 'exhausted'
            ELSE ${shareLink.status}
        END`,
    })
    .where(
        and(
            eq(shareLink.id, link.id),
            eq(shareLink.status, "active"),
            or(
                isNull(shareLink.maxAccessCount),
                sql`${shareLink.accessCount} < ${shareLink.maxAccessCount}`,
            ),
        ),
    )
    .returning({ id: shareLink.id });

if (result.length === 0) {
    throw new TRPCError({
        code: "GONE",
        message: "This link has already been used or has expired",
    });
}
```

Apply the same pattern to both `verifyEmailAndAccess` and `accessPublic` procedures.

**Testing:** Write a concurrent access test: fire 10 simultaneous requests at a one-time link, verify only 1 succeeds.

---

## #16 — MEDIUM: Share Rate Limit Check-Then-Increment Race Condition

**File:** `packages/api/src/routers/share.ts:934-987`

**Problem:** The rate limit check reads `linksCreatedToday`, checks if under limit, then increments. Two concurrent share-creation requests can both pass the check.

```typescript
// CURRENT — non-atomic rate limit
const rateLimit = await db.query.shareLinkRateLimit.findFirst({ ... });
// Check if under limit
const remaining = rateLimit.dailyLimit - rateLimit.linksCreatedToday;
if (remaining <= 0) throw ...;
// Increment later (race window)
```

**Fix:** Use atomic increment with a check in the WHERE clause.

```typescript
async function checkAndIncrementRateLimit(userId: string): Promise<void> {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Try atomic increment: UPDATE ... SET count = count + 1 WHERE count < limit
    const result = await db
        .update(shareLinkRateLimit)
        .set({
            linksCreatedToday: sql`${shareLinkRateLimit.linksCreatedToday} + 1`,
            lastResetAt: sql`CASE
                WHEN ${shareLinkRateLimit.lastResetAt} < ${todayStart}
                THEN ${todayStart}
                ELSE ${shareLinkRateLimit.lastResetAt}
            END`,
        })
        .where(
            and(
                eq(shareLinkRateLimit.userId, userId),
                or(
                    // New day: reset count (always allow)
                    sql`${shareLinkRateLimit.lastResetAt} < ${todayStart}`,
                    // Same day: check limit
                    sql`${shareLinkRateLimit.linksCreatedToday} < ${shareLinkRateLimit.dailyLimit}`,
                ),
            ),
        )
        .returning({ id: shareLinkRateLimit.id });

    if (result.length === 0) {
        throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: "Daily share link limit reached",
        });
    }
}
```

**Testing:** Concurrent share creation test: verify limit is enforced correctly under load.

---

## #25 — MEDIUM: No Audit Logging for Sensitive Operations

**File:** All routers (`auth.ts`, `vault.ts`, `share.ts`)

**Problem:** Password changes, key rotation, account deletion, vault member changes, and device revocation have no audit trail. If an account is compromised, there's no way to determine what actions the attacker took.

**Fix:** Create an audit log table and log sensitive operations.

```typescript
// New table in packages/db/src/schema/auth.ts
export const auditLog = pgTable("audit_log", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => user.id),
    action: text("action").notNull(), // e.g., "password_changed", "key_rotated"
    entityType: text("entity_type"), // "vault", "session", "share_link"
    entityId: text("entity_id"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata"), // Additional context
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

Operations to log:
- `changePassword` — auth.ts
- `regenerateSecretKey` — auth.ts
- `deleteAccount` — auth.ts
- `revokeDevice` / `logoutAll` — auth.ts
- `vault.delete` — vault.ts
- `vault.member.remove` (key rotation) — vault.ts
- `vault.member.add` — vault.ts
- `share.create` / `share.revoke` — share.ts
- `share.access` (successful access) — share.ts (already has `shareAccessLog`)

```typescript
// Helper function
async function logAudit(
    userId: string,
    action: string,
    device: DeviceContext,
    metadata?: Record<string, unknown>,
    entityType?: string,
    entityId?: string,
) {
    await db.insert(auditLog).values({
        id: nanoid(),
        userId,
        action,
        entityType,
        entityId,
        ipAddress: device.ipAddress,
        userAgent: device.userAgent,
        metadata,
    });
}
```

**Testing:** Verify audit logs are created for each operation. Verify no sensitive data (keys, passwords) is stored in audit metadata.

---

## #26 — MEDIUM: Share IDOR — Admin Can Revoke Owner's Links

**File:** `packages/api/src/routers/share.ts:347`

**Problem:** The revoke permission check allows admins to revoke links created by vault owners. The `listByItem` endpoint allows members to view all share links for an item, including links they don't own.

```typescript
// CURRENT — admin can revoke owner's links
if (
    userVaultKey.role === "read-only" ||
    (userVaultKey.role === "member" && link.createdById !== ctx.session.userId)
) {
    throw new TRPCError({ code: "FORBIDDEN", ... });
}
// Admins pass through and can revoke owner's links
```

**Fix:** Add an explicit check that admins cannot revoke owner-created links.

```typescript
// Only owner can revoke owner's links; admins can revoke admin/member links
const linkCreator = await db.query.vaultKey.findFirst({
    where: (vk, { and, eq }) =>
        and(eq(vk.vaultId, link.vaultId), eq(vk.userId, link.createdById)),
});

if (
    userVaultKey.role === "read-only" ||
    (userVaultKey.role === "member" && link.createdById !== ctx.session.userId) ||
    (userVaultKey.role === "admin" && linkCreator?.role === "owner")
) {
    throw new TRPCError({
        code: "FORBIDDEN",
        message: "You do not have permission to revoke this link",
    });
}
```

For `listByItem`, filter results based on role — members should only see their own links:

```typescript
// In listByItem, filter by ownership for non-owner/admin
if (userVaultKey.role === "member" || userVaultKey.role === "read-only") {
    links = links.filter((l) => l.createdById === ctx.session.userId);
}
```

**Testing:** Test matrix: owner revokes own link (pass), admin revokes member link (pass), admin revokes owner link (fail), member revokes own link (pass), member revokes other's link (fail).

---

## #28 — MEDIUM: Unlimited Verification Codes per Email

**File:** `packages/api/src/routers/share.ts:618-661`

**Problem:** While individual codes have a 5-attempt limit and 1-minute cooldown between codes, there's no limit on how many total codes can be requested per email/share link. An attacker can request unlimited codes, each with a new 5-attempt window, effectively giving unlimited brute-force attempts on the 6-digit code.

**Fix:** Limit total verification code requests per email per share link.

```typescript
// Count total codes generated for this email/link combination
const totalCodes = await db
    .select({ count: sql<number>`count(*)` })
    .from(shareEmailVerification)
    .where(
        and(
            eq(shareEmailVerification.shareLinkId, link.id),
            eq(shareEmailVerification.email, normalizedEmail),
        ),
    );

const MAX_CODES_PER_EMAIL = 5;
if (totalCodes[0].count >= MAX_CODES_PER_EMAIL) {
    throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "Too many verification attempts for this email. Contact the link creator.",
    });
}
```

**Testing:** Request 6 codes for the same email/link — verify the 6th is rejected.

---

## #29 — MEDIUM: Key Rotation Not Transactional

**File:** `packages/api/src/routers/vault.ts:1367-1473`

**Problem:** Key rotation performs multiple database operations (delete old key, update member keys, re-encrypt items, update vault version) without a transaction. If any operation fails midway, the vault is left in an inconsistent state: some items encrypted with the new key, some with the old, and member keys may be mismatched.

```typescript
// CURRENT — sequential operations without transaction
await db.delete(vaultKey).where(...);           // Step 1
for (const memberKey of ...) {
    await db.update(vaultKey).set(...);         // Step 2 (per member)
}
for (const reEncryptedItem of ...) {
    await db.update(item).set(...);             // Step 3 (per item)
}
await db.update(vault).set({ keyVersion });     // Step 4
await db.update(vaultKeyRotation).set(...);     // Step 5
```

**Fix:** Wrap all operations in a Drizzle transaction.

```typescript
try {
    await db.transaction(async (tx) => {
        // Delete the removed user's vault key
        await tx.delete(vaultKey).where(
            and(eq(vaultKey.vaultId, input.vaultId), eq(vaultKey.userId, input.userId)),
        );

        // Update vault keys for all remaining members
        for (const memberKey of input.keyRotation.memberKeys) {
            await tx.update(vaultKey)
                .set({ encryptedVaultKey: memberKey.encryptedVaultKey })
                .where(
                    and(
                        eq(vaultKey.vaultId, input.vaultId),
                        eq(vaultKey.userId, memberKey.userId),
                    ),
                );
        }

        // Re-encrypt all items with new vault key
        for (const reEncryptedItem of input.keyRotation.reEncryptedItems) {
            await tx.update(item)
                .set({
                    encryptedData: reEncryptedItem.encryptedData,
                    encryptionIv: reEncryptedItem.encryptionIv,
                    updatedAt: new Date(),
                })
                .where(eq(item.id, reEncryptedItem.itemId));
        }

        // Update vault key version
        await tx.update(vault)
            .set({ keyVersion: newKeyVersion, updatedAt: new Date() })
            .where(eq(vault.id, input.vaultId));

        // Mark rotation as completed
        await tx.update(vaultKeyRotation)
            .set({ status: "completed", completedAt: new Date() })
            .where(eq(vaultKeyRotation.id, rotationId));
    });

    // Emit sync events (outside transaction — OK to fail independently)
    await emitSyncEvent({ eventType: "vault_member_removed", ... });
    await emitSyncEvent({ eventType: "vault_key_rotated", ... });

} catch (error) {
    // Transaction rolled back automatically — mark rotation as failed
    await db.update(vaultKeyRotation)
        .set({
            status: "failed",
            errorMessage: error instanceof Error ? error.message : "Unknown error",
        })
        .where(eq(vaultKeyRotation.id, rotationId));

    throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Key rotation failed. Please try again.",
    });
}
```

**Testing:** Simulate a failure mid-rotation (e.g., invalid item ID). Verify all changes are rolled back and the vault remains in its pre-rotation state.

---

## Implementation Order

1. **#13** (remove console.log) — immediate, one-line fix
2. **#15** (atomic access counting) — standalone SQL change
3. **#16** (atomic rate limit) — similar pattern to #15
4. **#28** (limit verification codes) — standalone, additive check
5. **#26** (share IDOR) — permission logic change
6. **#29** (transactional key rotation) — wrapping existing code
7. **#25** (audit logging) — new table + migration + logging calls across all routers
