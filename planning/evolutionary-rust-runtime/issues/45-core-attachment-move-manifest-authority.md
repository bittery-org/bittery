# Keep Attachment Move manifest authority inside Client Core

Type: task
Status: resolved
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

### 2026-08-26 — Slice A delivered the authenticated manifest HTTP authority

Client Core now owns the exact authenticated manifest `PUT`, its typed wire request and bounded
success response, and the closed stale-authority, busy, reauthentication-required, and transient
classifications. The host receives no Server route or bearer responsibility.

Independent review found a real product liveness defect rather than a fixture bug: the first 64-KiB
response cap could not consume a valid multi-Attachment manifest and would leave accepted work on
transient retry forever. The corrected implementation uses a dedicated finite 16-MiB bound and a
behavioral 200-entry response larger than 64 KiB. A fresh re-review found no remaining issue.
Deliberately left open: Slice B still owns current-Session load, one refresh and durable replacement,
Scheduler adaptation, and removal of manifest renewal from the public host transfer port.

### 2026-08-26 — Slice B delivered the Core Session lifecycle and binary-only facade

Client Core now derives the exact Account incarnation, Server metadata, current Session, and
Operation-scoped manifest request. It refreshes one `401`, durably stores the renewed Session before
one replay, propagates that current credential through outcome lookup, send, authoritative fetch,
and Sync, and maps a second `401` or transient answer back into C2's durable unbounded backoff. The
public host port now exposes only bounded binary source and upload streams. A `Weak<Runtime>` keeps
the Scheduler authority cycle-free.

Independent review found real product defects in the initial implementation: manifest and ordinary
dispatch could both replace one Account Session; successful manifest refresh omitted the Runtime's
availability transition; Bootstrap/Sync remained a reachable second Session writer; and outcome
helpers discarded a renewed credential before the next exchange. The corrected Runtime serializes
preparation, dispatch, Bootstrap/Sync, Lock, close, and reconciliation on the existing Account
execution fence and uses the central Session renewal lifecycle. A final fresh review found no
remaining product or fixture defect.

Review also found stale fixtures rather than product defects: same-Runtime calls claimed to model
independent duplicate senders, and a Lock/no-plaintext test awaited Lock before releasing the
Bootstrap HTTP request whose Account fence Lock correctly waits for. The corrected tests prove
same-Runtime single-writer serialization, two genuinely independent Runtimes still sending duplicate
bytes to one exactly-once Server outcome, and Lock remaining pending until Bootstrap completes while
publishing no plaintext.

`pnpm check:ci` and `pnpm check:ci:rust` pass from the same clean tree with the development database
and `SQLX_OFFLINE=true`; neither gate changes a tracked file. Deliberately left open: Ticket 28 C4b
still owns Web Worker construction, per-Account lifecycle exclusivity, and the already-delivered
binary browser executor composition. No binding, TypeScript, Server protocol, C2 preparation
mechanic, accepted-work retry ceiling, or upload-URL persistence was added here.
