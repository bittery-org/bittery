# Rust Sign-in and Session

Type: task
Status: claimed
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

## Comments

### 2026-08-23 — Sign-in frontier resolved

- `SignIn` carries an explicit `insecure_transport_confirmed` boolean. Rust refuses a remote plain
  HTTP Server unless that field is true and persists the confirmation with the installed Account;
  neither the transport adapter nor Active account infers consent.
- After the Server proof identifies the User, Rust resolves an existing installation by normalized
  Server URL and Server User ID. A repeated full Sign-in keeps its stable local Account ID, atomically
  replaces the Account installation head with a new random incarnation, and preserves every accepted
  Operation and encrypted optimistic overlay. Explicit Device Account removal is the only flow that
  deletes those durable rows. A first Sign-in creates both a new stable Account ID and incarnation.
- Rust verifies and applies Travel Mode with the freshly issued Session token after loading all
  required Account material and before committing any usable local Session. Failure leaves no
  published or unlocked local Session; an orphaned Server Session remains safe and recoverable.
- `QuickUnlock` accepts only the stable Account ID and master password. Rust reads the stored Secret
  Key and pinned KDF profile, runs the complete existing SRP ceremony, verifies Travel Mode, and
  installs fresh Session credentials. The Account remains signed out and locked until that sequence
  succeeds. Missing, expired, or corrupt quick-unlock material requires full Sign-in with email,
  master password, and Secret Key.
- There are no users to migrate. Server, Runtime, and Web change directly in place without a Legacy
  Device-storage migration and without a parallel v2 key, schema, or client stack. The Runtime
  preserves the established storage lifetimes and authentication behavior, not the old Account-store
  representation.

### 2026-08-23 — Generation-scoped storage boundary

- Device-bound Account metadata and quick-unlock material, plus Session-bound credentials, are
  addressed by both stable Account ID and installation incarnation. A repeated full Sign-in stages a
  new generation without overwriting the active generation.
- The Rust-owned Device catalog records the active incarnation and an optional pending installation
  intent. Startup reconciles that intent with the durable Replica head before publishing any Account.
  This gives the non-transactional platform stores one small recoverable publication boundary.
- Rust owns the closed, versioned document shapes and their storage lifetimes. Hosts only execute
  primitive string `get`, `set`, and `delete` requests; master password and raw master unlock key have
  no persistable document field.
