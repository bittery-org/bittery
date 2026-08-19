# Current Server, Sync, and security architecture

## Server

**Observed.** The Server is a Rust/Axum application backed by Postgres and organized increasingly by
domain under `apps/server/src/domains/`.

**Observed.** Domain modules own authorization and SQL rather than delegating to a generic repository
tier. Real-Postgres integration tests exercise routes and domain behavior. This is a concept to keep.

**Partial.** Cross-cutting write mechanics such as mutation, audit, Sync event, and idempotency outcome
are not uniformly expressed through one atomic internal interface.

**Observed.** Email, object storage, Redis/pub-sub, Stripe, and other external integrations exist.
The greenfield product removes Stripe/billing and makes external network integrations opt-in.

## Transport

**Observed.** The repository is in a transition from Qubit JSON-RPC toward versioned Axum REST and
OpenAPI. ADR 0011 remains marked Proposed at the frozen snapshot. Generated TypeScript definitions and
contract checks already exist around the REST direction.

## Sync

**Observed.** The Server maintains durable Sync-event records and cursor-paginated change reads.
Bootstrap returns bounded pages and captures a Sync cursor. SSE communicates notification/control,
not authoritative state.

**Observed.** Current and proposed write behavior uses client operation IDs, optimistic concurrency,
idempotency outcomes, bounded retries, and explicit indeterminate states for uncertain commits.

**Observed.** Vault-key rotation uses short-lived server-recorded Rotation plans that pin security
assumptions and revalidate before finalization. Evidence:
[`docs/adr/0013-rotation-plans-coordinate-vault-key-rotation.md`](../../../legacy/docs/adr/0013-rotation-plans-coordinate-vault-key-rotation.md).

## Crypto and key lifetime

**Observed.** Rust owns cryptographic primitives and persisted formats. The current suite includes
password derivation, HKDF, AES-GCM with AAD, RSA wrapping, SRP, Secret Key generation, and bindings for
WASM/native contexts.

**Observed.** The master unlock key is not persisted in plaintext. Device-bound material wraps local
session material for quick unlock. Native platforms use OS secure storage; browser platforms cannot
provide equivalent at-rest separation.

**Documented limitation.** `CryptoPort.exportKey` is a total escape hatch, so “key material never
reaches JavaScript” is a convention enforced by callers, not a structural property.

## Storage

**Observed.** Storage values are classified by sensitivity (`secret` or `plain`) and lifetime
(`session-bound` or `device-bound`). Platform adapters declare what their storage actually guarantees.

**Observed.** Native and browser adapters differ significantly. Browser local/extension storage is a
profile trust boundary rather than an OS keychain. Current adapter complexity is especially high on
mobile.
