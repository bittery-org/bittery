# Operation state machine and crash safety

Type: grilling
Status: resolved
Blocked by: 15

## Question

`SYNC-004` names six operation states (accepted, queued, rejected, conflicted, indeterminate, failed) without defining the machine that moves between them.

Decide:

- The full state machine: states, transitions, terminal states, and which transitions are durable.
- The operation record format: client operation ID, intent, sealed payload, epoch, attempt count, and outcome.
- Crash safety at every step, including the write-then-crash-before-send case and the sent-then-crash-before-response case.
- Retry policy and backoff, and which failures are retryable.
- Exactly-once semantics against the Server's idempotency records, which in the frozen product store replayed response bodies keyed by principal, method, route, and key.
- Whether the user ever sees an operation state directly, and in what words.

Produces: a state-machine specification, `SYNC-004` refinement, and seed scenarios 1, 2, and 3.

## Comments

### Inherited from Browser durability floor

Web and Extension remain offline-first under the accepted `browser-transactional` Durability class.
This ticket must expose the count and age of Unsynced operations until Sync proves the matching
Server commits. Lock, navigation and runtime closure do not block on Sync. Account removal, Device
wipe and local reset must either Sync or produce an explicit discard transition naming the exact
operation count; they cannot silently pass through the ordinary removal state machine.

## Answer

Resolved with the maintainer on 2026-08-21. Promoted to refined `SYNC-004` in
[`product.md`](../../../docs/greenfield/target/product.md), the normative
[`operations.md`](../../../docs/greenfield/target/operations.md), accepted ADR
[0025](../../../docs/adr/0025-account-lifetime-operation-outcomes-provide-exactly-once-commands.md),
the root glossary, and seed scenarios [1](../../../docs/greenfield/scenarios/01-offline-operation-acceptance.yaml),
[2](../../../docs/greenfield/scenarios/02-duplicate-operation-delivery.yaml), and
[3](../../../docs/greenfield/scenarios/03-lost-operation-response.yaml).

### Resolution

1. **Acceptance is an event, not a state.** One guarded Replica commit creates the immutable
   operation, `queued` control row, optimistic overlay and defined derived updates before the host says
   **Saved on this device**. The closed state registry is `queued`, `indeterminate`, `committed`,
   `rejected`, `conflicted`, `failed`, and `discarded`.
2. **Every possible send has a durable intent.** Before network I/O, the client durably enters or
   retains `indeterminate` and advances attempt control. Crashes before send may conservatively look
   indeterminate; crashes after Server commit remain safely recoverable. There is no durable
   `in-flight` state.
3. **Commands are immutable canonical bytes.** Protocol `0x01` carries a random 16-byte Operation ID,
   closed `u8` kind, typed target, expected authenticated base, `u32` key epoch, and sealed command
   payload under one strict binary frame. Account-local accepted sequence and time stay local. SHA-256
   binds the fixed label, Server, Account and exact request bytes.
4. **Exactly-once follows Domain identity, not HTTP identity.** The Server ledger key is `(Account,
   Operation ID)`. Mutation or proved non-mutation, audit, Sync/outbox event and canonical outcome
   commit atomically. Matching retries receive that outcome; another fingerprint fails. Compact
   outcomes survive until Account deletion, so no 24-hour, route-scoped replay window weakens offline
   recovery.
5. **Indeterminate is automatic and nonterminal.** Retry uses the same bytes indefinitely with
   full-jitter exponential backoff from one second to a five-minute ceiling and honors
   `Retry-After`. Only closed matching outcomes prove `committed`, `rejected`, or `conflicted`;
   unknown responses remain indeterminate, and registered permanent local processing failure is
   `failed`.
6. **Commit reconciliation is locally atomic.** Canonical result, opaque commit marker, remote-base
   update, `committed` lifecycle and overlay removal land in one guarded commit. Ticket 18 defines the
   marker bytes and cursor relationship without reopening this invariant.
7. **Ordering is explicit but not globally serial.** Durable predecessors order overlapping targets;
   independent operations may run with bounded parallelism. An unsuccessful predecessor derivably
   blocks dependents without inventing another state. Ticket 19 owns their Domain reconciliation.
8. **Lock does not stop byte-identical Sync.** A locked core may send sealed bytes, pull opaque state
   and reconcile outcomes. Decryption, signing, re-sealing and User judgment wait for Unlock.
9. **Outcome and local lifecycle are separate.** A proved problem outcome never changes, while an
   explicit guarded resolution may remove its overlay and move the local lifecycle to `discarded`.
   For an indeterminate command, UI states that local discard cannot roll back a possible Server
   commit. Committed work is compacted after durable reconciliation; problem work stays until
   resolution.
10. **The UI is task language, not queue jargon.** It uses **Saved on this device**, **Waiting to
    sync**, **Synced**, **Needs review**, **Could not apply**, and **Discarded locally**. Web and
    Extension always expose count and oldest age until matching Server commits are proved.

### Legacy evidence and rejected shapes

The frozen Server stored replayable HTTP responses for 24 hours under principal, method, route and
key. Its claim committed before the Domain transaction, so a crash could strand an operator-managed
indeterminate row. It was useful evidence for fingerprint mismatch and concurrent in-progress
handling, but negative prior art for the new atomic writer and an unbounded offline product.

Rejected alternatives were keeping `accepted` while omitting `committed`, a durable `in-flight`
state, route-scoped or resource-revision identity, finite or Device-acknowledged ledger retention,
manual or bounded lost-response retry, HTTP-class terminal inference, Account-serial or fully parallel
sending, stopping Sync at Lock, raw internal UI states, JSON/CBOR command identity, replayed HTTP
responses, immediate terminal-row deletion, and silent local discard.

No new ticket surfaced. Existing
[Sync protocol: cursor, bootstrap, and retention windows](18-sync-protocol-cursor-bootstrap-and-retention.md),
[Conflicts, indeterminate outcomes, and authorization rejection](19-conflicts-indeterminate-and-authorization-rejection.md),
[Server domain architecture and atomic command writer](22-server-domain-architecture-and-atomic-writer.md),
[ClientRuntime interface](38-clientruntime-interface.md), and
[Conformance fixture corpus](49-conformance-fixture-corpus.md) inherit the boundaries they already own.
