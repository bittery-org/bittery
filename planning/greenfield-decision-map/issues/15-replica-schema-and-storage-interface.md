# Replica schema and transactional storage interface

Type: grilling
Status: resolved
Blocked by: 08

## Question

`ARCH-STORE-001` promises shared engine-level replica semantics with varying physical storage, and leaves both the schema and the adapter interface undefined.

Decide:

- The logical replica schema: entities, keys, indexes, and what is stored as ciphertext versus engine-visible plaintext, checked against the closed plaintext list.
- The transactional adapter interface the engine requires: atomicity scope, isolation, durability contract, and what an adapter must prove.
- Where decrypted material may exist and for how long.
- Generation and promotion semantics for bootstrap, so an interrupted bootstrap never replaces the last usable generation.
- What happens to the replica on lock, sign-out, Account removal, and Device wipe, and which invariants must hold across those.
- Whether the same schema serves a constrained credential-provider runtime.

Produces: a schema specification, an adapter conformance contract, and seed scenarios 5 and 10.

### Inherited from [Key hierarchy and canonical envelope format](08-key-hierarchy-and-envelope-format.md)

`CRYPTO-009` is a hard constraint on this ticket's interface: the additional authenticated data of
every envelope includes a binding tuple the decoder **reconstructs from where it found the blob**, so
no component may hand the cryptographic layer a bare blob. Every read and write path must carry the
stable Server identity and the object's typed path (Account and optional Device; Vault, Item and
revision; Attachment and chunk; or Share link) alongside the bytes. An interface that returns
`Vec<u8>` and nothing else cannot decrypt.

`CRYPTO-008` also means the replica stores envelopes verbatim, header included, so the schema needs no
separate columns for nonce, epoch, or algorithm.

## Answer

Resolved with the maintainer on 2026-08-21. Promoted to `ARCH-STORE-001` and new
`ARCH-STORE-012` through `ARCH-STORE-022` in
[`architecture.md`](../../../docs/greenfield/target/architecture.md), the normative
[`replica.md`](../../../docs/greenfield/target/replica.md), seed scenarios
[5](../../../docs/greenfield/scenarios/05-interrupted-bootstrap.yaml) and
[10](../../../docs/greenfield/scenarios/10-runtime-termination.yaml), the root glossary, and accepted
[ADR 0022](../../../docs/adr/0022-account-replicas-use-guarded-atomic-commits.md).

### Resolution

1. **One Replica belongs to one Account.** Its stable scope is the Server identity and Account
   identifier. A multi-Account runtime coordinates independent Replicas, and no cross-Account or
   cross-Server operation receives an atomicity promise. Physical adapters may co-locate data only if
   they preserve the same logical isolation and removal boundary.
2. **A completed state transition is Account-atomic.** Canonical objects, the durable local operation,
   its optimistic overlay effect, control state, cursor and already-defined derived updates may move in
   one serializable commit. Crypto, network, prompts and unbounded policy work happen before it.
3. **The logical schema is explicit and typed.** Fixed tables and composite Domain keys replace the
   frozen implementation's opaque string collections. Versioned objects are immutable; small head and
   control rows select the current state, and retention explicitly deletes old rows. Every Envelope is
   stored verbatim beside the complete path needed to reconstruct `CRYPTO-009` AAD; there is no bare
   blob API.
4. **Canonical, derived and volatile state are different contracts.** Remote base, local operation
   overlay and control state are canonical. Versioned search/materialized data is derived and
   rebuildable. Decrypted data is volatile only: the unlocked core and minimal purpose-built
   Projections may hold it until Lock or invalidation, with no forensic-erasure promise for host
   strings, swap, flash or backups.
5. **Replica plaintext is independently closed.** The specification enumerates only routing, binding,
   integrity, lifecycle and protocol-control fields plus opaque protocol bytes. `PRIVACY-007`
   does not automatically admit a local column. Decrypted Item content and content-derived data are
   encrypted or volatile; [Search and autofill index](20-search-and-autofill-index.md) owns any
   persisted encrypted search/autofill index.
6. **Bootstrap replaces only the remote base.** It captures one fixed Sync cursor, writes pages into an
   invisible generation, and promotes the complete generation and cursor in one guarded commit. The
   generation-independent local operation overlay survives byte-for-byte. Pre-promotion failure leaves
   the old base usable; post-promotion cleanup is idempotent and never decides which base is active.
7. **Snapshot reads plus guarded commit plans are the adapter seam.** A closed typed plan carries
   expected snapshot/head values and all mutations. It commits completely or returns
   `StaleSnapshot`; adapters do not expose raw SQL, object-store names or generic keys. This avoids an
   IndexedDB-sensitive async callback held open across unrelated awaits.
8. **Durability is a closed, honest class.** `native-crash-durable` and
   `browser-transactional` have distinct commit meanings while sharing atomicity and isolation.
   [Browser durability floor](16-browser-durability-floor.md) decides whether the measured browser
   class is an acceptable product floor; it cannot rename transaction completion into an on-disk
   guarantee.
9. **Lock, removal and wipe have separate meanings.** Lock drops live keys and Projections and keeps
   the encrypted Replica. There is no third local sign-out state: the Account is locked or removed.
   Removal and Device wipe first persist a deny-open intent in an installation catalog, then
   idempotently clean Replica and key stores after any interruption. Online Device revocation is
   claimed only after Server confirmation, and physical erasure is never claimed.
10. **Credential providers share the same truth.** A constrained provider runtime uses the same
    Account Replica and guarded-commit contract through a smaller capability API. There is no mirror
    or second Replica. [Credential-provider process key access](13-credential-provider-key-access.md)
    still owns the narrower key and concrete multi-process lock.
11. **Migration preserves unique work.** Supported versions migrate canonical state and the complete
    local overlay forward, using a shadow generation for large changes; derived state may rebuild.
    Unknown newer versions remain untouched. Corruption drops derived or inactive state, replaces a
    whole active remote base, and fails only the affected Account closed when unique local work is
    damaged. No canonical row is silently skipped.
12. **Support requires executable evidence.** Every real backend runs the shared release-blocking
    model, failpoint, forced-reopen, bootstrap, migration, corruption, removal and Durability-class
    suite. An in-memory fake cannot certify an adapter.

### Legacy evidence and rejected shapes

The frozen `AccountStore` and `ItemCache` were siblings over separate ports, so callers had to delete
both and preserve cross-store invariants themselves. Its staged bootstrap copied a baseline and merged
concurrent active rows at promotion. Those were useful evidence for atomic visibility, cold-versus-
empty semantics and page batching, but negative prior art for the greenfield boundary.

Rejected alternatives were one multi-Account or per-Server Replica, per-Vault or per-subsystem atomic
commits, a generic object heap or opaque key-value collections, durable plaintext projections, merging
local changes during promotion, pausing writes for bootstrap, provider mirrors, delete-and-resync
migrations, sequential best-effort removal, and row-skipping corruption recovery.

No new decision ticket surfaced. The existing
[Credential-provider process key access](13-credential-provider-key-access.md),
[Browser durability floor](16-browser-durability-floor.md),
[Operation state machine and crash safety](17-operation-state-machine-and-crash-safety.md),
[Sync protocol: cursor, bootstrap, and retention windows](18-sync-protocol-cursor-bootstrap-and-retention.md),
[Search and autofill index](20-search-and-autofill-index.md),
[Item revision history and retention](21-item-revision-history.md),
[Attachments: keys, chunking, and lifecycle](32-attachments-keys-and-lifecycle.md),
[Multi-Account, Collections, and cross-Server copy](36-multi-account-collections-and-cross-server.md),
[ClientRuntime interface](38-clientruntime-interface.md),
[Binding strategy across native and WASM](39-binding-strategy-native-and-wasm.md),
[Conformance fixture corpus](49-conformance-fixture-corpus.md), and
[Performance budgets](50-performance-budgets.md) inherit the schema, transaction, durability or
performance consequences they already own.
