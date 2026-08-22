# First existing-application slice

Type: grilling
Status: resolved
Blocked by:

## Question

Choose the first acceptance slice that proves the shared Rust runtime against an existing Bittery
application. Decide whether the slice begins after the current TypeScript SRP login or also moves the
login ceremony into Rust, and whether Web or Desktop hosts it first.

The slice must prove one active Account and one personal Vault can bootstrap existing encrypted Login
Items, read them after an offline restart, durably accept one new Login Item while offline, retry it
after reconnect, commit it exactly once on the Server, and reconcile the authoritative result.

## Evidence

- Web already uses the Rust crypto core through a WASM Worker and has end-to-end coverage for sign-in,
  Item CRUD, Sync, Vault behavior, and offline behavior.
- Desktop adds Tauri keychain, autolock, native-messaging, and Extension lock-authority concerns, while
  its runtime acceptance coverage is weaker.
- Extension has separate background-worker and popup runtimes and is therefore not a first-adapter
  proof.
- Current login orchestration is concentrated in
  `packages/core/src/services/auth-service.ts`; current Replica, operation, and Sync behavior is spread
  across `packages/core`, `packages/storage`, `packages/sync`, and host providers.

## Answer

The first slice uses Web and begins with Sign-in inside the shared Rust Worker. Rust owns the existing
SRP ceremony, KDF-profile validation, Server-proof verification, Session creation and renewal,
Account persistence, bootstrap, offline restart and read, durable offline acceptance of one new Login
Item, retry after reconnect, exactly one Server effect, and authoritative reconciliation. The host
collects credentials and provides platform adapters; current cryptographic algorithms and formats do
not change.

## Comments

The initial answer kept TypeScript SRP orchestration for the first slice. The maintainer reopened it
before implementation and chose direct Rust ownership of login and Session lifecycle so the first
external Runtime seam does not preserve a temporary split.
