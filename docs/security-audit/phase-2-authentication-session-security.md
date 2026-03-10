# Bittery Security Audit — Phase 2: Authentication & Session Security

Date: 2026-03-10
Scope: SRP authentication, opaque session tokens, session lifecycle, lock/unlock coupling, rate limiting, information leakage, and platform-specific session storage.

## 1. Summary

The opaque-session refactor is partially in place and several core controls are sound: session tokens are 32-byte random values, the server stores only a SHA-256 hash, bearer lookup is done against the hash, server-side platform lifetimes are implemented, refresh rotation deletes the previous session row in the same transaction, and password-change/logout invalidation is immediate.

The highest-risk issue is a critical SRP design break: the server returns its private ephemeral secret to the client during `startLogin`. That collapses SRP’s online-only property and enables offline password-verifier recovery. The next most important issues are auth/session lifecycle mismatches on the client side, incomplete abuse protections, and platform deviations from the stated token-storage model.

Severity overview:
- Critical: 1
- Medium: 6

## 2. Findings

### Finding 1 — SRP server private ephemeral is returned to the client
- Severity: Critical
- Location:
  - `packages/auth/src/index.ts:182-211`
  - `packages/api/src/routers/auth.ts:540-550`
  - `packages/core/src/services/auth-service.ts:297-300`
  - `packages/core/src/services/auth-service.ts:475-479`
  - `packages/crypto/core/crates/bittery-crypto-core/src/srp6a/server.rs:95-98`
- Description:
  - `startLogin(...)` returns `serverEphemeralSecret` and the router exposes it to the client as `serverSecret`. The client then sends that same value back to `finishLogin` / `quickUnlock`.
  - In SRP-6a, the server private ephemeral `b` must remain server-side. Here it is disclosed to the client, even though the server public value is computed as `B = kv + g^b mod N`.
  - Once an attacker has `salt`, `B`, and `b`, they can recover the verifier `v` and perform an offline dictionary attack against the password-derived SRP secret. That defeats the zero-knowledge goal of the login flow.
- Attack scenario:
  1. The attacker calls `auth.startLogin` for `victim@example.com`.
  2. The server returns `salt`, `serverPublicKey`, and `serverSecret`.
  3. The attacker computes `g^b`, subtracts it from `B`, divides by `k`, and recovers the SRP verifier.
  4. The attacker runs offline password guesses against the verifier and salt until a match is found.
  5. The attacker now has the password-equivalent SRP secret and can authenticate as the victim.
- Recommended fix:
  - Never send the server private ephemeral to the client.
  - Persist short-lived handshake state server-side and return only an opaque login-attempt identifier.
  - Bind that state to the email/user, expire it quickly, and consume it exactly once.

```ts
// Direction only
const attemptId = nanoid();
await handshakeStore.set(attemptId, {
  userId,
  serverEphemeralSecret,
  createdAt: Date.now(),
}, { ttlSeconds: 60 });

return {
  attemptId,
  salt,
  serverPublicKey,
  kdfParams,
};

// finishLogin
const state = await handshakeStore.get(attemptId);
if (!state) throw new TRPCError({ code: "UNAUTHORIZED" });
await handshakeStore.delete(attemptId);
const result = await finishLogin(state.userId, state.serverEphemeralSecret, ...);
```

### Finding 2 — Quick unlock creates a new server session on every unlock
- Severity: Medium
- Location:
  - `packages/core/src/services/auth-service.ts:414-481`
  - `packages/api/src/routers/auth.ts:671-706`
  - `packages/auth/src/index.ts:218-297`
- Description:
  - `performSRPUnlock(...)` calls `auth.quickUnlock`.
  - `auth.quickUnlock` immediately delegates to `finishLogin(...)`.
  - `finishLogin(...)` always creates a brand-new session row and bearer token.
  - This means “unlocking” is not a local-only operation when a valid session already exists. It creates extra active server sessions and couples vault unlock to server session issuance.
- Attack scenario:
  1. A user logs in on one device.
  2. The user locks and quick-unlocks repeatedly over days.
  3. Each unlock leaves another valid server session row behind.
  4. A previously stolen token from the same device remains valid until expiry/logout/password change because later unlocks do not revoke it.
  5. Session inventory and revocation semantics become noisy and weaker than intended.
- Recommended fix:
  - Separate local vault unlock from server authentication.
  - If a server session is still valid, unlock should only restore MUK/private material locally.
  - Only perform SRP when the server session is actually expired, and then either refresh/replace the current session or explicitly revoke the prior one.

### Finding 3 — Client-side session validity drifts from server expiry and refresh state
- Severity: Medium
- Location:
  - `packages/storage/src/types.ts:65-68`
  - `packages/storage/src/adapters/web.ts:225-321`
  - `packages/storage/src/adapters/react-native.ts:336-409`
  - `apps/mobile/src/lib/trpc.tsx:79-98`
  - `packages/shared/src/trpc-session-refresh.ts:90-121`
- Description:
  - Client storage adapters default `StoredSessionData.expiresAt` to `DEFAULT_SESSION_EXPIRY_MS` (14 days), independent of the server’s platform-specific session lifetime.
  - `isSessionValid(...)` checks only that local stored timestamp.
  - Silent refresh stores only the new token; it does not persist the new server `expiresAt` back into session storage.
  - Result: the client can treat a session as valid long after the server has expired it, and it cannot reliably distinguish “vault locked but session valid” from “session expired, must re-auth.”
- Attack scenario:
  1. A web user logs in; the server session expires after 24 hours.
  2. Local session metadata still says the session is valid for 14 days.
  3. The UI offers quick unlock / biometric unlock based on stale local state.
  4. The next authenticated request fails with `401` because the server session is gone.
  5. The user gets inconsistent auth state and token rotation can silently desynchronize after app restart.
- Recommended fix:
  - Persist the server `expiresAt` returned at login and refresh.
  - Update `StoredSessionData` during refresh, not just the bearer token.
  - Base `isSessionValid(...)` and unlock-path decisions on server-aligned expiry metadata.

```ts
interface RefreshResult {
  token: string;
  sessionId: string;
  expiresAt: string;
}

await storage.storeRefreshedSession({
  token: result.token,
  sessionId: result.sessionId,
  expiresAt: result.expiresAt,
});
```

### Finding 4 — Authentication endpoints allow direct account enumeration
- Severity: Medium
- Location:
  - `packages/auth/src/index.ts:190-198`
  - `packages/api/src/routers/auth.ts:539-564`
  - `packages/api/src/routers/auth.ts:174-180`
- Description:
  - `startLogin(...)` throws when the user does not exist, and the public router converts that into a failed request.
  - For an existing user, the same endpoint returns a full SRP challenge plus `userId`.
  - Public signup also returns a specific `"User with this email already exists"` message.
  - These paths reveal whether an email is registered.
- Attack scenario:
  1. The attacker submits candidate email addresses to `auth.startLogin`.
  2. Existing accounts receive a successful SRP challenge response.
  3. Unknown accounts receive `UNAUTHORIZED`.
  4. The attacker verifies ambiguous cases via the signup endpoint’s duplicate-email error.
  5. The resulting account list is used for phishing, credential stuffing, or targeted brute force.
- Recommended fix:
  - Make `startLogin` non-enumerating by returning an indistinguishable fake SRP challenge for unknown users.
  - Make duplicate-signup behavior generic on public endpoints.
  - Keep server-side telemetry detailed, but keep external responses uniform.

### Finding 5 — Rate limiting is incomplete and can be bypassed with spoofed IP headers
- Severity: Medium
- Location:
  - `packages/api/src/context.ts:30-35`
  - `packages/auth/src/index.ts:111-115`
  - `packages/auth/src/index.ts:573-620`
  - `packages/api/src/routers/auth.ts:140-159`
  - `packages/api/src/routers/auth.ts:307-325`
  - `packages/api/src/routers/auth.ts:1014-1023`
- Description:
  - Rate-limit identity is derived from `SHA256(normalizedEmail + "|" + ipAddress)`.
  - `ipAddress` is taken directly from `CF-Connecting-IP`, `X-Forwarded-For`, or `X-Real-IP` with no trusted-proxy validation.
  - Login therefore has no independent per-account ceiling and can be reset by spoofing or rotating IPs.
  - Public signup/invited-signup and authenticated refresh are not rate-limited at all.
- Attack scenario:
  1. The attacker targets one account and submits repeated bad logins.
  2. After each few attempts, the attacker changes `X-Forwarded-For` or uses a new proxy exit.
  3. Because the limiter key changes, backoff state resets.
  4. In parallel, the attacker can spam signup endpoints or churn refresh requests without any dedicated throttle.
  5. Online guessing, account-enumeration campaigns, and auth-path resource abuse become materially easier.
- Recommended fix:
  - Trust forwarded IP headers only when the request came through a known proxy/load balancer.
  - Add separate per-account and per-source limits for login.
  - Add explicit rate limits for signup, invitation signup, and refresh.
  - Consider a short sliding-window limiter plus the existing progressive backoff.

### Finding 6 — Extension bearer tokens are persisted in `chrome.storage.local` instead of `chrome.storage.session`
- Severity: Medium
- Location:
  - `packages/storage/src/adapters/chrome.ts:441-465`
  - `packages/storage/src/adapters/chrome.ts:515-534`
- Description:
  - The extension stores the auth bearer token in `chrome.storage.local`.
  - The same adapter already uses `chrome.storage.session` for `encrypted_private_key`, so the session-scoped storage API is available.
  - Persisting the bearer in `local` means it survives browser restarts and profile persistence, which is weaker than the stated `chrome.storage.session` model.
- Attack scenario:
  1. A user closes the browser expecting extension session state to disappear.
  2. The bearer token remains in `chrome.storage.local`.
  3. A later local compromise of the browser profile or extension context extracts that token.
  4. The attacker reuses the still-valid bearer to access the account until expiry/revocation.
- Recommended fix:
  - Store the bearer token only in `chrome.storage.session`.
  - If service-worker restarts require rehydration, store an encrypted non-bearer rehydration artifact instead of the bearer itself.
  - Fail closed when `chrome.storage.session` is unavailable rather than silently persisting the bearer more broadly.

### Finding 7 — Desktop bearer tokens are written to Tauri Store instead of the OS keychain
- Severity: Medium
- Location:
  - `packages/storage/src/adapters/tauri.ts:416-447`
  - `apps/desktop/src-tauri/src/keychain.rs:8-18`
- Description:
  - Desktop token persistence uses Tauri Store (`store.json`-style app storage), while the project already has OS keychain integration and uses it for the device key.
  - This is a platform-specific deviation from the stated requirement that desktop session tokens live in the OS keychain.
- Attack scenario:
  1. An attacker gets access to the desktop user’s app data directory or backups.
  2. The attacker reads the persisted auth token from the Tauri Store.
  3. The token is replayed as `Authorization: Bearer <token>`.
  4. The attacker gains the same API session until expiry or revocation.
- Recommended fix:
  - Store bearer tokens in the OS keychain alongside other high-value secrets.
  - Keep Tauri Store for non-sensitive metadata only.
  - On migration, move existing stored tokens into the keychain and delete the old store entry.

## 3. Positive Findings

- Registration sends only SRP salt/verifier and encrypted account material to the server; plaintext password and plaintext MUK are not sent on the normal signup path.
  - `packages/api/src/routers/auth.ts:140-212`
  - `packages/db/src/schema/auth.ts:20-29`

- Opaque session tokens are generated from 32 random bytes and server-side lookup is done against `SHA-256(token)`, with no plaintext token column in the session table.
  - `packages/auth/src/index.ts:83-89`
  - `packages/auth/src/index.ts:306-329`
  - `packages/db/src/schema/auth.ts:41-67`

- Server-side session lifetime policy is platform-aware (`web` 24h, `extension` 7d, `desktop/mobile` 30d) and refresh rotation inserts the new session then deletes the old one inside a transaction.
  - `packages/auth/src/index.ts:41-48`
  - `packages/auth/src/index.ts:106-109`
  - `packages/auth/src/index.ts:481-528`
  - `packages/api/src/__tests__/auth.test.ts:504-546`

- Session invalidation on logout and password change is immediate at the database layer.
  - `packages/api/src/routers/auth.ts:1009-1011`
  - `packages/api/src/routers/auth.ts:1127-1147`
  - `packages/auth/src/index.ts:534-555`

- Mutual SRP proof verification is enforced on the main login path and on quick unlock.
  - Client verifies server proof:
    - `packages/core/src/services/auth-service.ts:304-308`
    - `packages/core/src/services/auth-service.ts:483-487`
    - `packages/crypto/core/crates/bittery-crypto-core/src/srp6a/client.rs:206-224`
  - Server verifies client proof:
    - `packages/auth/src/index.ts:250-258`
    - `packages/crypto/core/crates/bittery-crypto-core/src/srp6a/server.rs:125-139`

- Recovery request/verification endpoints are intentionally non-enumerating, returning the same outward success shape regardless of account existence.
  - `packages/api/src/routers/auth.ts:794-809`
  - `packages/api/src/routers/auth.ts:816-845`

- Android biometric escrow uses Keystore AES-GCM, requires authentication for each decryption operation, invalidates on biometric enrollment changes, and enforces a timeout before allowing escrow retrieval.
  - `apps/mobile/modules/credential-provider/android/src/main/java/expo/modules/credentialprovider/crypto/MukEscrowManager.kt:31-102`
  - `apps/mobile/modules/credential-provider/android/src/main/java/expo/modules/credentialprovider/crypto/MukEscrowManager.kt:166-227`

## 4. Open Questions

1. I did not find a scheduled cleanup path for naturally expired session rows. They are ignored by `verifySession(...)`, but confirm whether periodic deletion is expected for DB hygiene.
2. TLS appears to be a deployment assumption rather than something enforced in-app. Confirm whether production will terminate HTTPS before requests ever reach this server and whether HSTS will be enabled.
3. On React Native, bearer tokens are not marked SecureStore-only and `setItem(...)` falls back to SQLite on SecureStore failure (`packages/storage/src/adapters/react-native.ts:136-168`, `431-439`). Confirm whether that fallback is acceptable.
4. For the extension, confirm whether persistent auth across browser/service-worker restarts is an intentional exception to the stated `chrome.storage.session` requirement.
5. `AuthDataEntity` stores the secret key plaintext in the Android Room DB (`apps/mobile/modules/credential-provider/android/src/main/java/expo/modules/credentialprovider/storage/AuthDataEntity.kt:20-44`). That may be an intentional local-first tradeoff, but it increases local-compromise impact and should be explicitly acknowledged.

## 5. Cross-References

- Phase 1 Finding 6 noted that quick unlock previously weakened SRP mutual authentication. That specific issue appears to be improved here: `quickUnlock` now returns `serverProof` and the client verifies it. The remaining Phase 2 issue is different: quick unlock still creates a new server session instead of remaining a local-only unlock.
- Phase 1 Finding 1 remains relevant to auth risk: sensitive key material still leaves the Rust/WASM heap on several paths. Any client compromise during login/unlock therefore has higher impact than the intended opaque-handle model.
- Phase 1 Finding 5 remains relevant as background hardening: the runtime path uses strong SRP settings, but public SRP configuration flexibility still increases downgrade surface for future auth code paths.
