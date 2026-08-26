# Keep Attachment source grants and exclusive lifecycle inside Client Core

Type: task
Status: claimed
Blocked by: 24, 45
Spec: ../spec.md#offline-create

## Outcome

Client Core mints Attachment Move source-download grants and drives each Account's startup sweep and
preparation only while a host-proved exclusive Account lease is held. Web bindings provide primitive
binary execution and lease acquisition, never Server or Operation policy.

## Problem

Ticket 28 C4b cannot compose the committed facade without crossing two private Core authorities.

First, `AttachmentMoveDownloadRequest` carries a durable storage key, but the fixed binary executor
requires an invocation-scoped URL. The only production URL comes from authenticated
`POST /api/v1/attachments/{attachmentId}/download-urls`. Core owns the Server URL, current Session,
one-refresh lifecycle, and the accepted source authority; bindings cannot construct or interpret that
exchange.

Second, Core privately owns the live artifact references and proof required to call orphan sweep.
The current lifecycle scans every unlocked Account under in-process locking, so a binding cannot put
one browser-wide per-Account Web Lock around the complete sweep, secret resolution, manifest work,
binary transfer, durable checkpoint, and promotion. Locking only the binary executor would leave a
reachable second writer across tabs or MV3 restarts.

The binding Rust-network-ownership and per-Account exclusive-Web-Lock decisions already determine
the architecture. This ticket supplies the missing composition seams and makes no new protocol
choice.

## Work

This blocker is split before implementation into three sequential, independently reviewed commits
with disjoint implementation paths:

1. **Authenticated source-grant HTTP authority (A):** extend only Client Core's authenticated HTTP
   module with the typed Attachment download-grant exchange, a finite response bound, exact
   Attachment route identity, bearer classification, and closed success/reauthentication/transient/
   stale or invariant answers grounded in the existing Server response. Behavioral transport tests
   prove method, path encoding, bounds, body, headers, malformed answers, and retryable statuses. No
   Session persistence, scheduler, binding, or TypeScript path belongs here.
2. **Runtime source-grant adaptation (B):** change only the Core Attachment Move scheduler/facade
   module and its tests so `open_source` loads the explicit Account incarnation and accepted source,
   invokes Slice A, refreshes once through the central durable Session lifecycle, validates the
   response against immutable Attachment identity/storage/envelope authority, and passes the public
   binary port only invocation-scoped URL/header/bound primitives. Add crate-private facade accessors
   needed by Slice C without exposing policy publicly. A second `401`, stale authority, or transport
   failure preserves accepted preparation under C2 backoff; URLs are never persisted or logged. Do
   not edit Runtime construction, C2, bindings, TypeScript, or Server.
3. **Core exclusive startup and Account lifecycle (C):** add a dedicated Core lifecycle module and
   Runtime construction paths, leaving Slice B untouched. Define one primitive host lease port; while
   its per-Account guard is live, Core derives that Account's published and provisional live artifact
   references, issues the private exclusive orphan sweep, and only then drives that Account's C2
   preparation through checkpoint or promotion. Restart, Lock, close, lease loss, sweep failure, and
   more than five retries never discard accepted work. Tests prove sweep-before-drive, one Account
   writer, explicit scope, live-reference preservation, resumable orphan deletion, and no drive after
   lease loss. The host never receives Operations, live-reference policy, or sweep proof.

Slice B may make existing facade fields available only crate-internally so Slice C can compose already
committed artifact ports without reopening B. Slice C owns new lifecycle/Runtime files and re-exports,
not the scheduler implementation. C4b remains the sole owner of the Web Locks primitive, fixed
IndexedDB/binary executor construction, actual browser reachability, and lifecycle error reporting.

## Verification

Every slice starts with an exact failing behavioral test, receives a fresh implementer and reviewer,
and passes its focused Client Core tests. After all three slices, the full Client Runtime package
check, `pnpm check:ci`, and `pnpm check:ci:rust` pass from a clean tree without tracked-file drift.
C4b then resumes without route, Session, live-reference, sweep, or Operation policy in bindings.

## Comments

### 2026-08-26 — filed from the second stopped C4b feasibility audit

The implementer made no edits. Inspection confirmed that the Artifact and provisional IndexedDB
adapters themselves are composable through one crate-visible store, but Core exposes neither a
source URL grant nor an authorized producer of `SweepOrphans`. Deliberately left open: this ticket
does not implement Web Locks, Worker construction, fixed browser executors, Server Share, ordinary
cross-kind dispatch/outcome, the general Attachment service, or final Web cutover.

### 2026-08-26 — source-download protocol resolved

The maintainer selected the existing authenticated
`POST /api/v1/attachments/{attachmentId}/download-urls` route. Client Core validates a successful
response against the accepted Attachment identity, durable storage key, envelope version, encrypted
metadata, and byte authority before handing its invocation-scoped URL to the binary port.

An exact `200` is the only download grant. A `404`, or a successful response whose authority does
not match the immutable accepted source, yields the local non-outcome `StaleAuthority` preparation
signal. C2 may freeze its existing `reject_stale_authority` request, but only the existing Move
finalization transaction may prove that fact and retain `attachment_state_conflict`; the download
route never creates or implies an Operation outcome. This makes a concealed or concurrently changed
Attachment safe: a false stale suspicion cannot commit a false rejection.

One `401` uses the central durable Session refresh and one replay. `403`, rate limiting, network
failure, response overflow, and Server failure remain nonterminal transport retry because access may
return and accepted work has no attempt or elapsed-time owner. Malformed success authority is a local
invariant. Extending the later manifest was rejected because C2 must download and transcrypt before
it knows the target ciphertext digest that the manifest requires. A new Operation-specific source
route was rejected as unnecessary protocol surface.
