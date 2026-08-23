# Web Worker and IndexedDB Replica

Type: task
Status: claimed
Blocked by: 15, 16
Spec: ../spec.md#web-binding

## Outcome

Host the production Runtime and existing crypto implementation in one process-wide Web Worker and
execute all first-slice guarded Replica plans atomically in a dedicated IndexedDB database.

## Work

- Multiplex legacy crypto calls and generated Runtime messages through one Worker instance.
- Add structured-clone guards, request correlation/cancel, observations, crash handling, and
  idempotent close.
- Implement the closed IndexedDB plan adapter with Account/incarnation/revision guards, staged
  generations, authority, overlays, Operations, outcomes, receipts, and fault injection.
- Bridge only browser storage primitives unavailable in a Worker and preserve the existing tier and
  lifetime classification.
- Run the shared logical plan suite against in-memory and IndexedDB implementations.

## Verification

Worker and IndexedDB tests prove atomic accept, promotion, Cursor, retry-state, stale guards, lock and
remove races, restart recovery, no persisted plaintext markers, and late-message handling. Existing
legacy crypto Worker behavior stays green during the transition.

## Comments

### 2026-08-23 — durable Account lock fencing

`ReplicaHead.lockEpoch` is a required canonical decimal-u64 field. Rust prepares the closed
`AdvanceLockEpoch` compare-and-swap; IndexedDB compares Account, User, incarnation, Replica revision,
and lock epoch in one `heads` transaction and writes only the successor head. Normal commits compare
and preserve the epoch; Rust never retags or recomputes a plan across an epoch mismatch, so a
pre-Lock commit is fenced and cannot roll the epoch back. Rust rereads the full
Replica after an applied response and rejects any changed Operation or encrypted optimistic row.
Runtime Lock invalidates plaintext delivery before awaiting storage and remains fail-closed while a
failed durable advance is pending. New incarnations start at zero; same-incarnation replay preserves
the installed durable epoch. Runtime close performs its durable advance best-effort only after local
access and callbacks are closed; no retry survives that process because reopened Accounts restore
signed out. An exhausted `u64` epoch is terminal for that incarnation and cannot be mistaken for a
successful same-epoch advance.

### 2026-08-23 — cold production Runtime transport

Replaced the Web-only Runtime shadow with a cold production transport. The Web app now owns the
single Worker composition root, attaches the unchanged Crypto service and `WebClientRuntime` to its
two closed channels, and exports a cold Runtime facade beside the existing Crypto port. Both
services enter through `@bittery/crypto-wasm`'s memoized initializer, so they share the existing
single generated WASM module; Crypto retains one Worker-owned key-handle table. The Runtime is
constructed with the dedicated IndexedDB executor, but a cold unauthenticated request does not
invoke persistence.

The outer wire now carries clone-guarded, uncorrelated channel notifications. The Runtime channel
supports only request, observe, and unobserve commands with exact fields. Tests cover notification
before observe acknowledgement, unknown and late observation IDs, listener replacement and
unobserve, cancel-before-ACK cleanup, request cancellation isolation, cross-channel crash handling,
idempotent close after Runtime close, and exactly one Worker. Existing Crypto Worker conformance and
the combined WASM initializer smoke remain green.

This is deliberately not an AccountStore/React cutover: account authentication, load/rehydration,
bootstrap, Sync/device transport, and product commit flows remain deferred. There is no
`localStorage` bridge and no claim that a durable IndexedDB plan ran during the cold Runtime smoke.
Ticket 18 remains claimed.

Verified from the repository root:

```text
pnpm --filter @bittery/client-runtime test
pnpm --filter @bittery/crypto-port test
pnpm --filter web exec bun test src/lib/crypto.test.ts
pnpm --filter @bittery/crypto-wasm test:combined
pnpm exec turbo -F @bittery/client-runtime -F @bittery/crypto-port -F web check-types
pnpm architecture:check
pnpm exec biome check <scoped TypeScript, JSON, YAML, and Markdown files>
git diff --check <scoped files>
```

### 2026-08-23 — first bounded Worker batch

Added the process-wide Web Worker owner and channel-tagged request multiplexer before the Runtime's
real Web ports are available. The Web composition root now creates one owner and injects its `crypto`
channel into the existing WASM Worker Crypto port. The adapter's default construction remains
compatible for Desktop and existing callers. The production Worker registers only the unchanged
Crypto service in this batch; `runtime` is exercised only through a shadow test service, and there is
no second Runtime WASM artifact or claim that the production Runtime is live.

Focused tests cover colliding per-channel request IDs, reverse-order replies, cancellation routing,
unknown and late messages, crash rejection across channels, forbidden structured-clone shapes,
copied byte buffers, synchronous `postMessage` failure, unattached channels, and close ACK before
termination with idempotent repeated close. Existing Crypto Worker conformance remains unchanged.

Ticket 18 remains claimed. The real Runtime Worker service and its transport/device-storage ports,
the dedicated IndexedDB Replica adapter, shared guarded-plan conformance, observation routing, fault
injection, and restart recovery remain for later batches.

Verified from the repository root:

```text
pnpm --filter @bittery/crypto-port test
pnpm --filter web exec bun test src/lib/crypto.test.ts
pnpm exec turbo -F @bittery/crypto-port -F '...@bittery/crypto-port' check-types
pnpm exec biome check <the nine changed TypeScript files>
git diff --check <the scoped tracked and new files>
```

### 2026-08-23 — combined production WASM artifact

Unified the unchanged Crypto exports and `WebClientRuntime` in the production-owned
`@bittery/crypto-wasm` package. Both surfaces now share one generated WebAssembly module, one
memoized initializer, and one linked `bittery-crypto-core` instance. The standalone Runtime Web
artifact was removed. Generation fails closed when UBRN changes either composed source template,
and CI checks the combined generated declarations, Rust composition input, lockfile, and absence of
a second production `.wasm` file.

The existing Crypto port continues to load the same package and its SRP, AES, RSA, and persisted
formats remain unchanged. The combined smoke test exercises representative low- and high-level
Crypto exports and Runtime request, observation, and close behavior against that one artifact.

Ticket 18 remains claimed. The production `runtime` Worker channel, browser transport and device
storage ports, the dedicated IndexedDB Replica adapter, shared guarded-plan conformance, observation
routing, fault injection, and restart recovery remain for later batches.

Verified from the repository root:

```text
pnpm --filter @bittery/client-runtime check
pnpm --filter @bittery/crypto-wasm test:combined
pnpm --filter @bittery/crypto-core test
pnpm check:ci
```
