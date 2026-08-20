# Candidate greenfield architecture

Status: **Candidate**.

## System shape

```text
React / SwiftUI / Compose presentation
                  |
       snapshots + domain commands
                  v
         ClientRuntime interface
                  |
        Rust bittery-engine
  session · commands · crypto policy
  replica · outbox · sync · projections
       |           |           |
 LocalDatabase  QuickUnlock  Transport/Scheduler
        platform capability adapters
```

## Client engine

`ARCH-ENGINE-001 MUST` One Rust client engine owns every security-sensitive behavior that must not
diverge across platforms: session state, domain commands, key ceremonies, local replica, durable
outbox, Sync reconciliation, conflicts, bootstrap, and read-model construction.

`ARCH-ENGINE-002 MUST` Each process has one `ClientRuntime` owner. UI windows and views are clients.
OS-mandated credential-provider processes use constrained runtimes and an explicit shared-store
locking/protocol design.

`ARCH-ENGINE-003 MUST` Applications cannot import engine internals. They cross a small command/query/
subscription interface.

`ARCH-ENGINE-004 MUST` Commands express intent rather than generic CRUD. Queries return purpose-built
immutable projections rather than database entities.

`ARCH-ENGINE-005 MUST` Expected outcomes cross bindings as closed, versioned data. Durable mutations
cannot be cancelled by loss of caller interest.

`ARCH-ENGINE-006 MUST` Observation uses versioned snapshots or invalidation generations. Slow
observers may skip intermediate states. Lock/security events have a high-priority channel.

Candidate external operations are `open`, `bootstrap`, `unlock`, `lock`, `dispatch`, `query`,
`syncNow`, `observe`, and `close`. Exact FFI form remains OPEN.

## Crate depth

Start with few deep crates:

```text
bittery-engine       session, domain commands, replica, sync policy
bittery-crypto       primitives and persisted cryptographic formats
bittery-protocol     public HTTP and interoperability types
bittery-bindings     UniFFI and WASM projection
bittery-server       modular monolith
```

Domain nouns begin as internal Rust modules. A module becomes a crate only for an independently
valuable interface, separate compilation target, or enforced dependency direction.

## Platform hosts

- **Web:** React/TypeScript, worker-hosted Rust/WASM runtime, transactional browser-store adapter.
- **Extension:** Chromium MV3 and Firefox required; Safari architecture-compatible and deferred.
  Background host owns the runtime; popup/content scripts are typed clients.
- **Desktop:** Tauri v2, React renderer, native Rust runtime owner. Renderer has no direct file,
  database, keychain, or arbitrary command access.
- **iOS:** Swift/SwiftUI with UniFFI, native secure storage, SQLite, background scheduler, and AutoFill
  extension.
- **Android:** Kotlin/Compose with UniFFI, Keystore, SQLite, WorkManager, and Credential Manager/
  Autofill integration.

`ARCH-HOST-001 MUST` Every webview-hosted surface runs under a Content Security Policy. The Web client
uses the `HOST-009` policy verbatim. The Desktop webview uses the same policy; a null or absent policy
is a defect. Extension pages declare `script-src 'self' 'wasm-unsafe-eval'` under
`content_security_policy.extension_pages`, which is the strictest policy Chromium and Firefox permit
for MV3 and is the minimum under which the WASM engine instantiates.

`ARCH-HOST-002 MUST` The Web client talks only to the Server that served it. It is same-origin with
its Server, so no Server sends cross-origin resource sharing headers and no deployment configures an
origin allowlist. `ACCOUNT-001` owns the product rule this enforces.

All platforms share engine behavior, protocol types, fixtures, localization source, and design tokens.
Native feature UI is not shared.

## Browser TypeScript and Effect

Effect v4 is the chosen TypeScript host framework. During beta it is pinned exactly; stable v4 is a
release gate.

```text
React
  -> snapshots and command callbacks
web-platform
  -> Effect adapters for actual browser capabilities
web-runtime
  -> sole WASM/Worker importer
Rust ClientRuntime
```

Effect owns typed browser-edge failures, Worker lifecycle, scoped listeners/resources, clipboard,
file picker, visibility/connectivity, notifications, and cancellable presentation tasks. It does not
own Vault policy, session state, replica/search, durable retries, Sync scheduling, conflict handling,
or canonical domain schemas. React feature modules do not import Effect Layers, WASM, or Worker
internals directly.

## Local persistence and quick unlock

`ARCH-STORE-001 MUST` Engine-level replica semantics and fixtures are shared; physical storage may
vary. Native hosts use SQLite through Rust. Web/extension start with a transactional browser-store
adapter; SQLite/OPFS remains an investigation, not a requirement.

`ARCH-STORE-002 MUST` The encrypted replica is separate from a Device Unlock Wrapper. Native OS
secure storage gates the wrapper; it never stores the master unlock key as an ordinary retrievable
value.

`ARCH-STORE-003 MUST` Web/extension storage is treated as weaker than native keychain/Keystore
capability. No implementation silently claims equivalent hardware or user-presence guarantees.

## Server

The Server is a Rust/Axum/Postgres modular monolith:

```text
server/
├── app/
├── domains/
│   ├── identity/
│   ├── sessions/
│   ├── vaults/
│   ├── teams/
│   ├── sharing/
│   ├── sync/
│   └── administration/
├── integrations/
├── transport/
└── persistence/
```

Each domain owns its authorization, SQL, commands, queries, mappings, and real-Postgres tests.
Persistence contains pool, transaction, migration, and shared error mechanics only.

`ARCH-SERVER-001 MUST` One command transaction atomically commits its domain mutation, audit record,
Sync/outbox event, and idempotency outcome.

`ARCH-SERVER-002 MUST` Postgres is an intentional product dependency. SQLx with checked explicit SQL
is the persistence mechanism. Generic repositories and entity-save workflows are absent.

`ARCH-SERVER-003 MUST` Static statements use checked SQLx macros/query files. Migrations are
hand-authored and append-only. CI creates a real schema, verifies SQLx metadata, runs upgrade tests,
and exercises critical query plans.

`ARCH-SERVER-004 MUST` OpenAPI and documented encrypted formats are public interfaces. Third-party
clients may implement them without the Rust engine; cross-platform fixtures define compatibility.

## Architecture enforcement

CI rejects forbidden dependency directions, manually restated generated types, policy in platform
adapters, external integrations enabled by default, and platform adapters that fail conformance.
Native Rust, WASM, Swift bindings, and Kotlin bindings execute the same behavioral fixture corpus.

Performance decisions use approved user-visible budgets: unlock-to-list, search, autofill, local
mutation acknowledgement, cold-start memory, and background energy. Technology-specific speed claims
are not requirements.

