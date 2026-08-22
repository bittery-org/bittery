# Encrypted local-first database layer

Produced 2026-08-22. Status: evidence and recommendations for exploration, not a specification or
accepted decision. Sources are primary specifications, first-party documentation, and upstream source
repositories. No legacy behavior is treated as authority.

GitHub sources are pinned to the upstream commit inspected on the research date. The frozen legacy
tree was searched explicitly for SQLite, `AccountStore`, `ItemCache`, outbound operations, and Sync
prior art. It supplies no claim in this report: the relevant negative prior art is already captured
in the current greenfield Replica and operation decisions linked below.

## Bottom line

The promising idea is real, but it should **not** be framed as “SQLCipher plus multiplayer SQLite.”
Page-encrypted SQLite solves local file confidentiality. It does not define end-to-end encrypted Sync,
offline conflict semantics, multi-user key distribution, revocation, rollback detection, or safe
compaction by a Server that cannot read the data.

The promising reusable project is instead an **opaque local-first replica protocol and engine**:

```text
typed application command or optional CRDT change
                         |
             sign + record-level encrypt
                         v
       durable local operation / optimistic overlay
                         |
               opaque untrusted relay
                         |
       verify + decrypt + reconcile on each client
                         v
          SQLite or IndexedDB local projection
```

SQLite is one local transactional adapter. IndexedDB can be another. Record or object envelopes are
the portable security boundary. The Server stores authenticated opaque operations, outcomes,
checkpoints, and limited routing metadata; it never receives a database key or plaintext database.

**Exploration recommendation: go** on a small RFC and adversarial prototype of that engine. **No-go**
on a transparent “encrypted replicated SQLite database” product, a whole-database-file Sync format,
or a generic CRDT policy applied to all Bittery tables. The reusable core should make no claim that
arbitrary SQL transactions automatically become secure, convergent distributed transactions.

## Four different problems that the phrase “encrypted database” hides

| Problem | Suitable mechanism | What it does not provide |
| --- | --- | --- |
| Confidentiality of a copied local file | SQLCipher, SQLite SEE, or application-encrypted records | E2EE Sync, key sharing, conflict rules, rollback detection |
| Atomic durable local state | SQLite or IndexedDB transactions behind a guarded-commit interface | Multi-device convergence or Server distrust |
| Confidentiality from the Sync Server | Client-side record/object envelopes and client-held keys | Correct authorization, ordering, omission detection |
| Offline multi-writer behavior | Domain operations, version/causal checks, and selected CRDTs | Cryptographic access control or malicious-writer safety |

Treating these as separable layers is the main architectural result of this research.

## What the SQLite family can and cannot supply

### SQLCipher and SEE are local-at-rest tools

[SQLCipher](https://www.zetetic.net/sqlcipher/design/) transparently encrypts and authenticates
individual SQLite pages. It also encrypts page data in rollback journals and WAL files, provided
file-backed temporary storage is disabled; other transient files are not encrypted. It accepts raw
key material, so an application can manage its own key hierarchy. It is a specialized SQLite build,
not an ordinary loadable extension, because it hooks SQLite pager internals.

[SQLite SEE](https://sqlite.org/see/doc/release/www/readme.wiki) likewise encrypts database pages and
WAL/rollback journals, while plaintext exists in process memory. Its documentation says `TEMP` tables
are not encrypted, some header bytes remain visible, and rekeying reads and rewrites every database
page. SEE is proprietary. SQLite's own [WASM guidance](https://www.sqlite.org/wasm/doc/tip/see.md)
says its license prevents distributing a public client-side SEE WASM build and no prebuilt package is
provided.

Consequences:

- Page encryption is useful defense for a copied native database, but only while its database key is
  separately protected and absent from the unlocked process.
- A whole-database rekey is the wrong primitive for routine Vault membership rotation. Per-record
  key epochs can protect new writes without rewriting unrelated pages or pretending to erase data a
  former member already copied.
- The encrypted database file is a physical implementation detail, not a portable Sync protocol.
  Independent offline SQLite files can change unrelated B-tree pages and WAL state; page ciphertext
  has no application merge meaning.
- Browser support still needs a distinct honest storage/key story. Shipping one SQLite-shaped API
  does not make native and browser key protection equivalent.

### SQLite Session is a changeset mechanism, not a convergence policy

The upstream [SQLite Session extension](https://www.sqlite.org/sessionintro.html) records row inserts,
updates, and deletes and can later apply, invert, or inspect a changeset. It assumes the same schema
and compatible starting data. It requires declared primary keys, ignores rows with `NULL` in a
primary-key column, and does not capture virtual-table changes. Applying a changeset may call an
application conflict handler to omit, abort, or replace a conflicting change.

This is useful as a local change-capture building block, but the emitted changeset contains row
values. Encrypting the complete changeset makes it opaque to the Server, which can then relay but not
merge, validate, filter, or compact it. Leaving the structure or values visible violates a strong
Server-blind boundary. Session also has no answer for membership, key epochs, malicious authors,
exactly-once commands, or cross-table domain invariants.

### SQLite CRDT extensions demonstrate the attraction and the mismatch

[CR-SQLite](https://github.com/vlcn-io/cr-sqlite/tree/43ab94cac537d080aac7cb7628a435c02ee9e268)
upgrades tables into replicated relations and
exposes row/column changes through `crsql_changes`. Its current documented approach is history-free
and automatically resolves conflicts using set and last-write-wins-style column semantics; it says
manual merge is unavailable, richer counters/text were still being implemented, and its causal event
log is future `v2` work. The repository also advises using a release because `main` may not be stable.

[SQLite-Sync](https://github.com/sqliteai/sqlite-sync/tree/0e4be011d7fdf2f760d5055f684799c6af921886)
is a newer CRDT extension with native and WASM
packages. It demonstrates broad interest in offline replicated SQLite, but its design advertises
Server-enforced row-level security, server-recognized schema hashes, relational server backends, and
automatic LWW/set merges. Those are useful in a Server-readable system, not evidence of a
Server-blind encrypted design. Its Elastic License 2.0 also requires a commercial license for the
production/managed-service uses named by the project.

Neither extension establishes that an automatic row/column merge preserves Bittery invariants. For
example, “revoke member, advance key epoch, install the complete grant set” is one security command,
not three independently mergeable LWW cells. The database can converge while the product state is
invalid.

## What CRDT libraries can contribute

[Automerge](https://automerge.org/docs/reference/concepts/) combines a JSON-like CRDT, full change
history, a compressed storage format, and a transport-agnostic per-document Sync protocol. Storage
and network adapters are pluggable. Its [binary format](https://automerge.org/automerge-binary-format-spec/)
contains actor, Lamport, predecessor, successor, value, and operation information needed to merge a
document.

[Yjs updates](https://docs.yjs.dev/api/document-updates) are binary, commutative, associative, and
idempotent. State vectors let peers calculate missing differences. This is excellent for collaborative
text or structured documents, including offline work. It is not a complete security model. Yjs's
own [threat model](https://github.com/yjs/yjs/blob/567af9b41fe5e1290e0cfe7fcc025a9f98c514a0/THREAT_MODEL.md)
says its collaboration model
assumes trusted writers, that a malicious accepted update becomes permanent history, and that
Server-side filtering of binary updates is not a reliable security boundary.

This yields three possible encryption boundaries:

1. **Encrypt the whole CRDT update.** The Server learns only admitted routing/framing and cannot merge
   or calculate state-vector differences. Clients can still merge after downloading opaque updates,
   but Server-side semantic compaction must be replaced by authenticated client checkpoints.
2. **Encrypt only CRDT values.** The Server can run the CRDT protocol but learns document structure,
   actor identifiers, operation shape, ordering, update frequency, and equality/length information.
   It still cannot validate invariants hidden inside values.
3. **Run peer-to-peer Sync through an opaque relay.** Online peers can exchange encrypted Sync messages,
   but an intermittently connected Server cannot independently produce missing semantic deltas or a
   trusted compact snapshot.

For Bittery, option 1 is defensible for a deliberately bounded collaborative-document payload. It is
not a good universal database representation. Most password-manager mutations need explicit domain
conflicts, authorization, and audit meaning rather than silent convergence. A CRDT codec should
therefore be optional and scoped per object type, behind the same signed encrypted operation frame.

## Evidence from end-to-end encrypted systems and standards

### Envelope hierarchies scale better than one database key

The [Standard Notes protocol](https://github.com/standardnotes/app/blob/b615ddd31751d1981de60ddb6ff136e9249ec0d1/packages/snjs/specification.md)
uses a random key per item, encrypts that item key under an items key, and wraps items keys under a
password-derived root key. Password changes therefore rewrap a small number of keys instead of all
content, and new items-key versions can be introduced progressively. The same specification also
documents a downgrade hazard when a client trusts the protocol version reported by the Server. This
is strong evidence for immutable format/suite identifiers and client-pinned minimums, not negotiated
cryptographic primitives chosen by an untrusted Server.

Bittery's existing candidate envelopes already follow the useful part of this shape: object keys or
Vault epochs protect records, and account/device wrappers protect the keys. Page encryption can be an
additional local layer, not the source of the portable security property.

### Multi-device messaging protocols solve a neighboring problem

Signal's [Sesame specification](https://signal.org/docs/specifications/sesame/) manages asynchronous
encrypted sessions across multiple devices in the presence of lost, reordered, duplicated, or
server-forged messages. It explicitly considers device-state loss and rollback. It is a mailbox and
session-selection protocol, not a replicated database or group authorization state machine, so it is
prior art for device identity and delivery—not a drop-in Sync layer.

[MLS, RFC 9420](https://www.rfc-editor.org/rfc/rfc9420.html) provides asynchronous group key
establishment, epochs, forward secrecy, and post-compromise security. It also requires an application
to define delivery and application-message semantics. MLS may be worth later comparison for large,
high-churn collaborative groups, but adopting it would not remove the need for object revisions,
offline conflict policy, checkpoints, or database transactions. For Bittery's current Vault model,
flat recipient grants plus explicit key epochs remain a much smaller conceptual fit.

### Server blindness does not imply Server integrity

Authenticated encryption detects modification of a record. Device signatures identify an author.
Neither detects that the Server omitted a newer record, replayed an internally valid old snapshot, or
showed two Devices different histories.

[Certificate Transparency v2, RFC 9162](https://www.rfc-editor.org/rfc/rfc9162.html) demonstrates the
relevant primitives: signed tree heads, Merkle inclusion proofs, and consistency proofs for an
append-only log. The RFC also makes the operational point that inconsistent signed structures become
evidence of misbehavior. Applied here, a client can pin a high-water checkpoint and reject an older
Server state. Detecting equivocation between isolated Devices additionally requires comparison—client
gossip, a witness, or another trusted channel. A Server-controlled transparency log with no checkpoint
comparison can present a consistent fork to each Device.

There is also a fundamental availability limit: an isolated client cannot distinguish “the Server is
currently withholding an unseen valid update” from “no update exists.” A protocol can detect rollback
below locally accepted state and later prove forks; it cannot force a malicious Server to reveal new
ciphertext.

## Leakage, search, deduplication, and compaction

### Search

Server-side searchable encryption is not “no leakage.” The USENIX Security paper
[Hiding the Access Pattern Is Not Enough](https://www.usenix.org/conference/usenixsecurity21/presentation/oya)
shows how repeated-query (search-pattern) leakage, access leakage, and background knowledge can recover
query keywords even when defenses obscure access patterns. For a password manager, local search over
an encrypted derived snapshot is the simpler strong boundary. The Server then learns checkpoint and
ciphertext sizes, not terms, result sets, or query repetition.

### Deduplication

Randomized encryption intentionally makes equal plaintexts produce unrelated ciphertexts.
[Message-Locked Encryption](https://www.iacr.org/archive/eurocrypt2013/78810294/78810294.pdf) exists
because cross-user encrypted deduplication otherwise conflicts with semantic security; deterministic
message-derived keys expose equality and permit confirmation attacks for guessable content.

The safe default is therefore no cross-Account or cross-Vault content deduplication. Within one
authenticated object, idempotent operation IDs and chunk IDs may suppress retransmission of the exact
same ciphertext. That is protocol deduplication, not plaintext equality deduplication.

### Compaction and garbage collection

An untrusted blind Server cannot synthesize a trustworthy compacted database state. A currently
authorized client must create an encrypted, signed checkpoint that commits to its included operation
frontier and schema/codec version. Other clients verify the author, membership/key epoch, hashes, and
frontier before adopting it.

Deletion is harder than insertion. The system may remove old operations only after a retention rule
proves that every supported bootstrap path has an accepted checkpoint containing their effects and
the necessary tombstones. “Offline forever,” finite Server storage, and deleting all history cannot
all be guaranteed simultaneously. A bounded Server can require a long-offline Device to bootstrap
from a newer authenticated checkpoint.

## The most promising architecture

### Reusable core: an opaque replica engine

The reusable project could own these deep mechanisms:

- a logical `ReplicaStore` with consistent snapshots, guarded atomic commits, monotonic local commit
  sequence, crash recovery, and SQLite/IndexedDB adapters;
- canonical operation and outcome frames, device signatures, AEAD envelopes bound to their visible
  routing context, immutable operation IDs, and duplicate-request fingerprints;
- a durable outbox state machine that records send intent before network I/O and reconciles only an
  authenticated matching outcome;
- an opaque relay protocol for append, fetch-after-cursor, resumable bootstrap, authenticated client
  checkpoints, tombstones, and explicit retention failure;
- local accepted-state floors and typed rollback/fork evidence;
- encrypted derived-checkpoint storage for search or other rebuildable indexes; and
- a conformance simulator that duplicates, reorders, drops, delays, replays, rolls back, and forks
  Server responses.

The core should own causality and transport idempotency, not universal merge meaning. It should call a
small application codec/policy interface to validate a decrypted operation, calculate its optimistic
effect, reconcile it against current state, and optionally merge a registered CRDT payload.

### Bittery remains responsible for policy

These parts should not be generalized out of Bittery:

- Account, Team, Vault, Item, Attachment, Share, and Device schemas;
- the closed Server-visible plaintext registry;
- command kinds, expected-base rules, conflict copies, authorization, and audit meanings;
- Vault grants, departure, epoch rotation triggers, and recovery ceremonies;
- which fields are searchable or secret and all autofill matching rules;
- the exact locked/unlocked projections and credential-provider capability boundary; and
- product retention, removal, Travel mode, and user-facing failure language.

A module that accepts arbitrary SQL writes cannot enforce those policies. A module that embeds them is
not actually reusable. The stable seam is the encrypted operation/replica machinery between the two.

## Comparison with the current greenfield artifacts

The idea does not require throwing away the current direction. It identifies a possible extraction
boundary inside it:

- [ADR 0022](../../../docs/adr/0022-account-replicas-use-guarded-atomic-commits.md) and the candidate
  [Replica contract](../../../docs/greenfield/target/replica.md) already define the local adapter
  semantics that can become generic: one replica scope, snapshot reads, guarded commits, a replaceable
  remote base, and a durable local overlay.
- [ADR 0025](../../../docs/adr/0025-account-lifetime-operation-outcomes-provide-exactly-once-commands.md)
  and [operations.md](../../../docs/greenfield/target/operations.md) already contain an unusually
  strong reusable durable-operation kernel: immutable operation identity, recorded send intent,
  indefinite byte-identical retries, and an outcome ledger independent of HTTP representation.
- [ADR 0026](../../../docs/adr/0026-search-indexes-are-opaque-account-local-checkpoints.md) and the
  [Search Index](../../../docs/greenfield/target/search-index.md) match the research recommendation to
  keep search local and persist only opaque derived checkpoints.
- The [cryptographic format](../../../docs/greenfield/target/cryptographic-format.md) contains
  Bittery-specific context numbers and binding tuples. The reusable lesson is a closed versioned
  envelope registry with authenticated context; the actual registry stays with Bittery.

The main missing reusable protocol work is authenticated opaque bootstrap/checkpointing, explicit
retention semantics, and rollback/fork evidence. The current
[rollback ticket](../issues/24-backup-restore-and-rollback-detection.md) already distinguishes
per-Device high-water detection from cross-Device equivocation, which is the correct distinction.

## Candidate RFC set

This is a research recommendation for how to explore the separate project, not a proposal to accept
these choices.

### RFC 0 — threat model and leakage contract

Define a curious/malicious Sync Server, malicious network, copied locked local storage, compromised
authorized Device, and malicious authorized collaborator separately. List every visible outer field
and explicitly exclude traffic-analysis resistance for an initial version. State that availability,
unseen-update detection while isolated, and revocation of already copied plaintext are impossible.

### RFC 1 — data and cryptographic model

Define only generic nouns: `Namespace`, `Replica`, `Actor`, `KeyEpoch`, `Operation`, `Outcome`,
`Checkpoint`, `Cursor`, and `AcceptedFloor`. Specify canonical bytes, versioning, signatures, AEAD
binding, size limits, and suite-upgrade rules. Do not define SQL tables or application field names.

### RFC 2 — local transaction contract

Specify atomic acceptance of an immutable operation, overlay, outbox state, and derived invalidation;
guarded reconciliation; crash states; durability classes; and adapter conformance. SQLite and
IndexedDB are independent implementations of this contract.

### RFC 3 — opaque relay protocol

Specify byte-identical append with immutable outcomes, cursor reads, paged bootstrap, device-signed
checkpoints, tombstone/frontier retention, duplicate/reorder tolerance, and rollback/fork evidence.
Make explicit which Server checks use visible authenticated metadata and which checks can happen only
after client decryption.

### RFC 4 — application semantics interface

Define the callback boundary for authorization evidence, expected-base validation, optimistic effects,
conflict results, and checkpoint validation. Register optional CRDT codecs per payload type. Do not
promise convergence for an unregistered arbitrary payload or arbitrary SQL transaction.

## Smallest useful prototype

Build a disposable Rust prototype before naming or publishing a database project:

1. One opaque namespace, two enrolled Devices, one local SQLite adapter, and an in-process hostile
   relay simulator.
2. Random operation IDs, per-Device monotonically increasing author sequence, canonical signed
   operation frames, random-nonce AEAD payloads, and an atomic local overlay/outbox commit.
3. Relay append/fetch/bootstrap with duplicate outcomes, arbitrary delivery order, loss, replay, and
   cursor rollback.
4. A client-produced signed encrypted checkpoint with an included frontier, followed by bootstrap of
   a fresh third Device and rejection of stale/tampered checkpoints.
5. One simple explicit application conflict (`expected revision`) and one optional small CRDT document
   payload to prove that both fit without making CRDT the universal policy.
6. Model/property tests proving convergence for the CRDT payload, explicit conflict for the revisioned
   object, exactly-once logical execution, no plaintext in relay state, and rollback detection below a
   locally accepted floor.

Defer multi-user membership, revocation, attachments, search, browser storage, production networking,
MLS, Server-side transparency witnesses, and history pruning until this prototype establishes the
core state model. The next experiment should add two Users and a key-epoch cutover; it should
specifically test an offline Device writing under the superseded epoch.

## Go/no-go gates after the prototype

Proceed toward a separate project only if:

- the application-policy seam remains small without leaking Bittery domain types into the core;
- hostile-relay tests can express every durable transition without relying on process memory;
- a fresh Device can verify and install a compact checkpoint without trusting Server-selected
  plaintext state;
- SQLite and a second simple adapter can pass identical semantic fixtures; and
- the public claim can stay narrow: “encrypted offline replica and opaque Sync substrate,” not
  “distributed SQL transactions.”

Stop extraction and keep the code inside Bittery if most operation frames, checkpoint validation, or
conflict behavior require Vault/Item/membership policy. That would mean the apparent generic layer is
only Bittery's engine with its nouns erased, which adds a compatibility surface without creating a
deep reusable module.
