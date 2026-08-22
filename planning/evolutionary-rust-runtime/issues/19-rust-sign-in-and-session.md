# Rust Sign-in and Session

Type: task
Status: ready-for-agent
Blocked by: 16, 18
Spec: ../spec.md#sign-in-and-session-behavior

## Outcome

Move full existing SRP Sign-in, KDF validation, proof verification, Account installation, quick-unlock
material, and Session creation/renewal into Rust without changing crypto behavior or storage lifetime.

## Work

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
