# Session Management Analysis (Current State)

Date: 2026-03-05

This document captures how Bittery session/auth/token handling works **today** before the opaque-session refactor.

## 1) Current session/token flow

### Server-side creation
- Core auth implementation: `packages/auth/src/index.ts`.
- Sessions are created in:
  - `finishLogin(...)` (SRP login completion)
  - `createUserSession(...)` (signup and non-SRP session creation paths)
- Session creation logic:
  1. Generate `sessionId = nanoid()`.
  2. Compute `expiresAt = now + 30d` (constant `SESSION_DURATION`).
  3. Compute `sessionTokenHash = sha256(serverSession.key)` for SRP flow OR `sha256(randomBytes(32).base64url)` for non-SRP.
  4. Insert DB row into `session` table with `id = sessionId`, `token = sessionTokenHash`, `userId`, `expiresAt`, device metadata, and `lastActiveAt`.
  5. Create JWT (`HS256`) containing: `userId`, `email`, `sessionId`, `sessionTokenHash`, `iat`, `iss`, `aud`, `exp`.
  6. Return JWT string to client as `token`.

### Server-side validation
- tRPC context auth extraction: `packages/api/src/context.ts`.
- Reads `Authorization` header, strips `Bearer `, then calls `verifySession(token)` from `@bittery/auth`.
- `verifySession(...)` does:
  1. Verify JWT signature + issuer + audience (`jose.jwtVerify`, HS256).
  2. Parse claims to `SessionPayload`.
  3. Query DB `session` row requiring:
     - `session.id == payload.sessionId`
     - `session.userId == payload.userId`
     - `session.token == payload.sessionTokenHash`
     - `session.expiresAt > now`
  4. Return payload if DB row exists, else null.

### Destruction/invalidation
- `deleteSession(sessionId)` deletes one session row by ID.
- `deleteAllUserSessions(userId)` deletes all rows for user.
- `deleteOtherUserSessions(userId, currentSessionId)` deletes all except current.
- These are called from auth/team/password/account flows (details below).

### JWT generation/sign/verify locations
- Sign and verify for auth sessions:
  - `packages/auth/src/index.ts` (`SignJWT`, `jwtVerify`)
- Recovery JWT also in same file (`createRecoveryToken`, `verifyRecoveryToken`) with separate audience.

### JWT claims in auth session token
- `userId`
- `email`
- `sessionId`
- `sessionTokenHash`
- plus standard registered claims (`iss`, `aud`, `iat`, `exp`).

## 2) Session table schema (Drizzle)

Schema file: `packages/db/src/schema/auth.ts`

Current `session` table columns:
- `id` (text, primary key) — logical session id (nanoid)
- `expiresAt` (timestamp, not null)
- `token` (text, unique, not null) — SHA-256 hash of session key (not JWT)
- `createdAt` (timestamp default now)
- `updatedAt` (timestamp with onUpdate)
- `ipAddress` (text nullable)
- `userAgent` (text nullable)
- `deviceName` (text nullable)
- `platform` (text nullable)
- `browserName` (text nullable)
- `browserVersion` (text nullable)
- `osName` (text nullable)
- `osVersion` (text nullable)
- `lastActiveAt` (timestamp default now, not null)
- `userId` (text FK to user, cascade delete)

Index:
- `session_userId_idx` on `userId`

## 3) Auth flow (SRP-6a) and session creation

### SRP flow on server
- `auth.startLogin` router (`packages/api/src/routers/auth.ts`) calls `startLogin(...)`.
- `startLogin(...)` (`packages/auth/src/index.ts`) loads user by email and returns SRP server challenge + `serverEphemeralSecret`.
- `auth.finishLogin` and `auth.quickUnlock` call `finishLogin(...)`.
- `finishLogin(...)` verifies SRP client proof via `deriveServerSession(...)`, then creates DB session and signs JWT.

### After successful SRP proof exchange
- Server returns:
  - `token` (JWT)
  - `sessionId`
  - `serverProof` (for client SRP verification)
  - user + vault key payloads via router layer.

### Client-side post-login handling
- Shared core service: `packages/core/src/services/auth-service.ts`.
- `performSRPLogin` / `performSRPUnlock` execute SRP handshake and receive `token`/`sessionId`.
- `storeLoginSession` / `storeUnlockSession` persist:
  - auth token (`storeAuthToken`)
  - session metadata (`storeSessionData(..., sessionId)`)
  - MUK in memory (+ encrypted at rest)
  - vault keys and encrypted private key
  - account metadata where applicable.

## 4) Client-side storage by platform (current)

Storage adapter interface: `packages/storage/src/adapter.ts`

### Web
- Adapter: `packages/storage/src/adapters/web.ts`
- Auth token key: `bittery_jwt_token`
- Stored in: `sessionStorage`
- Session metadata (`session_data`) in `localStorage`

### Desktop (Tauri)
- Adapter: `packages/storage/src/adapters/tauri.ts`
- Token stored under account key suffix `jwt_token`
- Stored in: Tauri Store (`store.json`) + in-memory cache
- MUK/session envelope encrypted with device key (device key in keychain)

### Mobile (React Native)
- Adapter: `packages/storage/src/adapters/react-native.ts`
- Token stored under account key suffix `jwt_token`
- Stored in: Expo SecureStore + in-memory cache

### Browser Extension
- Adapter: `packages/storage/src/adapters/chrome.ts`
- Token stored under account key suffix `jwt_token`
- Stored in: `chrome.storage.local` (for SW restart persistence), plus in-memory cache

## 5) Middleware / request auth extraction

### tRPC API requests
- `packages/api/src/context.ts`:
  - extract bearer token from `Authorization`
  - call `verifySession(token)`
  - put result into `ctx.session`
- `packages/api/src/index.ts` `protectedProcedure` checks `ctx.session` exists.

### SSE sync endpoint
- `apps/server/src/sync/sse-handler.ts`
- Reads `Authorization` bearer token directly and calls `verifySession(token)`.
- Uses returned `userId`/`sessionId` for connection identity.
- Periodic revalidation also calls `verifySession(token)`.

## 6) Session lifecycle / expiry / invalidation

### Expiration
- Server session lifetime is fixed 30 days (`SESSION_DURATION`) in auth service.
- JWT also has `exp = 30d`.
- Session validity requires BOTH valid JWT and DB row with `expiresAt > now`.
- Client-side local session envelope validity defaults to 14 days (`DEFAULT_SESSION_EXPIRY_MS` in `packages/storage/src/types.ts`) unless explicitly overridden.

### Activity tracking
- Server stores and updates `lastActiveAt`.
- `auth.heartbeat` endpoint updates `lastActiveAt` (`updateSessionActivity`).

### Invalidation
- Logout (single session): `auth.logout` expects `sessionId`, checks ownership, then `deleteSession(sessionId)`.
- Logout all: `auth.logoutAll` -> `deleteAllUserSessions(userId)`.
- Password change: `auth.changePassword` -> `deleteAllUserSessions(userId)`.
- Email change: `auth.updateEmail` -> `deleteAllUserSessions(userId)`.
- Recovery password reset: `resetUserPassword(...)` transaction deletes all sessions for user.
- Account deletion: user row delete cascades session delete.
- Team leave/removal flows also call `deleteAllUserSessions(...)` in team router.

## 7) Lock/unlock coupling (current)

### Intended separation already present in parts of storage layer
- Desktop `lockAllAccounts()` comment explicitly states JWTs are not deleted and lock state is about MUK-in-memory.
- `clearSession` on desktop/mobile primarily clears in-memory/decryption state, not always token persistence.

### But SRP quick unlock currently creates a new server session
- `performSRPUnlock` calls `auth.quickUnlock` which executes full `finishLogin` path server-side.
- That path creates a new DB session + JWT.
- Therefore unlock currently rotates/creates server sessions.

### Lock can still trigger server logout depending on caller path
- Shared `useLock` wraps `useLogout` with `clearSecretKey=false` but `notifyServer` defaults true.
- This means some lock flows can invoke `auth.logout` and invalidate server session.

### Net effect
- Current implementation has mixed semantics:
  - Some lock operations are local-memory only.
  - Some unlock/lock paths are coupled to server session creation/destruction.

## Additional observations relevant for refactor

1. **JWT is currently redundant for authorization decisions**
   - Every request already verifies JWT and then does DB lookup on `session` row.

2. **Session table already stores hashed token material**
   - `session.token` is SHA-256 of SRP-derived key (or random key), while client actually sends JWT.
   - So there is already hashing infrastructure (`hashToken`) but not used as direct bearer token ID.

3. **Platform session durations are not yet platform-specific server-side**
   - All server sessions are 30 days currently.

4. **No existing silent refresh endpoint**
   - Only heartbeat exists; it writes `lastActiveAt`.

5. **Recovery token uses JWT and should remain independent**
   - Recovery JWT is separate purpose/audience from auth session token.
