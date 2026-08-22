# Durable operation state machine and exactly-once command contract

Status: **Candidate**.

This document fixes the operation lifecycle selected by `SYNC-004`. It applies to every locally
accepted mutation, every Replica backend, and every ordinary Server command. Domain specifications
define the registered command kinds, target paths, expected-base shapes, payloads, rejection reasons,
and conflict results; they may not weaken this common lifecycle or reinterpret its bytes.

## Acceptance boundary

Local acceptance is an event, not an operation state. Before acceptance, the engine validates the
command, creates every cryptographic object, and prepares one guarded Replica commit. That commit
atomically inserts the immutable operation, its initial `queued` control row, its optimistic overlay
effect, and every already-defined derived update. The host reports **Saved on this device** only after
the adapter's declared Durability barrier succeeds. A failed or stale commit creates none of them and
does not acknowledge acceptance.

The immutable operation receives a random 16-byte identifier and the next Account-local `u64`
accepted sequence. The sequence fixes overlay order but is never part of the Server command. The
acceptance time is a local `u64` Unix timestamp in seconds used to report the age of Unsynced work; it
is operational display data, not command identity or conflict authority.

## Closed lifecycle

The persisted lifecycle registry is:

| Code | State | Meaning |
| --- | --- | --- |
| `0x01` | `queued` | Locally accepted and eligible when its retry time and predecessors permit |
| `0x02` | `indeterminate` | At least one send intent was durably recorded and no matching terminal outcome is proved |
| `0x03` | `committed` | A matching Server commit outcome was reconciled into the Replica |
| `0x04` | `rejected` | The Server proved a registered non-conflict refusal |
| `0x05` | `conflicted` | The Server proved the registered expected-base conflict outcome |
| `0x06` | `failed` | The client proved a registered permanent local or protocol-processing failure |
| `0x07` | `discarded` | The User explicitly discarded the remaining local work |

`0x00` and unknown values are invalid. `accepted` and `in-flight` are not states. A process-local
request may be in flight, but crash recovery relies only on the durable state above.

The permitted transitions are:

```text
local acceptance -> queued
queued            -> indeterminate | failed | discarded
indeterminate     -> queued | committed | rejected | conflicted | failed | discarded
rejected          -> discarded
conflicted        -> discarded
failed            -> discarded
committed         -> <none>
discarded         -> <none>
```

Before every possible network send, one guarded commit sets `queued` to `indeterminate`, or retains
`indeterminate`, increments the attempt count, and records the attempt and next-retry controls. Only
then may network I/O start. A crash after that commit but before the socket call therefore creates a
conservative false indeterminate result; retrying the same bytes is safe. A crash before the commit
leaves the operation `queued`. A crash after Server commit and before response handling leaves it
`indeterminate` and recoverable through the Server outcome ledger.

An authenticated registered retryable response moves `indeterminate` back to `queued` with its next
eligible time. A transport failure, timeout, malformed or unknown response, lost connection, or crash
cannot prove non-execution and leaves it `indeterminate`. Only an outcome matching the Account,
operation identifier, and request fingerprint may move it to `committed`, `rejected`, or `conflicted`.
A permanent local failure may set `failed` only under a closed reason; damaged unique operation or
overlay state fails the Account closed under [`replica.md`](replica.md) and is not relabelled failed.

The Server outcome is immutable even when the local lifecycle later moves a problem to `discarded`.
Resolution creates a new operation identifier when it needs a new command. An explicit discard uses
one guarded commit to remove the selected overlays and mark the exact selected operations discarded.
For an indeterminate operation the confirmation states that the command may already have committed
on the Server and that local discard is not rollback. Account removal, Device wipe, and local reset
name the exact count as required by `SYNC-005`; later lifecycle deletion may remove the Replica.

## Canonical command identity

Operation protocol `0x01` uses the integer and length rules in
[`cryptographic-format.md`](cryptographic-format.md). Its exact outer frame is:

```text
OperationRequest =
  operation_version:u8 | operation_id[16] | operation_kind:u8 |
  target_length:u32be | canonical_typed_target[*] |
  expected_base_length:u32be | canonical_expected_base[*] |
  key_epoch:u32be |
  payload_length:u32be | sealed_canonical_command[*]
```

`operation_version` is exactly `0x01`. `operation_kind` is a closed append-only registry; `0x00` and
unknown values fail. The kind selects the exact grammar and allowed emptiness of the target,
expected-base, epoch, and payload fields. Decoders reject length mismatch, alternate encoding,
unregistered fields, and trailing bytes. A domain command may tighten size limits but may not change
this frame. The local immutable record stores these exact bytes beside the indexed typed fields needed
by the Replica; it never reconstructs request identity from mutable host objects.

The request fingerprint is:

```text
SHA-256(
  label("bittery/operation-request/1") |
  Server | Account |
  request_length:u32be | OperationRequest[*]
)
```

`label`, `Server`, and `Account` use the canonical tuple rules in
[`cryptographic-format.md`](cryptographic-format.md). The Server ledger key is exactly `(Account,
operation_id)`. Reuse with another fingerprint always fails and never executes either interpretation.
HTTP method, route, Session, Device, retry number, and request counter are not operation identity.

## Local operation record

The logical record has two blocks. Physical adapters may normalize them into typed tables but must
preserve the same fields and update boundaries.

The immutable block contains:

- the exact `OperationRequest` bytes and SHA-256 request fingerprint;
- Account-local accepted sequence and acceptance time;
- indexed operation kind, typed target, expected authenticated base, key epoch, and sealed payload;
- the ordered predecessor operation identifiers; and
- references to every typed overlay effect owned by the operation.

The mutable control block contains:

- lifecycle state and an optional immutable `OperationOutcome`;
- `u32` attempt count, last-attempt time, next-eligible time, and a closed retry category; and
- resolution and cleanup eligibility needed to retain problem work or compact reconciled success.

Attempt-count exhaustion is not a retry limit: an implementation saturates at `u32::MAX`. Persisted
wall-clock values schedule and explain retries but grant no authority. After restart the scheduler may
retry immediately and never delays solely because a local clock moved backwards.

## Server outcome ledger

The canonical result frame is:

```text
OperationOutcome =
  outcome_version:u8 | operation_id[16] | request_fingerprint[32] |
  outcome_code:u8 | outcome_body_length:u32be | canonical_outcome_body[*]
```

Version is `0x01`. Outcome `0x01` is `committed`, `0x02` is `rejected`, and `0x03` is `conflicted`;
zero and unknown values fail. The code selects one exact domain-registered body. A committed body
contains a `u32be`-length-prefixed commit marker followed by a `u32be`-length-prefixed canonical
result. The marker is exactly the 25-byte `SyncCursorV1` defined by
[`sync-protocol.md`](sync-protocol.md), so any other marker length fails. Rejection and conflict bodies
are defined by their owning Domain tickets.

One Server command transaction atomically writes the Domain mutation or proved non-mutation, the
audit record, the initiating Account's Sync Commit and any affected-Account fan-out, and the exact
`OperationOutcome`. The initiating Sync Commit may have no changes only when no other Account-visible
Domain object changed; it still allocates the unique marker position. Concurrent or later
byte-identical requests return that stored outcome. A request currently executing returns a registered
retryable result and never starts a second writer. The ledger stores canonical outcomes, not HTTP
status, headers, or response bodies, and retains every entry until Account deletion. Device removal,
Sync-event compaction, cursor expiry, and elapsed time do not weaken exactly-once execution.

## Scheduling, retry, and Lock

Operations carry durable predecessor identifiers for commands whose typed targets overlap or whose
payload was derived from an earlier optimistic effect. A scheduler sends only operations whose
predecessors are committed or otherwise explicitly reconciled. Independent operations may use
bounded parallelism. An active predecessor waits; a rejected, conflicted, failed, or discarded
predecessor leaves its dependents derivably blocked until the owning Domain flow creates a replacement
operation or explicitly discards them. `blocked` is not a persisted lifecycle state.

Retry is unbounded. The client uses full-jitter exponential backoff with a one-second initial ceiling
and a five-minute ceiling, and honors a longer valid `Retry-After`. Transport errors, timeouts, HTTP
408, 425, 429 and 5xx, a concurrent-in-progress result, and a renewable expired Session are retryable.
Known Device revocation or a registered Domain refusal is a rejection, not a retry. Unknown 4xx or
unregistered response bytes never become a terminal Domain outcome merely because of their HTTP
class. Connectivity restoration, runtime start, and an explicit retry may schedule immediately.

Lock removes no operation state. A locked core may push byte-identical sealed commands, pull opaque
state, verify the available protocol controls, and reconcile a matching outcome without Account keys.
Any path requiring decryption, a new signature, re-sealing, or User judgment waits for Unlock. Lock,
navigation, and runtime termination neither block nor falsely claim completion.

## Projection and user language

The ordinary UI does not expose raw lifecycle names. It uses these meanings:

| Internal fact | User wording |
| --- | --- |
| local acceptance event | **Saved on this device** |
| `queued` or `indeterminate` | **Waiting to sync** |
| `committed` | **Synced**; normally removed from the problem view after reconciliation |
| `conflicted` | **Needs review** |
| `rejected` or `failed` | **Could not apply** |
| `discarded` | **Discarded locally** |

Every surface may expose a diagnostic detail view, but object-level problems appear at the affected
object rather than as raw queue rows. Web and Extension always show the count and oldest age of work
without a matching committed outcome, plus their browser-storage warning. A dependent blocked by an
earlier problem is described as waiting on an earlier change. Exact rejection, conflict-copy, export,
and resolution copy belongs to
[Conflicts, indeterminate outcomes, and authorization rejection](../../../planning/greenfield-decision-map/issues/19-conflicts-indeterminate-and-authorization-rejection.md).

## Crash-safety invariants

- No network request begins before the complete local operation and optimistic effect are accepted.
- Recovery observes either no accepted operation or one complete `queued` operation and overlay.
- Every possible send is preceded by a durable indeterminate intent using the same immutable bytes.
- A lost response cannot cause a new operation identifier, altered payload, or duplicate Server writer.
- Terminal reconciliation is one guarded Replica commit; a crash exposes the complete old or new
  local view, never a committed row beside its still-live optimistic overlay.
- A terminal problem preserves its local work until an explicit Domain resolution or discard.
- A Server ledger row never outlives its Account, but no other retention or cleanup path removes it.
