# Runtime module and first-slice sequence

Type: research
Status: resolved
Blocked by: 01, 03, 06, 11, 12, 13

## Question

Derive the module boundary and smallest dependency-ordered implementation sequence that proves the
first Web slice without putting new Runtime behavior into the crypto core or the transitional
TypeScript core.

## Evidence

- `bittery-crypto-core` already holds the compatible cryptographic implementation and has WASM and
  native binding pipelines.
- Current Client behavior is split among TypeScript core, storage, Sync, and application providers.
- ADR 0012 requires generated cross-language definitions instead of hand-restated types.
- Web can cut over one composition root while Desktop and Extension still temporarily compile against
  transitional TypeScript packages.

## Answer

Create a new `packages/client-runtime` Rust workspace with a deep `bittery-client-core` crate and a
shallow `bittery-client-bindings` crate. Client core owns protocol, Account auth and Session, Replica
plans, Operations and retry, Sync, Server request construction, and primitive ports. It depends on the
unchanged `bittery-crypto-core` and generated Server wire types, but knows no React, IndexedDB,
Kotlin, Swift, or UniFFI. Bindings translate the closed Runtime protocol and callbacks only.

The first slice proceeds through these gates:

1. compile/binding spike;
2. in-memory Runtime protocol and guarded-plan conformance model;
3. one multiplexed Web crypto/Runtime Worker plus atomic IndexedDB adapter;
4. Rust-owned existing SRP Sign-in and restorable Session;
5. staged Bootstrap and offline encrypted Replica read;
6. atomic Server semantic outcome for create Item and generated contracts;
7. durable offline create, unbounded retry, response-loss recovery, and authoritative reconciliation;
8. Web composition-root cutover and deletion of replaced Web-owned TypeScript behavior.

The Runtime protocol types originate in Rust and generate Web, Kotlin, and Swift bindings. Server
wire types originate in Server OpenAPI and generate the allowlisted Rust client contract. Generation
drift is a CI failure.

During development, the new Web Replica database may coexist with the untouched transitional store,
but exactly one path is the active writer for an Account. The Web composition root switches only
after Server and Runtime acceptance pass. Packages still required by Desktop and Extension remain
until those hosts cut over; they are removed host by host, not wrapped as a permanent compatibility
layer.

Each gate is test-first except the explicitly throwaway compile spike. The final gate requires Web
end-to-end acceptance, generated-artifact drift checks, targeted Server and Runtime suites, and the
full TypeScript and Rust CI commands.
