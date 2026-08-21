# Search and autofill index

Type: grilling
Status: resolved
Blocked by: 04, 13, 15

## Question

`ITEM-003` encrypts titles, URLs, tags and Favorite; `OFFLINE-001` requires browse, search and autofill offline. Domain-matched autofill must therefore evaluate every Item's URL set on every page load against a store that cannot index ciphertext. The only acknowledgement is one word inside `TRAVEL-001`, which presumes an index no requirement creates. See [corpus review, Significant #2](../research/corpus-review.md).

Decide:

- Memory-only index rebuilt at unlock, or persisted and encrypted.
- If persisted: what an attacker with the file learns, and which requirement bounds it. Term frequencies, Item counts, and domain sets all leak by default.
- Domain matching rules for autofill, including subdomain and public-suffix handling.
- Index scope under `ACCOUNT-003`, and how it is evicted for Travel mode.
- The unlock-to-list cost on a large Vault, which is the practical ceiling on the memory-only option.
- Whether search covers Secure Note bodies and custom fields.

Produces: an index specification, a `PRIVACY-*` bound, and an input to performance budgets.

### Inherited from ticket 08, key hierarchy and canonical envelope format

`CRYPTO-011` reserves no search derivation label. Prefer a random index key when persisted index data
needs its own key. Add an exact literal to the closed registry only if this ticket proves that deriving
the key from existing secret material is the simpler accepted construction.

Whatever the index persists is subject to `CRYPTO-009`, so an index entry must bind its own identity
or it can be relocated.

### Inherited from Credential-provider process key access

The locked mobile Suggestion Index is a separately protected derived projection, not a Replica truth.
Its complete permitted preview is Item title, username, website/application match, and User-chosen
local Account label. It contains no credential secret, Vault or Server name, other Item field, TOTP
seed, passkey private material, Attachment, Team data, count, or activity. This ticket must specify
the encryption, match-key leakage, invalidation, and rebuild that enforce that closed set without
changing it.

## Answer

Resolved with the maintainer on 2026-08-21. Promoted to `PRIVACY-018`, `ITEM-008`, `ITEM-009`,
`OFFLINE-004`, `TRAVEL-002`, and `ARCH-STORE-028` through `ARCH-STORE-031` in
[`docs/greenfield/target/`](../../../docs/greenfield/target/), the normative
[`search-index.md`](../../../docs/greenfield/target/search-index.md), local contexts `0x13`, `0x30`,
and `0x31` in
[`cryptographic-format.md`](../../../docs/greenfield/target/cryptographic-format.md), the Replica
schema, the root glossary, and accepted
[ADR 0026](../../../docs/adr/0026-search-indexes-are-opaque-account-local-checkpoints.md).

### Two purpose-built indexes

The ordinary **Search Index** is one encrypted, derived snapshot per Account Replica. It becomes
usable only after Account unlock and supports browse, manual search, Favorites/recent Items, and
website-autofill candidate lookup. Account, Collection, and All Accounts scopes merge independently
unlocked results only in volatile memory, preserving Server, Account, Vault, and Item provenance. No
persisted index spans Accounts or Servers.

The mobile **Suggestion Index** stays separate. It is one bounded projection per Account behind a
Device-only OS-unlocked key record and remains usable without a Bittery Account-unlock prompt. Apple
uses non-synchronizable `WhenUnlockedThisDeviceOnly` Keychain protection; Android uses a
non-exportable Keystore wrapping key requiring an unlocked Device but no per-use authorization. Only
the constrained Rust Provider core sees the complete projection. Public bindings and the OS receive
matching title, username, website/application match, and local Account label only.

### Opaque persisted form and honest leakage

Every Search Snapshot gets a fresh random 32-byte Search Index Key. RFC 9180 HPKE context `0x13`
seals that key to the Account, and AES-256-GCM-SIV contexts `0x30` and `0x31` protect authenticated
manifest and data chunks. Chunking respects the existing 32 MiB envelope ceiling. Binding tuples
include Server, Account, Device, random snapshot identifier, derivation version, source commit, chunk
index, and total count; the encrypted manifest commits lengths and SHA-256 digests.

A Device Thief with locked copied files sees only record/derivation version, source commit, random
snapshot identifier, chunk framing, and aggregate ciphertext length, on top of already admitted
Replica framing. No plaintext term, domain, field length, posting frequency, Item-count field, or
per-entry mutation log exists. A padded snapshot was rejected as disproportionate, while separately
encrypted posting records were rejected because they expose cardinality and change structure.

Suggestion chunks use a separate random key and context `0x31`; the platform record, not Account
material, protects that key. `PRIVACY-017` remains the honest weaker bound once the OS-unlocked store
or Provider process is controlled.

### Matching and search behavior

Website candidates share a registrable domain under one complete versioned Public Suffix List with
ICANN and PRIVATE sections. Exact hosts rank first, then parent/child, then sibling hosts. IPs,
`localhost`, other single-label hosts, and application identifiers are exact-only. Every Item URL
participates; a broader website/application association requires one-time or persisted User consent.
Surface policy may narrow these candidates for scheme, port, path, frame, field, or gesture safety but
cannot silently broaden them.

Manual search includes user-authored non-secret text: titles, usernames, URLs, tags, visible category
fields, Secure Note bodies, Custom Field names and non-secret values, and Attachment names. Passwords,
TOTP seeds, passkey private material, recovery material, secret Custom Field values, and Attachment
bytes are excluded. NFKC plus locale-independent full case folding feeds deterministic exact, prefix,
then substring ranking. There is no stemming, fuzzy matching, or locale-specific expansion.

### Checkpoints, rebuild, and eviction

The Search Snapshot is an asynchronous checkpoint, not part of canonical mutation durability. A
successful Item commit updates the live projection immediately and atomically marks the old derived
set incomplete. Construction happens outside the transaction; a guarded commit installs a complete
replacement only if its source still matches. Missing, stale, corrupt, unknown, or incomplete state
is discarded whole.

Cold rebuild does not block successful Account unlock until the complete Vault is indexed. Browse
appears progressively, domain matching has priority, and search/autofill reports `preparing` or
`incomplete`; it never returns a false `no matches`. Ticket 50 owns representative Vault sizes,
devices, percentiles, and numeric warm/cold budgets.

Any commit that can affect the locked preview atomically replaces or invalidates the Suggestion
Index. Locked Sync may invalidate but cannot rebuild it, so stale suggestions fail closed until the
next Account unlock. Travel policy receipt removes volatile views, old snapshot records, and wrapped
keys; allowed Vaults rebuild under fresh keys. Account removal and Device wipe remove both index
families. No forensic erasure or offline-policy receipt is claimed.

### Legacy evidence and downstream handoff

The frozen Extension provided useful negative prior art: it ranked exact, parent/child, and sibling
hosts but reimplemented only a hand-maintained subset of multi-label public suffixes across
TypeScript and Kotlin. Greenfield keeps the useful match ordering and rejects the partial suffix list
and duplicated matcher in favor of one engine-owned complete versioned dataset and fixtures. No
legacy code or data format is reused.

Existing tickets for the Item model, Travel mode, multi-Account behavior, Extension and Mobile
architecture, conformance fixtures, and performance budgets now carry the constraints they inherit.
No new decision ticket surfaced.
