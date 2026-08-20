# Operation state machine and crash safety

Type: grilling
Status: ready-for-human
Blocked by: 15

## Question

`SYNC-004` names six operation states (accepted, queued, rejected, conflicted, indeterminate, failed) without defining the machine that moves between them.

Decide:

- The full state machine: states, transitions, terminal states, and which transitions are durable.
- The operation record format: client operation ID, intent, sealed payload, epoch, attempt count, and outcome.
- Crash safety at every step, including the write-then-crash-before-send case and the sent-then-crash-before-response case.
- Retry policy and backoff, and which failures are retryable.
- Exactly-once semantics against the Server's idempotency records, which in the frozen product store replayed response bodies keyed by principal, method, route, and key.
- Whether the user ever sees an operation state directly, and in what words.

Produces: a state-machine specification, `SYNC-004` refinement, and seed scenarios 1, 2, and 3.
