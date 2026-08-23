# Runtime protocol contract generation

Type: task
Status: ready-for-agent
Blocked by: 19
Spec: ../spec.md#external-runtime-protocol

## Outcome

The external Runtime protocol has exactly one TypeScript definition and it is generated from the Rust
Serde definitions, so no Web host restates a request, response, observation, or error shape by hand.

## Problem

`packages/client-runtime/generated/` already generates and drift-checks the persistence,
platform-storage, and http-transport contracts. `generated/web/` is empty. The one boundary the Web
host actually crosses is therefore hand-written JSON strings and `as` casts:
`apps/web/src/lib/runtime-auth.ts` builds two request bodies and parses one response,
`apps/web/src/lib/runtime-items.ts` builds an observation request and restates `LoginItemProjection`,
and `packages/client-runtime/src/worker-runtime.ts` restates the `wasm-bindgen` surface as
`RuntimeWasm`.

That violates ADR 0012 and has already produced four defects: `RuntimeErrorCode` is discarded so the
host cannot distinguish `AuthenticationRequired` from `AccountMissing`; `LoginItemProjection.status`
is dropped so a `Failed` Operation renders as an authoritative Item; `custom_fields` is dropped; and
`replica_revision` is typed `string | number` because the wire shape was guessed.

## Work

- Add a `runtime-protocol-contract-schema` cargo feature to `bittery-client-core` and gate
  `schemars::JsonSchema` derives on `RuntimeRequest`, `RuntimeResponse`, `ObservationRequest`,
  `RuntimeProjection`, `ItemsProjection`, `LoginItemProjection`, `ItemProjectionStatus`,
  `RuntimeStatusProjection`, `AccountStatus`, `AccountAccessState`, `AccountWaitingReason`,
  `LoginItemDraft`, `RuntimeError`, and `RuntimeErrorCode`. `AccountId` is `#[serde(transparent)]`
  and needs `schemars(with = "String")`, as `replica/persistence_contract.rs` already does.
- Replace the implicit Serde `Result` envelope emitted by `WebClientRuntime::request_json` with a
  declared `RuntimeOutcome` enum so the success and failure wire shapes are part of the contract.
  Native bindings keep throwing and are unaffected.
- Promote the existing `decimal_u64` helper out of `replica::domain` into a crate-level `wire` module
  and apply it to `replica_revision` and `revision`, so no revision crosses the boundary as a lossy
  JSON number.
- Add `src/bin/generate_runtime_protocol_contract_schema.rs`,
  `scripts/generate-runtime-protocol-contract.mjs`, and its `.test.mjs`, following the persistence
  contract recipe exactly. Emit `contract.schema.json`, `contract.ts`, `validator.js`, and
  `validator.d.ts` under `generated/runtime-protocol/`.
- Wire `generate:runtime-protocol-contract` and `check:runtime-protocol-contract` into the package
  scripts and append the check to `check:generated`.
- Export the generated types as `@bittery/client-runtime/protocol`.

## Verification

`--check` fails on a deliberate Rust protocol edit and passes on a clean tree. The generated
`contract.ts` compiles and every field the Rust protocol declares, including `status`, `custom_fields`,
`waiting_reason`, and `code`, is present and non-optional where Rust makes it non-optional.
`pnpm --filter @bittery/client-runtime check` and `pnpm check:ci:rust` pass.
