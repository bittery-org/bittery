# Plan 05: Infrastructure & Cross-Cutting Concerns

**Scope:** Architecture-wide, `packages/api/src/context.ts`
**Findings:** 3 (all Low/Informational)

---

## #31 — LOW: IP Header Spoofing

**File:** `packages/api/src/context.ts:26-30`

**Problem:** IP address is extracted from client-provided headers (`X-Forwarded-For`, `X-Real-IP`) which can be spoofed by attackers if the server is directly accessible (not behind a trusted proxy). This IP is used for session tracking, rate limiting (#8), and audit logging (#25).

```typescript
// CURRENT — trusts client-provided headers
const ipAddress =
    context.req.header("CF-Connecting-IP") ||
    context.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
    context.req.header("X-Real-IP") ||
    null;
```

**Fix:** Only trust IP headers from known reverse proxies. The approach depends on the deployment:

**If behind Cloudflare (recommended):**
```typescript
// Only trust CF-Connecting-IP (set by Cloudflare, not spoofable when using Cloudflare)
const ipAddress = context.req.header("CF-Connecting-IP") || null;
```

**If behind a custom reverse proxy:**
```typescript
// Configure trusted proxy IPs
const TRUSTED_PROXIES = new Set(
    (process.env.TRUSTED_PROXY_IPS || "").split(",").filter(Boolean)
);

function getClientIp(context: HonoContext): string | null {
    // If behind Cloudflare
    const cfIp = context.req.header("CF-Connecting-IP");
    if (cfIp) return cfIp;

    // Only trust X-Forwarded-For if request came from a trusted proxy
    // (This requires the framework/runtime to provide the direct connection IP)
    const directIp = context.env?.remoteAddr; // Runtime-specific
    if (directIp && TRUSTED_PROXIES.has(directIp)) {
        const forwardedFor = context.req.header("X-Forwarded-For");
        if (forwardedFor) {
            return forwardedFor.split(",")[0]?.trim() || null;
        }
    }

    return null;
}
```

**Testing:** Test with Cloudflare enabled — verify IP is correctly extracted. Test without proxy — verify spoofed headers are not trusted.

---

## #34 — LOW: No Encrypted Data Versioning

**File:** Architecture-wide

**Problem:** There's no version marker on encrypted data, key derivation parameters, or crypto algorithms. If the crypto implementation changes (e.g., PBKDF2 iterations, key derivation method, encryption algorithm), there's no way to know which version was used to encrypt existing data, making migration impossible without breaking all existing data.

This is a **prerequisite** for:
- **#10** (changing key derivation concatenation method)
- **#14** (increasing PBKDF2 iterations)

**Fix:** Add versioning at two levels:

### Level 1: User-level crypto version (key derivation)

Add a `cryptoVersion` column to the user table:

```typescript
// In packages/db/src/schema/auth.ts
// Add to user table:
cryptoVersion: integer("crypto_version").default(1).notNull(),
```

Version semantics:
- `v1`: Current (PBKDF2 100k, pipe-separated concatenation, email salt)
- `v2`: Future (PBKDF2 310k, length-prefixed concatenation)

On login, check `cryptoVersion`:
```typescript
// In packages/auth/src/index.ts (finishLogin)
if (user.cryptoVersion < CURRENT_CRYPTO_VERSION) {
    // After successful login, re-derive with new params and update:
    // 1. SRP verifier + salt
    // 2. All vault keys re-encrypted with new MUK
    // 3. Encrypted private key re-encrypted with new MUK
    // 4. Update user.cryptoVersion
}
```

### Level 2: Item-level encryption metadata

The `encryptionAlgorithm` column on items already exists and stores the algorithm. Ensure it's always populated:

```typescript
// Already exists in schema, just ensure it's consistently used
encryptionAlgorithm: text("encryption_algorithm").default("aes-256-gcm").notNull(),
```

### Level 3: Key derivation parameters in a config table

For maximum flexibility, store derivation parameters per user:

```typescript
export const userCryptoConfig = pgTable("user_crypto_config", {
    userId: text("user_id").primaryKey().references(() => user.id),
    kdfAlgorithm: text("kdf_algorithm").default("pbkdf2-sha256").notNull(),
    kdfIterations: integer("kdf_iterations").default(100000).notNull(),
    kdfVersion: integer("kdf_version").default(1).notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

**Testing:** Verify existing logins work with `cryptoVersion: 1`. Write migration tests that upgrade a user from v1 to v2 and verify all data remains accessible.

---

## #37 — LOW: No Backup Codes / Recovery Mechanism

**File:** Architecture-wide

**Problem:** If a user loses both their password and secret key, there is no recovery mechanism. Their encrypted data is permanently inaccessible. While this is by design in a zero-knowledge system, many password managers offer backup codes or recovery kits.

**Fix (large feature):** Implement a recovery kit system.

### Option A: Recovery Kit (recommended)

On signup, generate a recovery kit containing:
1. The user's Secret Key (already shown once)
2. A set of 8 one-time recovery codes
3. Instructions for recovery

```typescript
// Generate recovery codes
function generateRecoveryCodes(count: number = 8): string[] {
    return Array.from({ length: count }, () =>
        randomBytes(4).toString("hex").toUpperCase().match(/.{4}/g)!.join("-")
    );
}
// Example output: ["A1B2-C3D4", "E5F6-G7H8", ...]
```

Store hashed recovery codes server-side:
```typescript
export const recoveryCode = pgTable("recovery_code", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => user.id),
    codeHash: text("code_hash").notNull(), // SHA-256 hash
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

Recovery flow:
1. User enters email + recovery code
2. Server verifies hashed code
3. Server initiates a password reset flow
4. User sets new password + gets new secret key
5. All vault keys re-encrypted with new MUK
6. Old recovery codes invalidated, new ones generated

### Option B: PDF Export Recovery Kit

Generate a printable PDF containing the user's Secret Key and account recovery information. This is a UX improvement over showing the secret key once on screen.

**Implementation timeline:** This is a large feature spanning multiple packages. Recommend planning as a dedicated sprint after critical/high fixes are complete.

**Testing:** Full recovery flow: create account, generate recovery codes, "lose" password, recover using code, verify all vault data is accessible.

---

## Implementation Order

1. **#34** (data versioning) — prerequisite for crypto-core breaking changes, implement first
2. **#31** (IP header spoofing) — quick config change based on deployment
3. **#37** (recovery mechanism) — large feature, plan separately

## Dependencies

```
#34 (this plan) ──blocks──> #10, #14 (01-crypto-core)
```

#34 must be implemented and deployed before any breaking changes to crypto parameters can be rolled out.
