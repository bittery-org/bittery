# Search and autofill index

Status: **Candidate**.

This document fixes the derived local indexes selected by `ITEM-008`, `ITEM-009`, `PRIVACY-018`,
`OFFLINE-004`, and `ARCH-STORE-028` through `ARCH-STORE-031`. Neither index is canonical Replica
truth. A missing, stale, corrupt, or unsupported index is discarded rather than repaired.

## Two indexes and two unlock boundaries

Each Account Replica may hold two independent projections:

- The **Search Index** supports browse, manual search, Favorites, recent Items, and website-autofill
  candidate lookup after the Account Key Set is live. It contains one Account only.
- The **Suggestion Index** supports the locked mobile Credential Provider. It contains only Item
  title, username, website/application match material, and the User-chosen local Account label. It
  contains no credential secret, Vault or Server name, other Item field, Attachment, Team data,
  explicit Item count, or activity field.

An Account, Collection, or All Accounts query opens the independently authorized Search Indexes and
merges their results in volatile memory. No persisted index spans Accounts, Replicas, or Servers.
Every result carries its Server, Account, Vault, and Item provenance. A locked Account contributes no
ordinary search result. The mobile Provider may query the separately authorized Suggestion Indexes
of locally enabled Accounts before Bittery Account unlock.

Lock destroys Search Index keys and plaintext views in memory. Lock intentionally leaves a valid
Suggestion Index available behind its Device-only system protection. Account removal and Device wipe
remove both index records and their local key records.

## Searchable content and query semantics

The Search Index admits user-authored text unless the Item schema classifies the field as a secret.
The initial searchable set is title, username, URLs and their hosts, tags, non-secret category fields,
Secure Note body, Custom Field names and non-secret values, and Attachment names. Passwords, TOTP
seeds, passkey private material, recovery material, secret-classified Custom Field values, and
Attachment bytes are never indexed. The Item schema owns the closed secret classification; adding a
new field does not make it searchable by default.

Search normalization is part of the index derivation version. Text is valid Unicode normalized to
NFKC and compared with locale-independent full Unicode case folding. Original values remain unchanged
for display. Search has no stemming, locale-specific collation, phonetic expansion, typo correction,
or fuzzy match. Match quality orders exact value before prefix before substring. Field precedence is
title, username, URL/host, tags, visible category and Custom Field text, Secure Note body, then
Attachment name. Stable provenance bytes break otherwise equal scores, so every platform returns the
same order.

The active Account, Collection, or All Accounts scope filters candidates before ranking. Favorites,
recent Items, and category filters use encrypted indexed attributes and never become Replica-visible
plaintext.

## Website and application matching

HTTP and HTTPS Item URLs are parsed to canonical ASCII hosts with UTS #46 non-transitional ToASCII,
ASCII lowercasing, and one trailing root dot removed. Invalid hosts produce no match key. The build
contains one complete, versioned Public Suffix List including both ICANN and PRIVATE sections. Its
digest is part of the derivation version; changing the list invalidates affected indexes and fixtures.

Two DNS hosts are candidates when their registrable domains are equal. Ranking is exact host, parent
or child host, then sibling host. A public suffix itself matches no child. IP literals, `localhost`,
other single-label hosts, and platform application identifiers match only their exact canonical value.
Every URL on an Item participates and the best match wins. Matching outside these rules requires a
one-time or persisted User confirmation, stored as another encrypted exact website/application match.

This is a candidate-selection rule, not permission to fill. Scheme downgrade, port and path policy,
frame trust, field detection, User gesture, and automatic-versus-manual fill remain host-surface
policy. A surface may narrow these candidates but may not broaden them silently.

## Search Snapshot confidentiality

The persisted Search Index is one opaque snapshot per Account. A fresh random 32-byte Search Index
Key is generated for every snapshot and sealed to that Account's X25519 public key in context `0x13`.
Context `0x30` AES-256-GCM-SIV envelopes encrypt the manifest and data chunks. The byte grammar is in
[`cryptographic-format.md`](cryptographic-format.md).

A Device Thief copying locked local files may learn that an index exists, its record and derivation
versions, source commit, snapshot identifier, chunk framing, and total ciphertext length. These fields
do not add a term, domain, field-length, Item-count, posting-frequency, or per-entry change registry.
The attacker already sees the separately admitted Replica framing, typed rows, commit sequence, and
ciphertext lengths. Index plaintext and the Search Index Key are unavailable until Account unlock.

The snapshot is an asynchronous checkpoint. A successful canonical Item mutation updates the live
Search Index projection immediately and marks the persisted derived set incomplete in the same guarded
Replica commit. Snapshot construction runs outside the transaction. A later guarded commit installs
the complete new snapshot only if its source commit still matches. Process death may lose this derived
work, never the canonical mutation.

An unrelated Replica commit may advance a complete derived set's source-commit marker without
rewriting its ciphertext. A search-relevant commit makes the set incomplete. On open, a missing,
incomplete, corrupt, unknown-version, or source-mismatched snapshot is discarded in full.

## Suggestion Snapshot protection

Each mobile Account has a fresh random 32-byte Suggestion Index Key protected by a Device-only system
record that is available only while that physical Device is OS-unlocked and requires no additional
Bittery prompt. Apple uses a non-synchronizable `WhenUnlockedThisDeviceOnly` Keychain record. Android
uses a non-exportable Keystore wrapping key with unlocked-Device required and no per-use User
authentication. Hardware backing is used and reported when available but is not required or claimed.
The random key enters only the constrained Provider core and encrypts context `0x31` snapshot chunks.

The Provider decrypts and matches the complete bounded projection inside that core. Swift, Kotlin,
the operating-system suggestion UI, and ordinary client bindings receive only matching permitted
preview records, never an index key, arbitrary query result, or non-matching entry. A Device Thief with
locked copied files learns only outer framing and ciphertext size. An attacker reading the OS-unlocked
Device store or controlling the Provider process may learn the permitted preview under `PRIVACY-017`.

Every commit that can change title, username, website/application match, local Account label, Item
visibility, Vault access, or Travel eligibility atomically marks the Suggestion Index incomplete or
installs a complete replacement. Locked ciphertext Sync may invalidate but cannot rebuild it. An
incomplete or source-mismatched index returns `preparing`, never stale suggestions or `no matches`.
The next Account unlock rebuilds it from canonical allowed Items.

## Progressive rebuild and Travel mode

A valid Search Snapshot is the warm path. Without one, successful Account unlock does not wait for a
whole-Vault rebuild. Browse results appear progressively, website/application matching is built first,
and manual search and autofill expose a typed `preparing` or `incomplete` state until their relevant
index is complete. No incomplete query may report `no matches`. The performance-budget decision owns
reference Vault sizes, device classes, percentiles, and numeric warm and cold budgets.

Receipt of a Travel-mode policy atomically invalidates volatile views, deletes the old derived-set
records and wrapped local index keys, and makes disallowed canonical ciphertext inaccessible under the
Travel-mode contract. The allowed remainder receives fresh Search and Suggestion keys and is rebuilt
from allowed Vaults only. No old key is reused. Bittery does not claim forensic erasure from flash,
swap, host strings, filesystem history, or backups, and it makes no promise for a Device that has not
received the policy.

## Conformance

Shared fixtures cover Unicode normalization and case folding; exact, prefix, and substring ranking;
every field class; multiple Item URLs; the complete Public Suffix List boundary including PRIVATE
suffixes; IDNA, IP, localhost, and application identifiers; Account and Collection scoping; snapshot
relocation, reordered/omitted/duplicated chunks, stale source commits, interrupted checkpoints,
progressive completeness, locked Sync invalidation, Account removal, and Travel rekeying. Rust and
WASM run identical semantic and cryptographic vectors; later Swift and Kotlin bindings adopt them.
