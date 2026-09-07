# Host binding architecture and Worker transport ownership

Type: task
Status: resolved
Blocked by: 25
Spec: ../spec.md#web-binding

## Delivered contract

`@bittery/client-runtime` owns the typed client, Worker transport, observation registry,
testing transport, and React subscription adapter.

- Observations use minted IDs, keyed reference counts, serialized per-key teardown, and deferred
  cancellable release. Sibling consumers share a cached immutable snapshot with
  `idle | loading | ready | failed` states; one unmount cannot close another's observation.
- Duplicate transport observation IDs fail instead of replacing a listener. Late callbacks are
  suppressed and observe/unobserve races are ordered.
- React uses one `useSyncExternalStore` primitive; feature hooks add presentation only.
  Runtime and Worker lifetime remain outside React.
- The host keeps literal `new URL(..., import.meta.url)` inside `new Worker(...)` because Vite
  needs that syntax to emit the Worker chunk.

## Remaining host boundaries

The current dependency edge is crypto-port → client-runtime while Desktop/Mobile Worker roots
still live in crypto-port. Do not add the originally proposed architecture ban before moving them.
The combined WASM package's Cargo dependency cycle is recorded in
[Runtime context](../../../packages/client-runtime/CONTEXT.md); rehoming remains separate work.
Web's compatibility projection mapper stays in Web until its transitional shape is retired.

## Verification

Registry and transport tests cover sibling subscriptions, StrictMode remount, deferred teardown,
duplicate IDs, crash/cancellation, and continued delivery after one consumer unmounts.
