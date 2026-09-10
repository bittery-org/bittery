# Rust Sign-in and Session

Type: task
Status: resolved
Blocked by: 16, 18
Spec: ../spec.md#sign-in-and-session-behavior

## Delivered

Delivered Rust Sign-in, password Quick Unlock, and Session renewal. A ceremony accepts at most
21,000 Vault keys and 32 MiB aggregate serialized key JSON; exceeding either refuses the entire
installation. Generation-scoped catalog publication recovers interrupted installation before
publishing any Account.

[Ticket 27](27-runtime-session-lifecycle.md) records Locked versus SignedOut restoration.
Biometric unlock remains local under [ADR 0015](../../../docs/adr/0015-keep-biometric-unlock-local.md).

## Contract

- Port current auth-service ordering and characterization cases into `bittery-client-core`.
- Use `bittery-crypto-core` directly; add behavior-preserving vectors where orchestration lacks them.
- Implement exact typed auth requests through the primitive transport port and generated Server types.
- Persist Device-bound Account/quick-unlock data and Session-bound credentials with the specified
  recoverable browser boundary.
- Wire only the Web Sign-in form and Runtime provider to the generated request/projections after tests
  pass; registration remains transitional.

## Verification

Existing and added vectors cover invalid Secret Key, downgraded/mismatched KDF, bad Server proof,
partial Vault-key pages, cancellation/zeroization, crash at each persistence boundary, refresh, and
successful Web Sign-in. No persisted marker contains master password, raw MUK, or unintended Session
credential lifetime.
