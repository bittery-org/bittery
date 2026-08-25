# Keep Attachment Move manifest authority inside Client Core

Type: task
Status: claimed
Blocked by: 24
Spec: ../spec.md#offline-create

## Outcome

Attachment Move manifest renewal uses the Runtime's current authenticated Session and Server
authority inside Rust, while Web and other hosts provide only bounded binary source and upload
primitives.

## Problem

Ticket 28's committed C4a facade exports `AttachmentMoveTransferPort::renew_manifest`. That method
requires a host to construct the authenticated manifest route even though Client Core privately owns
the Server URL, current Session, HTTP transport, one-`401` refresh policy, and durable replacement of
the renewed Session. C4b cannot implement the exported contract without duplicating security and
network policy in bindings or TypeScript.

The already-resolved Rust network-ownership decision fixes the architectural answer: Client Core
must own the typed manifest request and authentication lifecycle. This ticket supplies the missing
seam; it does not reopen the product protocol.

## Work

This correction is split before implementation into two sequential, independently reviewed commits
with disjoint implementation paths:

1. **Authenticated manifest HTTP authority (A):** extend only Client Core's authenticated HTTP
   module with the typed `PUT /api/v1/operations/{operationId}/attachment-move-manifest` request,
   bounded JSON response parsing, and the existing closed response classification. Prove exact
   method, route identity, bearer use, request body, success bounds, stale authority, busy,
   reauthentication-required, and transient answers with behavioral transport tests. Do not own
   Session persistence, retry, Scheduler composition, bindings, or TypeScript.
2. **Runtime manifest lifecycle and facade composition (B):** use the Runtime's private Account
   metadata, current Session, HTTP transport, and auth configuration to call Slice A, refresh exactly
   one `401`, durably replace the renewed current Session, and adapt its closed answers into the Move
   preparation scheduler. Remove manifest renewal from the public host transfer port so the host
   supplies only binary source and upload streams. Prove explicit Account and Operation scope,
   renewed-credential replay, durable replacement before replay, a second `401` boundary, and that
   transient or busy answers preserve accepted work for the scheduler's unbounded retry. Do not edit
   bindings, TypeScript, C2 preparation mechanics, or Server behavior.

No invocation-scoped upload URL may be persisted or logged. Neither a retry count nor Session loss
may discard or terminalize an accepted Operation.

## Verification

Each slice starts with an exact failing behavioral test, receives a fresh implementer and reviewer,
and passes its focused Client Core tests. After both slices, the full Client Runtime package check,
`pnpm check:ci`, and `pnpm check:ci:rust` pass from a clean tree without tracked-file drift. Ticket 28
C4b then resumes against the binary-only host facade.

## Comments

### 2026-08-26 — filed from the stopped C4b implementation

The C4b implementer made no edits. Inspection confirmed that `AuthHttpClient` has no manifest method
and that the current Session, platform storage, Server metadata, transport, and auth configuration
are deliberately crate-private. The defect is therefore a missing Core composition seam, not a Web
fixture or an unresolved product decision. Deliberately left open: Web Worker lifecycle and binary
stream wiring remain Ticket 28 C4b work after this ticket resolves.
