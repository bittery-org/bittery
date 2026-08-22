# First-slice adversarial review

Type: task
Status: ready-for-agent
Blocked by: 22
Spec: ../spec.md#verification

## Outcome

Independently challenge the completed Web slice against every fixed cryptographic, transaction,
retry, cross-Account, generated-contract, and cleanup invariant before Desktop migration begins.

## Work

- Review implementation against every spec statement and resolved decision ticket.
- Run fault injection and full applicable CI from a clean process state.
- Search for duplicate policy, hidden finite retries, plaintext persistence/logging, implicit Active
  account scope, response-cache idempotency, second Worker ownership, and reachable dual writers.
- File precise blocking tickets for every discrepancy; fix only when separately claimed to preserve
  independent review.

## Verification

The review report maps every acceptance criterion to code and a passing test or names a blocker. The
slice advances only with zero unresolved correctness/security blockers and green full checks.
