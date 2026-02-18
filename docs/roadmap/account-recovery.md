# Account Recovery (Password Reset) Implementation Plan

## Context

Bittery's zero-knowledge architecture derives the Master Unlock Key (MUK) deterministically from `password + secretKey + email` via PBKDF2 + HKDF. If a user forgets their password, there's currently no way to reset it, even with the Secret Key, because the old MUK is needed to decrypt vault keys and the RSA private key before re-encrypting them with a new MUK.

This plan implements **Approach A: Recovery Key**: a separate high-entropy key generated at signup that encrypts the intermediate `master_key` (the 32-byte PBKDF2 output before HKDF splitting). On recovery, the Recovery Key decrypts this blob, allowing derivation of the old MUK, decryption of all user data, and re-encryption with a new password-derived MUK. This preserves zero-knowledge: the server never sees plaintext keys.

Security requirement: all public recovery endpoints must be non-enumerating and return indistinguishable responses for existing/non-existing accounts.

### Password Reset Flow (User-Facing)
1. Click "Forgot Password" on login
2. Enter email -> server sends 6-digit verification code
3. Enter verification code
4. Enter Secret Key + Recovery Key
5. Enter new password
6. Client decrypts old data -> re-encrypts with new MUK -> sends to server
7. User is logged in with new session

---

## Phase 1: Crypto Primitives (Rust Core + WASM)

### 1A. New module: `packages/crypto/core/crates/bittery-crypto-core/src/recovery.rs`

- `generate_recovery_key() -> String` - Format: `R1-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX` (40 base32 chars, ~200 bits entropy). Reuses `CHARSET` from `secret_key.rs`; `R1` prefix distinguishes from `A3` Secret Key.
- `validate_recovery_key(key: &str) -> bool` - Format validation.
- `derive_recovery_encryption_key(recovery_key: &str, email: &str) -> [u8; 32]` - PBKDF2(SHA-256, recovery_key, email.lowercase(), 100k iterations).
- `encrypt_master_key(master_key: &[u8], recovery_key: &str, email: &str) -> EncryptedData` - Derive AES key from Recovery Key and encrypt the 32-byte `master_key`.
- `decrypt_master_key(encrypted: &EncryptedData, recovery_key: &str, email: &str) -> [u8; 32]` - Reverse operation.

### 1B. Modify `packages/crypto/core/crates/bittery-crypto-core/src/key_derivation.rs`

- `derive_master_key(password, secret_key, email) -> [u8; 32]` - Same PBKDF2 step currently inside `derive_keys`, but returns raw `master_key`.
- `derive_keys_from_master_key(master_key: &[u8], email: &str) -> DerivedKeys` - HKDF split only.

### 1C. Export from `lib.rs`

Add `pub mod recovery;` and re-export public recovery items.

### 1D. WASM bindings (`packages/crypto/core/crates/bittery-crypto-wasm/src/lib.rs`)

Add exports:
- `js_generate_recovery_key`
- `js_validate_recovery_key`
- `js_encrypt_master_key`
- `js_decrypt_master_key`
- `js_derive_master_key`
- `js_derive_keys_from_master_key`

### 1E. Web WASM wrapper (`apps/web/src/lib/wasm-crypto.ts`)

Add wrappers:
- `generateRecoveryKey()`
- `validateRecoveryKey()`
- `encryptMasterKey()`
- `decryptMasterKey()`
- `deriveMasterKey()`
- `deriveKeysFromMasterKey()`

### 1F. Web Worker + WorkerCrypto

Add matching message types in `apps/web/src/lib/crypto.worker.ts` and methods in `apps/web/src/lib/worker-crypto.ts`.

### 1G. Extension WASM wrapper (`apps/extension/src/lib/wasm-crypto.ts`)

Mirror the same recovery functions used by web.

### 1H. Desktop (Tauri)

Defer Tauri command/wrapper additions until desktop recovery UI is in scope.

**Build:** `pnpm run build:crypto-wasm`

---

## Phase 2: Database Schema

### 2A. Modify `packages/db/src/schema/auth.ts`

Add to `user` table:
- `encryptedMasterKey: text("encrypted_master_key")` - nullable, JSON `EncryptedData` blob
- `recoveryKeyHint: text("recovery_key_hint")` - nullable, e.g. `R1-XXXXXX`

Add table `recoveryVerification`:
```
id, email, code (6-digit), attempts (default 0), maxAttempts (default 5),
expiresAt (15 min), createdAt, usedAt
```
Pattern: `shareEmailVerification`.

Add table `recoveryRateLimit`:
```
id, email, ipAddress, attempts (default 0), lastAttemptAt, lockedUntil, createdAt, updatedAt
```
Pattern: `loginRateLimit`.

**Run:** `pnpm run db:generate && pnpm run db:migrate`

---

## Phase 3: Server-Side Auth Functions

### 3A. `packages/auth/src/index.ts` updates

#### Create/update data-shape functions
- Update `createUser(...)` input to accept optional recovery fields:
  - `encryptedMasterKey?: string | null`
  - `recoveryKeyHint?: string | null`
- Add `storeEncryptedMasterKey(userId, encryptedMasterKey, recoveryKeyHint)`.

#### Recovery read/reset functions
- `getRecoveryData(email)` -> returns `{ userId, encryptedMasterKey, encryptedPrivateKey, secretKeyHint, recoveryKeyHint }` for verified recovery session.
- `getUserVaultKeysForRecovery(userId)` -> returns vault keys including `createdById` to distinguish MUK-encrypted vs RSA-encrypted vault keys.
- `resetUserPassword(email, payload)` where payload includes:
  - `srpSalt`, `srpVerifier`, `encryptedPrivateKey`
  - `encryptedMasterKey`, `recoveryKeyHint`
  - `encryptedVaultKeys[]`

Implementation requirement: `resetUserPassword` must run in a single `db.transaction` and atomically:
1. update user credentials + recovery metadata
2. update vault keys
3. invalidate sessions
4. mark verification as used

#### Recovery verification + rate limiting
- `createRecoveryVerification(email) -> code` (6-digit, 15 min)
- `verifyRecoveryCode(email, code) -> boolean` (increments attempts on failure)
- `checkRecoveryRateLimit`, `recordFailedRecoveryAttempt`, `clearRecoveryRateLimit` with the same backoff policy as login.

#### Invalidate stale recovery metadata
- Update `updateUserPassword` and `updateUserSecretKey` to clear:
  - `encryptedMasterKey: null`
  - `recoveryKeyHint: null`

---

## Phase 4: API Endpoints

### 4A. `packages/api/src/routers/auth.ts` additions

**`requestRecoveryVerification`** (`publicProcedure`)
- Input: `{ email }`
- Behavior: rate limit check -> if user exists and recovery is configured, create/send code; otherwise no-op.
- Response: `{ success: true }`
- Must not reveal account existence or recovery-key setup state.

**`verifyRecoveryCode`** (`publicProcedure`)
- Input: `{ email, code }`
- On success, returns short-lived recovery JWT (15 min, includes `email` and `type: "recovery"`).
- Response: `{ success: boolean, recoveryToken?: string }`

**`getRecoveryData`** (`publicProcedure`, requires valid `recoveryToken`)
- Input: `{ recoveryToken }`
- Response:
  - `userId`
  - `encryptedMasterKey`
  - `encryptedPrivateKey`
  - `secretKeyHint`
  - `vaultKeys: [{ vaultId, encryptedVaultKey, createdById }]`

**`resetPassword`** (`publicProcedure`, requires valid `recoveryToken`)
- Input: `{ recoveryToken, srpSalt, srpVerifier, encryptedPrivateKey, encryptedMasterKey, recoveryKeyHint, encryptedVaultKeys[] }`
- Calls transactional `resetUserPassword`
- Creates new session
- Logs audit action `"password_reset_via_recovery"`
- Response: `{ token, sessionId, userId }`

**`storeRecoveryKey`** (`protectedProcedure`)
- Input: `{ encryptedMasterKey, recoveryKeyHint }`
- Used for initial setup or regeneration
- Logs `"recovery_key_setup"` or `"recovery_key_regenerated"`

### 4B. Existing endpoint updates

- `me` response adds `hasRecoveryKey: boolean` (`user.encryptedMasterKey !== null`).
- `signup` input adds `encryptedMasterKey` and `recoveryKeyHint`.
- `signupWithInvitation` input adds `encryptedMasterKey` and `recoveryKeyHint`.

---

## Phase 5: Client-Side Recovery Flow (Web)

### 5A. Recovery Key setup during signup (mandatory)

**Modify `apps/web/src/components/sign-up-form.tsx`:**

Recovery Key generation is mandatory for both signup flows (`signup` and `signupWithInvitation`).

1. Generate Recovery Key alongside Secret Key
2. Show both keys before account creation
3. Update Emergency Kit to include both keys
4. Require explicit acknowledgment that Recovery Key was saved
5. During signup crypto flow:
   - `deriveMasterKey(password, secretKey, email)` -> `master_key`
   - `encryptMasterKey(master_key, recoveryKey, email)` -> `encryptedMasterKey`
   - include `encryptedMasterKey` + `recoveryKeyHint` in mutation input

### 5B. "Forgot Password" link

**Modify `apps/web/src/components/sign-in-form.tsx`:**
- Add link below password field to `/recover`

### 5C. New route: `apps/web/src/routes/_auth/recover.tsx`

Multi-step wizard under public auth routes:

**Step 1 - Email:** call `requestRecoveryVerification`  
**Step 2 - Code:** call `verifyRecoveryCode`, store `recoveryToken`  
**Step 3 - Keys:** enter Secret Key (A3-...) + Recovery Key (R1-...), validate formats client-side  
**Step 4 - New Password:** perform client-side recovery crypto

```
1. getRecoveryData(recoveryToken) -> { userId, encryptedMasterKey, encryptedPrivateKey, vaultKeys }
2. decryptMasterKey(encryptedMasterKey, recoveryKey, email) -> old master_key
3. deriveKeysFromMasterKey(oldMasterKey, email) -> { masterUnlockKey: oldMUK }
4. decrypt(encryptedPrivateKey, oldMUK) -> privateKey
5. For each vault key where createdById === userId: decrypt(vaultKey, oldMUK)
6. deriveKeys(newPassword, secretKey, email) -> { authKey, masterUnlockKey: newMUK }
7. generateSRPRegistration(authKey) -> { srpSalt, srpVerifier }
8. encrypt(privateKey, newMUK) -> newEncryptedPrivateKey
9. Re-encrypt decrypted personal vault keys with newMUK
10. deriveMasterKey(newPassword, secretKey, email) -> new master_key
11. encryptMasterKey(newMasterKey, recoveryKey, email) -> newEncryptedMasterKey
12. resetPassword({ recoveryToken, srpSalt, srpVerifier, ... })
13. Store session/token and unlock locally
```

Reuse the same personal-vs-shared vault re-encryption rule already used in password/secret-key change flows.

**Step 5 - Success:** redirect to home.

### 5D. Route registration

No manual router config edits required. Add the route file and regenerate TanStack route tree (`routeTree.gen.ts`).

---

## Phase 6: Settings - Recovery Key Management

### 6A. Settings UI (`apps/web/src/routes/_app/settings/index.tsx`)

Add Recovery Key section:
- If `hasRecoveryKey === false`: show "Set up Recovery Key"
- If `hasRecoveryKey === true`: show "Regenerate Recovery Key"

### 6B. New: `apps/web/src/components/settings/setup-recovery-key-dialog.tsx`

For existing users without recovery setup:
1. Enter current password
2. Derive `master_key`
3. Generate Recovery Key and encrypt `master_key`
4. Show Recovery Key + download Emergency Kit
5. Call `storeRecoveryKey`

### 6C. New: `apps/web/src/components/settings/regenerate-recovery-key-dialog.tsx`

Same as setup flow, but replaces existing recovery material.

### 6D. Update password/secret-key settings copy

Update warnings in:
- `apps/web/src/components/settings/change-password-dialog.tsx`
- `apps/web/src/components/settings/regenerate-secret-key-dialog.tsx`

State that changing password or secret key invalidates current Recovery Key setup and requires re-setup.

---

## Rollout and Backward Compatibility

1. Existing users start with:
- `encryptedMasterKey = null`
- `recoveryKeyHint = null`
- `hasRecoveryKey = false`

2. Existing users can opt in via Settings setup flow.

3. Any password change or secret-key regeneration clears recovery metadata server-side.

4. Recovery endpoints remain non-enumerating throughout rollout.

---

## Email Service Dependency

Current codebase does not have production email sending wired for this use case. The share flow currently has a TODO and does not log/send verification codes.

For recovery MVP:
- Implement `sendRecoveryCode(email, code)` stub that logs code in server logs for dev/testing.
- Keep provider integration (SES/Resend/etc.) as a separate follow-up task.

---

## Verification Plan

1. **Rust crypto tests**
- Add unit tests in `recovery.rs` and `key_derivation.rs` for:
  - key format validation
  - encrypt/decrypt round trips
  - HKDF consistency when deriving from raw `master_key`

2. **WASM build**
- `pnpm run build:crypto-wasm`

3. **DB migration validation**
- `pnpm run db:generate && pnpm run db:migrate`

4. **Type checking**
- `pnpm run check-types`

5. **Non-mutating lint verification**
- `pnpm exec biome check .`
- Do not use `pnpm run check` as verification because it writes files.

6. **Manual E2E**
- Sign up (normal) and verify recovery fields are stored
- Sign up via invitation and verify recovery fields are stored
- Log out -> open `/recover`
- Complete recovery with logged verification code
- Verify login works with new password and vault data decrypts
- Verify prior sessions are invalidated

7. **Edge cases**
- User with no recovery setup receives non-enumerating response and cannot proceed
- Wrong Recovery Key fails decryption cleanly
- Wrong Secret Key fails SRP/crypto consistency checks
- Rate limit lockout after repeated failures
- Expired or reused verification code is rejected

8. **Security checks**
- Public responses are indistinguishable between existing and non-existing accounts
- Recovery token TTL and scope enforcement are validated
