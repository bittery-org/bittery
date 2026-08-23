# Host binding architecture and Worker transport ownership

Type: task
Status: ready-for-agent
Blocked by: 25
Spec: ../spec.md#web-binding

## Outcome

One layered host binding lives in `@bittery/client-runtime`: a platform-neutral typed client over a
transport interface, an observation registry that owns observation identity and lifetime outside
React, and a React entrypoint with exactly one subscription primitive. Web, Desktop, and Extension
differ only in the transport they supply.

## Problem

Two defects and one inversion.

**Observation identity is derived from the Account.** `bindRuntimeItemsObservation` uses
`items:${accountId}`. `routes/_app/vaults/route.tsx` and each child page both call `useRuntimeItems()`,
so both register the same id. `createWorkerRuntime`'s listener map and `WebClientRuntime::observe_json`
both replace on insert, so the child destroys the layout's observation; unmounting the child then
unobserves the layout's. The sidebar freezes permanently after the first navigation.

**Teardown races the un-awaited observe.** `bindRuntimeItemsObservation` fires `void host.observe(...)`
and returns a synchronous stop that fires `void host.unobserve(...)`. The two RPCs have no ordering
guarantee, so a fast remount can deliver `unobserve` first and leave a live observation whose listener
has already been deleted; projections then arrive and are silently dropped.

**The Worker transport lives in the crypto package.** `packages/crypto/port/src/worker-wire.ts`,
`worker-router.ts`, `worker-host-rpc.ts`, and `shared-worker-rpc.ts` are roughly 767 lines of generic
transport containing no crypto, and `WORKER_CHANNELS` hardcodes the string `runtime`. The Runtime is
the top-level abstraction per ADR 0014, so it assembles itself out of its own dependency's internals.
`RuntimeRpcChannel` and `WorkerRpcChannel` are byte-identical declarations in two packages only
because neither package can see the other.

## Work

- Move `worker-wire.ts`, `worker-router.ts`, `worker-host-rpc.ts`, `shared-worker-rpc.ts`, and the
  transport test into `packages/client-runtime/src/worker/` and export them as
  `@bittery/client-runtime/worker`. Delete the duplicated `RuntimeRpcChannel`. `crypto-port` imports
  the channel type from its new home; `@bittery/crypto-port/worker` is deleted once no host uses it.
- Add `@bittery/client-runtime/client`: a `RuntimeTransport` interface structurally satisfied by
  today's `WorkerRuntime`, and a `RuntimeClient` with typed methods over the generated protocol.
  Observations return a `RuntimeStore` handle of `{ subscribe, getSnapshot }` carrying a frozen,
  cached, four-state snapshot (`idle | loading | ready | failed`), because the protocol publishes full
  coalescible snapshots rather than an event stream.
- Add the observation registry inside that client. Observation ids are minted, never derived. Entries
  are keyed and reference counted, teardown is deferred and cancellable, and per-key work is
  serialized so a release/retain pair cannot post `observe` ahead of a pending `unobserve`.
- Harden the transport underneath: `createWorkerRuntime.observe` rejects a duplicate observation id
  instead of replacing the listener, and `WebClientRuntime::observe_json` returns an error instead of
  closing the previous handle. A silent corruption becomes a loud failure.
- Add `@bittery/client-runtime/react`: a stateless `RuntimeProvider` that receives an already-built
  client, one `useRuntimeStore` primitive holding the only `useSyncExternalStore` call, and derived
  feature hooks. The package contains no `useEffect`. Requests stay on TanStack Query `useMutation`.
- Add `@bittery/client-runtime/testing` with a fake transport exposing `publish`, `answer`,
  `openObservations`, and a call transcript.
- Add one composition root per JS host under `src/web/`, so the Web app supplies only a Worker URL and
  its client identity. Keep it at module scope: ticket 02 requires the Worker to outlive React.
- Add `["crypto-port", new Set(["client-runtime"])]` to `scripts/check-architecture.mjs` once
  `crypto-port` no longer imports the transport, so the inversion cannot return.

## Verification

A test with two sibling consumers of the same Account under `StrictMode` opens exactly one transport
observation, delivers each published projection to both, and keeps delivering after one unmounts. It
fails on the current implementation. Rapid remount posts no `observe`/`unobserve` pair at all.
`pnpm --filter @bittery/client-runtime test`, `pnpm --filter @bittery/crypto-port test`,
`pnpm --filter web test`, `pnpm architecture:check`, and `pnpm check:ci` pass.

## Comments

### 2026-08-23 — deliberately out of scope

`mapRuntimeItemsProjection` stays in `apps/web`. It adapts to `UnifiedItem`, the legacy repository
shape ticket 22 deletes; a compatibility mapper for a dying type must not enter the shared package.

Rehoming the combined WASM artifact is a separate ticket. `@bittery/crypto-wasm`'s Rust crate depends
on `client-runtime/crates/bittery-client-bindings` and re-exports `WebClientRuntime`, so the package
graph holds a genuine cycle that neither pnpm, turbo, nor `check-architecture.mjs` can see, because
the Rust edge is a Cargo path dependency. Document it in `packages/client-runtime/CONTEXT.md` here and
fix it there.
