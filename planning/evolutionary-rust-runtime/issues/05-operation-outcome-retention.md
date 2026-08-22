# Operation outcome retention

Type: grilling
Status: resolved
Blocked by: 04

## Question

Choose how long the Server retains the semantic result of an accepted client Operation. The result is
stored in the same transaction as the Domain mutation, audit row, and Sync event, so a retry can prove
what happened after a lost response or long offline period.

Decide between Account-lifetime retention, a bounded time window, or garbage collection after client
acknowledgements establish that no enrolled Device can retry the Operation.

## Evidence

- Current HTTP idempotency claims and completed response bodies expire after 24 hours and commit
  separately from the Domain transaction.
- A device can retain an accepted local Operation longer than an arbitrary Server TTL.
- Account-lifetime rows grow with successful and terminal Operations until Account deletion.
- Acknowledgement-based collection requires a trustworthy per-Device floor and rules for removed or
  permanently offline Devices; none exists today.

## Answer

The Server retains successful and terminal semantic Operation outcomes until Account deletion. The
outcome commits atomically with its Domain mutation or proved non-mutation, audit row, and Sync event.
Elapsed time, Device offline duration, Sync-event retention, and HTTP response loss do not make a
locally accepted Operation ambiguous. Outcome garbage collection would require a separately decided
Device acknowledgement-floor protocol.
