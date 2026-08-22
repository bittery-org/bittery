# Web runtime placement

Type: grilling
Status: resolved
Blocked by: 01

## Question

Choose where the Web `ClientRuntime` lives relative to the existing Rust crypto Worker. The current
`KeyRef` is an identity owned by one crypto adapter/Worker instance; it is not a structured-cloneable
key and is invalid in another instance.

Decide whether Runtime and crypto share one process-wide Worker, the Runtime remains on the main
thread and calls the existing crypto Worker through its port, or a separate Runtime Worker receives
exported key material or new cross-Worker key IPC.

## Evidence

- `packages/crypto/port` deliberately binds each `KeyRef` to the port instance that minted it.
- Web already keeps cryptographic key material behind `createWasmWorkerCryptoPort()`.
- The first slice moves the existing SRP ceremony and Session lifecycle into Rust, so the same
  Runtime instance must retain the resulting opaque key handles without exporting key material.
- All three independent Runtime interface designs found that colocating Runtime and crypto in one
  Worker avoids raw-key export and makes React lifecycle independent from durable work.

## Answer

Web crypto and the Rust `ClientRuntime` share one process-wide Worker instance. The existing
SRP implementation and the Runtime execute inside that same handle-owning instance. React and the
main thread submit credentials and receive only typed results, projections, status, and opaque
references; component lifecycle does not own the Worker, live keys, or durable work.

## Comments

The initial wording assumed TypeScript-owned login. It was updated when the maintainer moved Sign-in
and Session lifecycle into Rust before implementation; the Worker-placement decision itself did not
change.
