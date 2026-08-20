# The Server stores sequence numbers, not timestamps

Status: accepted

The Server needs to order changes so that synchronization works, and a per-Vault monotonic sequence
number does that as well as a wall-clock timestamp does. It records no behaviour. `PRIVACY-008`
therefore forbids stored creation and modification times on Items, Vaults, and Attachments. Real
times are sealed inside the ciphertext, where only the User can read them.

The attack this closes is not the live operator, who watches requests arrive anyway. It is the
permanent record: a stolen database, a subpoenaed backup, or an operator reading history months
later reconstructs working hours, absences, sleep patterns, and the week a User rotated everything
after a scare. That is often more revealing than the passwords.

## Consequences

A future reader will look at the schema, find no `created_at` or `updated_at`, and want to add them.
This ADR exists to stop that.

Sorting and display by date require decryption first, which costs nothing in practice because the
client already decrypts to render.

Retention and cleanup jobs genuinely need a coarse time, so `PRIVACY-007` grants a day-resolution
bucket and nothing finer. Every write path must truncate it, or the removed history leaks back by
accident.

Server request logs carry wall-clock times and request paths, so unbounded request logging undoes
this decision entirely. `PRIVACY-014` requires a documented retention bound; ticket 25 sets it.
