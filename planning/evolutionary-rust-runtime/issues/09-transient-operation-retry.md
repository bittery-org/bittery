# Transient Operation retry

Type: grilling
Status: resolved
Blocked by: 05, 06, 08

## Question

Choose how an already accepted local Operation behaves after transport failure, Server unavailability,
or renewable Session expiry. Acceptance means its immutable request, Operation state, and optimistic
effect are already durable on the Device.

Decide whether transient work retries automatically without a fixed attempt limit, changes to a
manual-retry state after a bounded number of attempts, or becomes a terminal failure after that bound.

## Evidence

- Current TypeScript Sync marks transient commands permanently failed after five attempts.
- A fixed attempt count says nothing about whether the Server is reachable later and must not discard
  or misclassify locally accepted work.
- Backoff can remain bounded while the number of retries remains unbounded.
- Semantic rejection, conflict, explicit discard, and Account deletion provide real terminal states;
  transport failure does not.

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

## Consequences

- The Runtime must durably schedule pending work and wake it after restart, connectivity changes,
  Session renewal, and bounded backoff expiry.
- UI status may explain why work is waiting, but UI lifecycle does not control retry ownership.
- Tests must cover arbitrarily many transient failures followed by one authoritative outcome and
  prove that the Server effect occurs at most once.
