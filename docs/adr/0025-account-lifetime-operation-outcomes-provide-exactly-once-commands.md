# Account-lifetime operation outcomes provide exactly-once commands

Bittery identifies each command by a random Operation ID within one Account and fingerprints its
canonical immutable bytes. The Server commits a compact canonical outcome in the same transaction as
the mutation and retains that outcome until Account deletion; clients may therefore retry the same
bytes indefinitely after a timeout, crash, long offline period, or local restore without executing a
second writer. This deliberately rejects the frozen design's route-scoped, 24-hour replayed HTTP
responses: a time-bounded record cannot support the product's unbounded offline promise, and storing
transport responses couples Domain identity to an incidental API representation.

