# Audit model and privacy

Type: grilling
Status: ready-for-human
Blocked by: 04, 26

## Question

`AUDIT-001` requires "privacy-conscious" audit history with configurable retention, which is not a testable predicate, and the audit log is the richest metadata source in the system. The frozen product stores raw IP and user-agent, masks only on read, and has no pruning job for it.

Decide:

- The closed event list: what is recorded, and what is deliberately not.
- Which fields are plaintext and which are ciphertext the operator cannot read.
- Whether IP and user-agent are stored at all, and if so for how long.
- Retention defaults and what an operator may change.
- Who can read audit history: administrator, Team Owner, the subject user.
- Whether the log is tamper-evident, given [backup and restore](24-backup-restore-and-rollback-detection.md) can rewrite it.

Produces: `AUDIT-001` rewrite into testable requirements.

## Comments

### Inherited from ticket 04, threat model and server-visible plaintext

`AUDIT-001` is now settled in shape by ADR 0003: an Operator Log administrators read, and a Security
History encrypted to the owning User or Team. This ticket decides the event taxonomy, the retention
defaults for each stream, and how the two write paths stay consistent, not whether the split exists.

### Inherited from ticket 08, key hierarchy and canonical envelope format

`CRYPTO-010` gives Security History two key contexts: `0x30` under a **User History Key** for a
personal Account, and `0x31` under the **Team History Key** for a Team. `CRYPTO-006` scopes the Team
History Key to Security History and nothing else, deliberately, so that reading a Team's history never
implies decryption access to its Vaults.

This ticket owns who holds the Team History Key: every member, or Team Owners and Admins only.
Departure rotates it, which is cheap because it protects only a log. `CRYPTO-012` makes Security
History's actor field provable rather than claimed, which is the point of signing revisions at all.
