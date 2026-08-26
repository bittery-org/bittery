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

### 2026-08-26 — implementation split at storage, Core, and host boundaries

The decided teardown spans three independently failing authorities and cannot be implemented and
verified honestly in one pass. It is split before implementation, in this order:

1. **Destructive storage primitives:** extend the closed Replica, platform-storage, Attachment
   artifact, and upload-spool persistence seams with idempotent explicit-Account deletion and
   whole-Device namespace wipe. Implement the native SQLite and browser IndexedDB/OPFS primitives,
   including orphaned records that the Device catalog can no longer name. Fault-injection and real
   restart tests prove exact scope, no renumbered persisted tags, retry after every partial primitive
   failure, and no secret logging. This slice exposes no Runtime request and edits no host lifecycle.
2. **Core teardown state machine:** add the two closed Runtime requests and one scoped
   `complete | incomplete` outcome over the committed primitives. Core owns catalog serialization,
   fences dispatch, Sync, preparation, observations, plaintext/key leases, and Account installation
   before deletion, then reports bounded redacted phase failures and resumes an identical explicit
   scope idempotently. This slice edits no Web or transitional TypeScript lifecycle path.
3. **Web lifecycle composition and reachability:** expose the Core requests through the existing
   binding/client seam, route Web Account removal and Device wipe through Runtime, and remove their
   reachability to the transitional lifecycle owner. Behavioral browser tests prove named scope,
   orphan wipe, retry after partial host failure, capability destruction, and no active-Account
   inference. Desktop, Extension, iOS, and Android consume the same Runtime contract in their later
   ordered host phases rather than reimplementing it.

Generated persistence artifacts belong to slice 1; generated Runtime/native/Web protocol artifacts
belong to slice 2. The three slices are sequential. Each starts with an exact behavioral failure,
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
