# Plan 02: Auth Package & Auth Router

**Scope:** `packages/auth/src/index.ts`, `packages/api/src/routers/auth.ts`
**Findings:** 9 (2 Critical, 2 High, 4 Medium, 1 Low)

---

## #1 — CRITICAL: Hardcoded JWT Secret Fallback

**File:** `packages/auth/src/index.ts:27-29`

**Problem:** The JWT secret falls back to a hardcoded string if the environment variable is not set. Any attacker who knows this string (it's in the source code) can forge valid JWTs for any user.

```typescript
// CURRENT — hardcoded fallback
const JWT_SECRET = new TextEncoder().encode(
    process.env.JWT_SECRET || "bittery-secret-change-in-production",
);
```

**Fix:** Throw at module load time if `JWT_SECRET` is not set. Optionally enforce minimum length.

```typescript
const jwtSecretRaw = process.env.JWT_SECRET;
if (!jwtSecretRaw) {
    throw new Error(
        "FATAL: JWT_SECRET environment variable is not set. " +
        "The server cannot start without a secure JWT secret."
    );
}
if (jwtSecretRaw.length < 32) {
    throw new Error(
        "FATAL: JWT_SECRET must be at least 32 characters for adequate security."
    );
}
const JWT_SECRET = new TextEncoder().encode(jwtSecretRaw);
```

**Testing:** Verify server fails to start without `JWT_SECRET` set. Verify existing tokens still validate with the same secret. Update CI/CD to ensure the env var is always set.

---

## #4 — CRITICAL: Unauthenticated Logout Endpoints (DoS)

**File:** `packages/api/src/routers/auth.ts:576-599`

**Problem:** Both `logout` and `logoutAll` are `publicProcedure`. Any attacker can force-logout any user by guessing/enumerating session IDs or user IDs.

```typescript
// CURRENT — unauthenticated
logout: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ input }) => {
        await deleteSession(input.sessionId);
        return { success: true };
    }),

logoutAll: publicProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ input }) => {
        await deleteAllUserSessions(input.userId);
        return { success: true };
    }),
```

**Fix:** Make both `protectedProcedure` and verify ownership.

```typescript
logout: protectedProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
        // Verify the session belongs to the authenticated user
        const targetSession = await getSession(input.sessionId);
        if (!targetSession || targetSession.userId !== ctx.session.userId) {
            throw new TRPCError({
                code: "NOT_FOUND",
                message: "Session not found",
            });
        }
        await deleteSession(input.sessionId);
        return { success: true };
    }),

logoutAll: protectedProcedure
    .mutation(async ({ ctx }) => {
        // Only allow logging out own sessions
        await deleteAllUserSessions(ctx.session.userId);
        return { success: true };
    }),
```

**Client-side impact:** All apps (web, desktop, extension, mobile) must update their logout calls to include the auth token. `logoutAll` no longer needs a `userId` input since it uses `ctx.session.userId`.

**Testing:** Verify authenticated logout works. Verify unauthenticated logout returns 401. Test that user A cannot logout user B's sessions.

---

## #7 — HIGH: User Enumeration via checkEmail

**File:** `packages/api/src/routers/auth.ts:527-539`

**Problem:** Returns `{ exists: true/false, secretKeyHint }` for any email, allowing attackers to enumerate registered users and harvest secret key hints.

```typescript
// CURRENT — reveals user existence
checkEmail: publicProcedure
    .input(z.object({ email: z.string().email() }))
    .query(async ({ input }) => {
        const user = await getUserByEmail(input.email);
        return {
            exists: !!user,
            secretKeyHint: user?.secretKeyHint || null,
        };
    }),
```

**Fix:** Always return a consistent response regardless of whether the user exists. Generate a fake hint for non-existent users to prevent timing-based enumeration.

```typescript
checkEmail: publicProcedure
    .input(z.object({ email: z.string().email() }))
    .query(async ({ input }) => {
        const user = await getUserByEmail(input.email);

        if (!user) {
            // Return a deterministic fake hint to prevent enumeration
            // Use HMAC of email with a server-side key for consistency
            return {
                exists: true, // Always say exists
                secretKeyHint: generateDeterministicFakeHint(input.email),
            };
        }

        return {
            exists: true,
            secretKeyHint: user.secretKeyHint || null,
        };
    }),
```

Alternative: Require a rate-limited proof-of-work or CAPTCHA before returning results.

**Testing:** Verify login flow still works. Verify response shape is identical for existing and non-existing emails. Verify response time is similar for both cases.

---

## #8 — HIGH: No Rate Limiting on SRP Login

**File:** `packages/api/src/routers/auth.ts:338-522`

**Problem:** `startLogin`, `finishLogin`, and `quickUnlock` have no rate limiting. An attacker can make unlimited brute-force attempts against any account.

**Fix:** Implement per-(email, IP) rate limiting with exponential backoff and account lockout.

Option A — Database-backed rate limiting:
```typescript
// New table in packages/db/src/schema/auth.ts
export const loginRateLimit = pgTable("login_rate_limit", {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    ipAddress: text("ip_address"),
    attempts: integer("attempts").default(0).notNull(),
    lastAttemptAt: timestamp("last_attempt_at").notNull(),
    lockedUntil: timestamp("locked_until"),
});

// Rate limit check in startLogin
async function checkLoginRateLimit(email: string, ip: string | null) {
    const limit = await db.query.loginRateLimit.findFirst({
        where: (rl, { and, eq }) =>
            and(eq(rl.email, email.toLowerCase()), eq(rl.ipAddress, ip ?? "")),
    });

    if (limit?.lockedUntil && limit.lockedUntil > new Date()) {
        throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: "Too many login attempts. Please try again later.",
        });
    }

    // After 5 failed attempts: lock for 2^(attempts-5) minutes, max 30 min
    if (limit && limit.attempts >= 5) {
        const lockMinutes = Math.min(30, Math.pow(2, limit.attempts - 5));
        // Update lock
        await db.update(loginRateLimit).set({
            lockedUntil: new Date(Date.now() + lockMinutes * 60 * 1000),
        }).where(eq(loginRateLimit.id, limit.id));

        throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: "Too many login attempts. Please try again later.",
        });
    }
}
```

Option B — Hono middleware with in-memory rate limiting (simpler, but resets on restart):
```typescript
// In the Hono app setup, add rate limiting middleware for auth endpoints
```

**Testing:** Verify rate limiting triggers after threshold. Verify lockout expires. Verify successful login resets the counter.

---

## #18 — MEDIUM: Email Normalization Inconsistency

**File:** Multiple locations in `auth.ts` and `packages/auth/src/index.ts`

**Problem:** `.toLowerCase()` is applied inconsistently across auth flows. Some places normalize email, others don't. This can lead to duplicate accounts or failed lookups for mixed-case emails.

**Fix:** Normalize email at the entry point of every procedure that accepts email input. Create a helper:

```typescript
function normalizeEmail(email: string): string {
    return email.toLowerCase().trim();
}
```

Apply in:
- `startLogin` input
- `finishLogin` (for device tracking)
- `quickUnlock` input
- `checkEmail` input
- `signup` / `signupWithInvitation` input
- `changePassword` input
- Key derivation salt (already done in Rust via `email.to_lowercase()`)

**Testing:** Verify login works with mixed-case email variants.

---

## #24 — MEDIUM: No Input Length Validation on SRP Parameters

**File:** `packages/api/src/routers/auth.ts`

**Problem:** SRP parameters (`clientPublicKey`, `clientProof`, `serverSecret`) have no length constraints. An attacker could send extremely large hex strings to cause memory exhaustion or DoS.

**Fix:** Add `.max()` constraints to Zod schemas:

```typescript
startLogin: publicProcedure
    .input(z.object({
        email: z.string().email().max(255),
        clientPublicKey: z.string().max(2048), // SRP-4096 public key hex
    }))

finishLogin: publicProcedure
    .input(z.object({
        userId: z.string().max(64),
        serverSecret: z.string().max(2048),
        clientPublicKey: z.string().max(2048),
        clientProof: z.string().max(512),
    }))
```

Apply similar constraints to `quickUnlock` and all vault/share router inputs that accept encrypted data.

**Testing:** Verify normal-length inputs still work. Verify oversized inputs are rejected with a 400 error.

---

## #30 — MEDIUM: Session Tokens Stored in Plaintext in Database

**File:** `packages/auth/src/index.ts:153-168`

**Problem:** The SRP session key (`serverSession.key`) is stored directly in the `session.token` column. If the database is compromised, all active session tokens are immediately usable.

```typescript
// CURRENT — plaintext token storage
await db.insert(session).values({
    id: sessionId,
    userId: existingUser.id,
    token: serverSession.key,  // Plaintext!
    expiresAt,
    // ...
});
```

**Fix:** Store a hash of the token. Compare using the hash on verification.

```typescript
import { createHash } from "crypto";

function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

// On session creation
await db.insert(session).values({
    id: sessionId,
    userId: existingUser.id,
    token: hashToken(serverSession.key), // Store hash
    expiresAt,
    // ...
});

// On session verification (verifySession)
const tokenHash = hashToken(token);
const sess = await db.query.session.findFirst({
    where: (s, { eq }) => eq(s.token, tokenHash),
});
```

**Migration:** Existing sessions need to be re-hashed or invalidated. Simplest approach: force all users to re-login (clear session table).

**Testing:** Verify login creates hashed token. Verify session verification works with hashed lookup.

---

## #35 — LOW: Debug console.log(result) in Auth Router

**File:** `packages/api/src/routers/auth.ts:475`

**Problem:** `console.log(result)` logs the entire authentication result object to server logs, including tokens, session IDs, user data, server proofs, and vault keys.

```typescript
// CURRENT — logs sensitive data
const result = await finishLogin(/* ... */);
console.log(result);  // Exposes everything
```

**Fix:** Remove the line entirely.

```typescript
const result = await finishLogin(/* ... */);
// console.log removed
```

**Testing:** Verify quickUnlock still works. Check server logs no longer contain auth result objects.

---

## #36 — LOW: Weak nanoid(32) for Non-SRP Session Keys

**File:** `packages/auth/src/index.ts:289`

**Problem:** Non-SRP session keys use `nanoid(32)` which generates 32 characters from a 64-character alphabet, yielding ~192 bits of entropy. While sufficient for most purposes, session tokens should ideally have at least 256 bits of entropy per OWASP guidelines.

```typescript
// CURRENT
const sessionKey = nanoid(32); // ~192 bits entropy
```

**Fix:** Increase to 43 characters for ~256 bits, or use `crypto.randomBytes`:

```typescript
import { randomBytes } from "crypto";

const sessionKey = randomBytes(32).toString("base64url"); // 256 bits
```

**Testing:** Verify session creation and verification still work with the new format.

---

## Implementation Order

1. **#1** (JWT secret) — immediate, standalone
2. **#35** (remove console.log) — immediate, one-line fix
3. **#4** (protected logout) — requires coordinated client changes
4. **#7** (checkEmail enumeration) — standalone server change
5. **#8** (rate limiting) — requires new DB table + migration
6. **#18** (email normalization) — standalone, low risk
7. **#24** (input validation) — standalone, additive
8. **#30** (hash session tokens) — requires migration strategy
9. **#36** (stronger session keys) — standalone, low risk
