# Web offline authoritative Replica read

Type: task
Status: ready-for-agent
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
