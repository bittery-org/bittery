# Account Sync protocol

Status: **Candidate**.

This document fixes the Account stream, Cursor, Delta, Bootstrap, Trash and permanent-deletion
contract selected by `SYNC-002`, `SYNC-003`, `SYNC-006` through `SYNC-009`, and `ITEM-006`. HTTP route
names and OpenAPI packaging remain owned by the Server protocol specification; they may transport
these canonical bytes but may not reinterpret them.

## Account stream and Cursor

Each Account has one ordered Sync stream containing every canonical change that Account is authorized
to observe: Account and Device control, Team and Vault authorization, and Vault content. A Server
transaction that affects several Accounts appends one independent Sync Commit to each affected
Account stream in the same transaction. No order is claimed between Accounts. A client holds one
Cursor per `(Server, Account)` Replica, never one per Vault and never one for the whole Server.

`SyncCursorV1` is exactly 25 bytes:

```text
SyncCursorV1 = 0x01 | stream_generation[16] | position:u64be
```

The Server generates `stream_generation` randomly when it creates a stream history. Position zero is
the empty stream. Every later Sync Commit increments the position by exactly one; gaps, wraparound,
and reuse are invalid. The Server refuses a write before `u64::MAX` could wrap.

The Cursor is not signed. An authenticated secure transport already excludes a Network Attacker, and
a Malicious Operator could sign an old Cursor with its own Server key. Instead each Replica durably
pins its greatest accepted position and its accepted object floors. A response in the same generation
may retain or increase the position as allowed below, but may never reduce it. A different generation
is never installed by Delta. It requires a complete Bootstrap promotion. Event compaction does not
change the generation.

A Cursor is a Replica control value, not an Item revision, Bootstrap page token, wall-clock time, or
proof that another Device saw the same history. It detects rollback only relative to state already
accepted by that Replica. Cross-Device Server equivocation remains Acknowledged.

## Canonical Delta frames

Version 1 uses the integer and length rules in
[`cryptographic-format.md`](cryptographic-format.md). The exact outer frames are:

```text
SyncChangeV1 =
  change_kind:u8 |
  change_body_length:u32be | canonical_change_body[*]

SyncCommitV1 =
  cursor[25] |
  change_count:u16be |
  (change_length:u32be | SyncChangeV1[*])*

SyncDeltaPageV1 =
  page_version:u8 |
  request_cursor[25] |
  end_cursor[25] |
  commit_count:u16be |
  (commit_length:u32be | SyncCommitV1[*])* |
  has_more:u8
```

`page_version` is exactly `0x01`. `has_more` is exactly `0x00` or `0x01`. Every count must equal the
number of following values, every length must equal the enclosed bytes, and trailing bytes are
invalid. `change_kind` is a closed append-only registry: `0x00` and unknown values fail the whole
page. The owning Domain specification defines one exact body grammar for each admitted kind.

A Sync Commit is the complete Account-visible effect of one Server transaction. Its changes are
applied together and a page never splits it. A Commit may contain zero changes only when an ordinary
Domain operation has a canonical committed outcome but no other Account-visible Domain object; this
still gives the initiating Account a unique commit marker. Otherwise it contains one or more changes.
Each transaction may append at most one Sync Commit to a given Account stream.

The first Commit position is exactly one greater than `request_cursor`; later positions are
consecutive. Every Commit generation equals the request generation. `end_cursor` equals the last
Commit Cursor, or `request_cursor` when the page is empty. A page contains no more than 512 total
changes and its complete canonical frame is no more than 2 MiB. One Commit must fit both limits;
larger Domain work is expressed as explicitly resumable operations, never as an oversized exception.

The Server retains a compact change index rather than full event copies. Its admitted plaintext is
the target Account, Cursor, registered change kind, typed Server-visible object path, revision, epoch
or generation control needed by that kind, and operational time. When constructing a Delta page the
Server joins the exact referenced canonical ciphertext, signed statement, public control object, or
Deletion Fence into the change body. The page is self-contained and requires no per-change object
fetch. A referenced canonical object cannot be collected while a retained event still needs it.

The client validates the whole page before storage: framing, bounds, generation, consecutive
positions, typed paths, relationships, Envelope shapes, signatures, authenticated floors, and every
Domain body. One guarded Replica commit then applies all remote-base changes and advances to
`end_cursor`. Local Operations and overlays are not rewritten by that commit. A crash or lost local
acknowledgement therefore exposes either the complete old page state or the complete new page state;
repeating the same request is idempotent.

## Operation commit marker

The commit marker in a canonical committed `OperationOutcome` is exactly one `SyncCursorV1`, so its
existing `u32be` length is exactly 25. The command transaction appends a Sync Commit for the initiating
Account and stores that Cursor in the outcome atomically with the Domain effect, audit record, and
fan-out commits. A matching retry returns the same marker bytes.

Reconciling a matching outcome proves the operation committed even when its marker has aged out of
Delta retention. The client then performs the required Delta or Bootstrap path independently. Sync
event cleanup never removes the Account-lifetime outcome ledger.

## Delta retention and expiry

The Server publishes one Sync-event retention setting. Its default is 30 days, its minimum is 48
hours, and it may be set to indefinite. The setting is a privacy and operational control, not a client
correctness assumption. Retention cleanup removes only a complete position prefix and never a partial
Sync Commit, a referenced object still needed by a retained event, an active Bootstrap pin, an
Operation outcome, or a Deletion Fence.

A request at the retained floor or later returns an ordinary Delta page. A Cursor older than the
retained floor receives the registered `cursor_expired` result; a different generation receives the
registered `generation_changed` result. Neither result supplies an invented newer Cursor or mutates
the Replica. Both require Bootstrap. The old active base remains readable, and all local Operations
and overlays remain byte-for-byte intact while Bootstrap proceeds.

Changing retention never changes `stream_generation`. Shortening the setting may collect an eligible
prefix immediately after active Bootstrap pins are honored. Extending it cannot recreate a prefix
already collected.

## Resumable Bootstrap

Beginning Bootstrap creates a Server-held lease over one logical Account snapshot and captures its
fixed `SyncCursorV1` before returning the first page. The lease expires exactly 24 hours after
creation; page activity does not extend it. It pins every canonical object needed to reproduce its
snapshot and the Delta suffix after its Cursor until expiry. A lease is scoped to the authenticated
Account and enrolling Device credential; ordinary Session renewal does not invalidate it, and it may
not be transferred between Accounts, Servers, or Devices.

Bootstrap records follow a closed section registry. Sections sort by `section_kind:u8`, then by the
canonical bytes of each typed primary key. A Server implementation may materialize the snapshot or
query versioned state, but it must return the same logical records in the same order. The exact page
frame is:

```text
BootstrapRecordV1 =
  section_kind:u8 |
  primary_key_length:u32be | canonical_typed_primary_key[*] |
  body_length:u32be | canonical_record_body[*]

BootstrapPageV1 =
  page_version:u8 |
  snapshot_cursor[25] |
  record_count:u16be |
  (record_length:u32be | BootstrapRecordV1[*])* |
  complete:u8 |
  next_page_token[0 or 32]
```

`page_version` is `0x01`; `complete` is `0x00` or `0x01`. An incomplete page carries exactly 32
random opaque token bytes. A complete page carries none. Each page contains at most 512 records and
its complete canonical frame is at most 2 MiB. Unknown sections, noncanonical order, duplicate keys
with different bytes, inconsistent snapshot Cursors, malformed paths, invalid authenticated objects,
count or length mismatch, and trailing bytes make the staging generation unusable.

The Server binds each token to the lease and next ordered record. Repeating the same token before
expiry returns the byte-identical page and next token. Tokens are page continuations only; clients do
not interpret them or store them as Sync Cursors.

Each client page commit writes records and the next token atomically into a fresh invisible staging
generation. Interruption resumes from that token. An expired or invalid lease abandons only that
staging generation and begins a new lease; it never selects an incomplete generation. After a complete
page, the client verifies every required section, relationship and control object, marks the staging
generation complete, and promotes generation plus `snapshot_cursor` in one guarded commit. The
previous active base remains selected until that commit. Retired and incomplete generations are
cleaned only after they are unreachable.

Local Operations and overlays remain visible above either active base and are never copied, merged,
reconstructed, or deleted by Bootstrap. After promotion the client immediately requests Delta after
the snapshot Cursor. Bootstrap may run while locked to the extent already allowed by the closed core
interface; decryption, new signatures, re-sealing, derived-index rebuild and User judgment still wait
for Unlock.

## Trash, Tombstones and permanent deletion

Moving an Item to Trash creates the next immutable Account-signed Item revision as a Tombstone. The
Tombstone names the last live revision it supersedes but does not copy that revision's ciphertext.
The Server must retain the referenced live revision and all Attachment material required to restore it
for as long as the Tombstone remains current, regardless of ordinary revision-retention policy.

Restore creates the next signed live revision from that retained content. It never clears a mutable
flag or reuses an old revision number. Manual permanent deletion and automatic retention cleanup are
allowed only against the current Tombstone and use the same atomic transaction.

The Server publishes one Server-wide Trash-retention setting. Its default is 90 days, its minimum is
one day, and it may disable automatic deletion. Manual permanent deletion remains available. A shorter
setting applies to existing Tombstones and may make them eligible at the next cleanup run. Clients
display the current policy and warn when an entry is immediately eligible; no Team- or Vault-specific
override exists.

Permanent deletion atomically:

1. removes every content-bearing live and historical Item revision plus its Attachment keys and bytes;
2. writes the compact Deletion Fence;
3. appends the permanent-deletion Sync Commit to every affected Account stream; and
4. writes the admitted Operator Log and retention facts.

The Deletion Fence retains the exact canonical signed Tombstone revision bytes, including their
Envelope where the Item format encrypts them, plus the permanent status and permanent-deletion Sync
position. It retains no earlier live revision, Item content, name, Attachment, or user-authored time.
It lives until the Vault is deleted. Item identifiers are never reused; every
later create, update, restore, or move targeting that identifier receives the registered
`permanently_deleted` outcome carrying the exact Fence, so a client can authenticate and retain the
Tombstone floor even when the permanent-deletion event itself has expired.

A client applying permanent deletion removes the remote Item material but retains its authenticated
accepted-revision floor. An old local Operation and overlay are not silently deleted; the Server Fence
rejects them and the conflict/rejection specification owns their user resolution. A Bootstrap need not
mirror every Fence to the Replica: absence removes old remote-base content, while the Server remains
the authority that rejects stale Operations. A Delta permanent-deletion change carries the Fence
needed to advance the local authenticated floor.

Permanent deletion is a conforming Server lifecycle rule, not proof of physical erasure. A Malicious
Operator may have copied ciphertext, and backups may retain it under the separately documented backup
policy.

## SSE and polling without it

SSE is an optional wake-up channel. Its only data event is `sync_available` carrying the current
Account `SyncCursorV1`; it carries no change kind, object path, Item or Vault identifier. Receipt never
applies state or marks the Cursor processed. Duplicate, old, malformed, missing, disconnected, and
out-of-generation hints affect no correctness. A valid newer hint schedules ordinary HTTP Delta.

Without working SSE, a runtime schedules Delta immediately on start, resume, connectivity restoration,
manual refresh, and local Operation acceptance. After each successful background cycle it chooses the
next delay uniformly between 60 and 120 seconds. Concurrent triggers coalesce. Retryable failures use
full-jitter exponential backoff with a five-minute ceiling, while a fresh direct trigger may schedule
immediately.

These intervals apply only while the operating system permits the runtime to execute. Web pages,
Workers, extension backgrounds and mobile Providers make no promise while suspended or terminated;
they pull immediately on the next wake. Desktop polls while its runtime remains active. Realtime
delivery is never a correctness or revocation boundary.

## Server-visible information

This protocol adds no Vault-content plaintext. The Server necessarily observes the target Account,
Account stream generation and position, registered change kind, typed Vault/Item/Attachment/Device or
other admitted path, revision or generation control, ciphertext and its length, operational time,
retention state, Bootstrap lease/token state, and request chronology. Those fields are admitted by
`PRIVACY-007` and documented as operator-visible.

Item titles, URLs and domains, tags, Favorite state, categories, custom fields, Attachment names and
MIME types, Secure Note text, credentials, user-authored times, and every other content field remain
encrypted or absent. SSE reveals only connection chronology and a Cursor already known to the Server.

## Required invariants

- One Replica has one Account stream generation and greatest accepted Cursor.
- A same-generation Cursor never decreases; a different generation installs only by Bootstrap.
- One Server transaction maps to at most one atomic Sync Commit per affected Account.
- Operation effect, fan-out commits, audit record and canonical outcome commit together.
- A Delta page is fully validated and locally committed with its end Cursor or changes nothing.
- Bootstrap exposes either the old complete base or the new complete base, never staging or a mix.
- Event expiry changes performance, never operation exactly-once behavior or deletion safety.
- No old Device can recreate an Item identifier protected by a Deletion Fence.
- SSE loss, duplication and suspension change latency only.
