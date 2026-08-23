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

### 2026-08-23 — cold Runtime startup and catalog recovery

- A production Runtime is cold until `open` restores the Rust-owned Device catalog. Requests and
  observations fail closed before that point; the existing in-memory and Replica-only constructors
  remain immediately usable for their established test and conformance roles.
- Startup reads only the Accounts named by the catalog and publishes the recovered batch once, as
  signed out. A missing catalog is an authoritative empty Device and does not trigger a Replica scan.
- A pending installation is promoted when its Replica head is durable, rolled back when the expected
  active head remains durable, or removed when a first installation has no head. Any other head,
  missing active head, or mismatch with generation metadata fails the complete startup attempt.
- A corrected catalog must be durable before any Account becomes visible. Old generation metadata,
  quick-unlock material, and Session credentials are then removed best-effort. A failed attempt
  exposes no partial Accounts and `open` can be retried; closing always wins a startup race.

### 2026-08-23 — durable lock epoch prerequisite

The installed Account head now carries a required durable decimal-u64 lock epoch. Lock clears live
plaintext and access before its exact persisted epoch advance completes; a storage error leaves the
Account locked with the epoch pending, and unlock/plaintext work stays fail-closed until retry.
Ordinary Replica commits compare and preserve the epoch. Re-login with a new incarnation starts at
zero while same-incarnation replay preserves its current epoch and all accepted Operations and
encrypted optimistic overlays.

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

### 2026-08-23 — Authentication transport resource boundary

- Rust normalizes Server URLs with the existing WHATWG behavior and requires explicit Account-local
  confirmation before dispatching to a remote plain HTTP Server. Query and fragment input do not
  become part of the normalized Account identity.
- Generated Server DTOs are the only auth wire definitions. Their generated Rust deserializers reject
  unknown fields, so strict Server evidence does not require a parallel hand-written contract.
- One authentication ceremony accepts at most 21,000 Vault keys and 32 MiB of their serialized JSON
  array representation across the initial response and every cursor page. Crossing either bound
  fails the complete ceremony without returning or installing a partial Account. Per-page Server
  bounds remain independent defenses; the aggregate bounds protect Web and native client memory from
  an unlimited sequence of unique cursors.
