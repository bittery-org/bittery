# Make the fixed Web binary executor compile in the production Worker graph

Type: task
Status: resolved
Blocked by:
Spec: ../spec.md#offline-create

## Outcome

The already-delivered Web binary-transfer executor type-checks when the authenticated production
Worker imports it under the Web application's ES2022 DOM library configuration, without changing its
wire contract, transfer bounds, OPFS ownership, cancellation, or credential handling.

## Problem

Ticket 28 C4b2 is the first production Worker path to import `WebBinaryTransferExecutor`. That makes
the dependent Web type-check reach the existing digest comparison in
`web-binary-transfer-executor-internal.ts`. Its `Uint8Array<ArrayBufferLike>` is rejected as a
`BufferSource`, whose current Web DOM declaration requires an `ArrayBuffer`-backed view. The runtime
package's own TypeScript configuration did not expose this latent integration error.

C4b2 explicitly excludes edits to the committed binary implementation. Folding the compatibility
change into Worker composition would erase that path boundary and prevent an independent behavioral
review of the cryptographic comparison.

## Work

- Add a focused type/behavior regression that reaches the digest comparison under the dependent Web
  compiler configuration.
- Make the smallest ownership-preserving conversion required by `crypto.subtle.timingSafeEqual` (or
  its current typed equivalent); do not widen accepted input, copy signed URLs or headers, change
  chunking, add retry, or edit Worker composition.
- Run the binary executor's focused tests and the Client Runtime plus dependent Web type checks.

## Verification

The exact dependent Web type-check first fails at the existing `BufferSource` argument and then
passes. Existing binary-transfer unit and Chromium tests remain green. A fresh reviewer checks that
the correction neither introduces plaintext/credential persistence or logging nor changes transfer
abandonment, retry, or bounds.

## Comments

### 2026-08-26 — filed from the paused C4b2 production import

C4b2's lease primitive and Worker composition tests remain uncommitted in disjoint TypeScript paths.
The production import exposed this pre-existing binary-executor typing defect; the C4b2 implementer
did not edit the excluded implementation. Deliberately left open: this ticket does not construct the
Worker, acquire an Account lease, start preparation, or prove browser reachability.

### 2026-08-26 — resolved

Commit `86f684b7` copies the exact viewed ciphertext bytes into an owned `ArrayBuffer`-backed
`Uint8Array` only at the WebCrypto digest boundary. The fixed executor now type-checks in both the
Client Runtime and dependent Web application configurations. Its 19 behavioral tests still accept
the matching digest and reject same-length corruption, and the existing MV3 Chromium transfer test
passes under Xvfb. Independent review found no product or fixture defect in the correction.

Deliberately left open: the copy changes no transfer contract, OPFS ownership, credential handling,
retry, cancellation, or bounds. Ticket 28 C4b2 remains responsible for Worker construction, Account
leases, lifecycle restart, and actual preparation reachability.
