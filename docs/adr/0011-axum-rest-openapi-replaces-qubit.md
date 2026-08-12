# Axum REST and OpenAPI replace Qubit JSON-RPC

Status: Proposed

## Context

Bittery exposes 113 Qubit procedures through `/rpc`. Qubit owns handler registration,
jsonrpsee integration, JSON-RPC behavior, batching, Rust-to-TypeScript generation and the
TypeScript client. Bittery has already vendored and patched Qubit after dependency and
correctness failures.

There are 45 queries, 68 mutations and no subscriptions. Realtime sync already uses
authenticated SSE outside Qubit. Four clients share `packages/core` and connect to cloud or
arbitrary self-hosted servers. There are currently no users or deployed compatibility
obligations, so a coordinated pre-launch cutover is possible.

[ADR 0002](0002-server-services-own-their-sql.md) requires domain services to retain SQL
ownership. [ADR 0003](0003-secret-tokens-are-stored-only-as-digests.md) requires out-of-band
secret tokens to be stored only as digests and disclosed once.

## Decision

Bittery will replace `/rpc` with a versioned HTTP API rooted at `/api/v1`.

Runtime routing, extraction and middleware will use Axum and Tower directly. The API will
use resource-oriented HTTP methods where their semantics are honest and explicit command
resources for sign-in ceremonies, recovery, invitations, key rotation, billing and other
workflows.

The Rust transport module is the API authoring source. It owns dedicated Serde
request/response DTOs, Axum route registration and OpenAPI metadata. Transport DTOs are not
service or database models. Handlers map between transport and service types; services
retain authorization rules and SQL ownership.

A deterministic OpenAPI 3.1 document will be generated and committed. Utoipa and
utoipa-axum will be used for route and schema registration, with exact version pins. Because
generated schemas cannot be assumed to reproduce every Serde edge case, input and output
DTOs are separate and contract fixtures validate actual serialization and deserialization
against the generated schema.

TypeScript types will be generated with `openapi-typescript`. `openapi-fetch` will be used
only inside `packages/api-contract`. All clients consume a handwritten Bittery facade that
owns authentication, session refresh, version negotiation, errors, retries, query keys and
domain-level operations.

Authenticated device sessions continue using bearer tokens. Middleware resolves a typed
`AuthenticatedPrincipal`. Service-account principals are reserved for a future decision but
are not exposed in v1.

Errors use RFC 9457 `application/problem+json`, normal HTTP status codes and stable Bittery
error codes. Human-readable detail is never parsed by clients.

PATCH uses JSON Merge Patch tri-state semantics. Syncable resources use client-generated
IDs. Optimistic concurrency uses ETag and If-Match. Generic batching is removed. Retryable
non-idempotent commands may use a documented `Idempotency-Key` contract, except operations
returning one-time secrets.

Queued item creation, trash and permanent deletion also persist idempotency outcomes. Although
their HTTP methods are normally idempotent, replaying a lost success against version checks can
otherwise wedge the outbound queue. A claim that outlives its five-minute execution lease is
terminally marked indeterminate and is never executed automatically again. This fail-closed
choice avoids duplicating a mutation that may have committed immediately before a server crash;
operator recovery follows `docs/idempotency-recovery.md`.

All collections are cursor-paginated and bounded by record count and serialized bytes.
Encrypted item ciphertext is capped at 1 MiB. Bulk import is capped at 200 items and 16 MiB.
Attachments continue using authorized presigned storage transfers.

SSE remains the only realtime transport. It carries notifications and control events, not
authoritative data. Durable sync uses cursor-paginated HTTP bootstrap and change endpoints.
Full bootstrap writes into a staging cache generation and atomically promotes it only after
completion. The previous offline cache remains usable during failures.

`GET /api/meta` advertises supported API majors, preferred major, capabilities and protocol
limits. `/api/v1` is additive and independent of the product release number. Future
deprecation uses standard `Deprecation` and `Sunset` headers.

All authenticated and authentication-related responses use `Cache-Control: no-store`.
`GET /api/meta` also uses `no-store` so compatibility and capability decisions cannot use stale
deployment metadata. Public asset caching remains explicitly allowlisted. Tracing uses W3C Trace
Context plus a server-generated Bittery request ID.

Non-loopback HTTP is rejected by default. Self-hosted operators may explicitly enable
insecure transport, and each affected client account must confirm it. Recommended
deployments pin server and web to the same release rather than using `latest`.

The implementation will be completed on a dedicated branch and merged as one coordinated
pre-launch cutover. No production dual stack will be maintained. Database changes required
by the transport rewrite must be additive and backward-readable. After the first REST
release, rollback targets a previous REST server, not Qubit.

## Consequences

Qubit, jsonrpsee, ts-rs API generation, JSON-RPC batching and the generated Qubit client are
removed.

The transport layer gains additional DTO and mapping code. This is intentional: wire
representation, bounds, nullability and security behavior become explicit.

HTTP caching, status codes, conditional requests, rate limiting, tracing and pagination
become endpoint-specific and observable.

The checked OpenAPI artifact becomes a compatibility boundary. CI rejects nondeterministic
generation and breaking `/api/v1` changes.

Screens cannot rely on unbounded server responses. Offline screens read the local cache
while background sync drains paginated server data.

## Rejected alternatives

- A maintained Qubit fork retains framework ownership and bus-factor risk.
- Direct jsonrpsee retains RPC semantics but does not solve TypeScript/OpenAPI, caching,
  versioning or structured HTTP behavior.
- A thin internal RPC layer recreates the same framework responsibilities.
- rspc/Specta substitutes another small RPC framework without improving the long-term HTTP
  and public-contract boundary.
- A generic REST batch endpoint recreates RPC and is not permitted.

## Verification

The cutover requires deterministic OpenAPI and TypeScript generation, OpenAPI
breaking-change checks, Serde/schema fixtures, route/spec coverage, live-Postgres
authorization tests, cross-client conformance, sync failure injection,
upload/CDN/webhook security tests and packaged self-host deployment tests.
