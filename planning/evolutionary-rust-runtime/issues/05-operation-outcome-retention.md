# Operation outcome retention

Type: grilling
Status: resolved
Blocked by: 04

## Question

How long must the Server retain an accepted Operation's semantic outcome?

## Answer

The Server retains successful and terminal semantic Operation outcomes until Account deletion. The
outcome commits atomically with its Domain mutation or proved non-mutation, audit row, and Sync event.
Elapsed time, Device offline duration, Sync-event retention, and HTTP response loss do not make a
locally accepted Operation ambiguous. Outcome garbage collection would require a separately decided
Device acknowledgement-floor protocol.
