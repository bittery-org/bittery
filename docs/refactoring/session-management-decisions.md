# Session Management Refactor Decisions

Date: 2026-03-05
Status: Implemented

This document records the decisions made for the opaque-session refactor and the rationale behind each choice.

## 1) Use opaque bearer tokens for auth sessions

### Decision
- Authenticated API access uses a random opaque bearer token.
- The server stores only a hash of that token in `session.id` and validates by DB lookup.

### Rationale
- Removes JWT claims from the online session path.
- Reduces token parsing/claim-coupling and makes revocation state fully DB-authoritative.
- Keeps the session model simple: possession of a valid opaque token + non-expired DB row.

### Consequences
- `Authorization: Bearer <opaque-token>` is now the only session auth credential.
- Session verification no longer depends on JWT audience/issuer/claims.

## 2) Clean cutover with no compatibility fallback

### Decision
- Do not support dual-mode verification (JWT + opaque) during migration.
- Remove fallback logic and use one final path.

### Rationale
- Product is pre-launch, so backward compatibility is unnecessary.
- Avoids temporary complexity and long-tail bugs from split auth semantics.

### Consequences
- Any old session token formats are intentionally invalid after cutover.
- Operational reset is acceptable and expected.

## 3) Keep JWT only for recovery-token flows

### Decision
- Recovery/security flows that already depend on signed short-lived tokens continue using JWT.
- Normal auth sessions do not use JWT.

### Rationale
- Recovery tokens are purpose-scoped and self-contained; this remains appropriate.
- Avoids broad changes to unrelated recovery mechanisms.

### Consequences
- Two token types exist by intent:
  - Opaque DB-backed auth sessions
  - JWT recovery tokens

## 4) Session lifecycle APIs are server-authoritative and current-session-centric

### Decision
- `logout` invalidates the current authenticated session without requiring a `sessionId` argument.
- `refreshSession` rotates the current session token and updates expiry.

### Rationale
- Prevents client misuse of arbitrary session IDs for self-logout action.
- Makes refresh explicit and compatible with opaque token rotation patterns.

### Consequences
- Client logout hooks/services call no-input logout.
- Clients must store the newly returned token on refresh.

## 5) Session table schema simplification

### Decision
- Remove legacy `session.token` column.
- Keep session/device metadata and use hashed token material as the session primary identifier.

### Rationale
- Eliminates duplicated token identifiers and ambiguous source of truth.
- Aligns schema with opaque-token verification model.

### Consequences
- Migration baseline reflects a single-session-token representation.

## 6) Migration strategy: generated-only + baseline reset

### Decision
- Follow repository policy: never hand-author migrations.
- Regenerate migrations from schema after deleting prior migration history and meta.
- Recreate local Postgres Docker volume/database before generation.

### Rationale
- Resolves drift/branching conflicts in local migration history.
- Produces one coherent baseline for continued development.

### Consequences
- New baseline migration is `packages/db/src/migrations/0000_fresh_pandemic.sql`.
- Prior migration files/snapshots are intentionally removed in this branch state.

## 7) Non-goals for this refactor

- No backward-compatibility bridge for old auth tokens.
- No build/dev-server workflow changes.
- No broad product UX changes beyond auth session semantics.
