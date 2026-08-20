# ClientRuntime interface

Type: grilling
Status: ready-for-human
Blocked by: 15, 17

## Question

`ARCH-ENGINE-001` through `006` describe the interface in prose and leave the FFI form OPEN. Candidate operations are `open`, `bootstrap`, `unlock`, `lock`, `dispatch`, `query`, `syncNow`, `observe`, and `close`.

Note that the frozen product already has a 35-line TypeScript `ClientRuntime`, which the corpus's "greenfield lesson" names as if it were new.

Decide:

- The operation set and the exact shape of each, at the boundary.
- The command vocabulary: intent-shaped, not CRUD, per `ARCH-ENGINE-004`.
- The query and projection model: purpose-built immutable read models rather than entities.
- Observation: versioned snapshots or invalidation generations, how a slow observer skips intermediate states, and the high-priority channel for lock and security events. This is the piece [the binding strategy](39-binding-strategy-native-and-wasm.md) has to carry across FFI, where UniFFI offers no stream primitive.
- Closed versioned outcome types, and the rule that durable work survives loss of caller interest.
- Cancellation, which UniFFI does not support at all, so it must be a contract in the API shape.
- What a constrained credential-provider runtime is allowed to call.

Produces: an interface specification and `ARCH-ENGINE-*` refinement.

### Inherited from ticket 08, key hierarchy and canonical envelope format

`CRYPTO-009` forbids any component from handing the cryptographic layer a blob without its context, so
the `ClientRuntime` boundary must carry object identity through every read and write that touches
ciphertext. This is the same constraint ticket 15 inherits, one layer up: a runtime method that moves
bytes without their Vault, Item, revision, or chunk identity cannot decrypt them.

`CRYPTO-007`'s closed format registry is compiled into the core, so nothing in this interface exposes
algorithm selection to a host.
