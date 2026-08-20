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
