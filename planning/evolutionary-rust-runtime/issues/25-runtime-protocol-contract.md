# Runtime protocol contract generation

Type: task
Status: resolved
Blocked by: 19
Spec: ../spec.md#external-runtime-protocol

## Delivered contract

The Rust Serde Runtime protocol generates TypeScript schema, types, and validators under
`packages/client-runtime/generated/runtime-protocol`, exported as
`@bittery/client-runtime/protocol`. `RuntimeOutcome` declares the Web success/error envelope.
Revisions cross JSON as canonical decimal-u64 strings.

Hosts consume generated requests, results, projections, status, and errors. They preserve
projection status, Custom fields, waiting reasons, and error codes instead of restating or dropping them.
Native bindings keep their throwing API.

## Verification

Generation drift checks fail on a Rust contract change and pass after regeneration.
Generated field presence, requiredness, error envelopes, and lossless revision encoding are tested.
