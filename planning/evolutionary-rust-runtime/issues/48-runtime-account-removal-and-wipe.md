# Move Account removal and Device Wipe into the Runtime

Type: task
Status: resolved
Blocked by: 22
Spec: ../spec.md#web-cutover

## Delivered

Runtime owns explicit `RemoveAccount { accountId }` and Device-wide `Wipe`. Web lifecycle callers
use it; shared transitional lifecycle code remains for hosts not yet migrated.
The closing commits `4f3aa61f`, `17bc20e0`, and `e2708c40` completed Web reachability, rendered
teardown acceptance, and serial actual-Chromium CI. Both full repository gates passed at completion.

## Local teardown contract

- Remove names exactly one Account; Wipe includes orphaned Account/device records in Runtime-owned
  namespaces. Both explicitly authorize deletion of pending accepted Operations. Neither claims to
  cancel or reverse a Server effect.
- Fence admission, catalog transitions, Account execution, observations, plaintext delivery,
  keys, dispatch, and preparation before deleting Replica, protected platform material, artifacts,
  and host spool state. [Ticket 53](53-runtime-create-vault-lifecycle.md) extends this to Vault images.
- Return the explicit scope and bounded redacted `complete | incomplete` phase result. Success
  requires every phase. Retry uses the same scope, tolerates missing records, and has no attempt
  ceiling. Cancellation does not interrupt the irreversible authority.
- Catalog detachment precedes namespace/Replica destruction. Partial failures retain same-Runtime
  pending-scope fencing while unrelated Accounts remain usable. A Device wipe can need more than
  two attempts; a missing catalog entry is not proof its rows were deleted.
- Remove requires an open Runtime. Wipe requires only a non-closed Runtime and serializes with open,
  so corrupt catalog/Replica startup remains wipeable. Web retains the failed-open Runtime for this
  exact request. Uncertain close/ownership failure cannot start a second Runtime.
- Host cleanup uses closed scope-specific responses. Account cleanup preserves other Accounts;
  Device cleanup stays inside owned namespaces. Binary cleanup shares the upload lifecycle locks.
- Existing Web subscriptions must be rebuilt after Wipe; retired observations are not live views
  of the emptied Device.

## Web gestures

The shared Runtime contract is host-neutral; Web composes these existing product gestures:

- Sidebar “Log out” confirms and then removes the Account. Resolve Runtime and transitional IDs
  once, retain them through retries/dialog dismissal, run Runtime removal first, and clear browser
  leftovers only after completion. Incomplete removal stays visible without navigation.
- “Use a different account” performs Session retirement, not destructive removal. It must leave a
  usable full sign-in form.
- Danger Zone deletion is Server-first, using the typed Runtime command below. A Server refusal
  destroys nothing locally.
- After repeated local failure, browser-only escape may clear transitional data or forget the
  browser Session. It never calls Runtime/Server, preserves `bittery_runtime_account_id`, and reports
  `browserDataCleared` or `browserSessionForgotten` rather than removal. No success navigation,
  deletion toast, or retry control follows an escape. Deletion escape requires authoritative
  `serverDeleted` first.
- Runtime and transitional Account IDs name different stores. Startup with a null transitional
  pointer and nonempty Account list selects the first listed Account; it creates/reuses a synthetic
  ID only for an empty list.
- No Web Device-wipe screen was added. Wipe is available through the Runtime API and tests.

## Authenticated Server deletion

`DeleteServerAccount { accountId, confirmEmail, requestId }` is a narrow foreground Runtime command,
not a durable Operation or a combined local teardown. Runtime owns current-Session HTTP and fencing;
Web owns the durable user gesture.

Normalize confirmation email with the shared trim/lowercase/NFKC function; require nonempty and at
most 254 UTF-8 bytes. The host durably records a canonical lowercase UUID v4 before dispatch.
Send the existing `DELETE /api/v1/users/me` with deterministic `{ confirmEmail }` and required
`Idempotency-Key`. Return explicit Account/request identity and
`deleted | confirmationEmailMismatch | blocked`; mismatched echoed identity is an invariant failure.

### Retained Server proof

A separate `account_deletion_outcome` table survives User/Session cascade. It stores only request UUID,
domain-separated credential proof and request fingerprint, closed outcome, and timestamp.
No User/email/token/body, mutable claim, or automatic expiry is retained. Exactly one row is allowed
per request ID, and at most one deleted row per credential proof.

`frame(bytes)` is u64 big-endian byte length followed by bytes:

- Proof: `SHA-256(frame("bittery/account-deletion-proof/v1") || frame(rawBearerUtf8))`.
- Fingerprint: `SHA-256(frame("bittery/account-deletion-request/v1") || frame("DELETE") ||
  frame("/api/v1/users/me") || frame(canonicalRequestId) || frame(canonicalJsonBody))`.

A request-ID advisory transaction lock precedes the retained-row re-read. Compare proof in constant
time and fingerprint exactly. Exact original bearer/request replay reconstructs the original
200/400/409 after cascade; UUID possession alone, refreshed/foreign bearer, or changed bytes do not.
Mismatch returns indistinguishable 401 without mutation.

With no retained row, recheck live authentication and rate limits, lock User/credential and Team
authority, and decide email/owner constraints. Success commits audit, User cascade, and outcome
together; refusal commits its closed decision without deletion. Infrastructure/rate-limit failure
commits neither. Shared Team authority locks cover membership and Vault transitions that can change
the deletion decision. Observe insert/replay/outcome/rate-limit/growth/uniqueness signals without
logging proofs, fingerprints, credentials, or email.

Success is 200; wrong email is 400 `ACCOUNT_DELETION_CONFIRMATION_MISMATCH`; owner constraints are
409 `ACCOUNT_DELETION_BLOCKED`. Exact retries retain the original refusal even after authority changes.
A corrected gesture uses a fresh UUID. `Idempotency-Replayed` remains a transport hint on this route,
independent of the legacy response-cache wrapper that ticket 29 will remove.

### Runtime fencing and classification

Acquire teardown admission before the explicit Account execution fence; recheck open/incarnation.
Hold both across Session load, request, optional renewal, and classification. Only the first
authoritative 401 may trigger one durable refresh and identical retry. Transport ambiguity never
refreshes or destroys original retry authority. A second 401/missing Session requires authentication.

Check cancellation before first dispatch. Once dispatched, finish fenced classification; close
waits and suppresses later mutable publication. Transport loss, 408/425/429/5xx, invalid/oversized
responses, or post-dispatch ambiguity mean unconfirmed, never “not deleted.”

### Durable Web marker

The versioned marker contains Runtime/transitional Account IDs, normalized email, UUID, and phase:

1. Persist `prepared` before granting any transport authority.
2. Persist `dispatchedUnknown` before invoking Runtime with those exact values.
3. On authoritative deletion, persist `serverDeleted` before local removal.
4. Remove Runtime Account, clear its transitional browser data, then clear the marker.

Recovery runs before Web authentication/Bootstrap can rotate the original bearer.
`dispatchedUnknown` gates Sign-out and Remove and replays exactly; it has no expiry or abandonment
interpretation. Definitive pre-dispatch refusal, retained closed refusal, or authoritative 401 can
clear it. Transport ambiguity cannot. `serverDeleted` skips the Server on reload and retries only
local cleanup; browser-only escape is permitted only in this phase. `prepared` may be cancelled.

Settings receives validated email through RuntimeStatus, including restored metadata; missing
validated identity is not fabricated. It never reads Runtime storage or mirrors credentials.

## Verification and host limits

Coverage includes exact Account/orphan scope, every teardown phase failure, repeated retry,
runner/key/capability fencing, failed-open Wipe, and actual Web confirmation/cancel/incomplete/escape.
Server tests cover lost-response post-cascade replay, refusal replay after authority changes,
proof/fingerprint mismatch, rollback, concurrency, and Team authority races. Browser tests cover
marker-before-dispatch, every reload phase, deletion recovery before refresh, and explicit target
isolation.

Native/Extension host cutovers remain later slices. A hung open (for example a blocked IndexedDB
upgrade) is distinct from a failed open; [ticket 38](38-replica-persistence-evolution.md) owns the
remaining blocked-upgrade behavior.
