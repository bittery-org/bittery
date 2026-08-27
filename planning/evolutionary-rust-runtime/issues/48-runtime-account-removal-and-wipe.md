# Move Account removal and Device Wipe into the Runtime

Type: task
Status: ready-for-agent
Blocked by: 22
Spec: ../spec.md#web-cutover

## Outcome

The Rust Runtime owns explicit single-Account removal and whole-Device Wipe, destroys every named
Account's protected material and Replica—including protected Share capabilities—and reports enough
closed teardown state that no host can claim success after a partial wipe or infer an active Account.

## Problem

Ticket 28's decided Share capability lifecycle says Sign-out, Account removal, and Wipe destroy the
locally protected capability. Client Runtime currently exposes only `Lock` and `SignOut`. The
remaining `removeAccount(accountId)` and `wipeDevice()` orchestration is owned by
`packages/core/src/services/account-lifecycle.ts` and coordinates several host stores outside the
Runtime protocol. There is therefore no public Runtime seam at which Ticket 28 can prove capability
destruction for those two teardown actions.

Folding the missing general lifecycle protocol into the Share acceptance correction would make a
Share slice decide unrelated partial-failure and destructive-operation semantics. Leaving it in
TypeScript would preserve a transitional owner after the final Web cutover.

## Decision required

Choose the closed Runtime request and response semantics for:

- explicit `RemoveAccount { accountId }`, which removes exactly one installed Account; and
- device-wide `Wipe`, which removes every installed and orphaned local Account/device record.

The decision must state whether an explicit removal/Wipe may destroy still-pending accepted
Operations, how the Runtime fences their runners first, and what one caller observes when Replica,
platform storage, or host cleanup succeeds only partially. It must not use active-Account scope.

## Recommendation

Expose two distinct requests. Treat either as an explicit irreversible local-destruction authority,
not as per-Operation discard: first fence all selected Account runners, then delete their complete
Replica and protected platform state. Return a closed, idempotent teardown outcome naming the
requested scope and any bounded phase failures; never return success while named data may remain.
This preserves the existing single-Account versus whole-Device distinction and gives Web, Desktop,
Extension, iOS, and Android one host-independent truth.

## Work after decision

- Add the two explicit Runtime requests and one closed teardown outcome without active-Account
  lookup.
- Move the existing lifecycle ordering behind a deep Runtime module; host adapters implement only
  primitive deletion of named Replica/platform records.
- Fence dispatch, preparation, observations, plaintext leases, and live keys before deletion.
- Delete the selected Replica rows, protected Share capabilities, Session/Quick Unlock/account
  metadata, cached ciphertext, and device material according to the selected scope.
- Make repeated removal/Wipe idempotent and preserve bounded, redacted failure reporting.
- Cut every host over and remove the transitional TypeScript lifecycle owner in Ticket 28's final
  host slice.

## Verification

Behavioral tests prove exact Account scope, whole-Device scope including orphaned records, runner
fencing before deletion, protected Share capability destruction, no implicit active Account,
idempotent retry after every partial failure point, and no plaintext or credential logging. A
reachability audit proves no final host invokes the transitional lifecycle owner.

## Comments

### 2026-08-27 — deletion dialog browser-only escape delivered

Commit `96ade6a5` delivers the Danger Zone deletion's browser-only escape. It appears only after the
Server Account is authoritatively deleted and repeated local removal attempts still fail. It reuses
`clearBrowserStoredDataOnly`, but the deletion overload enforces the narrower authority at the pure
module boundary: a Server refusal, a first local failure, or a report without a named transitional
target cannot be turned into permission to clear anything.

The escape clears only the transitional Account data this browser stored, including the Secret Key,
then forgets that transitional Account id. It does not call the Server or the Runtime and leaves
`bittery_runtime_account_id` in place. Its terminal outcome is `browserDataCleared`, never
`deleted`: the dialog clears its query cache, stays on the page, offers no removal retry, emits no
successful Account-deletion toast, and states in both English and German that Runtime-owned Account
data can remain on the Device. A failed clear stays `incomplete`, retains the already-deleted Server
fact, and reports its own failure instead of claiming deletion succeeded.

Focused behavioral coverage proves that two failed deletion attempts make one Server call and two
Runtime calls, while the escape itself makes neither; that the Server-side authority gate cannot be
bypassed; and that a null target remains incomplete and clears nothing. The component source
tripwire proves the clear button dispatches the browser-only action, bounds the terminal branch so
navigation and a success toast cannot hide elsewhere in the file, and pins the terminal controls and
truthful bilingual copy. The final focused run passed 66 tests with 0 failures and 261 expectations.
`turbo -F web check-types` completed 11/11 tasks, the en/de key-parity check passed, Biome on the four
changed TypeScript/TSX files was clean, i18n generation produced no tracked changes, and
`git diff --check` was clean.

Independent review found no production defect. It found three coverage gaps and the writer corrected
all three: the dispatch assertion had not proved that the clear action called
`clearBrowserStoredDataOnly`; the terminal assertion had not proved that the browser-cleared branch
could not emit the successful Account-deletion toast; and the null-target guard had no exact
regression proof. Fresh re-review killed each corresponding mutation: routing both actions back to
`deleteAccountEverywhereFromDevice`, adding `toast.success` to the browser-cleared arm, and returning
`browserDataCleared` for a null target each failed its focused test. The source was restored after
every mutation and the final focused suite passed.

Ticket 48 now owes only slice 4d: repair and extend the end-to-end wiring, update transitional-key
shape assertions, complete the Web reachability audit, decide whether the Chromium Runtime tests join
a repository gate, and run the full TypeScript and Rust gates from a clean tree. `Status:` stays
`ready-for-agent`.

### 2026-08-27 — start-up seeding rule delivered: abandoned removal re-selects its Account

Commit `78eed595` delivers the binding start-up rule. When `initializeStorage()` finds no active
Account pointer, it now reads the ordered Accounts list and re-points at its first Account. It mints
or reuses the synthetic `bittery_web_account_id` only when that list is empty. An existing pointer
still wins, SSR remains a no-op without consuming the browser initialization, and the memoized rule
still runs only once per page load.

The behavioral RED was exact. Before the production change,
`pnpm --filter web exec bun test src/lib/storage.test.ts -t "re-points an abandoned removal at the listed transitional Account"`
exited 1 with 0 passing and 1 failing: it expected `login-account` and received the generated UUID
`4aa477c2-ef2d-4f09-8667-67f78fb3599f`. That proves the old path minted a synthetic name over the
surviving login Account rather than merely failing during setup.

The new focused file covers an existing pointer, an abandoned removal, synthetic-id creation and
reuse for an empty list, once-per-page-load memoization, and SSR followed by browser initialization.
Its final run passed 5 tests, 0 failed, with 14 expectations. The adjacent false-success regression,
`account-removal.test.ts -t "a retry never reports removed while transitional values survive"`,
passed with 1 test, 40 filtered and 0 failed. `turbo -F web check-types` completed 11/11 tasks;
Biome on both changed files and `git diff --check` were clean.

Independent review found no production defect. It did find that the original single-Account fixture
could not kill a first-to-last selection mutation: changing `accounts[0]` to the last Account left
all 5 tests green. The writer added a second Account with a distinct ordering. Re-review applied the
same mutation and obtained the intended failure—expected `login-account`, received
`other-account`, with 4 passing and 1 failing—then restored the source and confirmed 5/5 passing.

Ticket 48 still owes the deletion dialog's browser-only escape and slice 4d's end-to-end wiring,
reachability audit, gate decisions, and full gates. `Status:` stays `ready-for-agent`.

### 2026-08-27 — slice 4c-2 delivered: Web account switching and deletion route through the Runtime

Commit `c663f3ec` delivers slice 4c-2. The last two Web teardown gestures now go through the
Runtime and report what survived, reusing the orchestrator slice 4c-1 built rather than adding a
second one.

"Use a different account" retires the Session. It does not destroy the Account. That button sits on
the locked screen, so anyone at the keyboard reaches it, and a one-click irreversible removal there
could destroy a Replica still holding Operations this Device never sent. A retirement already drops
every secret that matters and leaves ciphertext under keys the Device no longer holds, so the
user's intent is fully served. The gesture's dependencies carry no removal call, so escalating it
later is a compile error rather than a judgement.

The Danger Zone deletion keeps its server-first ordering, which the Runtime cannot express because
it has no notion of a Server delete. Names resolve first, then the Server deletes, and only then does
the Runtime become the authority over the local half. A Server refusal destroys nothing locally. An
Account this Device cannot name stops before the Server is asked, because deleting it there would
strand a local copy nothing could afterwards name.

Real defects fixed here, all found by independent review:

- The dialog reported success while local data survived, because only the Server step surfaced and
  every local failure was dropped. It also never signed the Runtime out, so the live master unlock
  key and decrypted Items outlived a Server-side Account deletion.
- The fact that the Server had already deleted the Account was held in React memory. Deleting the
  Account makes the next request answer 401, and the 401 handler replaces the whole document, so
  that memory died exactly when it was needed. The retry then asked the Server for an Account it no
  longer had, took the failure as "still there", and blocked local destruction permanently. The
  fact is now persisted, keyed by the Account name it belongs to, and believed only when it matches
  the name the attempt just resolved.
- Routing "Use a different account" through the Runtime made it inherit the Runtime's ability to be
  wedged, and it is the only control on that screen: the email field stays disabled while a quick
  unlock is offered. A wedged Device therefore trapped the user with no way to sign in as anybody
  else. After repeated refusal the gesture now offers to forget this browser's sign-in alone, and
  says plainly that the Account stays on the Device.
- That escape dropped the Secret Key but left the same disabled field on screen, because the query
  gating it is stale-timed and nothing invalidated it. It now invalidates, so the screen becomes an
  ordinary sign-in.
- A comment claimed a failed switch left the user where they started and an ordinary retry was the
  whole answer. That was false, and it was the one piece of recorded reasoning in the slice that was
  wrong.

Coverage gaps closed, not production defects: the two behaviours this slice was written to
establish were the two that survived mutation. A record this browser cannot read must never stand
in for a Server delete, and a record it cannot write must never block a destruction the Server
already completed. Three source tripwires were also re-bounded to their own branch: each previously
survived the exact mutation its comment warned about.

Recorded, deliberately not changed here:

- The deletion dialog has no browser-only escape. After a Server deletion a wedged Device leaves the
  Secret Key in plain storage for an Account that no longer exists. Persisting the Server fact
  shrinks this to a true Runtime wedge; the escape and its copy are a follow-up slice, because the
  existing wording would be false there.
- After the 401 replaces the document the Danger Zone dialog does not mount, so the retry the
  persisted record enables is not yet reachable end to end. That is wiring, and belongs with the
  other Web coverage slice 4d owes.
- An unnamed transitional Account still stops both gestures for the rest of the page load. The
  refusal is right; the start-up seeding rule owns the cause.

`bun test src` in `apps/web` is 375 passing. At the package root `bun test` also reports 20
failures, all pre-existing Playwright specs that cannot run under bun. Type checks, Biome and en/de
key parity are clean. `Status:` stays `ready-for-agent`; the start-up seeding rule, the deletion
dialog's browser-only escape, and 4d are still owed.

### 2026-08-27 — slice 4c-1 delivered: Web log out routes through the Runtime

**Slice 4c was split in two.** The frontier comment below plans 4c as one sub-slice. In practice it
became **4c-1**, the sidebar "Log out" gesture, delivered here in commit `093ebb9b`; and **4c-2**,
the other two Web entry points, still owed and defined at the end of this comment. Any later
reference to "4c-2" means that remainder.

The Web "Log out" button removes the Account from this Device. That meaning is deliberate for a
browser and stays. It now runs through the Runtime, asks before it destroys, and says what survived
when it cannot finish. Before, one menu click ran a Runtime sign-out whose error was swallowed,
cleared the transitional store through a function returning `Promise<void>`, and navigated to the
login screen regardless. A partial failure was invisible.

The gesture resolves both Account names once, runs Runtime `RemoveAccount` as the authority, and
clears the transitional Web store only on `complete`. The two name different things: the Runtime
owns the Replica, its platform namespace, Attachment artifacts and the OPFS spool, while the
transitional store owns the `bittery_account_*` keys and the item cache. They are composed, not
swapped. The reverse order would let the interface look signed out over a surviving Replica.

An `incomplete` outcome keeps the dialog open, lists the surviving areas in user language rather
than phase names, and offers a retry. Retry is unbounded by construction, because convergence can
need three attempts. It reuses the carried Account name instead of resolving again: once catalog
detachment succeeds the catalog no longer answers for that Account, and a second resolve could
return a different one.

Account-scope removal still requires an open Runtime, so a wedged Device refuses it forever, and the
local Secret Key would become unreachable with it. Per the maintainer's decision, a second action
appears after repeated failure. It clears this browser's stored data only and says exactly that. It
touches no Runtime-owned state, reports its own `browserDataCleared` status, never claims the
Account was removed, and does not navigate.

Four real defects, found by independent review and fixed here:

- A retry could report success while `secret_key`, `session_data`, `vault_keys` and `jwt_token`
  survived. The store nulls its active pointer before it sweeps values and never rethrows, so a
  half-finished clear left a null pointer that the next attempt read as nothing to do. Both Account
  names now travel across attempts, and an unnamed target is `incomplete`, never success. The shape
  that allowed it is deleted, so the guard is a type error rather than a check somebody can drop.
- A throw from any dependency other than the Runtime call locked the dialog on "Removing…" forever,
  with both buttons disabled and Escape blocked. Every step after the Runtime call is now wrapped in
  the module the tests can reach.
- Closing the dialog discarded the report, so the next attempt resolved again and could report
  success over the same surviving data. The report now outlives the dialog.
- The failure copy claimed nothing had been deleted. That is wrong for a Runtime that answered, and
  wrong for a transport that dropped mid-request.

Coverage gaps closed, not production defects: a test double asserted the unnamed-sweep bug as
intended behaviour, which is why no test caught it; the fix that closed the last defect had no test
of its own; one guard clause was pinned only by a vacuous assertion; and a navigation tripwire
counted one of the two ways this file reaches the login screen.

Recorded, deliberately not changed here:

- A dependency that never settles still holds the dialog, because Escape is blocked while busy. That
  trade-off is deliberate.
- Reloading after a half-removal re-seeds the store under the synthetic pre-login name rather than
  the login name the surviving keys use, so a later log out can again report success over live
  material. The maintainer has since answered this; see the start-up rule comment above. It is the
  same false-success class as the first defect above, one within a page load and one across a
  reload.
- Every other host on the shared lifecycle module has the same retry hazard. Only Web works around
  it.

**Three independent reviews.** The first confirmed the Runtime-first ordering, the retry contract
that carries `accountId`, the observation-scope claim, and that no phase name reaches the user. It
returned five should-fix items. The second found a **blocker**: the same false-success defect had
moved rather than died. Closing the dialog discarded the report, so the next attempt re-resolved,
read a null pointer as "nothing to do", and reported `removed` while `secret_key`, `session_data`,
`vault_keys` and `jwt_token` survived. The third cleared the slice and proved the fix holds
structurally: deleting either guard is now a **compile error**, not a silent regression. The test
double that had asserted the bug as intended behaviour was flipped, and four coverage gaps were
closed, including one where the fix that closed the blocker had no test of its own.

**What 4c-2 still owes.** Both entry points must reuse `apps/web/src/lib/account-removal.ts` rather
than adding a second orchestrator.

- `apps/web/src/components/sign-in-form.tsx` — "Use a different account". Today it calls
  `runtimeClient.signOut(accountId).catch(() => undefined)`, then `forgetActiveSession(...)`, then
  an unconditional `window.location.reload()`. The outcome is discarded.
- `apps/web/src/components/settings/delete-account-dialog.tsx` — the Danger Zone deletion. It must
  **keep its server-first ordering**. `deleteAccountEverywhere` is the only place in the codebase
  where a failed server call prevents local destruction, and the Runtime has no notion of a server
  delete, so the Web handler must re-express that ordering itself. Today only the server step
  surfaces, every local failure is dropped, and it never signs the Runtime out. So the Runtime keeps
  the live master unlock key and decrypted Items after a server-side Account deletion.

**What 4d inherits from 4c-1.**

- The confirmation dialog breaks the shared end-to-end `signOut` fixture at
  `apps/web/tests/fixtures/auth.ts`, which now hangs waiting for a navigation that no longer
  happens. Three specs break with it: `apps/web/tests/e2e/smoke.spec.ts`,
  `apps/web/tests/e2e/auth-signin.spec.ts` and `apps/web/tests/e2e/auth-recovery.spec.ts`. The
  fixture needs the confirm click. The new test ids are `log-out-dialog`, `log-out-confirm`,
  `log-out-cancel` and `log-out-incomplete-areas`.
- `apps/web` has **no DOM test harness**, so 4c-1 kept every decision in a pure module and left the
  wiring untested. 4d owes Playwright coverage for: the menu item destroying nothing until
  confirmed; a successful removal clearing the query cache and landing on `/login`; an incomplete
  removal keeping the dialog open without navigating; a throw from `manager.refresh()` or
  `localStorage` re-enabling the buttons instead of wedging on "Removing…"; the escape hatch
  appearing only on the second failure and leaving `bittery_runtime_account_id` in place;
  `browserDataCleared` showing its own title, offering no retry, and not navigating; and the
  transitional id read resolving to the **login** id rather than the synthetic seed for a signed-in
  user.

`pnpm --filter web test` is 366 passing. `turbo -F web check-types` and `biome check .` are clean.
`Status:` stays `ready-for-agent`; 4c-2, the start-up seeding rule, and 4d are still owed.

### 2026-08-27 — start-up rule decided: a null pointer with accounts is an abandoned removal

The maintainer answered the hazard that slice 4c-1 recorded and deliberately left open. This answer
is binding.

**Start-up must treat "no active-Account pointer, non-empty Accounts list" as an abandoned removal,
not as a fresh browser.** `initializeStorage` (`apps/web/src/lib/storage.ts:118`) re-points the
store at the listed Account. It mints a synthetic `bittery_web_account_id` only when the Accounts
list is empty.

Today it does the opposite. It reads the pointer, finds none, and seeds a new synthetic id
(`apps/web/src/lib/storage.ts:52-60`). An abandoned Account removal leaves exactly that state.
`removeAccount` writes `active_account` to `null` **before** it sweeps the Account values
(`packages/storage/src/account-store.ts:1070`), and `step()` records a failure instead of rethrowing
(`packages/core/src/services/account-lifecycle.ts:193`). So one `localStorage` failure part-way
through leaves no pointer while the Accounts list, `secret_key`, `session_data`, `vault_keys` and
`jwt_token` all survive under the login Account id.

After a reload the store therefore points at an empty synthetic Account. The next log out sweeps
that empty Account, finds nothing to delete, and reports **success**. The real key material
survives while the screen says it is gone. This is the same false-`removed` class that slice 4c-1
fixed inside one page load, reached across a reload instead.

Fixing the seeding rule removes the cause. The next log out then names the real keys, so the false
success cannot happen. Three alternatives lost:

- **Check `LifecycleOutcome.remaining` after the sweep.** The independent 4c-1 review ruled this
  unsound as a fix. It looks like a fix and leaves the cause in place. It is blind to a failed
  `clear_item_cache`, which never touches the Accounts list. And it reports `incomplete` forever in
  a browser that genuinely holds more than one Account.
- **Surface the half state in the interface.** This adds new surface and new copy to a path almost
  nobody reaches.
- **Leave it recorded and change nothing.** This keeps a screen that says the user's secret material
  is gone while it is still there. A post-sweep check is no better: it treats the symptom and
  strands the user with an error they cannot clear.

One risk, named plainly: this changes the start-up path. It runs in every session, not only at log
out. It needs careful tests, and the slice must budget for them.

Where it belongs: its own bounded slice, sequenced after 4c-2 and before or within 4d, and finished
before Ticket 48 resolves. It touches `apps/web/src/lib/storage.ts` — `initializeStorage` and the
seeding rule — and its tests. That file has no test file today, so the slice adds one. Note that
`initializeStorage()` memoises its promise, so the rule applies once per page load, not per call.

`Status:` stays `ready-for-agent`.

### 2026-08-27 — slice 4b delivered: a wedged Device stays wipeable

Commit `043a5938` delivers sub-slice 4b. A user reaches for "wipe this device" exactly when the
Device is wedged, and until now the Runtime refused that request.

`teardown()` required `ensure_open()`, which fails unless the Runtime reached `ready`. `open()`
fails permanently for an incarnation when the platform catalog or the Replica cannot load, when an
active Account has no durable Replica or no generation metadata, when the two disagree, or when a
catalog incarnation cannot be reconciled. Clearing IndexedDB but not `localStorage` reaches that
state. At the Web layer it was worse: the worker closed the created Runtime and rethrew, so no
Runtime object survived to receive a `Wipe` at all. The transitional owner has no readiness
precondition and works fine there, so routing Web teardown through the Runtime unchanged would have
been a straight recovery regression.

Device `Wipe` now requires only `ensure_not_closed()`
(`packages/client-runtime/crates/bittery-client-core/src/runtime/teardown.rs:129`). That is safe
because the Device phases are namespace-wide and read no catalog, and `catalog_transition`
(`packages/client-runtime/crates/bittery-client-core/src/runtime.rs:437`) still serializes a wipe
against a concurrent `open()`. Account-scope `RemoveAccount` keeps `ensure_open()`. The Web worker
keeps a Runtime whose `open()` threw and forwards an exact `{"type":"wipe"}` to it, so the Runtime
stays the single destruction authority; the host adds no deletion code.

A `terminalFailure` wedge deliberately gets no escape hatch. It is in-memory and dies with the
worker, and a reload reaches the durable wedged-`open()` path where the hatch does apply. It is also
only ever set after `close()` rejected, so serving a wipe would mean a second Runtime over the same
IndexedDB and OPFS handles while the first may still be writing.

Three real defects, found by independent review and fixed here. The first two share one shape, a
request racing a closing Runtime:

- `retire()` tested its holder count synchronously, but a wipe takes its hold only after it yields.
  Any other request arriving first closed the Runtime under the live wipe, and the next request
  opened a second Runtime over the same storage, where `open()` could write a reconciled catalog
  after the wipe deleted the namespace. A `wipesPending` count is now taken before the first await.
- `retire()` then still cleared the Runtime slot before awaiting the close, so a request arriving
  mid-close built a second Runtime anyway. A restart barrier now makes callers wait. Nothing had
  guarded this by design; it happened to be safe only because IndexedDB serializes overlapping
  transactions.
- `close()` reported a clean shutdown when a retiring close failed, which contradicts the two
  sibling paths in the same function that exist to surface exactly that failure.

Coverage gaps closed, not production defects: the hold and release mechanism had no behavioural test
at all, and deleting its guard left the whole suite passing. Both continuation orderings are now
covered separately, because the defect appears in only one of them. The post-wipe asymmetry, where a
wipe keeps its answer while later requests are poisoned, gained a comment and a test.

Recorded, deliberately not changed here:

- After a wedged wipe the Runtime stays not `ready`. That is load-bearing rather than a gap: the
  dispatcher idles on an empty snapshot list and preparation eligibility idles on `ready`, so no
  background writer races the destroy.
- Two deviations in the barrier fix are correct but untested: escalating the failure inside the
  rejection handler rather than after the await, and clearing the barrier by identity. Both matter
  only in an ordering the current test doubles cannot produce.

**Three independent reviews.** The first found the Core relaxation sound. It verified that each
Device phase genuinely destroys on a never-opened Runtime rather than silently finding nothing, that
`open()` and `Wipe` are serialized by `catalog_transition`, and it probed the host-side
`isDeviceWipe` predicate (`packages/client-runtime/src/worker-runtime.ts:176`) with fifteen hostile
payloads, including duplicate keys, unicode escapes, and prototype-polluting keys. It found one
blocker. The second review cleared that fix and found the second defect of the same shape, which two
earlier reviews had missed. The third cleared the result as ship. It also overruled a proposal to
merely record the `close()` reporting bug: the two sibling paths in the same function exist
specifically to surface that failure, so resolving there was an inconsistency, not a design choice.

Two gate facts that outlive this slice:

- `pnpm --filter @bittery/client-runtime check` runs **no** TypeScript tests, and neither does
  `pnpm check:ci:rust`. Only `pnpm check:ci` runs `bun test src`. A slice that moves TypeScript and
  runs only the Rust gate ships untested. Every slice in this migration must run both.
- The kernel OOM killer ended this session three times, because reviewers copied the repository into
  the RAM-backed `/tmp` and built Rust there on a 15 GB box with no swap. A subagent must never copy
  the repository and never build Rust under `/tmp`; scratch belongs under `/home/julian/.cache/`.
  See `../handoff-2026-08-27.md` for the detail.

What 4c inherits from 4b, on top of the two 4c dependencies 4a already recorded — the post-wipe
silent observation, and clearing the active-Account pointer and the transitional `bittery_account_*`
keys:

- Retiring a wedged incarnation after an **incomplete** wipe discards Core's in-memory pending-scope
  tombstone. The host, not Core, owns driving that retry.
- The recovery path covers an `open()` that **throws**. An `open()` that **hangs**, for example on
  an IndexedDB version-change block from another tab, produces no wedged incarnation and therefore
  no wipe path. 4c must not assume every wedge is recoverable.

`pnpm --filter @bittery/client-runtime check` passes and `bun test src` is 216 passing. Nothing
under `apps/` changed. `Status:` stays `ready-for-agent`; 4c and 4d are still owed.

### 2026-08-27 — slice 4a delivered: the Web host-cleanup seam

Commit `8d4aa7e7` delivers sub-slice 4a. Web `RemoveAccount` and `Wipe` now reach `complete`, and
observation sinks quiesce across the destroy. Until now no host installed the Core host-cleanup
seam, so every teardown returned `incomplete` with `hostCleanup`.

Host cleanup rides the transfer-control contract, which mirrors the artifact control arms slice 2
added. `ConfigurableWebBinaryTransferExecutor` is the one production owner of the OPFS
ciphertext-spool root, so `deleteAccount` and `wipeDevice` reach it over that existing seam instead
of a second handle. `JsSpoolTeardown` implements `TeardownHostCleanup` and installs in
`configured_runtime`. It converges only on the exact expected response with no side-channel bytes,
so a wrong-scope answer stays a `HostCleanup` failure. The upload path now shares the same lazy
opener, so a Device that never uploaded still destroys a directory an earlier incarnation left
behind.

`RemoveAccount` and `Wipe` now retire observations. The bookkeeping moved out of the binding into
`packages/client-runtime/crates/bittery-client-bindings/src/account_retirement.rs`, where one rule
decides suspend, resume, and catch-up alike, so they cannot drift apart. `Wipe` retires every
observation including the Device-wide one: a projection already queued in a sink is otherwise
delivered to the host while the destroy runs, which is the leak retirement exists to stop.
`RuntimeClient` gains `removeAccount` and `wipe` and returns the whole outcome, so a caller can
render `incomplete` and retry.

Real defects fixed here:

- A `RemoveAccount` that retired nothing let the host receive plaintext of the Account it was
  destroying. Reproduced end to end in real WebAssembly: without the catch-up for an observation
  admitted while a `Wipe` waits behind a slow Sign-in, the sink first leaks a projection, then the
  unbalanced resume traps the module and the request never settles.
- The retirement ledger held its lock across the counter update but not the iteration beside it, in
  all three of `begin`, `end`, and `admit`. The type advertised a protection it did not have. The
  guard now spans each operation whole. No sink re-enters the ledger, and lock order stays counts
  before sink queue on every path, so this adds no inversion.
- A rejected `OpfsUploadSpoolRoot.open()` was cached forever, so an identical teardown retry could
  never converge until the worker restarted. It reported `incomplete` rather than false success, so
  nothing lied about having deleted data, but it broke convergence within one executor lifetime.

Coverage gaps closed, not production defects: a spool answer that smuggles bytes alongside the right
scope; and the joined host-cleanup failure path, where TypeScript proved the executor throws and
Core proved an error becomes a `HostCleanup` failure, but nothing drove both halves together.

Recorded residual, deliberately not changed here. The retirement snapshot is still built outside the
guard. `observe_json` admits before it inserts, which is what keeps the current window safe. The
residual is that `request_json` builds the live observation list outside the guard; on a threaded
host that would under-suspend a sink and panic it on resume. `mod web` compiles only for wasm32 and
the executor is single threaded, so it is unreachable. Closing it means the ledger owning the
observation table, which is a design change.

**Two independent reviews, no blockers.** The first mutation-tested twelve production hunks. All
were caught, and no test passed with its production code reverted. It raised three should-fix items,
all since implemented. The second re-reviewed those corrections. It confirmed independently that the
new lock nesting goes one way only, retirement counts before sink queue; that nothing in the sink
path re-enters the ledger; and that the cleared queue holds no type with a `Drop` impl that could
re-enter. It also verified that the static-stub test at
`packages/client-runtime/src/web-binary-transfer-executor.test.ts:1081` fails loudly, not vacuously,
if its module-identity assumption ever breaks.

Four note-level follow-ups, recorded so they are not lost. None blocks 4b:

- `packages/client-runtime/crates/bittery-client-bindings/src/account_retirement.rs`: sink calls now
  happen under the guard, so a sink balance panic would poison the retirement mutex and every later
  lock would panic. On wasm32 a panic already traps the module, so this is theoretical, but it is a
  real widening of the blast radius. Worth one sentence in the doc comment.
- Same file, `counter_guard_is_held` (line 176): it returns `true` for a poisoned mutex as well as a
  would-block. A poisoned mutex would therefore make the test witness report "guarded" for every
  later change. The current tests cannot reach that. Matching only `TryLockError::WouldBlock` would
  make it airtight.
- `packages/client-runtime/crates/bittery-client-bindings/src/web.rs:351`: the comment "Resuming a
  closed sink is silent" is imprecise. `BufferedSink::end_retirement` does not check `closed` and
  would panic at zero. The path is safe only because `close()` never resets the retirement counter,
  so that counter is always at least one there. State the actual reason.
- `every_suspension_change_happens_under_the_counter_guard` asserts that unguarded changes are zero
  and that final depth is zero, but never that a suspension happened at all. Four sibling tests
  catch the combined no-op mutation, so the suite is sound. One positive assertion would make the
  test self-contained.

Two gate facts:

- Commit `d306bf85` is formatting only.
  `packages/client-runtime/scripts/combined-web-bindings.test.mjs` had failed `biome check` since
  commit `99e92c58`, so repository `pnpm check:ci` was already failing before this migration work.
  Nobody caught it because the repository-wide gate has not run from a clean tree.
  `pnpm exec biome check .` now exits 0 repo-wide.
- The actual-Chromium tests under `packages/client-runtime/tests/*.chromium.test.ts` are reachable
  from no repository gate, because the package `test` script is `bun test src`. This is pre-existing
  since slice 2. Slice 4d owes a decision: wire them into a gate, or record deliberately why a
  destructive-storage proof runs only on demand.

What the remaining sub-slices inherit:

- **4b** is next and unchanged: `ensure_not_closed()` for Device `Wipe`, plus the SharedWorker
  escape hatch, per the recorded frontier decision.
- **4c** inherits a hard dependency. After a `Wipe`, Core closes every subscription while the
  binding's sink stays open, so the host's status observation goes silent with no signal. 4c must
  reopen its observations rather than render the emptied Device through the old one. The real fix
  belongs in Core and was deliberately out of 4a's scope. 4c still owns clearing the active-Account
  pointer and the transitional `bittery_account_*` keys.
- **4d** keeps the audit, the gates, and the Chromium-reachability decision above.

`pnpm --filter @bittery/client-runtime check` passes. 394 crate tests, 203 package TypeScript tests,
and the actual-Chromium OPFS run all pass. Nothing under `apps/` or `crates/bittery-client-core/`
changed. `Status:` stays `ready-for-agent`; 4b, 4c, and 4d are still owed.

### 2026-08-27 — slice-4 frontier decided: wedged Device, destructive log out, no wipe screen

The maintainer answered the three open slice-4 questions. These answers are binding.

**A wedged Device must stay wipeable.** Device `Wipe` now requires only `ensure_not_closed()`, not
`ensure_open()`. `open()` fails permanently for an incarnation when the platform catalog or the
Replica cannot load, when an active Account has no durable Replica or no generation metadata, when
Replica and metadata disagree, or when a catalog incarnation cannot be reconciled. A user who clears
IndexedDB but keeps `localStorage` reaches exactly that state. The relaxed precondition is safe: the
Device phases are namespace-wide, they read no catalog, and `catalog_transition`
(`packages/client-runtime/crates/bittery-client-core/src/runtime.rs:437`) still serializes them
against a concurrent `open()`. The Web SharedWorker must also accept a `Wipe` after `open()` has
thrown; `packages/client-runtime/src/worker-runtime.ts` rethrows and resets the runtime task today,
so no Runtime object survives to receive the request. The Runtime stays the single destruction
authority. A second host-side deletion path was rejected: removing exactly that path is the purpose
of this ticket. Account-scope `RemoveAccount` keeps its `ensure_open()` precondition.

**Web "Log out" keeps destroying, and now asks first.** The sidebar action removes the whole Account
from the Device on one menu click. That meaning is deliberate for a browser and stays. "Log out"
routes through Runtime `RemoveAccount`. Because the action is irreversible, it asks for confirmation
before it destroys. An `incomplete` outcome shows its failed phases with a retry instead of
navigating away. Today the Runtime error is swallowed and navigation happens regardless
(`apps/web/src/components/layout/sidebar.tsx:99-102`), so a partial failure is invisible. Model the
new failure handling on `apps/web/src/router.tsx:37-74`, the one Web path that reads a lifecycle
outcome correctly. This changes an established gesture, so the same effort must update the sign-out
flow in `apps/web/tests/e2e/auth-signin.spec.ts` and the shared `signOut` fixture at
`apps/web/tests/fixtures/auth.ts:411-419`.

**No Web Device-wipe screen in this slice.** Web has no Device-wipe interface; only Desktop has one,
in the macOS menu. `Wipe` stays reachable through the Runtime API and is proven by tests, not by a
screen. Slice 4 moves ownership; it adds no product surface. A Web wipe screen can follow later.

Slice 4 therefore runs as four sequential sub-slices. Each gets a fresh implementer and an
independent reviewer, and each is green before the next starts.

1. **4a — host-cleanup seam.** Install a real `TeardownHostCleanup` on Web so `RemoveAccount` and
   `Wipe` can reach `complete`. Drive the slice-2 OPFS spool cleanup from it. Add the
   `RemoveAccount` arm to the retirement match in
   `packages/client-runtime/crates/bittery-client-bindings/src/web.rs:324-328`. Expose
   `removeAccount` and `wipe` on `RuntimeClient`
   (`packages/client-runtime/src/client/index.ts:104`). No app changes.
2. **4b — wedged-Device recovery.** `ensure_not_closed()` for Device `Wipe` in Core, plus the
   SharedWorker escape hatch. Each needs a reproducing test first.
3. **4c — Web routing.** Route the Web entry points through the Runtime, add the confirmation,
   render `incomplete` with a retry, and decide who deletes the leftover transitional
   `bittery_account_*` keys and the `bittery_runtime_account_id` pointer
   (`packages/client-runtime/src/client/session.ts:69`).
4. **4d — audit and gates.** Prove `apps/web` no longer reaches
   `@bittery/core/services/account-lifecycle`. Update the end-to-end assertions that pin
   transitional key shapes. Add the missing negative tests. Run `pnpm check:ci` and
   `pnpm check:ci:rust` from a clean tree.

Two constraints, recorded so nobody rediscovers them:

- `packages/core/src/services/account-lifecycle.ts` **cannot be deleted** in slice 4. Desktop,
  Mobile, and the Extension still depend on it. Slice 4 removes Web reachability only. The module
  and its tests stay.
- The transitional Web store keys its Accounts by a synthetic `bittery_web_account_id`
  (`apps/web/src/lib/storage.ts:50-60`). That id is **not** the Runtime's `AccountId`.
  `clearActiveAccountData()` and `runtimeClient.removeAccount(runtimeAccountId)` name different
  things and cannot be swapped one for one.

### 2026-08-27 — Core teardown state machine delivered

Commit `40220d09` delivers slice 3. The Runtime protocol now carries explicit
`RemoveAccount { accountId }` and `Wipe` as irreversible local-destruction authority. Each returns a
bounded four-phase `complete | incomplete` outcome that names the explicit Account or Device scope.
Core fences before it destroys: a Device admission write fence, catalog serialization, sorted
Account execution locks, delivery invalidation, observation closure, and key/plaintext/access
retirement all run before the first deletion. The phases compose the slice-1 and slice-2 primitives.
Catalog detachment is a dependency of namespace and Replica destruction, so a fresh Runtime can open
and retry after a catalog write failure. An `incomplete` outcome leaves a same-Runtime pending-scope
tombstone, and selected requests, dispatch, and Attachment preparation stay fenced until an
identical retry returns `complete`. Host cleanup answers with a closed
`AccountDeleted | DeviceWiped` response and rejects a wrong scope. `RuntimeRequest` and
`RuntimeResponse` now deny unknown fields, so `{"type":"wipe","accountId":"x"}` is rejected instead
of silently widened to a whole-Device destroy.

Independent review found real defects, now fixed:

- An incomplete removal of one Account rejected every `SignIn`, so it blocked sign-in to an
  unrelated Account. The Account-scope check now runs inside installation, after the authenticated
  Account identity is resolved and before the first installation write. Device scope still rejects
  every request globally.
- A pending Account tombstone refused `Wipe` and refused removal of any unrelated Account with
  `InvariantViolation`, permanently, because the tombstone lives in memory. The single slot is now a
  set of a Device flag plus Account ids, so a partial failure no longer withdraws the user's
  whole-Device destruction authority.
- From the earlier review round: an incomplete scope could revive; observation admission raced and
  `Wipe` retained global observers; a catalog failure could strand restart; host cleanup had no
  scope-specific response. Each now has a behavioral regression test.

Coverage and fixture gaps, not defects: the routing harness always reports `incomplete` because it
installs no attachment-move lifecycle and no host cleanup, so that assertion is not load-bearing;
the installation platform harness gained a `deletePrefix` arm and a named catch-all; the protocol
generator test needed Biome formatting.

Behavior recorded, not changed. Later hosts must not misread it:

- A Device wipe whose platform namespace and Replica both fail converges in **three** attempts, not
  two. A platform-namespace failure forbids the Replica phase, because the Device catalog lives in
  that namespace and destroying the Replica while the catalog survives would strand restart. Slice-4
  hosts must not implement "retry once, then report permanent failure".
- When catalog detachment succeeds but the Replica delete fails, the catalog no longer names the
  Account while its rows remain. The identical retry still converges without consulting an active
  Account, and a later sign-in for that Server identity resolves to a fresh Account id.
- `RemoveAccount` and `Wipe` ignore `RequestCancellation`. That is intended for an irreversible
  authority.

Slice 4 debt. No host calls these requests yet, so today they return `incomplete` with
`hostCleanup`. Slice 4 owes Web lifecycle composition, adaptation of the committed OPFS cleanup
primitive to the Core host-cleanup seam, a `RemoveAccount` arm in the `web.rs` retirement match
(`packages/client-runtime/crates/bittery-client-bindings/src/web.rs:324-328` drops it into
`_ => None` today, so observation sinks would not be quiesced across the destroy), and removal of
reachability to `packages/core/src/services/account-lifecycle.ts`. Slice 4 should also weigh two
recorded risks. `teardown` calls `ensure_open()`, so `Wipe` is unavailable exactly when a Device is
wedged, which would regress recovery against the transitional owner that has no such precondition.
And the admission read lock is held across a slow Sign-in, so a queued `Wipe` can stall behind it.

Gates: `pnpm --filter @bittery/client-runtime check` passed and 347 crate tests pass. Formatting,
Clippy over the workspace and all targets with warnings denied, the protocol generator `--check`,
generator tests 7/7, the native binding drift check, and `git diff --check` are all clean.
Repository-wide `pnpm check:ci` and `pnpm check:ci:rust` have not yet run from a clean tree. Ticket
48 still owes that before it resolves.

### 2026-08-26 — Artifact and upload-spool deletion primitives delivered

Commit `10fcb46f` delivers slice 2. The closed Attachment artifact control seam now supports
whole-Device wipe alongside explicit-Account deletion across native SQLite and browser IndexedDB.
Both scopes remove published artifacts, provisional metadata, ciphertext chunks, physical
generations, and hostile orphan rows in one transaction, preserve other Accounts for the narrower
scope, reject an empty Account identity, survive restart, and roll back at every one of the four
store boundaries. Persisted database versions and store names remain unchanged.

The browser ciphertext upload spool now exposes idempotent explicit-Account deletion and
whole-Device wipe inside its dedicated OPFS root. Every Account upload and cleanup holds the shared
Device lifecycle Web Lock plus its existing exclusive Account lock; Device wipe holds the exclusive
Device lock. Actual MV3 Chromium coverage proves wipe waits for an active file callback, and unit
coverage proves stale/orphan generations, colliding UTF-8 Account identities, restart, and repeated
cleanup without touching unrelated origin storage.

Implementation found two real pre-existing defects in this slice's authority: SQLite Account
deletion could leave a foreign-key-disabled orphan published chunk, and IndexedDB Account deletion
committed one record at a time rather than atomically. Both are fixed and behaviorally protected.
Independent standards/spec review found no additional defect. The orchestrator's
`pnpm --filter @bittery/client-runtime check` and focused actual-Chromium OPFS test passed, including
Rust tests, Clippy, formatting, generators and drift, native bindings, and the combined WebAssembly
binding.

Deliberately left open for slice 3: public Runtime teardown requests and closed outcomes, catalog
serialization, runner/Sync/preparation/observation and plaintext/key-lease fencing, composition of
the committed deletion authorities, and bounded `incomplete` phase reporting. Web lifecycle
cutover and reachability remain slice 4.

### 2026-08-26 — Replica and platform-state deletion primitives delivered

Commit `a1424699` delivers slice 1. The closed Replica persistence seam now supports idempotent
explicit-Account deletion and whole-Device wipe across InMemory, native SQLite, and browser
IndexedDB. SQLite and IndexedDB remove heads plus every existing numeric/store-tagged row in one
transaction, preserve other Accounts, remove orphaned rows, survive reopen, and roll back at every
injected write boundary. The shared conformance history covers deletion, repeated deletion, wipe,
and repeated wipe without changing the IndexedDB version or persisted store tags.

Rust now owns length-delimited Account and Runtime-namespace prefixes for platform state. The Web
host exposes only a generated non-empty `deletePrefix` primitive; Account cleanup spans device
plain, device secret, and session secret storage while preserving colliding UTF-8 Account identities
and unrelated host keys. Partial storage-area failure is surfaced without secret material, and an
identical retry converges.

Independent review found one real defect before commit: an empty `deleteAccount.accountId` was
wire-valid, accepted by InMemory, and rejected by SQLite/IndexedDB. The generated contract and
InMemory adapter now reject it consistently. Review also identified cache-preservation and Unicode
prefix behavior as coverage gaps rather than implementation defects; behavioral tests now protect
both. The final re-review had no findings. The orchestrator's
`pnpm --filter @bittery/client-runtime check` passed, including 316 Core tests, Clippy, formatting,
all generators and drift checks, native bindings, and the combined WebAssembly binding.

Deliberately left open for the remaining recorded slices: Attachment artifact and OPFS/upload-spool
deletion, the public Runtime teardown state machine and runner/key/lease fencing, closed
`complete | incomplete` phase reporting, and Web lifecycle composition/reachability. Browser
PlatformStorage cannot make a multi-area deletion atomic; this primitive therefore exposes failure
and idempotent retry while the Core slice will own bounded incomplete-phase reporting.

### 2026-08-26 — implementation split at storage, Core, and host boundaries

The decided teardown spans four independently failing authorities and cannot be implemented and
verified honestly in one pass. It is split before implementation, in this order:

1. **Replica and platform-state deletion primitives:** extend the closed Replica-persistence and
   platform-storage seams with idempotent explicit-Account deletion and whole-Device namespace wipe.
   Implement native SQLite and browser IndexedDB primitives, including orphaned Replica/catalog,
   Session, Quick Unlock, Account metadata, Device-key, and receipt/capability records that the
   current catalog cannot name. Restart and fault-injection tests prove exact scope, preserved
   persisted tags, retry after every primitive failure, and no secret logging. This slice exposes no
   Runtime request and edits no Attachment, spool, or host lifecycle path.
2. **Binary artifact and spool deletion primitives:** extend the closed Attachment-artifact and
   upload-spool seams with the same explicit-Account and whole-Device scopes. Native SQLite and
   browser IndexedDB/OPFS tests prove that published, provisional, pending, and orphan generations
   are removed without crossing Account scope and that repeated cleanup converges. This slice edits
   no Replica/platform state, Runtime request, or host lifecycle path.
3. **Core teardown state machine:** add the two closed Runtime requests and one scoped
   `complete | incomplete` outcome over the committed primitives. Core owns catalog serialization,
   fences dispatch, Sync, preparation, observations, plaintext/key leases, and Account installation
   before deletion, then reports bounded redacted phase failures and resumes an identical explicit
   scope idempotently. This slice edits no Web or transitional TypeScript lifecycle path.
4. **Web lifecycle composition and reachability:** expose the Core requests through the existing
   binding/client seam, route Web Account removal and Device wipe through Runtime, and remove their
   reachability to the transitional lifecycle owner. Behavioral browser tests prove named scope,
   orphan wipe, retry after partial host failure, capability destruction, and no active-Account
   inference. Desktop, Extension, iOS, and Android consume the same Runtime contract in their later
   ordered host phases rather than reimplementing it.

Generated Replica/platform persistence artifacts belong to slice 1; artifact/spool contracts belong
to slice 2; generated Runtime/native/Web protocol artifacts belong to slice 3. The four slices are
sequential. Each starts with an exact behavioral failure,
receives a fresh implementer and independent reviewer, and is independently green before the next.

### 2026-08-26 — destructive scope and partial-failure contract decided

The maintainer accepted the recommendation. `RemoveAccount { accountId }` and `Wipe` are explicit,
irreversible local-destruction authorities. After the Runtime fences every runner and plaintext/key
lease in the named scope, either request may destroy still-pending accepted Operations together with
the selected Replica and protected platform material. This is requested Account/Device teardown,
not a transport-attempt or per-Operation discard policy.

The response is closed and idempotently retryable. It names the requested Account or whole-Device
scope and returns success only after every required phase is proven complete. A partial Replica,
platform-store, or host-primitive failure returns `incomplete` with bounded redacted phase failures;
it never reports success while named data may remain. Retry resumes the same explicit scope without
consulting an active Account. The implementation must fence first, tolerate already-absent records,
and converge repeated calls to the same complete outcome.

### 2026-08-26 — filed from the durable Share acceptance correction

The correction proved successful Sign-out destruction and durable restart, Lock retention without
exposure, and actual password Quick Unlock recovery. It found no production Runtime request for
Account removal or Wipe and stopped rather than inventing their destructive/partial-failure
protocol. Ticket 28 remains blocked on this decision and implementation before final host cutover.
