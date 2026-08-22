# Backup, restore, and rollback detection

Type: grilling
Status: ready-for-human
Blocked by: 18, 23

## Question

`HOST-004` requires backup and automated restore and never says the archive is encrypted or that restore is rollback-detectable. An operator restoring last month's backup resurrects deleted Items, revoked sessions, revoked Share links, and superseded key epochs, and rewrites the audit history that `ADMIN-001` exists to constrain. Seed 12 tests only the happy path. See [corpus review, Significant #5](../research/corpus-review.md).

Decide:

- Whether clients must detect server rollback, via a monotonic server epoch, a signed cursor, or a client-pinned high-water mark, and whether they refuse or warn.
- Whether the backup archive must be encrypted with operator-held material distinct from the running Server's secrets.
- What restore does to authorization state that the security model treats as irreversible.
- Whether the audit log is tamper-evident against the operator, and if not, whether the product says so.
- Restore validation: what an automated test must prove.

Produces: `HOST-004` rewrite, a rollback-detection requirement, and a replacement for seed scenario 12.

## Comments

### Inherited from ticket 04, threat model and server-visible plaintext

`PRIVACY-004` makes rollback Detectable a MUST, not an option. Each client keeps a high-water mark of
accepted Server state and reports a Server that presents older state. This is the mechanism that stops
a restored backup from silently resurrecting deleted Items and revoked Vault access.

`PRIVACY-005` acknowledges Server equivocation between two Devices of one Account as undefended in the
first release. Confirm that a high-water mark per Device does not accidentally imply cross-Device
agreement the design cannot deliver.

### Inherited from the reopened password authentication decision

One OPRF seed and static 3DH key per Server and authentication-protocol version are root authentication
secrets. A database backup without them cannot authenticate a fresh Device or reproduce OPAQUE's export
key to unwrap the Account Key Set. Restore validation must prove the setup, registrations, wrappers, and
active version pair are restored together. Enrolled Devices remain locally usable through their Device
Unlock Wrappers, but that is not a substitute for a complete Server backup.

### Inherited from Sync protocol: cursor, bootstrap, and retention windows

Each Replica now pins the greatest accepted position of a random 16-byte Account stream generation;
same-generation regression fails, a different generation installs only through complete Bootstrap,
and ordinary event compaction never changes the generation. Server-signing a Cursor was explicitly
rejected because a Malicious Operator owns that signing key. This ticket decides which Server
backup/restore events may create a legitimate new generation, how a client distinguishes or presents
that event, and whether it refuses or warns; it may not silently accept a lower same-generation
position or imply cross-Device agreement.
