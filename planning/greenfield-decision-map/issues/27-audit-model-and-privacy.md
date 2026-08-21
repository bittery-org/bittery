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

### Superseded by ticket 04's reopened answer

There is one operator-readable audit log and no encrypted Security History, User History Key, or Team
History Key. The log is operator-controlled evidence and no security guarantee depends on it. This
ticket now owns its exact event taxonomy, fields, retention, access, export, and redaction only.

### Inherited from ticket 08, key hierarchy and canonical envelope format

`CRYPTO-006` confirms there is no User, Team, or Security History key and reserves no encrypted-log
context. This ticket designs only the operator-readable log fixed by ticket 04 and ADR 0016. Item and
grant signatures authenticate client-consumed product state; they do not turn the Operator Log into a
security boundary.

### Inherited from ticket 09, recovery model and single-artifact paths

Five events are candidates for an Operator Log entry: a master password change (`AUTH-025`), a Secret Key
rotation (`AUTH-027`), a Recovery Key creation and revocation (`AUTH-006`, `AUTH-030`), and a recovery
sign-in (`AUTH-026`). Ticket 04 makes that log operator-controlled evidence, so this ticket must not
claim that a User can rely on finding any entry after a Malicious Operator acts.

`PRIVACY-007` gained the recovery authentication record and the Account Private Object ciphertext, so
the Operator Log's event categories must be able to describe an Account-secret change without naming
which secret changed.
