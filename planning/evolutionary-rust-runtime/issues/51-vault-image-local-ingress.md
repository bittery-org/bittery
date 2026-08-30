# Add durable local Vault-image ingress

Type: task
Status: ready-for-agent
Blocked by: 50
Parent: [28 — finalized E1–E10 frontier](28-remaining-item-write-kinds.md#2026-08-30--final-web-item-and-import-frontier-resolved)

## Outcome

The Runtime can claim one bounded host image source and atomically publish an
Account/Operation-bound durable plaintext Vault-image artifact through conformant IndexedDB and
SQLite adapters, without accepting or dispatching a create-Vault Operation.

## Work

- Define a distinct Vault-image source and artifact contract. Accept exactly `image/jpeg`,
  `image/png`, `image/webp`, `image/gif`, or `image/avif`, 1–2,097,152 declared raw bytes, bounded
  reads of at most 256 KiB, exact EOF, and a Rust-computed lowercase SHA-256. Do not accept a host
  digest or reuse the Attachment ciphertext artifact type.
- Reuse the Attachment upload registry's lifecycle invariants: bind each claim to the actual Runtime
  incarnation, Account, prepared Operation, and exact request; cap entries, tombstones, Account
  states, and active/pending/retired Runtime state in one inclusive 1,024-identity total; cap in-flight
  source operations at 1,024; limit grant lifetime to at most one hour; retain replay/expiry
  tombstones; retry failed cleanup; and drain a failed-open registry before reconstructing one fresh
  bounded registry.
- Publish chunks and immutable Vault ID/length/content-type/digest metadata before any later Replica
  reference. Add IndexedDB, SQLite BLOB, and in-memory conformance histories for exact replay,
  conflict, publication, deletion, and exclusive startup orphan sweep.
- Before Lock, Sign-out, Remove, Wipe, close, failed-open cleanup, Account retirement, or incarnation
  retirement, cancel and drain source work and complete or durably retain deletion of every partial
  pre-accept artifact. Acceptance fencing must be expressible so a later slice cannot race
  retirement.
- Zeroize only Runtime-owned or transferred plaintext buffers. Explicitly make no promise about an
  original host `File`, `Blob`, provider backing, structured-clone source, or physical media
  overwrite after logical deletion.

## Path ownership and failure domain

This slice owns new source/artifact policy in
`packages/client-runtime/crates/bittery-client-core`, shallow native/WASM ports and ADR-0012 control
artifacts in `packages/client-runtime/crates/bittery-client-bindings` and
`packages/client-runtime/generated`, fixed IndexedDB/source composition under
`packages/client-runtime/src/web` or adjacent dedicated executor files, and the native SQLite plus
in-memory conformance adapters. It owns pre-accept source, publication, cleanup, and retirement
failure boundaries. It must not edit Server routes/schema, create a Vault Operation, open network
dispatch, or expose a registry from `apps/web`.

## Verification

- Start with failing cross-adapter histories covering every write/publication/delete failure,
  crashes between artifact publication and a hypothetical Replica reference, exact concurrent
  replay, replay/expiry tombstones, inclusive capacity edges, wrong Account/incarnation/Operation/
  request, short/long input, every rejected MIME value, and restart reconstruction.
- Hold source reads and cleanup across every retirement authority and prove retirement waits,
  partial artifacts cannot survive unowned, failed cleanup retries, and the acceptance fence cannot
  race retirement. Prove Attachment ciphertext artifacts cannot satisfy this port.
- Run focused Core, binding, SQLite, TypeScript, generated-contract, and actual-Chromium IndexedDB
  tests; then client-runtime type/generation checks, `pnpm check:ci`, `pnpm check:ci:rust`, and
  `git diff --check`.
