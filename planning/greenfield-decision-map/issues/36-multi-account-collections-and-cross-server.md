# Multi-Account, Collections, and cross-Server copy

Type: grilling
Status: ready-for-human
Blocked by: 15, 18

## Question

Settled already: **the engine is designed multi-Account and multi-Server from day one; the All Accounts aggregation UI ships in the second cut.** This ticket decides the engine-side model so the later UI is not an engine rewrite.

Decide:

- How the engine represents several Accounts across several Servers concurrently: one replica or several, one sync loop or several.
- Session and lock semantics across Accounts: whether locking one locks all.
- How provenance travels on every projection, per `ACCOUNT-004`.
- The Collection model as a local filtering construct owning no data, keys, or membership.
- Cross-Server copy as copy-then-confirm-delete, per `ACCOUNT-007`, and what makes it safe without atomicity.
- What is genuinely deferred versus what must exist in the engine now.

Produces: `ACCOUNT-*` refinement and an engine model, plus seed scenario 9.
## Comments

### Inherited from ticket 05, client delivery trust and transport

`ACCOUNT-001` now restricts multi-Server to installed clients. This ticket's scope is Desktop and
Extension only; the Web client's widest scope is the Server that served it. Decide what the Web client
shows a user who has several Servers configured on their Desktop client, if anything.

[ADR 0005](../../../docs/adr/0005-the-web-client-is-bound-to-the-server-that-served-it.md) holds the
reasoning. A project-operated Web client origin was considered as a way to give Web full multi-Server
parity, and rejected.

### Inherited from Search and autofill index

Every persisted Search Snapshot belongs to one Account Replica. Account, Collection, and All Accounts
queries merge independently unlocked results only in volatile memory and preserve Server, Account,
Vault, and Item provenance. No combined persisted cross-Account or cross-Server index is permitted.
