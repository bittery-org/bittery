# Runtime session lifecycle, lock, and observation delivery

Type: task
Status: ready-for-agent
Blocked by: 26
Spec: ../spec.md#sign-in-and-session-behavior

## Outcome

The Runtime owns and publishes the signed-in Account state, the Web host observes it instead of
mirroring it, sign-out and lock reach the Runtime, and a projection published outside a request still
reaches the host.

## Problem

Four defects, one of them a security defect.

**Sign-out never reaches the Runtime.** `RuntimeRequest` declares only `SignIn`, `QuickUnlock`, and
`CreateLoginItem`. `Runtime::mark_account_locked` exists in `runtime/lock.rs` but no protocol variant
reaches it. The Web sign-out path clears the transitional TypeScript store only, so the Worker keeps
`AccountAccessState::Unlocked`, the live master unlock key, and the decrypted `unlocked_items` in
memory. `setRuntimeAccountId(null)` has no production caller at all; its only caller in the repository
is a test's `afterEach`.

**A restart shows an empty vault instead of a lock screen.** `runtime/open.rs` restores accounts as
`SignedOut`, so the Items observation returns `AuthenticationRequired`, and
`parseRuntimeItemsObservation` turns every failure into `[]`. The user sees the empty-vault state,
which is indistinguishable from having no Items. For a password manager that reads as data loss.

**Session state is mirrored into `localStorage`.** `apps/web/src/lib/runtime-auth.ts` keeps a module
global plus a `localStorage` key plus a listener set. The Runtime already publishes
`ObservationRequest::RuntimeStatus` carrying `access`, `waiting_reason`, and `failure` per Account,
and `runtime/install.rs` publishes on every transition. The mirror cannot represent `Locked` or
`ReauthenticationRequired`, has no invalidation, and cannot see another tab. It also inverts Quick
Unlock precedence: `getRuntimeAccountId() ?? quickUnlockAccountId` prefers the stale stored id over
the Account the form is actually offering to unlock.

**Projections published outside a request never reach JS.** `flush_observations` is called only from
`request_json` and `observe_json`. Every `publish_all_unless_closed` that runs from Sync catch-up, an
SSE hint, Session renewal, or lock fills the buffer and stops. The Items observation is written as a
live subscription and is not one.

**`storeAuthToken("runtime-session")` is a gate bypass used as a credential.** The value exists only
to make `storage.isAuthenticated()` return true for the `_app` route guard, but it is written into the
credential store and `api-client-factory` sends it as a bearer token, so the first transitional query
answers 401 and the router bounces the user to `/login`, discarding a successful Runtime Sign-in.

## Work

- Add `SignOut { account_id }` and `Lock { account_id }` request variants that reach the existing
  `mark_account_locked` and Account teardown, destroy live keys and plaintext leases, and publish the
  resulting status. Sign-out must not claim to cancel or reverse a committed Server effect; durable
  Operations survive per ticket 10.
- Drain buffered observations whenever the Runtime publishes, not only inside a request. The Web
  adapter needs a drain path that a background publish can reach.
- Delete `apps/web/src/lib/runtime-auth.ts`. Session state comes from one Device-wide
  `RuntimeStatus` observation opened once at the composition root and never torn down, because
  `RuntimeStatus { account_id: Some(x) }` answers `AccountMissing` for an uninstalled Account while
  the Device-wide form never fails.
- Keep the active-Account pointer a host UI selection, per ticket 08, but reconcile it against the
  observed catalog so a stale pointer can never win over the Runtime's truth. Put that reconciliation
  in the platform-neutral client layer, not in React.
- Surface `RuntimeErrorCode` in the host snapshot so the UI can distinguish locked, reauthentication
  required, missing Account, and unavailable, and render a lock screen rather than an empty list.
  Map codes onto the existing `m.toast_auth_*` messages instead of toasting raw Rust strings.
- Replace `storeAuthToken("runtime-session")` with a route guard that reads the observed Runtime
  status. Remove the sentinel value entirely.
- Replace the hardcoded `clientId: "bittery-web"` and `version: "0.5.2"` in the Worker entry with the
  per-browser client id the transitional path already derives and the build's version, so the Server
  can still tell two browsers apart on the Devices screen.

## Verification

Sign-out leaves no unlocked Account, no live key, and no decrypted Item in Worker memory, proven by a
Runtime-level test. A restart with a previously signed-in Account renders a lock screen and Quick
Unlock restores the same Account. A projection published by a Sync catch-up with no request in flight
reaches an open observation. Two browsers report distinct client ids. `pnpm check:ci` and
`pnpm check:ci:rust` pass.
