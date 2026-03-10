# Phase 2 Auth / Session Security Remediation Plan

## Summary
Remediate Findings 1, 2, 3, 4, 5, and 7 from the audit, plus mobile bearer-storage hardening. Finding 6 (persistent extension bearer storage) is not being fixed in this phase by explicit product choice and will be recorded as an accepted risk.

## Public API / Interface Changes
- `auth.startLogin`
  - Return `{ attemptId, salt, serverPublicKey, kdfParams }`
  - Remove `userId` and `serverSecret` from the response
- `auth.finishLogin`
  - Accept `{ attemptId, clientPublicKey, clientProof }`
  - Return `expiresAt` alongside `token`, `sessionId`, `serverProof`, `user`, and `vaultKeys`
- Remove the public `auth.quickUnlock` RPC
  - Quick unlock becomes a client/local flow
  - Re-auth on expired sessions reuses `startLogin` + `finishLogin`
- Session-creating auth responses also return `expiresAt`
  - signup
  - signup with invitation
  - recovery password reset
  - refresh session already returns it and keeps doing so
- Core auth types
  - `StartLoginResponse` gains `attemptId`, loses `userId` and `serverSecret`
  - `FinishLoginResponse` gains `expiresAt`
  - `UnlockResult` gains `mode: "local" | "reauth"` and `expiresAt?: string | Date`
- Storage adapter contract
  - `storeSessionData` and `storeSessionDataWithMasterUnlockKeyHandle` take server `expiresAt` instead of a derived local TTL when available
  - Add `updateStoredSessionMetadata(email, { sessionId, expiresAt })`
- Shared refresh client
  - Replace `storeRefreshedToken(token)` callback with `storeRefreshedSession({ token, sessionId, expiresAt })`

## Implementation Plan

### 1. SRP handshake remediation
- Add a new DB-backed login-attempt table with:
  - `id`
  - `userId nullable`
  - `normalizedEmailHash`
  - `clientPublicKey`
  - `serverEphemeralSecret`
  - `expiresAt`
  - `createdAt`
- `startLogin` behavior:
  - Always return success-shaped challenge data
  - For real users, generate a normal SRP server ephemeral and store attempt state
  - For unknown users, generate a fake challenge using:
    - a fake salt derived as `HMAC(JWT_SECRET, normalizedEmail)`
    - a constant fake verifier
    - a stored attempt row with `userId = null`
  - TTL for attempts: 60 seconds
- `finishLogin` behavior:
  - Load by `attemptId`
  - Require unexpired row and exact `clientPublicKey` match
  - Delete the row before SRP verification so attempts are single-use
  - If `userId` is null, return generic `UNAUTHORIZED`
  - If SRP proof fails, return generic `UNAUTHORIZED`
- Cleanup:
  - Consume attempts on success/failure
  - Best-effort prune expired attempts during new `startLogin` calls using an index on `expiresAt`

### 2. Decouple unlock from session issuance
- Remove server-side `quickUnlock`
- Change `performSRPUnlock` to be local-first:
  - Derive MUK from password + stored secret key
  - If local session metadata is still valid and an auth token exists, unlock locally only
  - If the session is expired or auth/session metadata is missing, perform a normal SRP login using stored secret key + password
- Local unlock path:
  - Restore only MUK / handle into memory
  - Do not create or rotate server sessions
  - Do not rewrite token or session expiry metadata
- Re-auth unlock path:
  - Use `startLogin` + `finishLogin`
  - Persist returned token, sessionId, and expiresAt
- Update `storeUnlockSession`, `useQuickUnlock`, and `useQuickUnlockAll` to branch on `mode`
- Acceptance rule:
  - Repeated unlocks with a valid existing session must leave exactly one active session row per device/account

### 3. Align client session validity with server expiry
- Persist server `expiresAt` on:
  - login
  - signup
  - invitation signup
  - recovery reset
  - refresh
- Stop deriving session validity from `DEFAULT_SESSION_EXPIRY_MS` for new sessions
- `StoredSessionData.expiresAt` remains the source of truth, but it must come from the server
- `isSessionValid` and `canQuickUnlock` must require:
  - unexpired stored server expiry
  - stored auth token present
- Add `updateStoredSessionMetadata` in all storage adapters so refresh can update `sessionId` and `expiresAt` without re-encrypting the MUK
- Update all shared/client refresh providers to persist `{ token, sessionId, expiresAt }`
- Keep the 14-day constant only as a migration fallback for legacy session records that predate this change

### 4. Remove direct account enumeration
- `startLogin` becomes outwardly non-enumerating because unknown users also receive a challenge
- Public signup and invitation-signup duplicate-email paths return the same generic external error
  - Detailed reasons stay in server logs / telemetry only
- Keep `checkEmail` unchanged because it already uses the non-enumerating outward shape

### 5. Complete abuse protections and fix IP trust
- Add explicit namespaces:
  - `auth_login_account`
  - `auth_login_source`
  - `auth_signup_source`
  - `auth_invite_signup_source`
  - `auth_refresh_session`
- Trusted-source policy:
  - Default: do not trust forwarded IP headers
  - Only use forwarded headers when explicit proxy config is enabled
- Introduce config-gated proxy resolution:
  - `TRUST_PROXY_MODE=none|cloudflare|forwarded`
  - default `none`
- Login limits:
  - Keep existing per-account progressive backoff: 5 free failures, max 30-minute lock
  - Add per-source sliding window when trusted source IP is available: 20 `startLogin` attempts per 5 minutes
- Signup / invited-signup limits:
  - 5 attempts per trusted source per hour
- Refresh limits:
  - 30 refreshes per session per 5 minutes
- Failure accounting:
  - Record account backoff on invalid proof, invalid attemptId, expired attemptId, and fake-user finish
  - Clear per-account login failure state only after successful finish
  - Do not clear shared source-window counters on success

### 6. Storage hardening
- Desktop:
  - Store bearer tokens in OS keychain, not Tauri Store
  - On read, migrate legacy store value into keychain once, then delete the store key
  - Update native Rust unlock / desktop-bridge paths to read keychain first and perform the same one-time migration
  - Fail closed if keychain storage for the bearer is unavailable
- Mobile:
  - Mark account `jwt_token` keys as SecureStore-only
  - Reuse the existing legacy migration path to move historical SQLite token copies into SecureStore and delete SQLite remnants
- Extension:
  - No code change in this phase
  - Record Finding 6 as an accepted risk because persistent bearer storage is being kept intentionally for now

## Tests and Scenarios
- SRP flow
  - `startLogin` never returns `userId` or `serverSecret`
  - Unknown email gets a valid-shaped challenge and `finishLogin` still fails generically
  - Reused, expired, mismatched-client-public-key, and fake attempts all fail
- Unlock semantics
  - Local quick unlock with a valid session does not create a new session row
  - Expired-session quick unlock performs re-auth and returns one replacement session
  - Multi-account unlock-all does not multiply sessions when sessions are still valid
- Session metadata
  - Login/signup/reset/refresh all persist server `expiresAt`
  - Refresh updates both token and stored expiry/sessionId
  - `canQuickUnlock` is false when token is missing or stored expiry is elapsed
- Enumeration
  - Existing and non-existing emails are indistinguishable at `startLogin`
  - Duplicate public signup responses are generic
- Rate limiting
  - Per-account lockout still works
  - Per-source window works only when trusted-proxy mode is enabled
  - Untrusted forwarded headers do not affect limiter identity
  - Signup, invite-signup, and refresh are throttled
- Storage migration
  - Desktop migrates `jwt_token` from store to keychain and deletes legacy value
  - Mobile migrates legacy SQLite bearer token into SecureStore and deletes SQLite copy

## Assumptions and Defaults
- Trusted proxy handling is config-gated and defaults to `none`
- Login-attempt TTL is 60 seconds
- Source-window defaults:
  - login `20 / 5m`
  - signup `5 / 1h`
  - invitation signup `5 / 1h`
  - refresh `30 / 5m`
- Extension persistent bearer storage is an accepted risk for this phase and remains an open audit item
- Session-row hygiene, TLS/HSTS deployment controls, and other non-finding operational hardening are not part of this remediation plan
