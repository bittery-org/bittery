# Web offline authoritative Replica read

Type: task
Status: resolved
Blocked by: 32, 35
Spec: ../spec.md#bootstrap

## Outcome

A real Web browser path renders the same previously bootstrapped authoritative encrypted Login Item
after Runtime Worker replacement, one online Full Sign-in or password Quick Unlock, and subsequent
transport disconnection, proving the read comes from the local Replica rather than the Server.

## Why this blocks the first-slice review

Ticket 32 proves an accepted Operation survives Worker replacement and later reconciles, but begins
with an empty personal Vault. Before unlock it inspects raw IndexedDB rows; after online unlock it
releases dispatch and reconciles the new Item. It never bootstraps an existing authoritative Login
Item, disconnects after unlock, and behaviorally renders/decrypts that same Item from local
authority. The accepted spec requires that distinct offline-read path.

## Work

- Add one Playwright scenario using the real Runtime composition root and full Rust authentication.
- Create and Bootstrap an authoritative encrypted Login Item while online, then replace the Worker
  and prove the Account restores locked with the same encrypted authority.
- Complete one online password Quick Unlock or Full Sign-in, wait until local decryption is ready,
  disconnect every subsequent Server transport, and navigate/render the same Item from the Replica.
- Prove no post-disconnect Bootstrap, changes, Item authority fetch, or legacy repository read
  supplies the result; assert the plaintext marker is absent from IndexedDB and diagnostics.

## Verification

Start with the complete browser scenario failing before its harness/product correction and retain
the exact output. Run the targeted cloud Playwright test with the development database, relevant Web
checks, and then both full gates from a clean tree.

## Comments

### 2026-08-24 — filed by ticket 23 rerun

This is a missing behavioral acceptance proof, not a demonstrated Runtime storage defect. It stays
separate from ticket 30: the transport is deliberately disconnected after online unlock, so no
held-SSE reconnect/backoff behavior is decided here.

### 2026-08-24 — kept as one browser slice

The independently verifiable boundary is the whole path from online authoritative Bootstrap through
Worker replacement and online unlock to a rendered read after transport disconnection. Seeding,
restart, or transport harness changes without that final behavior would not satisfy a separate spec
statement, so one implementer and reviewer own the complete scenario.

### 2026-08-24 — resolved

Commit `bb4ec003` adds the real cloud Playwright path: a fresh browser profile bootstraps an
authoritative encrypted Login Item, replaces its Runtime Worker, restores the Account locked,
unlocks online, tears down and recreates the Items observation after transport disconnection, and
renders the plaintext from byte-identical Account-scoped IndexedDB Replica authority. The test
proves exactly one Runtime Worker before and after replacement, no post-disconnect API response,
no legacy Item authority, and no plaintext marker in either browser database, console, Server
diagnostics, or Server ciphertext. The initial red and first review exposed harness defects rather
than a product defect; the corrected behavioral Worker probe received an independent clear review.

Deliberately left open: ticket 30 still owns whether Bootstrap, catch-up, or held SSE are attempted
after disconnection and owns all reconnect/backoff behavior. This test constrains successful
post-disconnect responses, not attempts. The focused cloud E2E, Web typecheck, Biome, and both
`pnpm check:ci` gates passed from a clean tree.
