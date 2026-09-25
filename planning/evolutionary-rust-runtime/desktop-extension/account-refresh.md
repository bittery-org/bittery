# Desktop Account refresh

## Frontier resolution

Question: who preserves Desktop's authenticated Account refresh when the renderer stops owning
Sessions and the AccountStore?

Answer: Core's existing background driver owns this read-only lane. No new public request or host
policy is required. Activate it only for the configured Desktop platform; Web and Mobile retain
their existing behavior until their own callers migrate. Reuse the Device clock/timer, bounded
authenticated HTTP, Session refresh and Account lifecycle fences. Hosts merely poll the existing
driver. This is routine preservation of mounted behavior, not a new product choice.

Actual callers: `apps/desktop/src/routes/vault/route.tsx` mounts
`packages/core/src/hooks/auth/use-account-metadata-sync.ts` at a 60-second interval. It calls
Account-specific `GET /api/v1/auth/me`; when the Team avatar changes it updates Team name/avatar.
`apps/desktop/src/hooks/use-desktop-sync.ts` independently validates all retained Sessions at startup
and every five minutes online, including locked Accounts. Its unauthorized path calls
`lockInvalidSession` in `packages/core/src/services/account-lifecycle.ts`, then
`AccountStore.clearSession`: JWT, wrapped Vault keys, encrypted private key, live MUK and biometric
grace are retired. Quick Unlock material, Account metadata and encrypted Item cache survive.
Core's existing `mark_reauthentication_required` alone does not implement that retirement.

## Contract

- Validate each retained Account Session on driver startup and every five minutes, including while
  locked. Refresh Team display metadata for unlocked Accounts every minute. Coalesce coincident
  reads. Missing Session, signed-out Account, pending teardown and failed Account storage perform
  no HTTP. No retry spin: transient/offline/malformed responses retain state and wait for the next
  bounded scheduled attempt. Other Accounts remain independently runnable.
- Generate `MeResponse` from the existing Server OpenAPI contract. Use exact Account Server and
  consent configuration, existing bearer handling, finite response limits, and existing single
  Session-refresh opportunity after unauthorized HTTP. Never perform password sign-in or create
  a new credential. A successful response must name the installed Server User before publication.
- Capture Account incarnation, access/lock epoch and exact Session identity. Lock, removal,
  replacement, refresh by another request or owner loss wins over late results. Work participates
  in existing cancellation/drain and execution fences; a stale result cannot write metadata,
  Session credentials or waiting state into a newer owner. Metadata updates preserve all unrelated
  Account fields, update only the existing Team fields, and publish through RuntimeStatus.
- Definitively refused Session renewal retires live access and removes only the refused current
  Session under the existing Account lifecycle. Retain Quick Unlock and all accepted Replica work,
  publish reauthentication required, and retire biometric grace. Do not substitute SignOut, whose
  contract forgets Quick Unlock. Storage failures remain errors and cannot claim successful cleanup.
  After a failed credential deletion, the same per-Account future retries retirement at a bounded
  Device-timer deadline without more HTTP. Each retry proves the exact refused Session and Account
  generation; an already absent Session is accepted only to finish that same pending lock epoch
  after an ambiguous deletion result. Replacement ends the old cleanup without touching new access.
- Renderer migration in 66 removes both legacy timers and authenticated callers atomically with
  native ownership. No second Account catalog or host-side retry policy remains.

## Acceptance

The agreed seams are actual Core open/request/observation/background-driver behavior, the existing
Device clock/timer boundary, and serialized platform/HTTP capabilities. Use controlled time and
HTTP responses to prove startup/one-minute/five-minute boundaries, locked validation, coalescing,
metadata persistence/publication, cross-Account isolation, offline and malformed response retention,
one renewal then refusal, and no Web activation. Hold actual HTTP/storage boundaries across Lock,
replacement, removal and close to reproduce stale-result and drain races. Preserve Quick Unlock
and accepted work on refusal; reopening must not restore the refused Session. Verify generated
contract drift and exact HTTP request semantics. Real Desktop/server periodic refresh and offline
reconnect remain application acceptance under 66/73, not claims from capability doubles.
