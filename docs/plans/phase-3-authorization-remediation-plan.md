# Phase 3 Authorization Remediation Plan

## Summary
- Implement all six phase 3 audit fixes plus your added requirement to gate all new-account signups behind email-code verification.
- Locked decisions: respect explicit vault ACLs, prefer `NOT_FOUND` on the tightened IDOR-sensitive endpoints, and never expose stored invitation tokens from list/read management APIs.
- The attachment issue is closed in this pass by making attachment keys non-public everywhere; no attachment ciphertext/key-rotation redesign is included.

## Public APIs and type changes
- Add `auth.requestSignupVerification({ email, invitationToken? }) -> { success: true }`.
- Add `auth.verifySignupVerification({ email, code, invitationToken? }) -> { success: boolean; signupVerificationToken?: string }`.
- Add required `signupVerificationToken` to both `auth.signup` and `auth.signupWithInvitation`.
- Change `team.invitations.list` response to remove `token`.
- Change `vault.members.lookupUser` input from `{ email }` to `{ vaultId, email }`.
- Keep `createPresignedUpload` shape unchanged, but `publicUrl` must be `null` for private prefixes such as `attachments/`.

## Implementation

### 1. Public storage boundary
- Introduce one shared allowlist helper for public storage keys and use it from both `getStoragePublicUrl(...)` and the `/cdn/*` route.
- Allow only the image/avatar namespaces already used by the app as public; deny `attachments/` and any unknown prefix by default.
- Update `/cdn/*` to return `404` before presigning/fetching when the key is not publicly allowed.
- Ensure attachment reads continue to work only through `vault.getAttachmentDownloadUrl`.

### 2. Invitation secrecy and signup verification
- Restrict `team.invitations.list` to team `owner` and `admin`.
- Remove invitation tokens from list/read responses; only `team.invitations.send` may return the freshly created token once.
- Add a new `signup_verification` persistence model with `email`, optional invitation binding, `code`, `attempts`, `maxAttempts`, `expiresAt`, `usedAt`, and timestamps.
- `auth.requestSignupVerification` should be non-enumerating for normal signup. When `invitationToken` is present, it must validate a pending, unexpired invitation whose email matches the requested email before issuing a code.
- `auth.verifySignupVerification` should mark the code used and return a short-lived JWT `signupVerificationToken` bound to normalized email and optional invitation context.
- `auth.signup` and `auth.signupWithInvitation` must reject missing or invalid verification tokens, verify that token/email match, and for invite signup also verify the same invitation context.
- Successful verified signup should create users with `emailVerified = true`. Existing users stay unchanged.
- Scope includes normal public signup, invited signup, and self-hosted bootstrap signup, using the existing dev email-stub pattern until a real provider is wired.

### 3. Team rotation must respect vault ACLs
- `team.getLeaveRotationData` must return only team vaults where the leaving user currently has a `vaultKey`.
- `team.members.getTeamRotationData` must return only vaults where the target user is a member and the acting user has vault role `owner` or `admin`.
- If the target user still belongs to any team vault outside the acting user’s vault-admin scope, both `team.members.getTeamRotationData` and `team.members.remove` must fail with `FORBIDDEN`; partial team removal is not allowed.
- `team.members.remove` must validate that `vaultRotations` exactly matches the server-computed removable vault set, with no extras and no omissions.
- Team role alone must no longer imply authority over unrelated team vaults.

### 4. Share management visibility
- Add a small helper that loads a share link plus the actor’s vault role and creator relationship.
- Apply the same visibility rule already used by `share.listByItem` to `share.get` and `share.getAccessLogs`: vault `owner` and `admin` can view any link in the vault; regular members can view only links they created.
- Return `NOT_FOUND` instead of `FORBIDDEN` when a link exists but is outside the actor’s allowed visibility.

### 5. IDOR-resistant conflict check and member lookup
- Rework `sync.checkConflict` to load the item through accessible vault membership first. If no accessible item exists, return `NOT_FOUND`. If an accessible item exists but has no sync events yet, keep returning `{ hasConflict: false }`.
- Rework `vault.members.lookupUser` to require `vaultId`, require the caller to be vault `owner` or `admin`, require a team vault context, require the target user to be in the same team and not already in the vault, and return `NOT_FOUND` for foreign-team or missing users.

### 6. Web UI updates
- Update the team page so pending invitations are fetched only for `owner` and `admin`, and hide the invitations tab for regular members.
- Remove the per-row “copy invite link” action from the pending invitations UI; keep resend/cancel only.
- Add a pre-submit verification step to both signup UIs and the shared signup hook: request code, verify code, store `signupVerificationToken`, then run crypto and submit signup.
- Keep invitation signup email locked to the invitation email during verification.

## Tests and acceptance criteria
- `auth.test.ts`: verified normal signup succeeds; verified invite signup succeeds; signup without `signupVerificationToken` fails; wrong or expired code fails; invite token/email mismatch fails; created users have `emailVerified = true`.
- `team.test.ts`: non-admin cannot list invitations; invitation list no longer exposes `token`; `getLeaveRotationData` excludes foreign vaults; `getTeamRotationData` rejects inaccessible target memberships; `members.remove` rejects partial or extra rotations.
- `share.test.ts`: creator can read link/logs; another regular vault member gets `NOT_FOUND`; vault admin can still read any link/logs.
- `sync.test.ts`: foreign and nonexistent items produce the same `NOT_FOUND`; accessible item with no events still returns `hasConflict: false`.
- `vault.test.ts`: `lookupUser` now requires `vaultId`, rejects foreign-team users with `NOT_FOUND`, and rejects non-admin callers.
- Storage/server coverage: attachment keys produce no public URL; `/cdn/attachments/...` returns `404`; public image/avatar prefixes still work.

## Assumptions and defaults
- The `NOT_FOUND` policy is limited to the phase 3 IDOR-sensitive endpoints above; this is not a repo-wide status-code rewrite.
- `team.invitations.send` may still return a new bearer token once at creation time; `list`, `resend`, and other management reads never return stored invite tokens.
- Existing accounts are not backfilled to `emailVerified = true`; no current authz path depends on that column.
- Schema changes should be made in Drizzle schema files and generated through the repo’s migration workflow, not hand-written manually.
