# Audit splits into an Operator Log and a Security History

Status: superseded by ADR-0016

Audit is a bigger leak than the database it describes. The database is a snapshot; audit is a movie.
A single readable audit log would give an administrator a running record of who shares which secret
with whom, and when each secret was created and rotated, without decrypting anything. That would make
`ADMIN-001`'s "cannot decrypt" true and irrelevant at the same time.

`AUDIT-001` therefore splits the log. The **Operator Log** holds Account identifier, event category,
sequence number, source address, and byte counts, and administrators read it. The **Security
History** holds the actor, Vault, Item, and object of each event, is encrypted to the owning User or
Team, and administrators cannot read it. An operator sees that a membership event occurred on an
Account. They never see which Vault, or whose access.

## Considered options

One fully encrypted log was rejected because it removes the operator's ability to investigate abuse,
diagnose a deployment, or help a stuck User, and because rate limiting still needs a readable signal,
so plaintext would return through that door anyway.

## Consequences

Two write paths exist where products normally have one, and they must not drift.

Administrator-assisted support gets harder. An operator cannot see the event a User is describing,
so support conversations depend on what the User reads from their own client.
