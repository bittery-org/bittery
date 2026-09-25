# Desktop Runtime placement and live-key ownership

Type: grilling
Status: resolved
Blocked by:

## Question

Should Desktop amend ADR 0010 and put its single Runtime, live keys, SQLite Replica, and native
messaging projections in the Tauri Rust process?

## Evidence and accepted answer

ADR 0010 puts renderer crypto in a WASM Worker and explicitly retains native cache decryption for
Extension snapshots. Tickets 11 and 33 select native Rust keys and SQLite, but do not deliver the
Desktop composition. The current `apps/desktop/src-tauri/src/lib.rs` unwraps retained keys and reads
the transitional cache independently of the renderer. Merely adding a renderer Runtime would leave
two behavioral/key owners.

Recommend one Tauri-process Runtime, calling the existing Rust Core directly, with a thin generated
typed `request`/`observe`/`close` renderer bridge. Native messaging reads Runtime projections and
uses Runtime commands; the native-host binary remains a transport bridge. Account and key policy
must not move into Tauri command handlers. SQLite executes the existing guarded Replica contract.
Biometric unlock remains local under ADR 0015, with no new durable authentication secret.

ADR 0004 remains binding: a connected Extension follows Desktop lock authority. Amend ADR 0010
before implementing the new placement; do not silently retain its cache-decryption exception.

## Comments

2026-09-08: maintainer accepted the recommended native placement, explicitly conditional on no
duplicated code. ADR 0010 is amended before implementation. Tauri calls the existing Core and
reuses its SQLite implementation; bindings and platform executors contain no behavioral policy.
Independent review and simplification must check that condition, including deletion of the native
cache-decryption exception after its callers migrate.
