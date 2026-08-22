# Candidate greenfield architecture

Status: **Candidate**.

## System shape

```text
React / SwiftUI / Compose presentation
                  |
       snapshots + domain commands
                  v
         ClientRuntime interface
                  |
        Rust bittery-engine
  session · commands · crypto policy
  replica · outbox · sync · projections
       |           |           |
 LocalDatabase  QuickUnlock  Transport/Scheduler
        platform capability adapters
```

## Client engine

`ARCH-ENGINE-001 MUST` One Rust client engine owns every security-sensitive behavior that must not
diverge across platforms: session state, domain commands, key ceremonies, local replica, durable
outbox, Sync reconciliation, conflicts, bootstrap, and read-model construction.

`ARCH-ENGINE-002 MUST` Each independently managed host has one `ClientRuntime` owner. UI windows and
views are clients. An OS-launched Credential Provider is an independent constrained host even when
Android currently places its service in the main application's process: it shares no mutable engine
singleton, unlocked session, live key, or correctness-critical in-memory state with the main host.

`ARCH-ENGINE-003 MUST` Applications cannot import engine internals. They cross a small command/query/
subscription interface.

`ARCH-ENGINE-004 MUST` Commands express intent rather than generic CRUD. Queries return purpose-built
immutable projections rather than database entities.

`ARCH-ENGINE-005 MUST` Expected outcomes cross bindings as closed, versioned data. Durable mutations
cannot be cancelled by loss of caller interest.

`ARCH-ENGINE-006 MUST` Observation uses versioned snapshots or invalidation generations. Slow
observers may skip intermediate states. Lock/security events have a high-priority channel.

`ARCH-ENGINE-007 MUST` A Credential Provider exposes a closed credential capability interface:
locked suggestions; unlocked Login search and selection; password fill; TOTP generation; passkey
assertion and registration; Login or passkey creation and update in a named writable Vault; and
one-time or persistent website/application match confirmation. It exposes no generic query, CRUD,
Vault browser, Secure Note, Attachment, Team, administration, import/export, or Sentinel operation.

`ARCH-ENGINE-008 MUST` Each Provider Unlock Wrapper opens the complete Account Key Set only inside
the Provider's Rust core. A platform binding may return the one User-selected password, TOTP result,
or passkey response required by the OS ceremony, and may accept a credential creation request; it
never returns a wrapping key, Vault key, Account Key Set, Account Signing Key, key handle, or generic
decryption primitive. The narrow capability interface is not represented as cryptographic
least-privilege against code execution inside the Provider core.

`ARCH-ENGINE-009 MUST` Main and Provider hosts have separate unlocked sessions and separate wrapper
records. A Provider unlock may batch every locally configured Provider Account through independent
wrappers, but it neither unlocks nor hands a session to the main host. Process termination destroys
only that host's live keys. Explicit Device Lock, OS session lock, suspend, learned Device revocation,
and Account removal advance shared lock state that both hosts check before their next command and that
invalidates both sessions.

`ARCH-ENGINE-010 MUST` A locked Credential Provider reads only a separately protected Suggestion
Index. Its permitted preview is Item title, username, website/application match, and User-chosen local
Account label. It contains no credential secret, Vault or Server name, other Item field, TOTP seed,
passkey private material, Attachment, Team data, count, or activity. The exact encrypted index and
matching construction are fixed by [`search-index.md`](search-index.md).

`ARCH-ENGINE-011 MUST` A Provider create or update reports success after the Account Replica's
declared Durability class accepts the complete local operation, never after an in-memory mirror write.
The Provider attempts Sync within its OS execution budget. An offline, interrupted, or terminated
attempt remains the same durable pending operation for any later main or Provider runtime to resume.

`ARCH-ENGINE-012 MUST` iOS AutoFill and Android Credential Manager/Autofill implement one semantic
Provider contract and the same fixtures. Their OS entry points, UI, key adapters, and lifecycle code
may differ. Android co-residence is an implementation detail and cannot weaken the independent-host
contract.

`ARCH-ENGINE-013 MUST` The main and Provider hosts are one enrolled Mobile Device. They use one
Device Grant, public Device credential, status, and revocation while each host and authorization
method keeps a separately wrapped copy of the same private Device credential seed. Only Rust opens
that seed. Concurrent hosts reserve request-counter ranges through guarded Replica commits before
signing, so no counter can be reused; no second Provider Device or platform key bridge exists.

Candidate external operations are `open`, `bootstrap`, `unlock`, `lock`, `dispatch`, `query`,
`syncNow`, `observe`, and `close`. Exact FFI form remains OPEN.

## Crate depth

Start with few deep crates:

```text
bittery-engine       session, domain commands, replica, sync policy
bittery-crypto       primitives and persisted cryptographic formats
bittery-protocol     public HTTP and interoperability types
bittery-bindings     UniFFI and WASM projection
bittery-server       modular monolith
```

Domain nouns begin as internal Rust modules. A module becomes a crate only for an independently
valuable interface, separate compilation target, or enforced dependency direction.

## Platform hosts

- **Web:** React/TypeScript, worker-hosted Rust/WASM runtime, transactional browser-store adapter.
- **Extension:** Chromium MV3 and Firefox required; Safari architecture-compatible and deferred.
  Background host owns the runtime; popup/content scripts are typed clients.
- **Desktop:** Tauri v2, React renderer, native Rust runtime owner. Renderer has no direct file,
  database, keychain, or arbitrary command access.
- **iOS:** Swift/SwiftUI with UniFFI, native secure storage, SQLite, background scheduler, and AutoFill
  extension.
- **Android:** Kotlin/Compose with UniFFI, Keystore, SQLite, WorkManager, and Credential Manager/
  Autofill integration.

`ARCH-HOST-001 MUST` Every webview-hosted surface runs under a Content Security Policy. The Web client
uses the `HOST-009` policy verbatim. The Desktop webview uses the same policy; a null or absent policy
is a defect. Extension pages declare `script-src 'self' 'wasm-unsafe-eval'` under
`content_security_policy.extension_pages`, which is the strictest policy Chromium and Firefox permit
for MV3 and is the minimum under which the WASM engine instantiates.

`ARCH-HOST-002 MUST` The Web client talks only to the Server that served it. It is same-origin with
its Server, so no Server sends cross-origin resource sharing headers and no deployment configures an
origin allowlist. `ACCOUNT-001` owns the product rule this enforces.

All platforms share engine behavior, protocol types, fixtures, localization source, and design tokens.
Native feature UI is not shared.

## Browser TypeScript and Effect

Effect v4 is the chosen TypeScript host framework. During beta it is pinned exactly; stable v4 is a
release gate.

```text
React
  -> snapshots and command callbacks
web-platform
  -> Effect adapters for actual browser capabilities
web-runtime
  -> sole WASM/Worker importer
Rust ClientRuntime
```

Effect owns typed browser-edge failures, Worker lifecycle, scoped listeners/resources, clipboard,
file picker, visibility/connectivity, notifications, and cancellable presentation tasks. It does not
own Vault policy, session state, replica/search, durable retries, Sync scheduling, conflict handling,
or canonical domain schemas. React feature modules do not import Effect Layers, WASM, or Worker
internals directly.

## Local persistence and quick unlock

`ARCH-STORE-001 MUST` Engine-level Replica semantics are shared while physical storage and Durability
profiles vary. Native hosts use SQLite through Rust. Web and Extension use IndexedDB transactions
with the explicit `durability: "strict"` hint; SQLite/OPFS is not a requirement and may be investigated
later only for measured performance. The normative logical schema, transaction interface, lifecycle
and conformance contract are in [`replica.md`](replica.md).

`ARCH-STORE-002 MUST` The encrypted replica is separate from every Device Unlock Wrapper record. Each
local authorization method owns one key-context `0x03` Account Key Set envelope for one Account and
Device. A wrapper contains no Account Unlock Key, master password, Secret Key, Vault key, or plaintext
Account Key Set. Locking deletes live keys without deleting the encrypted replica, Device enrollment,
or wrapper records.

`ARCH-STORE-003 MUST` Web/extension storage is treated as weaker than native keychain/Keystore
capability. No implementation silently claims equivalent hardware binding, non-extractability, or
user-presence guarantees. A copied password-wrapper record permits offline password trials under the
Account's pinned key-derivation profile, and product documentation states that limit.

`ARCH-STORE-004 MUST` The public `ClientRuntime` quick-unlock operation accepts an authorization
intent and returns only account-scoped unlocked capabilities and projections. It never returns a
wrapping key or Account Key Set through a client binding. The platform adapter reports capabilities,
creates or deletes its local anchor, performs one fresh authorization ceremony, and releases one
account-and-Device-bound 32-byte wrapping key at a time directly into sensitive Rust memory. The core
opens the `0x03` envelope, zeroizes the wrapping key, retains the Account Key Set only in its unlocked
session, and zeroizes it on Lock.

`ARCH-STORE-005 MUST` Password quick unlock is the baseline on every enrolled Device that passes the
64 MiB capability gate. It derives one wrapper key from the NFKD UTF-8 master password and a local
random 32-byte Device factor under the Account's pinned profile and the canonical construction in
`cryptographic-format.md`. The factor and wrapper are local Device state, are never stored by the
Server or synchronized by Bittery, and are not claimed to remain secret after Device storage is
copied. Full sign-in or trusted enrollment creates the first password wrapper; trusted enrollment
uses the transferred Secret Key to verify the entered master password before enabling it.

`ARCH-STORE-006 MUST` Platform quick unlock is an optional enhancement, explicitly enabled on each
Device after password quick unlock. Current Accounts are confirmed individually and a later Account
asks once before joining the local platform anchor. A Secure Enclave Mac with Apple silicon or T2 is
labeled **hardware-gated quick unlock**. A browser may offer **authenticator-gated quick unlock** only
after an end-to-end runtime capability check returns a user-verified WebAuthn PRF result; PRF is not a
browser requirement and unverified Extension paths remain disabled. Other Macs, Windows, and Linux
offer password quick unlock and label platform quick unlock unavailable. No app dialog, DPAPI,
PasswordVault, Credential Manager, or Linux Secret Service read is represented as a cryptographic
gate. Native mobile Provider capability and its honest system/hardware labels follow `AUTH-047`.

`ARCH-STORE-007 MUST` Every local authorization method and runtime host retains a separate `0x03`
envelope and wrapping key for each Account and Device. A Secure Enclave installation has one platform
anchor across its local Accounts. WebAuthn has one PRF anchor per stable Server and RP ID, so one
ceremony may open every joined Account of that Server; a standalone multi-Server Extension prompts
once per Server, while Desktop delegation may open all. WebAuthn's root is separated by labeled
HKDF-SHA-512 over Server, Account, and Device; a Secure Enclave anchor separately unwraps one random
32-byte key per Account. Neither construction reuses one Account's wrapping key for another. Every
authorization context expires at Lock and is never reused by a later unlock ceremony.

`ARCH-STORE-008 MUST` A password entered at the shared locked screen is tried sequentially against
each local password wrapper and unlocks every matching Account; non-matching Accounts remain visibly
locked. The implementation keeps one Argon2id allocation at a time. A platform ceremony likewise
unlocks every Account enrolled under that anchor, subject to WebAuthn's per-Server boundary. Desktop
and Extension remain distinct Devices with distinct wrappers. When an authenticated Desktop IPC is
available, the Extension may delegate the narrow Vault operations that
[Desktop architecture and the extension IPC](../../../planning/greenfield-decision-map/issues/42-desktop-architecture-and-ipc.md)
permits; it receives neither the Desktop Account Key Set nor a wrapping key and retains its own
password-wrapper fallback. A mobile Provider uses the same batch rule only over Accounts explicitly
enabled for that Provider and never opens the main host's wrappers.

`ARCH-STORE-009 MUST` Auto-lock is host-wide across unlocked Accounts. Its default is ten minutes of
no real User interaction in that Bittery host, selectable as 1, 5, 10, 30, or 60 minutes; there is no
never setting. Background Sync, page activity, and unauthorised IPC do not reset it. Process or
browser-runtime termination locks that host immediately. Explicit Device Lock, OS session lock,
suspend or hibernate, and learned Device revocation advance shared lock state and lock every host of
that Device. Lock drops the affected core handles and all live Account and wrapping keys before
publishing its locked projection.

`ARCH-STORE-010 MUST` The locked projection shows only a local User-chosen Account label, lock reason,
and available Unlock routes. It reveals no email, Server address, Vault or Item data, Team data,
counts, activity, or blurred prior view. Platform quick unlock requires periodic password quick unlock
after 30 days by default, selectable as 14, 30, 60, or 90 days or disabled. The setting is Device-wide;
a successful password quick unlock resets the clock for every Account that password opened. The
Credential Provider's separate locked Suggestion Index is the sole exception and is bounded by
`ARCH-ENGINE-010` and `PRIVACY-017`.

`ARCH-STORE-011 MUST` A missing or permanently invalid platform key fails closed, removes only the
unusable platform record, explains the cause, and leaves password quick unlock and remote Unlock
routes intact. Re-enabling platform quick unlock requires an explicit successful password quick
unlock. Learned recovery or sign-out revocation locks and removes every local wrapper for the revoked
Device. Remote erasure is never claimed for a Device that does not reconnect.

`ARCH-STORE-012 MUST` One logical Replica belongs to exactly one stable Server and Account pair.
Multi-Account and cross-Server behavior coordinates independent Replicas and has no cross-Replica
transaction. Physical co-location does not weaken Account isolation or removal.

`ARCH-STORE-013 MUST` The Replica uses the typed logical tables and indexes in
[`replica.md`](replica.md). Accepted versioned objects are immutable; small head and control rows
select current state, and retention deletes rather than rewrites old authenticated bytes. Every
Envelope-bearing row carries the complete typed path required to reconstruct `CRYPTO-009` AAD.

`ARCH-STORE-014 MUST` Canonical remote-base, canonical local-overlay, canonical local-control,
derived, and volatile state have distinct loss rules. Durable decrypted Vault content is forbidden.
Plaintext may exist only in an unlocked core or a purpose-built minimal Projection until Lock or
invalidation; forensic erasure of host strings, swap, flash and backups is not claimed.

`ARCH-STORE-015 MUST` [`replica.md`](replica.md) is the closed registry of engine-visible plaintext
Replica fields. Server visibility under `PRIVACY-007` does not admit a local field automatically.
Item content and content-derived data are encrypted or volatile; a persisted search/autofill index
uses the separate encrypted design and registry amendment in [`search-index.md`](search-index.md).

`ARCH-STORE-016 MUST` The adapter offers consistent Snapshot reads and closed typed guarded commit
plans. A plan validates its expected commit/head values and applies all mutations in one serializable
Account transaction or applies none; stale input returns a typed `StaleSnapshot`. Network, crypto,
prompts and unbounded work cannot run inside the transaction.

`ARCH-STORE-017 MUST` Bootstrap follows [`sync-protocol.md`](sync-protocol.md): one fixed Cursor, a
non-renewing 24-hour Server lease, deterministic bounded pages and opaque resumable tokens write one
invisible remote-base generation. One guarded commit promotes the complete generation and Cursor
together. A generation is never mixed with another Cursor, locally accepted operations remain in a
generation-independent overlay, and retired/incomplete generation cleanup is idempotent and
post-promotion.

`ARCH-STORE-018 MUST` Every adapter declares one closed Durability class with the exact commit meaning
in [`replica.md`](replica.md). Native crash durability and browser transaction completion are not
represented as equivalent. `browser-transactional` is an accepted product floor for Web and
Extension: it promises one whole committed state while the Origin store exists, not a physical-disk
acknowledgement or survival of eviction, clearing, browser policy, Extension removal, or storage
forensics.

`ARCH-STORE-019 MUST` Lock removes volatile keys and Projections without changing encrypted durable
state. There is no separate local sign-out state: a User either Locks or removes an Account. Account
removal and Device wipe first persist a deny-open intent in the installation catalog, then resume
idempotent deletion across Replica and key stores after any interruption. Physical erasure from flash
or backups is not promised.

`ARCH-STORE-020 MUST` A constrained Credential Provider uses the same Account Replica schema,
operation overlay, guarded-commit contract, and Sync state through the closed capability subset in
`ARCH-ENGINE-007`. There is no Provider mirror or second Replica truth. The Suggestion Index is a
separately protected derived projection, never a second canonical store.

`ARCH-STORE-021 MUST` Supported schema upgrades preserve canonical state and the complete local
overlay, rebuilding derived state when useful. Large upgrades use an invisible shadow generation;
newer unknown versions remain untouched and fail closed. Corruption handling follows the state class:
rebuild derived, discard inactive, replace a whole active remote base, and stop only the affected
Account on damaged unique local work.

`ARCH-STORE-022 MUST` A storage adapter is supported only after the release-blocking conformance suite
passes against its real backend. It covers model histories, failpoints, forced termination/reopen,
migration, corruption, bootstrap, removal/wipe and the declared Durability class. An in-memory fake
cannot certify an adapter.

`ARCH-STORE-023 MUST` Web requests persistent Origin storage once during Device enrollment, after a
plain-language explanation and before the initial Replica bootstrap. Refusal or heuristic denial
does not block enrollment, reads, or local mutation. The Device storage view reports the current
grant and offers an explicit retry; Bittery does not repeatedly surprise the User with the request.

`ARCH-STORE-024 MUST` The Chromium and Firefox Extension manifests require `unlimitedStorage`.
Implementations treat it as quota and eviction protection only to the extent documented by the
running engine; it does not change the `browser-transactional` acknowledgement or imply survival of
Extension removal, explicit clearing, or exhausted physical storage.

`ARCH-STORE-025 MUST` Browser hosts expose the count and age of locally accepted operations until
Server Sync proves them committed. Lock, navigation, runtime termination and page or browser close
are not blocked. Account removal, Device wipe and any Bittery-controlled local reset first complete
Sync or require an explicit confirmation that names the exact number of operations whose only known
copy will be discarded.

`ARCH-STORE-026 MUST` Storage conformance has one host-independent semantic corpus plus a mandatory
profile for each declared Durability class. Every adapter proves the same typed-state, atomicity,
isolation and Sync invariants. `native-crash-durable` additionally proves forced termination and
reopen across its strongest persistence barrier; `browser-transactional` proves Worker/runtime
termination while the Origin remains and proves that whole-Origin loss is reported rather than
misrepresented as a recoverable partial Replica.

`ARCH-STORE-027 MUST` Every native Account Replica has an OS-released Replica Lease. Main and Provider
hosts hold a shared lease for ordinary snapshots, guarded commits, and Sync; database transactions,
not the lease, serialize those operations. Schema migration, corruption repair, physical-store
replacement, Account removal, and Device wipe require the exclusive lease before touching the
Replica. Failure to acquire the required lease returns a retryable busy result and never reads a
stale mirror, breaks a live lock, or proceeds after a timeout by assumption.

`ARCH-STORE-028 MUST` Each Account Replica may persist one opaque Search Snapshot under a fresh random
Search Index Key sealed to that Account. No snapshot spans Accounts or Servers. Account, Collection,
and All Accounts scopes merge independently unlocked results only in volatile memory and preserve
Server, Account, Vault, and Item provenance.

`ARCH-STORE-029 MUST` A Search Snapshot is an asynchronous derived checkpoint. A search-relevant
canonical commit immediately updates the live projection and marks the stored derived set incomplete;
construction happens outside the transaction, and a guarded commit installs the replacement only
while its source still matches. Open discards the whole snapshot on absence, incompleteness, source
mismatch, unknown version, corruption, or failed authentication.

`ARCH-STORE-030 MUST` Each mobile Account's Suggestion Snapshot uses a distinct random key protected
by a Device-only, OS-unlocked system record without a Bittery Account-unlock prompt. The constrained
Provider core may return only matching `PRIVACY-017` previews. Any commit that may change those
previews, their visibility, Vault access, or Travel eligibility atomically installs a replacement or
marks the set incomplete; an incomplete set returns `preparing`, never stale or negative results.

`ARCH-STORE-031 MUST` [`search-index.md`](search-index.md) is the normative field, normalization,
ranking, domain-match, encrypted framing, rebuild, invalidation, and Travel-eviction contract. Its
semantic, relocation, corruption, interrupted-checkpoint, progressive-completeness, Public Suffix,
Account-scope, and Travel-rekey fixtures are release-blocking for every applicable core and adapter.

## Server

The Server is a Rust/Axum/Postgres modular monolith:

```text
server/
├── app/
├── domains/
│   ├── identity/
│   ├── sessions/
│   ├── vaults/
│   ├── teams/
│   ├── sharing/
│   ├── sync/
│   └── administration/
├── integrations/
├── transport/
└── persistence/
```

Each domain owns its authorization, SQL, commands, queries, mappings, and real-Postgres tests.
Persistence contains pool, transaction, migration, and shared error mechanics only.

`ARCH-SERVER-001 MUST` One command transaction atomically commits its Domain mutation, audit record,
canonical Operation outcome, the initiating Account's Sync Commit and one ordered fan-out Sync Commit
per other affected Account. A Sync Commit is the atomic client apply unit defined by
[`sync-protocol.md`](sync-protocol.md); there is no per-Vault or Server-global client Cursor.

`ARCH-SERVER-002 MUST` Postgres is an intentional product dependency. SQLx with checked explicit SQL
is the persistence mechanism. Generic repositories and entity-save workflows are absent.

`ARCH-SERVER-003 MUST` Static statements use checked SQLx macros/query files. Migrations are
hand-authored and append-only. CI creates a real schema, verifies SQLx metadata, runs upgrade tests,
and exercises critical query plans.

`ARCH-SERVER-004 MUST` OpenAPI and documented encrypted formats are public interfaces. Third-party
clients may implement them without the Rust engine; cross-platform fixtures define compatibility.

## Architecture enforcement

CI rejects forbidden dependency directions, manually restated generated types, policy in platform
adapters, external integrations enabled by default, and platform adapters that fail conformance.
Native Rust, WASM, Swift bindings, and Kotlin bindings execute the same semantic fixture corpus plus
the mandatory profile for each storage adapter's declared Durability class.

Performance decisions use approved user-visible budgets: unlock-to-list, search, autofill, local
mutation acknowledgement, cold-start memory, and background energy. Technology-specific speed claims
are not requirements.
