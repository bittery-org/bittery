# Shared Replica adapter conformance

Type: task
Status: ready-for-agent
Blocked by: 22
Spec: ../spec.md#shared-replica-conformance

## Outcome

The same Rust-owned logical Replica plan histories pass against the in-memory interpreter,
failure-injected Web IndexedDB, and Rust SQLite, proving equivalent visible Account-scoped state and
atomic failure behavior across hosts.

## Why this blocks the first-slice review

Ticket 23 confirmed that the delivered Runtime has an in-memory Rust Replica and a Web IndexedDB
executor but no SQLite adapter or SQLite dependency. IndexedDB tests construct persistence wire
requests directly, so they do not prove that the Rust histories exercised in memory have identical
meaning at either durable adapter.

## Work

- Add the first Rust SQLite Replica adapter behind the existing closed persistence contract. The host
  supplies an application-owned database location; no SQL or table identity crosses the host seam.
- Define one adapter-neutral plan-history fixture format from the Rust logical plans and expected
  visible state, including Account scope, incarnation, revision, lock epoch, tagged Cursor, staged
  Bootstrap, Operations, outcomes, overlays, and receipts.
- Run those histories against the in-memory interpreter, IndexedDB executor, and SQLite adapter.
  Reuse the generated persistence contract rather than restating its domain model in TypeScript.
- Inject a failure at each write boundary and prove old-or-new atomicity. Cover stale/missing guards,
  Account remove-and-readd, lock races, retry/replay, and no known plaintext marker in durable rows.
- Keep the existing destructive IndexedDB-version upgrade recorded as a release gate; this ticket
  must not silently broaden into that separate migration decision.

## Verification

Start with a failing cross-adapter history test that cannot run against SQLite and include its output
in the implementation report. The completed suite proves equivalent visible state for every history
and failure point across all three adapters. Targeted Rust, IndexedDB, generated-contract, and
architecture checks pass, followed by `pnpm check:ci` and `pnpm check:ci:rust` from a clean tree.

## Comments

### 2026-08-24 — split into three independently green slices

The missing adapter, the shared history contract, and its browser execution cross different build
systems and cannot be implemented and verified honestly in one pass. They land sequentially:

- **A, Rust SQLite adapter.** Add the native-only SQLite implementation behind the existing closed
  persistence contract and compare representative install, load, guarded commit, lock-epoch, replay,
  and failure behavior with `InMemoryReplica`. This slice changes Rust paths only.
- **B, Rust-owned history corpus.** Generate and check in an adapter-neutral corpus from Rust logical
  plans, including expected responses and visible state for the full invariant set. Prove both Rust
  adapters consume it identically. This slice owns the generator and generated corpus.
- **C, IndexedDB conformance.** Consume that exact corpus in the TypeScript IndexedDB executor, add
  failure injection at its transaction boundaries, and compare its responses and visible durable
  state with the recorded Rust expectations. This slice changes TypeScript adapter/test paths only.

Each slice begins with its own failing targeted test and reports that output. Ticket 31 resolves only
after C and both full gates pass from a clean tree.

### 2026-08-24 — browser engine decision leaves this split unchanged

[Ticket 33](33-browser-replica-engine.md) keeps IndexedDB as the Web and Extension adapter for the
current migration and Rust SQLite as the native adapter. This ticket's closed logical plans and
shared history corpus are the durable cross-host seam: common SQL files would not by themselves prove
common semantics. Slice C therefore proceeds on IndexedDB after A and B; a later SQLite/OPFS Web
prototype in ticket 34 consumes the same corpus without changing Runtime policy.
