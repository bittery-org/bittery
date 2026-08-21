# Browser durability floor

Type: prototype
Status: resolved
Blocked by: 01, 15

## Question

`SYNC-001` requires durable local acceptance before any network call. `ARCH-STORE-001` picks a transactional browser-store adapter for Web and extension and leaves OPFS as an investigation. Browser storage does not offer that contract: quota eviction, "clear site data", MV3 worker termination mid-transaction, and Safari's cap on script-writable storage. Seeds 1 and 10 would pass natively and may fail in the browser, contradicting the claim that fixtures are shared. See [corpus review, Significant #1](../research/corpus-review.md).

Build a throwaway prototype that measures rather than argues: write an operation through the candidate adapter, kill the worker mid-transaction, and observe what survives on each engine.

Decide from the result:

- Whether OPFS is promoted from investigation to requirement for Web, extension, or both.
- Whether `navigator.storage.persist()` is a precondition, and what the product does when a user declines.
- Whether browser hosts carry an explicitly weaker durability class with a matching honesty clause, or must meet the same floor.
- Whether unsynced work blocks anything, and what the user is told.
- Whether the shared fixture corpus is genuinely shared, or splits by host class.

Produces: a prototype under `planning/greenfield-decision-map/prototypes/`, an `ARCH-STORE-001` rewrite, and a fixture-corpus decision.
## Comments

### Inherited from ticket 05, client delivery trust and transport

`HOST-007` makes a secure context a precondition for the Web client, so the Origin Private File
System and `StorageManager.persist()` are guaranteed available. The prototype no longer has to plan
for their absence, and the non-secure-origin branch of ticket 01's findings is closed.

`HOST-009` pins `worker-src 'self'` and forbids `'unsafe-inline'`, so the prototype's Worker and WASM
loading must work under that policy rather than assume a permissive page.

## Answer

Resolved with the maintainer on 2026-08-21. The throwaway
[prototype](../prototypes/browser-durability/) and its
[observations](../prototypes/browser-durability/results.md) are primary evidence. The decision is
promoted to `ARCH-STORE-001`, `ARCH-STORE-018`, new `ARCH-STORE-023` through `ARCH-STORE-026`, refined
`SYNC-001`, new `SYNC-005`, the Replica contract, behavioral scenarios 10 and 16, the root glossary,
and accepted [ADR 0023](../../../docs/adr/0023-browser-transaction-completion-is-an-honest-weaker-durability-floor.md).

### Resolution

1. **Every host remains offline-first.** A browser Device locally accepts ordinary mutations before
   network Sync and updates its Projection immediately. A server-first Browser exception was examined
   and rejected because it contradicted the settled Offline and Sync product without being the
   maintainer's intended final choice.
2. **`browser-transactional` is the honest Browser floor.** Web and Extension promise one whole old or
   new Account commit while their Origin store exists. They promise no physical-disk acknowledgement
   and no survival of eviction, explicit clearing, browser policy, Extension removal or storage
   forensics. The class is weaker than `native-crash-durable` and is never presented as equivalent.
3. **IndexedDB is required; OPFS is not.** Both browser hosts open `readwrite` transactions with the
   explicit `durability: "strict"` hint. OPFS remains a possible later performance investigation; its
   `flush()` has no stronger documented guarantee, and an MV3 Extension would add an offscreen
   database host merely to use it.
4. **Persistence protection is best effort.** Web asks once during Device enrollment, after an
   explanation and before initial bootstrap. Denial does not block enrollment, reading or local
   mutation; the Device storage view reports the grant and offers an explicit retry. The Chromium and
   Firefox Extension manifests require `unlimitedStorage`, without inflating what each engine actually
   promises.
5. **Unsynced work is durable product state.** Browser surfaces show the count and age of locally
   accepted operations until Server Sync proves their commits. Missing persistent-storage protection
   is visible while such work exists. Lock, navigation and close are not blocked. Account removal,
   Device wipe and local reset first Sync or require an explicit confirmation naming the exact count
   whose only known copy will be discarded.
6. **The fixture corpus shares meaning, not impossible physics.** One semantic core proves typed
   state, atomicity, isolation and Sync on every adapter. Mandatory `native-crash-durable` and
   `browser-transactional` profiles add their distinct failure cases. Whole-Origin loss is a required
   Browser case and yields an absent Replica, never partial recovery or a false Server-commit claim.

### Prototype result and limit

In Chromium 146, five forced terminations during one IndexedDB transaction recovered the whole old
commit every time. Termination after transaction completion but before caller acknowledgement
recovered the whole new commit, demonstrating the indeterminate acknowledgement case. Explicit
Origin-store deletion removed an acknowledged but Unsynced operation. No partial logical commit was
observed.

The collaborative preview rewrote localhost to an insecure private-address origin, so OPFS could not
run there. More importantly, this prototype cannot prove power-loss persistence, OS flush behavior,
eviction safety, Firefox behavior or a future engine. Those limits agree with the primary-source
[browser durability research](../research/browser-storage-durability.md) and are part of the decision,
not missing evidence silently upgraded into a promise.

No new decision ticket surfaced. [Operation state machine and crash safety](17-operation-state-machine-and-crash-safety.md),
[Extension architecture for Chromium and Firefox](41-extension-architecture.md), and
[Conformance fixture corpus](49-conformance-fixture-corpus.md) inherit the settled policy details they
already own downstream.
