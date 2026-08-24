# Runtime session lifecycle, lock, and observation delivery

Type: task
Status: resolved
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

## Comments

- `SignOut` and `Lock` are both `retire_account_access` in `runtime/lock.rs`. Both destroy the live
  master unlock key, drop the decrypted Items, revoke the plaintext delivery lease, advance the lock
  epoch, and publish before the request answers. They differ only in what the Device keeps
  afterwards. `Lock` keeps the Quick Unlock material and Session, so one master password reopens the
  Account through the same full online ceremony. `SignOut` deletes that material and the Session for
  the active incarnation, so the Account needs email, master password, and Secret Key again. The
  Spec states that rule directly: quick-unlock material has no time-based expiry, and explicit
  Sign-out, Account removal, or Wipe deletes it.
- Account metadata, the durable Replica, and every accepted Operation survive a Sign-out. Sign-out
  is not a cancellation: per ticket 10 an accepted Operation stays durable until the Server returns
  its retained semantic outcome, and no local action may claim to reverse a committed Server effect.
  Removing an Account from the Device remains a separate lifecycle action.
- Sign-out is local. This slice has no Server session-revocation route, so the issued Session token
  stays valid on the Server until it expires. The Runtime does not pretend otherwise.
- Both answer `RuntimeResponse::AccessChanged { account_id, access }` with the access state the
  Device now holds. An unknown, uninstalled, or already retired Account answers `SignedOut` instead
  of failing, so a host teardown path never has to handle an error it cannot act on, and a repeated
  request is harmless.
- Open boundary for the Web slice: `open` still restores an installed Account as `SignedOut` even
  when its Quick Unlock material is intact, so `SignedOut` alone does not tell the host whether to
  offer Quick Unlock or a full Sign-in. The lock-screen bullet of this ticket still needs that
  distinction.
- Background publications now reach the Web host. The buffered sink stores the projection and wakes
  one drain task that the wasm-bindgen executor polls from a microtask, which is the only point
  where the Runtime holds no lock, no publication ordering, and no plaintext delivery lease. Drain
  policy lives in the host-testable `observation_buffer` module; `web.rs` only supplies the JS call.
- The open boundary is closed. `open` now restores an installed Account as `Locked` when the
  Device still holds its Quick Unlock document and the Device key that wraps the stored
  master unlock key, and as `SignedOut` otherwise. That is the same line `AccessRetirement`
  already draws: `Lock` keeps exactly that material and `SignOut` deletes it, so a restart
  that kept it is a locked Device and nothing else. Restoring everything as `SignedOut`
  collapsed the two states and left the host unable to tell a lock screen from a full
  Sign-in. The presence check reuses the authentication loaders, so missing or unusable
  material answers `SignedOut` instead of failing startup, and only a host or executor
  failure propagates. Both documents are zeroized on drop and startup reads nothing out of
  them. `restore_known_accounts` keeps its `SignedOut` restore: it is a Replica-only path
  with no production caller and no platform storage to consult.
- Web host shape. Session state is one Device-wide `RuntimeStatus` observation opened once in
  `apps/web/src/lib/crypto.ts` and never torn down. `src/client/session.ts` folds it and the
  injected active-Account pointer into `RuntimeSessionSnapshot`, which carries the
  `AccountAccessState`, the `AccountWaitingReason`, and the `RuntimeErrorCode` the UI
  branches on. The pointer is reconciled on every read and an explicit offer outranks it, so
  Quick Unlock targets the Account the form is offering rather than a stored id.
- One transitional gap stays open. The Runtime holds the Session and there is no route that
  hands a token to the transitional API client, so every transitional query on the Runtime
  path answers 401. Removing the `"runtime-session"` sentinel does not change that; the
  sentinel was answering 401 too. What changed is that a 401 on a request that carried no
  credential no longer locks the Account and bounces to `/login`, so it can no longer discard
  a Sign-in the Runtime completed. Ticket 22 removes those queries.
