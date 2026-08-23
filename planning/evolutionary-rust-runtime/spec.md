# Evolutionary Rust Runtime: first Web acceptance slice

Status: accepted
Date: 2026-08-22
Decision map: [map.md](map.md)

## Purpose

Prove that Bittery can move its existing client behavior into one shared Rust Client Runtime without
rebuilding the product or changing its cryptographic specification. The first slice runs inside the
existing Web application and covers full Sign-in, encrypted Bootstrap, offline restart and read, and
one durable offline Login-Item create through authoritative Server reconciliation.

This specification is complete when its implementation can be delegated without inventing Runtime
ownership, persistence, retry, Server-outcome, binding, or Web-cutover behavior.

## Acceptance scenario

Against the existing Server and Web UI, one Device can:

1. perform a full Sign-in with email, master password, and Secret Key through Rust's existing SRP and
   crypto implementation;
2. validate and pin the current KDF profile, verify the Server proof, create and renew the Session,
   and install one Account;
3. Bootstrap one personal Vault and its encrypted Login Items through the current bounded feed;
4. restart the Worker and browser while offline, unlock using existing behavior, and read the same
   locally encrypted Items;
5. create one Login Item while offline and receive `Accepted` only after the Operation and encrypted
   optimistic Item are durable in one local transaction;
6. survive more than five transient attempts and process restarts with identical Operation identity
   and request bytes;
7. reconnect, commit exactly one Item, audit record, Item Sync event, semantic Operation outcome, and
   Operation Sync event in one Server transaction;
8. recover after the first successful response is deliberately lost; and
9. atomically reconcile the authoritative encrypted Item, Operation outcome, optimistic overlay, and
   any matching Sync cursor, leaving one visible Item and one compact completed receipt.

The scenario is tested with one Account and one personal Vault, while every external identifier and
durable record remains explicitly Account-scoped and compatible with the decided multi-Account
Runtime.

## Fixed constraints

- Current SRP, KDF, encryption algorithms, key hierarchy, AAD, wrapped-key shapes, persisted crypto
  formats, and compatible `bittery-crypto-core` behavior do not change.
- No Item plaintext, password, TOTP secret, raw live key, or master password is persisted.
- Existing storage sensitivity and lifetime classes remain authoritative. In particular, Web Session
  credentials that currently die with browser session still die with browser session; Device-bound
  quick-unlock material remains Device-bound.
- The Server, OpenAPI, generated clients, and active application callers change together under the
  existing `/api/v1` route family. No `/v2`, compatibility route, or permanent dual protocol exists.
- Web proves the Runtime before Desktop and Extension cut over. Android Compose follows the existing
  clients; iOS SwiftUI follows Android.

## Module boundary

Add a new `packages/client-runtime` Rust workspace containing:

- `bittery-client-core`: the deep module owning Runtime protocol, Device Account catalog, per-Account
  authentication and Session, live keys, Replica, Operations, retry, Bootstrap, changes, request
  construction, outcome interpretation, and observation projections;
- `bittery-client-bindings`: shallow native UniFFI conversions plus an explicit Web `wasm-bindgen`
  adapter and host callback wiring; and
- generated Server wire types sourced from the checked-in OpenAPI contract.

`bittery-client-core` depends directly on the unchanged `bittery-crypto-core`. It does not depend on
React, TypeScript storage packages, IndexedDB, Kotlin, Swift, Compose, SwiftUI, or UniFFI. Platform
behavior arrives through primitive internal ports.

The dependency direction is:

```text
Web / Kotlin / Swift facade
            ↓
  bittery-client-bindings
            ↓
     bittery-client-core
            ↓
     bittery-crypto-core
```

The transitional TypeScript `packages/core`, `packages/storage`, and `packages/sync` remain only for
hosts not yet cut over. New Runtime policy is not added to them.

## External Runtime protocol

The Rust-defined external object has exactly three operation families. UniFFI generates its Kotlin
and Swift projections; the thin Web `wasm-bindgen` adapter projects the same closed types:

```text
request(RuntimeRequest) async -> RuntimeResponse
observe(ObservationRequest, ObservationSink) -> ObservationHandle
close() async
```

The first closed request variants are:

- `SignIn { server_url, email, master_password, secret_key, insecure_transport_confirmed }`
  -> `SignedIn { account_id, user_id }`;
- `QuickUnlock { account_id, master_password }`
  -> `SignedIn { account_id, user_id }`; and
- `CreateLoginItem { account_id, vault_id, draft }`
  -> `Accepted { operation_id, item_id, replica_revision }`.

The first observation variants are:

- `Items { account_id }` -> full immutable `ItemsProjection`; and
- `RuntimeStatus { account_id? }` -> full immutable per-Account or Device aggregate status.

Account scope is explicit after Sign-in. Active account is a host UI pointer and never supplies
implicit Runtime scope. Host facades may expose convenient functions, `Flow`, or `AsyncStream`, but
contain no authentication, Domain, Replica, Operation, or Sync decisions.

Every observation starts with the current full snapshot, then publishes monotonically increasing
Replica revisions. Full snapshots permit coalescing to the newest value. Closing an observation is
idempotent and drops late callbacks. Closing the Runtime stops ephemeral calls and destroys live keys;
durable pending Operations resume when the Runtime next starts.

Caller cancellation stops waiting. Before durable commit it may abort Sign-in or create processing
and must destroy ephemeral secrets. After Account installation or Operation acceptance it cannot undo
the committed state. Projections are authoritative if a response races with cancellation.

## Primitive platform ports

The Rust core defines closed inputs and outputs for:

- Replica persistence: load Account state and atomically execute a `GuardedCommitPlan`;
- Device storage: execute Rust-owned key classification through plain, session, and secret primitives
  while preserving the existing tier table and platform honesty;
- transport: execute exact HTTP method, URL, headers, immutable body bytes, and SSE wakeup requests;
- time and platform availability signals; and
- cryptographically appropriate randomness through the established crypto/system source.

Rust owns authentication headers, request serialization, immutable request bytes, fingerprints,
Session refresh, retry classification, outcome decoding, and SSE policy. A transport adapter returns
status, headers, and bytes without interpreting them.

Native Runtime persistence is implemented in Rust SQLite after the host provides an application-owned
database location. Web executes the same logical guarded plans through a dedicated IndexedDB adapter.
Host storage code never receives arbitrary SQL/table names and never reimplements a plan.

## Web binding

Web extends the existing process-wide crypto Worker into one multiplexed crypto/Runtime Worker. A
second Worker is forbidden because opaque `KeyRef` values belong to the Worker/port instance that
created them.

The main-thread facade transports only structured-clone-safe plain data, byte arrays, request IDs,
observation IDs, and closed error records. It never clones functions, `AbortSignal`, `Request`,
`Response`, `Error`, generated object handles, or `KeyRef`. Immutable Operation body bytes are copied,
not transferred and detached.

The facade maps a local `AbortSignal` to a cancel-by-request-ID message. It rejects pending calls on
Worker failure, ignores snapshots for unknown observation IDs, and waits for the idempotent Runtime
close acknowledgement before terminating the Worker.

Worker-side adapters execute Fetch/SSE and IndexedDB. A minimal main-thread bridge supplies browser
storage primitives unavailable inside a dedicated Worker. React subscribes to projections; component
lifecycle neither creates the process-wide Worker nor owns durable work.

## Replica contract

### Guards

Each Account installation receives a new random incarnation. Every visible guarded plan includes:

```text
account_id
expected_incarnation
expected_replica_revision
expected_lock_epoch
```

A successful visible plan increments the revision exactly once. A mismatched guard returns `Stale`
or `Missing` without writes. Rust rereads and recomputes. An in-process per-Account actor reduces
contention but is not the durability authority.

A separate durable lock epoch tags work that may produce plaintext. Lock first clears live secrets
and decrypted projections and invalidates old deliveries, then advances the persisted Account head
with an exact compare-and-swap that leaves the Replica revision and every Replica row unchanged.
Normal guarded writes compare and preserve that epoch, so work prepared before Lock becomes stale.
The Account stays locked and refuses new plaintext work while an epoch advance needs retry. A new
incarnation starts at epoch zero; a replay of the same incarnation preserves its durable epoch. A
Runtime close may advance the durable fence best-effort after synchronously closing access and
callbacks: the closed process accepts no later work, and a restored Account starts signed out, so
that close-only advance does not require retry across process lifetime.

### Logical records

The first logical schema is Account-scoped and contains:

- Account installation: local Account ID, incarnation, Server URL, Server User ID, schema version,
  Replica revision, required decimal-u64 durable lock epoch, existing Account metadata and pinned
  KDF profile;
- existing Device-bound quick-unlock/session data and existing Session-bound credentials, routed by
  their established storage classifications rather than silently promoted to longer persistence;
- Replica metadata: tagged state (`cold`, `bootstrapping`, `ready`, `refresh_required`), active
  Bootstrap generation, tagged Cursor (`cold`, `captured_empty`, `captured_value(id)`), and safe status;
- staged Bootstrap generations with pinned watermark, next page cursor, and page identity;
- authoritative Vault summaries, wrapped Vault keys, encrypted Items, ciphertext metadata, Server
  versions, and tombstones;
- encrypted optimistic Item overlays keyed by Item and Operation;
- immutable active Operations and their mutable scheduling state;
- immutable observed semantic outcomes; and
- compact Account-lifetime local receipts preventing completed Operation-ID reuse.

The local receipt retains identity, fingerprint, terminal result, entity/version, and completion
revision, not the full request ciphertext. It is distinct from the Server's retained outcome.

The Web adapter uses a dedicated versioned Replica IndexedDB database whose stores can participate in
one transaction. It does not stretch the current isolated generic-record calls into false atomicity.

### Bootstrap

`BeginBootstrap` creates an unreachable staging generation. `StageBootstrapPage` verifies generation,
page identity, and expected next cursor before storing encrypted Vault and Item records. Replaying the
same page is a no-op only with the same page fingerprint.

`PromoteBootstrap` requires the final page and atomically changes the active generation, tagged pinned
watermark, Replica state, and revision. Readers observe either the previous complete generation or the
new complete generation. Cursor expiry begins another staging generation while the old projection
remains readable; cleanup removes only a proved unreachable generation.

### Offline create

Rust creates the final Item ID before encryption. That ID is used in AAD, optimistic projection, route
path, Server row, and authoritative reconciliation. There is no temporary-ID remapping.

`AcceptCreateLoginItem` verifies an unlocked Account, ready Replica, personal Vault, and absence of a
conflicting active Operation. One transaction inserts:

- Operation ID and kind;
- canonical Item and Vault IDs;
- exact immutable HTTP method, path, content headers, and body bytes;
- independent request fingerprint;
- scheduling state with no terminal attempt limit; and
- the encrypted optimistic Item overlay.

Only then does `request` return `Accepted`. Authorization is excluded from immutable bytes and is
attached from the current Session when dispatched.

A dispatch lease suppresses duplicate local sends but supplies no correctness. Transient transport,
Server, and renewable Session errors clear/expire the lease and persist bounded exponential backoff.
Attempt count is diagnostic. No per-Operation discard exists.

### Outcome and reconciliation

A matching semantic outcome is immutable. A same-ID/different-fingerprint result is a fatal invariant
violation. Transport status alone is never an outcome.

For applied create, Rust fetches the authoritative encrypted Item. One reconciliation plan verifies
outcome fingerprint and Item/version, writes the authority, removes active Operation and overlay,
inserts the compact receipt, and advances a matching exact Cursor when present. An HTTP success before
this plan is not local completion.

A retained semantic rejection stops retry and marks the encrypted optimistic Item failed without
silently destroying the user's ciphertext. Editing or clearing failed optimistic Items is outside the
first slice. Account removal deletes all local records and invalidates late plans by incarnation; it
does not cancel or reverse a Server effect. A repeated full Sign-in replaces only the installed
Account head and preserves accepted Operations and their encrypted optimistic overlays. Explicit
Device Account removal is the only flow that deletes those durable local records.

Applying a remote change fetches its authoritative entity outside storage, then atomically applies the
encrypted entity/tombstone and advances from the exact expected Cursor. Fetch or commit failure leaves
the Cursor unchanged. Stale Server versions cannot overwrite newer ciphertext.

## Sign-in and Session behavior

Rust ports the existing sequence and characterization cases from the TypeScript auth service:

1. validate Secret Key;
2. create SRP client ephemeral;
3. normalize the Server URL and require the request's explicit `insecure_transport_confirmed` field
   before contacting a remote plain HTTP Server;
4. start login;
5. validate the Server KDF profile against the pinned/default policy before expensive derivation;
6. derive the existing auth key and MUK;
7. finish SRP and verify the Server proof;
8. load all wrapped Vault-key pages and required Account material;
9. verify and apply Travel Mode with the freshly issued Session token; and
10. install Account, quick-unlock data, live keys, and current Session according to existing storage
   lifetime rules.

The HTTP confirmation is part of `SignIn`, not transport-adapter policy. Rust refuses a remote plain
HTTP Server unless `insecure_transport_confirmed` is true and stores that confirmation with the
Account. Active account and previously confirmed unrelated Accounts never supply it implicitly.

After the verified Server response supplies the User ID, Rust resolves the installation by normalized
Server URL and Server User ID. Repeated full Sign-in preserves the stable local Account ID and
atomically replaces its installation with a new random incarnation. First Sign-in creates a new
stable Account ID and incarnation. Replacement has no observable deleted or partially installed
state, and the new incarnation rejects late work from the replaced installation.

The Device key is created and stored before it is needed for installation. A crash can leave an
unused Device key or orphaned Server Session, neither of which exposes Account data. Device-bound
Account/quick-unlock data commits before publication. Session-bound credentials then commit to their
platform scope. `SignedIn` is returned only when both are usable.

If a crash leaves Device-bound Account data without Session-bound credentials, startup presents that
Account as signed out and locked. When its stored Secret Key, pinned KDF profile, and quick-unlock
lifetime remain valid, `QuickUnlock { account_id, master_password }` reads that material inside Rust
and runs the complete existing SRP ceremony, including Server-proof verification, all Vault-key
pages, Travel Mode verification, and fresh Session installation. Password-only describes the host
input, not an offline or shortened authentication path. The Account remains signed out and locked
until the sequence succeeds. Missing, expired, or corrupt quick-unlock material requires full
Sign-in with email, master password, and Secret Key. The Runtime never publishes an unlocked Account
or treats missing credentials as a successful Session. This recoverable boundary is explicit because
browser session storage cannot join an IndexedDB transaction.

Session renewal runs in Rust through the current refresh route. A missing/expired Session during a
pending Operation changes its visible waiting reason and preserves the Operation. Flows that require
re-running SRP use the same Rust-owned existing ceremony; the host only collects credentials.

## Server Operation contract

### Persistence

Add a new migration with a final-only `operation_outcome` relation keyed by `(user_id, operation_id)`
and cascaded from Server User deletion. It stores:

- closed Operation kind;
- 32-byte request fingerprint;
- closed applied/rejected result;
- affected entity identity and version for applied results;
- closed rejection code and bounded safe details for rejected results; and
- resolution timestamp.

Rows have no expiry. They do not store arbitrary HTTP response bytes, authentication, or Session
identity. Rust-defined closed values generate the OpenAPI contract under ADR 0012.

### Identity and fingerprint

`Idempotency-Key` remains the wire header but is required and redefined as the stable Operation ID for
durable mutation routes. Server identity is `(User, Operation ID)`, independent of Session, client ID,
or Device. Client ID remains Sync attribution only.

The Server recomputes a length-delimited SHA-256 fingerprint over a fixed discriminator, Operation
kind, canonical route identity and path values, exact raw body bytes, and normalized concurrency
preconditions where relevant. Bearer token, Session ID, client ID, tracing, and other transport-only
headers are excluded.

Same User, ID, and fingerprint returns the retained outcome. Same User and ID with another fingerprint
returns `OPERATION_ID_REUSED` without changing the original. Different Users may use the same ID.

### Atomic create Item

One domain-facing create-Item Operation starts a PostgreSQL transaction and acquires a transaction-
scoped advisory lock derived from `(user_id, operation_id)`. A collision may serialize unrelated work
but cannot change correctness. The transaction reads an existing final outcome and replays or rejects
ID reuse before mutation.

With no outcome, the transaction performs all schema-valid ciphertext validation, Vault visibility,
and write authorization. It then either:

- inserts the Item plus existing Item audit and `item_created` Sync event; or
- proves one closed semantic rejection and inserts its rejection audit record.

It next inserts the final semantic outcome and a User-scoped `operation_resolved` Sync event, then
commits and wakes SSE. A different Operation racing for the same Item ID uses non-throwing conflict
detection so its semantic Item-ID conflict can commit. Database, serialization, and infrastructure
failures roll back everything and store no outcome. Authentication and malformed transport requests
are rejected before semantic execution and store no outcome.

The route remains:

```http
PUT /api/v1/vaults/{vaultId}/items/{itemId}
Idempotency-Key: <operation-id>
```

It returns a generated closed `CreateItemOperationOutcome` body for applied and rejected terminal
results. Add authenticated `GET /api/v1/operations/{operationId}` returning the same User-scoped type
or `404`. A caller may recover by retrying identical bytes or by lookup.

Changes include `operation_resolved` as a User-scoped event and fetch its authority through the lookup
route. Applied creates also retain `item_created`. Current bounded page/byte limits, opaque Cursor,
authoritative entity fetch, and hint-only SSE remain. Bootstrap never enumerates unbounded historical
outcomes; locally pending IDs remain directly retrievable even when their outcome predates the pinned
watermark.

All remaining uses of the old HTTP response-cache idempotency wrapper must migrate before its tables,
24-hour expiry, stale claims, indeterminate errors, and code are deleted. Temporary development
sequencing is not a shippable dual protocol.

## Web cutover

The production switch occurs at the Web composition root after Server and Runtime acceptance tests
pass. The Sign-in form calls `request(SignIn)`. The Account Runtime provider observes the generated
Runtime projections. Existing Web Sync ownership and create-Item dispatch stop before the Runtime
writer becomes active for that Account.

The new Replica database may coexist temporarily with the untouched transitional database during
development, but the two paths are never active writers for the same Account. Because there are no
users, no persisted-client migration bridge is required.

After Web acceptance, delete Web-owned orchestration and providers replaced by the Runtime. Shared
TypeScript modules still compiled by Desktop or Extension remain until those hosts cut over and are
then removed rather than kept behind a compatibility facade.

## Verification

### Binding gate

A completed throwaway compile spike proved, with the pinned toolchain:

- data-carrying closed request/response/projection variants;
- async Rust-to-host primitive callbacks;
- observation callback and handle close exactly once;
- caller cancellation after simulated durable acceptance without stopping Runtime-owned work;
- one WebAssembly artifact containing Runtime API and existing crypto implementation; and
- headless native Runtime creation without Activity or SwiftUI-scene ownership.

The spike source and artifacts were removed after its verdict was recorded in ticket 15. Native
Kotlin/Swift use UniFFI 0.31.2. Web uses a thin explicit `wasm-bindgen` adapter because the pinned
UniFFI experimental single-threaded WASM backend generated an async foreign-callback future with an
incompatible `Send` requirement. This binding-only difference does not change Runtime ownership or
protocol semantics. Android and Apple production link tests remain required because their language
toolchains were unavailable on the spike machine.

### Shared Replica conformance

Run the same logical plan suite against an in-memory interpreter, failure-injected IndexedDB, and
Rust SQLite. It proves:

- accepted implies Operation plus optimistic overlay atomically;
- Bootstrap generations promote old-or-new with tagged empty Cursor distinct from cold;
- Cursor advances only with all covered authority;
- arbitrary transient attempts and restarts preserve exact bytes and continue retry;
- leases, duplicate sends, response loss, and concurrent Runtime calls create at most one effect;
- stale revision/version/incarnation and lock races publish no partial or stale state;
- Account remove-and-readd rejects late work;
- no persisted fixture contains known plaintext markers; and
- equivalent plan histories produce equivalent visible IndexedDB and SQLite state.

### Server

Server tests inject failure after each prospective Item, audit, Sync, and outcome write and prove a
fully rolled-back or fully committed transaction. They cover identical concurrent replay, ID reuse,
different Operations racing for one Item ID, retained rejection, arbitrary elapsed time, renewed
Session, response loss plus lookup, User isolation, User-deletion cascade, changes visibility and
limits, and absence of historical outcomes from Bootstrap.

### End to end

The acceptance scenario runs with deliberate Worker termination, offline transport, more than five
failures, Session renewal, dropped first success response, UI unsubscribe after acceptance, and final
authoritative read. It asserts one Item row, one Item audit, one Item event, one Operation outcome, one
Operation event, one completed local receipt, no active Operation, and no duplicate visible Item.

Generated Runtime bindings, generated OpenAPI clients, and generated Rust Server-wire types have drift
checks. Final verification runs targeted suites while iterating, then `pnpm check:ci` and
`pnpm check:ci:rust`.

## Out of scope

- Registration, Recovery, cryptographic algorithm or format changes.
- Searchable plaintext persistence or a new encrypted search-index design.
- Shared Vault create conflicts, update/move/delete, Attachments, Travel-mode mutation, and remaining
  mutation kinds beyond what Sign-in/Bootstrap must read.
- Editing or discarding a terminally rejected optimistic Item.
- Desktop, Extension, Android, and iOS cutover inside this first Web acceptance slice.
- iOS minimum version, App Group/credential-extension model, Keychain accessibility, and background
  execution policy; these are decided before the iOS foundation slice.
