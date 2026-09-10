# Transient Operation retry

Type: grilling
Status: resolved
Blocked by: 05, 06, 08

## Question

What ends retry for an already accepted Operation after transient failure?

## Answer

Retry automatically without a fixed attempt limit. The Runtime uses exponential backoff with a
bounded maximum delay and persists enough scheduling state to resume after process or Device restart.

Transport failure, Server unavailability, and renewable Session expiry leave the accepted Operation
pending. They are not semantic outcomes and must not consume a finite retry budget. Session renewal
is part of the retry path and may expose a visible waiting-for-authentication state without changing
the Operation into a terminal failure.

An accepted Operation leaves the retry loop only when the Server returns its durable semantic outcome
or the Account is removed from the Device. The first Runtime offers no per-Operation discard. Conflict
and semantic rejection are terminal only when represented by an authoritative Server outcome.

## Verification

Persist retry scheduling across restart; prove more than five transient failures can converge
on one Server effect and that UI cancellation never ends accepted work.
