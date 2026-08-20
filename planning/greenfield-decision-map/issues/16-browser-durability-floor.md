# Browser durability floor

Type: prototype
Status: ready-for-human
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
