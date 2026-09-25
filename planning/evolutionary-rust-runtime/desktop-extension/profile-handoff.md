# Existing-profile admission into Core

This records the technical verdict for [research 82](../issues/82-existing-profile-runtime-handoff.md).
Shared Core and Desktop delivery is tracked by [91](../issues/91-existing-profile-runtime-admission.md);
the Extension source adapter is [106](../issues/106-extension-profile-admission.md).
It specifies a compatibility reader and guarded admission owned by shared Core. It is not an
implemented upgrade path. The cross-Account pending-work variant follows the accepted explicit reauthorization decision in
[83](../issues/83-runtime-cross-account-item-move.md) and the
[workflow specification](cross-account-move.md). Production startup must demonstrate
exclusive ownership before admission is enabled.

## Delivery allocation

The 2026-09-22 coordinating review separates host delivery without changing this shared contract.
91 completes the shared admission engine and Desktop source families, including every required
accepted-work shape, before Desktop activation66. Actual packaged Desktop upgrade remains73.
After73,106 supplies Chrome local/session/IndexedDB source primitives and focused admission
acceptance to the same Core owner; composition74 depends on106. Actual Chrome upgrade, browser
restart, broker reattachment and Worker/document loss remain77. Every Extension requirement in
this document remains required under106/77. Keeping those post73 requirements in91 would create
the cycle91 →66 →72 →73 →Extension admission →91. No capability or production acceptance is
waived by this allocation, and91 remains open until its complete shared/Desktop scope passes.

## Actual source families

| Production source | Persisted contents | Evidence |
| --- | --- | --- |
| Desktop `store.json` | AccountStore DevicePlain values and `record:` ItemCache records. Values are serialized strings; record mutation uses native batch commands. | [Tauri adapter](../../../packages/storage/src/adapters/tauri.ts), [record store](../../../apps/desktop/src-tauri/src/record_store.rs) |
| Desktop `sync-store.json` | `bittery_sync_client_id`, `bittery_pending_mutation_queues_v3`, and per-source Sync checkpoints. This is a separate file from AccountStore. | [Sync identity/store](../../../apps/desktop/src/lib/sync-client-id.ts), [persistent queue adapter](../../../apps/desktop/src/hooks/use-desktop-sync.ts) |
| Desktop OS credential storage | Service `com.bittery.desktop`, entry `bittery_vault`: a JSON map containing the legacy resolved secret references. Desktop Session-bound credentials survive process restart. | [Keychain primitive](../../../apps/desktop/src-tauri/src/keychain.rs), [storage tiers](../../../packages/storage/src/tiers.ts) |
| Extension `chrome.storage.local` | Device-bound AccountStore values, Device key and wrapped-MUK/Secret Key material, queue document and client identity. | [Chrome adapter](../../../packages/storage/src/adapters/chrome.ts), [Sync storage](../../../apps/extension/src/lib/sync-storage.ts) |
| Extension `chrome.storage.session` | Session-bound token, wrapped Vault keys and encrypted private key. Survives service-worker recreation; browser restart may remove it. | [Extension composition](../../../apps/extension/src/lib/storage.ts), [Chrome adapter](../../../packages/storage/src/adapters/chrome.ts) |
| Extension IndexedDB `bittery_records` version 1 | Store `records`, keyPath `key`, index `by_collection`; each row retains opaque `collection`, `id` and serialized `value`. | [IndexedDB record adapter](../../../packages/storage/src/adapters/indexeddb-records.ts) |

The new [native adapter](../../../apps/desktop/src-tauri/src/runtime_host/storage.rs) uses the same
OS keychain primitive but different Core references and new `platform.sqlite` DevicePlain storage.
Sharing the physical credential entry does not import the old keys. Core
[startup](../../../packages/client-runtime/crates/bittery-client-core/src/runtime/open.rs) reads only
its DeviceCatalog and publishes an empty catalog when that document is absent. Startup must detect
an existing legacy profile before this empty-profile path becomes the production UI result.

The existing queue adapters can treat a parse failure as an absent document, and ItemCache treats
some malformed records as disposable. Admission must read original values through primitive readers;
calling these permissive loaders is not evidence that all accepted work was preserved.

## Exact Account and security mapping

The [legacy key scheme](../../../packages/storage/src/keys.ts) is
`bittery_account_${accountId}_${name}` for Accounts and `bittery_${name}` for globals. Account IDs
are stable local identities; email is not an identity key. The compatibility envelope is versioned
by the new reader; do not claim that these existing unversioned AccountStore values have a version
field they do not contain.

| Legacy evidence | Core admission rule |
| --- | --- |
| `accounts_list`, `active_account` | Preserve Account IDs and selected Account when valid. Validate normalized Server URL plus Server User ID, duplicate identities and per-Account metadata agreement. Create one recorded Core incarnation for each admitted Account; retries reuse it. Do not allocate a fresh Account because the email spelling changed. |
| Metadata email, User ID, name, Server URL, team name/avatar, Secret Key hint, added/last-active times, insecure-transport confirmation | Preserve source metadata. Core's existing Account display projection remains the renderer source. Keep source timestamps that have no current projection in admission evidence rather than silently discarding them. |
| Global `device_key` | Decode the existing Base64 32-byte key into Core's DeviceKey document. Preserve the bytes. Never mint a replacement key because a source read failed, and never write it to plaintext staging. |
| `session_data.encryptedMasterUnlockKey`, `secret_key` | Keep the exact existing `EncryptedData` ciphertext, IV and algorithm and Secret Key. Admit through validated QuickUnlockDocument construction. No password sign-in, SRP, new Auth key or rewrapping is required for the handoff. |
| `session_data.createdAt`, `lastMasterPasswordEntry` | Preserve the original milliseconds and optionality. Existing password re-entry falls back to creation time; migration time must not become new password-entry evidence. |
| `session_data.sessionId`, `expiresAt`, `serverExpiresAt`; `jwt_token`, `vault_keys`, `encrypted_private_key` | Preserve a complete retained Session through CurrentSessionDocument. Match the legacy relative/absolute expiry interpretation in AccountStore, with Server expiry precedence. Do not extend expiry. Absent Extension session-area values after browser restart do not invalidate otherwise complete password QuickUnlock material. Incomplete Session evidence is retained and explicitly classified; it is not filled with fabricated credentials. |
| `pinned_kdf_params`, `server_url` | Reuse Core's KDF and Server normalization validation. A conflicting Server/User or unsupported KDF is an explicit admission failure, not permission to fetch replacement secrets or install an empty Account. |
| `biometric_enabled` plus Session/catalog mirrored flags | Preserve the existing authoritative separate enrollment value and make admitted Core metadata/QuickUnlock flags consistent. Refuse malformed values. Preserve disabled state; hardware availability remains a live primitive input. |
| Global `master_password_reentry_period_ms`, per-Account `auto_lock_timeout` | Preserve signed values and existing negative/zero meanings. Default only if absent. Core local-security documents become the sole policy source. Do not use truthiness, which would lose zero. |
| `last_biometric_auth` | Record its existence as source evidence, but retire grace at ownership handoff. The accepted [local-access contract](native-capabilities.md#local-access-contract) explicitly retires grace on owner loss. Do not treat migration as a successful OS prompt. |
| `background_timestamp` and native unlocked projection | Neither proves live access in the new owner. Start locked and establish Core-clock inactivity receipts through the existing local-access policy. Do not import in-memory MUKs or trust the old `native_view` unlocked set. |
| `travel_mode_cache` | Preserve and validate the existing verified policy with the associated Account. Apply the same Core installation/read restrictions and [hidden-work decision](../issues/65-hidden-vault-durable-work-contract.md); stale cache cannot authorize hidden keys or new work. |

Legacy shapes and expiry semantics are defined in [storage types](../../../packages/storage/src/types.ts)
and [AccountStore](../../../packages/storage/src/account-store.ts), including
`resolveStoredSessionExpiryTimestamp`, `effectiveSessionExpiry`, `isBiometricAuthRequired`,
`storeSessionData` and `clearSession`. The destination
[documents](../../../packages/client-runtime/crates/bittery-client-core/src/platform_storage.rs)
already represent the principal credential fields. Compatibility decoding belongs beside these
Core validators; hosts must not reconstruct AccountStore policy in Rust adapters or TypeScript.

## Replica and Sync evidence

ItemCache state version 2 selects `activeGeneration`, `itemsPrimed`, `vaultsPrimed`, and metadata
containing `lastFullSyncAt`, `itemCount`, `cacheVersion` and optional
`syncBaseline { serverUrl, cursorId }`. Collection names are defined once in the legacy key scheme:
`${accountId}:items|vaults|meta` and
`item-cache-stage:${accountId}:${generation}:items|vaults|item-baseline|vault-baseline`.
Admission reads the metadata pointer and all referenced records from a stable captured source.
An unpromoted stage is not the active Replica. Retain it until the reader has established whether
it carries unique evidence; do not publish its rows as confirmed data.

[CachedEncryptedItem](../../../packages/types/src/index.ts) derives from the generated Server Item
payload and adds Account scope, Attachment metadata and optional retained `optimisticFailure`.
Normal pending projections are rebuilt from the durable queue by
[AccountVaultReplica](../../../packages/core/src/services/account-vault-replica.ts); they are not
all persisted as confirmed rows. Failed Create may persist rejected ciphertext and its Operation
identity. Import the confirmed baseline and pending/failed evidence as different Core records so
an optimistic value never becomes a fabricated Server acknowledgement.

Sync source keys use `sync_source_${encodeURIComponent(source.id)}:` followed by `lastSyncCursor`
or `syncBaselineV1`. The latter contains `{ initialized: true, cursor }`, where the cursor can be
null. The source ID and Server URL must agree with the Account and ItemCache baseline before a
cursor is admitted. If confirmed cache needs rebootstrap, retain offline encrypted evidence and
accepted work through Core's existing recovery/bootstrap ownership; a network fetch is not a
substitute for preserving the populated profile during an offline upgrade.

### Bounded Desktop cache admission frontier

The first Desktop cache slice admits only one promoted ItemCache generation whose complete active
records are representable as existing Core authority rows. The version-3 `bittery_native_view`
remains captured stale projection evidence: its unlocked set and published pointers do not grant
authority, and an absent view remains valid. Core derives the exact plain ItemCache state key from
the accepted legacy AccountStore/record-key contract, then requires the version-2 state document,
its `activeGeneration`, and its version-1 item/vault prefixes to agree byte-for-byte with the Account
identity and the actual `record:` keys in the captured Store. It
validates every cached row strictly, including its Account/Server scope, record ID, Vault
relationship and closed encrypted Server payload. Unknown cache fields, `optimisticFailure`, an
unpromoted staging collection, unique baseline records, or unsupported Travel/pending-work
combinations remain explicit admission failures with the source untouched.

An admitted active generation is recorded as a typed optional `legacyAdmission` origin on Core's
existing Bootstrap generation record. The origin retains the admission manifest digest, Account and
normalized Server identities, the source `activeGeneration`, the full ItemCache pointer/state,
metadata and checkpoint evidence. The Core generation ID is derived deterministically from the
catalog-recorded Account incarnation; the source generation is evidence only and never becomes a
Core generation identity. Legacy-origin generations contain no fabricated Server page receipts and
use otherwise neutral Bootstrap control fields. Ordinary Server Bootstrap generations have no
legacy origin and keep their existing receipt-chain validation unchanged.

Core admits a live Cursor only when `syncBaselineV1`, legacy `lastSyncCursor` when present, and the
ItemCache metadata baseline all establish the same source ID, normalized Server URL and exact
captured Cursor. A verified null Cursor becomes `CapturedEmpty`; a verified nonempty Cursor becomes
`CapturedValue`. Any missing or unreliable baseline produces only `RefreshRequired` with the legacy
generation active and the cursor `Cold`. This special legacy-origin state preserves the exact
offline encrypted Vault and Item rows while normal mutation and incremental Sync remain gated; it
does not pretend that the Server returned an empty baseline. A later ordinary Bootstrap may replace
that generation through the existing staging/promotion owner. Persistence and restart validate the
legacy origin separately, without relaxing ordinary generation receipts or inventing Server
authority.

### Duplicate-only unpublished cache frontier

The maintained producer can stop Bootstrap after copying the active Item/Vault baselines and
staging an unchanged Vault page, while the first Item page is still awaited. The isolated
[ticket91 evidence](../issues/91-existing-profile-runtime-admission.md#comments) records exactly
that cut: one nonactive generation, three physical collections and no unpublished Item row.
Every unpublished raw record is already present, byte-for-byte, in the pointer-selected active
collection of the same Account and kind. This resolves the first disposition question: those
proved duplicate rows need no additional durable owner after the active evidence is admitted.
It does not resolve preservation of unique, stale, changed or stage-only evidence.

Keep all existing active-state, cache-row, Account/Server, Vault-key and checkpoint validation.
The first bounded extension may recognize only one nonactive generation per Account and the
closed collection kinds `items`, `vaults`, `item-baseline` and `vault-baseline`. Item kinds compare
with active Items; Vault kinds compare with active Vaults. A row is eligible only when its
nonempty physical record ID and original serialized value exactly match the already validated
active row. For this new duplicate-only path, that active row must carry an explicit `accountId`
equal to the accepted Account; exact byte equality also binds the stage row to that scope.
The maintained producer and captured baselines contain this field. Older active-only rows with
absent Account scope keep their existing admission rule, but an absent scope cannot justify
eliding a stage: the physical key could also name a legacy active collection for an unknown
Account. Equality after JSON decoding, a matching version, shared ciphertext or a matching
subset is insufficient. All recognized rows must pass; one differing or unmatched row refuses
the whole captured profile before admission writes. A missing physical collection is not an
empty synthetic page or evidence that Bootstrap completed.

Resolve physical-key ownership before consuming duplicates. Account and record IDs are opaque
and may contain `:`; only the generated stage token is nonempty and colon-free under the
maintained producer. Enumerate every syntactically valid Account/generation/kind/record
partition of a stage key, including partitions that would name an Account absent from the
catalog. The record ID is the entire remainder after a recognized collection kind. Require
exactly one partition and require that Account to be accepted; matching an active row must not
hide an alternative interpretation. Also reject overlap with any accepted Account's
pointer-selected active prefix, an active-generation baseline, an unknown collection kind or a
second nonactive generation. A colon inside a record ID alone is not an unknown suffix. Do not
assume a fixed number of colon-separated components or that the shortest or longest Account
match establishes ownership. Existing limits on captured source size and entries continue to
apply.

Compare against a temporary view of the original active raw records while decoding. Consume
only the keys proved to be duplicates; every other leftover still triggers the existing
unsupported-source refusal. Preserve the current active pointer, metadata, cursor disposition,
manifest digest, deterministic Core generation and scoped cleanup protocol. Add no new origin,
Bootstrap receipt, confirmed row, cursor, archive or persistence owner. The original full
capture remains available throughout validation and recoverable admission; final source cleanup
still follows successful admission of the active data and all other accepted evidence.

Freeze the producer capture as a maintained fixture, then demonstrate behavioral refusal in
Domain and public SQLite admission before implementation. The positive path must retain exact
active authority/origin/checkpoint evidence, admit locked, reopen without a source provider and
keep unpublished records out of the public projection. Negative controls include changed raw
JSON bytes despite equivalent values, changed or absent IDs, wrong kind, missing/deleted active
counterparts, unique baseline or stage-only rows, unknown scope/suffix, active-generation
baselines, multiple generations and ambiguous keys, including one accepted and one unknown
Account interpretation. Include unambiguous colon-bearing Account and record IDs as positive
controls and absent explicit row Account scope as a refusal control. Public refusal must leave
the source and catalog unchanged
with no protected or Replica publication. Actual application scheduling and physical Desktop
capture remain separate acceptance; this bounded decoder rule does not establish either.

### Retained Travel policy provenance and first disabled-policy path

Legacy `TravelModeConfig` stores the verified policy but never records a local verification receipt
when persisting it. Admission must not substitute its own clock, zero or a Server update timestamp.
The existing `verifiedAtMs` field becomes required-nullable in durable verified policy, public policy
projection and native transfer evidence. Existing numeric/decimal-string values remain unchanged;
a fresh authenticated Server response supplies its actual receipt, while legacy admission supplies
null and native transfer preserves that absence. Omission remains malformed. Enforcement still
uses the existing verified-policy owner and restrictions, not the presence of a receipt timestamp.

The next bounded path admits a disabled policy with its exact ordered hidden-Vault selection and
optional Server update timestamp. Decode a closed object, require unique nonempty IDs within Core's
existing selection bound, reject noninteger/out-of-JavaScript-range timestamps and a present-null
`updatedAt`, and require `enabledAt` absent or null when disabled. These two enabledAt spellings have
the same policy meaning; the source manifest continues to bind their original bytes. Store the
policy in the existing generation-bound Account metadata and its admission digest. Populated cache,
Session and Replica staging otherwise retain their existing owners and original identities. Prove
strict refusal before writes and successful locked admission/reopen without a network request.

Enabled policy additionally follows the preparation rules below. Hidden keys and cached authority
are erased before publication; accepted encrypted work still requires its decision65 preservation
path before an enabled-policy Account with pending commands can be admitted.

### Enabled Travel policy before staging, without pending work

The enabled-policy path uses the existing admission owner to remove hidden authority
before any destination document or Replica row is staged. A valid enabled policy requires its
original activation timestamp and the same strict selection/timestamp validation. Any pending
command on that Account, including work targeting a visible Vault, still causes recoverable refusal
until the accepted-work path implements decision65. Other Accounts keep their own independent
policy and queue validation.

Fully validate source rows and credentials before filtering. In particular, hidden Item attachment
identity, scope, duplicate IDs, envelope version and size still undergo the existing checks, and
source Item-to-Vault references must be explainable. Then omit hidden cached Vaults/Items and their
Attachment metadata, and remove hidden Vault keys from both complete CurrentSession material and
partial Session evidence. Hidden cached Vaults need no retained key: the legacy enforcer may already
have erased that key. Visible Vaults still require the unchanged exact key/envelope join.

Preserve original ItemCache pointer, source metadata (including its original itemCount), checkpoint
and manifest as captured evidence. Source counts do not describe the filtered destination; its actual
rows and documents enter the fixed admission digests. No hidden destination authority ever exists,
so this preparation needs no live retirement journal. Preparing/resume/Abort retain their existing
ownership and exact filtered-content checks. The source remains untouched until ordinary committed
cleanup. Prove visible retention, hidden-key erasure in both Session shapes, already-erased source
keys, strict refusal of malformed hidden evidence and restart recovery.

### First normal pending Update admission

Admit one same-Account Update per Item with status omitted or pending, retryCount zero and no retry
error/deadline, projection claim, conflict copy or cross-target fields. Preserve original command,
optional semantic and optional attempt IDs; deduplicate source, resolved semantic and wire IDs.
Core's Operation and overlay use `attemptId ?? command.id`, the Server's Update idempotency identity.
The distinct semantic ID remains immutable lineage. Create continues using its semantic fallback.

Reproduce the actual encoded PATCH path, merge-patch content type, quoted positive baseVersion
If-Match and encryptedData/encryptionIv/encryptionAlgorithm property order. At admission require a
live cached Item in the same source Vault, exact cached Server version equal to baseVersion and a
writable retained Vault. Cached encryptionVersion remains independent: metadata-only changes can
advance Server version without resealing. The new payload must use checked `baseVersion + 1` for
its AAD encryptionVersion; Create payloads must use version one.

The maintained legacy projection path changes only memory, so keep its cached base as confirmed
authority. Build a separate optimistic overlay from that base's category, favorite, creation time,
deletion state and attachments, replacing ciphertext, version/encryptionVersion and update time
from the command. Do not remove the authority row or force a cold generation. Historical projected
cache and other unrepresented variants remain recoverable refusals. Source/base checks run at
admission; later persistence validates immutable lineage/request/overlay without comparing them to
Bootstrap authority that may legitimately evolve. Ordinary retries retain lineage while changing
live scheduling. Genuine acknowledgement reconciles through the existing owner and atomically
replaces Operation/overlay with the compact receipt, whose Update identity uses the attempt fallback.

Persist an `overlaySha256` witness in the immutable legacy admission evidence: required for
Update, omitted for Create, with present null refused. Hash the canonical typed ReplicaItemRecord
under a versioned domain separator, including Account, Item, Vault and wire Operation identity.
This binds inherited base fields and attachments without copying another payload or consulting a
mutable Bootstrap generation on reread. Whenever the overlay remains, validate the whole witness;
initial admission additionally requires the overlay. Rescheduling cannot change the witness, and
receipt compaction discards it together with the removed overlay. This uses the existing Operation
owner and introduces neither a separate journal nor a new authority generation.

Prove actual SQLite import/reopen while locked/offline, base version6/encryptionVersion3 with new
payload7, exact request bytes/fallback IDs, pre-Preparing refusal of mismatched evidence, and durable
retry/changed-lineage rejection/acknowledgement/receipt reload. No new generation or journal is added.

### Normal pending metadata and lifecycle commands

After the Update path passes, admit Favorite, Trash, Restore and Permanent delete with the same
initial normal scheduling restrictions, one command per Item, original identity deduplication and
same-Account writable Vault/base-version checks. Reproduce their exact existing methods, encoded
paths, bodies, headers and fingerprints; the actual Server identity is `attemptId ?? command.id`.
Keep source favorite optionality, including omitted meaning false, in the immutable command evidence.
No payload, cross-target or unrelated kind-specific fields may be invented or silently discarded.

Preserve the maintained legacy projection instead of applying a new user command. All four retain
base ciphertext, encryptionVersion, Server version, writer, category, attachments and creation time.
Favorite changes favorite and update time; Trash sets deletion and update time to the source command
timestamp; Restore clears deletion and sets update time. Permanent delete retains the complete base
projection, including update time and visibility, until genuine acknowledgement. Its imported overlay
keeps `permanentlyDeleted` false. Confirmed authority remains unchanged. Require the same generic
versioned `overlaySha256` witness, with conditional durable validation after legitimate retirement
and immutable retry/compact receipt rules from Update.

Favorite and Trash require a live source Item. Restore and Permanent delete accept either live or
trashed bases: the actual legacy ItemCommands API allows both. Preserve those already accepted
requests and let the ordinary Server outcome owner reconcile a real ItemNotTrashed rejection;
admission does not fabricate that outcome. Reproduce both base states, true/false/omitted Favorite,
independent version fields, locked SQLite reopen, exact request bytes, pre-write malformed refusal,
ordinary retry, overlay tamper refusal and genuine applied/rejected receipt compaction. Failed,
conflicted, claimed, retried and multiple-command-per-Item variants remain separate bounded paths.

The maintained [legacy projection oracle](../../../packages/core/src/services/vault-repository-bootstrap.test.ts)
drives public repository commands over the real legacy cache/crypto fixture for eight variants:
true/false/omitted Favorite, Trash, and both live/trashed Restore and Permanent delete. It checks the
entire projected Item and unchanged persistent cache with Server version6/encryptionVersion1.
Those passing TypeScript cases establish source behavior; Rust admission still requires its own
public storage, retry and outcome evidence above.

### Normal pending same-Account Move

After metadata/lifecycle admission passes, extend the same existing-Item owner to a normal pending
Move under the same initial scheduling, identity, single-command and exact cached base-version
checks. Require a live source Item and retained writable source and destination Vaults in the same
Account; allow their IDs to coincide, as the legacy API does. Bind the new payload to checked
`baseVersion + 1` and the current User. Preserve the cached source as confirmed authority.

The immutable POST request uses the encoded Item `/moves` path, original attempt fallback,
quoted base-version precondition and exact legacy field order: mode, sourceVaultId, targetVaultId,
encryptedData, encryptionIv, encryptionAlgorithm. In particular, preserve the omitted `attachments`
property. The Operation target names the destination Vault; the retained source command and body
continue to name the source. Existing accepted-Vault inspection then gates both sides.

Construct the destination optimistic row by replacing Vault, ciphertext, version/encryptionVersion
and update time on the source base. Retain original category, favorite, creation/deletion fields and
complete source-bound Attachment rows. This is representable: existing Core projection decrypts
each overlay Attachment using its own authority Vault. Bind the full row with the generic immutable
overlay witness. Do not invent Attachment preparation, staging identities, a new request body or a
local rejection. The Server interprets the old omitted Attachment list as empty; any genuine retained
or newly returned AttachmentStateConflict follows ordinary reconciliation with current authority.

Prove locked SQLite import/reopen, two-Vault projection with unchanged Attachment bindings, a same-
Vault Move, exact absent-property bytes, successful empty-Attachment acknowledgement and genuine
AttachmentStateConflict receipt reconciliation. Retire either source or destination Vault separately
and reload/recover the retained Operation through existing both-Vault gates. Missing or malformed
source Attachment evidence still refuses before Preparing; no partial Attachment set is admitted.

### Normal retry scheduling and retired projection claims

Once the ordinary kinds pass, admit their absent, staged, applying, pending and retrying statuses as
Normal. Preserve every original optional error, deadline and projection-claim field as immutable
source evidence. Initialize existing live scheduling from `retryCount` and `nextAttemptAt ?? 0`.
The retained count is cumulative queue history, not a claim about sends using the current attempt
ID: metadata rebase can change that ID while retaining a nonzero count. Core's existing outcome
lookup followed by exact immutable replay handles an unsent replacement attempt without resetting
history. A pending command can have retry history/error; retrying can lack both deadline and error.
Apply existing numeric bounds, without inventing a new maximum retry quota.

Reconstruct the projection before whole-profile commit and retire every departed projection claim,
including future, expired and missing-expiry claims. The original ID/expiry remains source evidence
only and cannot delay or authorize Core work. Bind the initial live schedule only during admission;
ordinary retries subsequently evolve it without changing the captured DTO or compact receipt lineage.
For this path retain the existing one-command-per-Item and exact cached-base requirements. Stopped
commands, command chains and stale/missing source bases remain separate paths.

Before admitting arbitrary valid future deadlines, fix the existing Wasm SystemDeviceTimer's
signed-32-bit host delay overflow. Preserve the durable deadline and timer minimum-duration contract:
split a long wait into positive chunks no greater than `i32::MAX` milliseconds, retaining the current
clear-on-drop lease for each physical timeout. Keep zero and ordinary short waits unchanged and let
existing wake/cancellation stop a long wait. Add an actual Chromium regression through the existing
test-only binding feature: overflowing delays must stay pending until cancelled, and cancellation
must clear their physical timer. No production Runtime request or additional timer owner is added.

Cover pending history/error, a reminted retrying attempt without a deadline, preserved future
eligibility followed by exact dispatch, all three claim-expiry forms, and retry/receipt persistence.

### First cross-Account conversion frontier

After the ordinary stopped-command path, start with one normal pending cross-Account command,
retry count zero, no error/deadline/claim/conflict, both original Accounts present, an exact live
cached source base and no Attachments. Require writable retained source and destination Vaults,
matching source/target category, distinct Item IDs and canonical Server/User identities, checked
source version plus two, and destination payload version one encrypted by its captured User.
A missing or mismatching Account, payload or source baseline refuses before Preparing. A cached
target may be absent or match the exact expected target content under ticket90's existing comparison;
a conflicting target refuses. Start with the absent-target case before widening to retained target
proof. Audit/creation timestamps do not become new current-authority proof.

Bind after all destination incarnations and cached authority are available. Install one source-owned
ticket90 workflow and its unchanged source overlay; the destination Replica gets no fabricated
Operation or overlay. Reuse the workflow's immutable source record and exact source-overlay validator
without another overlay digest. Its target owns the original destination ciphertext, version one,
favorite false, no deletion or Attachments, and destination writer. Closed typed workflow admission
evidence preserves original command optionality and references that accepted target payload.

Use `LegacyItemCommandV1<Payload = ImmutableRequestPayload>` with the payload parameter limited to
its optional encrypted-envelope reference, preserving the ordinary wire shape. A boxed optional
`LegacyCrossAccountMoveAdmission` on the workflow contains version, admission ID, original queue
index, `LegacyItemCommandV1<WorkflowAcceptedPayload>` and the closed workflow admission disposition.
`WorkflowAcceptedPayload::Target` retains envelope version/writer and refers to the workflow's target
payload. Both command instantiations retain strict map-only, duplicate/unknown-field and present-null
rejection. Compare immutable workflow evidence on later advances and reschedules.

Prepare all Account documents and incarnations first, then bind commands against the complete
Account map and compute final expectations. Reuse one pure workflow-local legacy child constructor
for initial binding, durable validation and later source-step creation. The shared strict Item
request verifier receives a private path-encoding mode; only validated workflow admission selects
legacy component encoding, without inventing ordinary child admission metadata.

Begin at TargetCreate with an Active original destination binding, Ready disposition and only the
exact original target child request, without a result. The
[actual TypeScript executor oracle](../../../packages/core/src/services/cross-account-item-command-executor-serialization.test.ts)
and its [byte fixture](../../../packages/core/src/services/fixtures/legacy-cross-account-request-serialization.json)
fix `${operationId ?? id}:create-target`, `:trash-source` and `:delete-source`, independent of attempt
ID. Reproduce component-encoded paths, Create category/data/IV/algorithm property order, empty source
DELETE bodies and source base/base-plus-one preconditions. Validate these identities and bytes on
every durable reread and later child creation, not just initial admission. Include all three derived
IDs in the endpoint-scoped Server/User collision census against ordinary imported wire identities
and other workflow children. Also preserve the existing source Replica's local owner/child identity
namespace, which is stricter than endpoint uniqueness: reserve future source child IDs against local
accepted owners and children before Preparing, so later child creation cannot invalidate the Replica.
Derive the same fixed reservations from the validated workflow during durable reread and streaming
recovery; ordinary workflows continue to reserve their materialized child IDs. These are derived
validation identities, without another persisted registry or physical work count.
An ordinary destination-Account Operation may share a source-step ID when both its local Replica
and actual Server/User endpoint differ; this is not an all-profile identity namespace.

Durable validation at binding revision zero must still match the source command's original target
Account. Later guarded destination reauthorization may change that binding after its revision
advances, while preserving the original source DTO.

Existing retained lookup, exact replay, current-authority and destination retirement/reauthorization
guards remain authoritative. A matching target without retained proof stays blocked. This first
TargetCreate mapping also blocks when current source is already trashed or absent; it does not
invent a previous child result or claim complete already-applied legacy convergence. Subsequent
source stages and Attachment history require their own evidence mapping. Public SQLite tests must
prove locked source-free reopen, unchanged destination Replica, exact child sequence and refusal
before writes; controlled dispatch proves original suffix IDs through completion before widening.

### Normal cross-Account scheduling history

After the first cross-Account path passes, widen its no-Attachment conversion to absent, staged,
applying, pending and retrying source status with retained retry, deadline, error and claim history.
Keep the existing exact live source base, matching/absent target, writable scope and conflict-copy
refusal boundaries. Staged and applying are persisted local projection phases; neither status nor
retry count proves that any child was sent or completed.

The legacy queue counts retries for the whole choreography, including client acquisition before a
child request and failure after a successful child. Initialize the existing workflow schedule with
`attempt_count = retryCount` and `not_before_ms = nextAttemptAt ?? 0`. Preserve full source optionality
and history immutably while retiring departed claim ownership. Check JavaScript-safe numeric bounds
and nonempty claim IDs in both source decoding and durable admission validation. Do not give children
inferred send counts, deadlines or results. Start at TargetCreate/Ready with the original target
child and retain all three semantic-ID suffixes even when the queue reminted its attempt ID; that
attempt ID is used by the legacy Attachment path, which remains outside this conversion.

Only initial workflow acceptance must compare the current schedule with the source-derived schedule;
ordinary nonlegacy acceptance still requires its default schedule. Durable reread and guarded advance
retain immutable source evidence while allowing the existing live schedule to evolve. Each child
continues to require its original retained lookup and exact replay/current-authority proof regardless
of the workflow's retry count. No claim-expiry timer or additional retry owner is introduced.

Prove a captured future deadline across locked reopen, no early lease or HTTP, the first transient
failure incrementing the retained count, and unchanged child identities through subsequent progress.
Cover staged/applying records with an unexpired departed claim, absent/expired claim expiry, all
normal statuses and malformed numeric/claim history. Retained target content alone remains
insufficient proof; already-trashed or missing source, Attachments and stopped workflows require
their separate mappings.

### Original child proofs after legacy remote progress

After normal cross-Account scheduling history passes, widen only its no-Attachment Runtime path
when the captured source cache still satisfies the exact live admission baseline, but authenticated
current source has progressed. The actual legacy executor may leave the whole command queued after
target Create, source Trash or source Permanent-delete takes effect without a local acknowledgement.
It writes no ItemCache row between those child requests. A retry count, matching target or missing
current source supplies no child result; recover each result from its original Server identity.

Classify progressed current source narrowly: either the exact original source content, Vault,
category, favorite and Attachment set at base plus one with deletion present, or authoritative
absence. Reuse the existing current-Item comparison, which does not invent historical Server
timestamps. A present live/restored Item, another version or changed content/scope remains blocked.
This classification does not widen admission of a missing, trashed or changed captured cache.

At TargetCreate with progressed current source, require an exact current target. Apply that check
even when the target child's genuine Applied result is already durable after a lost local reply;
retained outcome proof is not proof of current authority. An unproved target child requires a fresh
Applied lookup for its original identity and equal exact-request replay at version one. Missing,
Rejected, wrong-version or inconsistent proof blocks; it cannot authorize an undecided Create.

Keep the existing sequential workflow owner and guarded transitions. With preceding Applied proof,
Core may prepare the next pure, reserved original source child with no result despite a progressed
current source. Preparation has no Server effect and retains the original semantic suffix, bytes,
fingerprint and base/base-plus-one precondition. When current source is beyond that child's own
precondition, replay requires its fresh Applied original-ID lookup, matching exact replay and expected
result version. Missing proof cannot become permission to send a new effect in that recovery path,
including after reopen. Preserve each child's normal unchanged-source path: exact post-Trash source
is the original Delete precondition, so after durable preceding proofs its ordinary lookup may be
Missing and the already-authorized original Delete may execute.

If source is already absent, prove original Trash and original Permanent-delete separately. Do not
infer Trash from absence, skip to Delete, or use another child's result as proof. Retain the existing
one-child preparation, preceding-proof and stage guards; result and stage may advance together only
where their existing guarded transition permits it. Complete and remove captured source authority
only after durable original Delete proof and a fresh absence check. Preserve current target,
Account/Vault, destination binding, cancellation and whole-workflow retry fences throughout.
Ordinary workflows, Attachment workflows and stopped/reauthorized legacy workflows keep their
existing behavior; no new schema, journal, receipt owner or transition relaxation is required.

Acceptance covers remote post-Trash and already-deleted source with all original child bytes and
IDs, each missing retained outcome independently, retained rejection, wrong versions, replay
disagreement, changed/missing target, restored/changed source, and target change after a durable
target result. Lose child-preparation and result-commit replies and reopen SQLite before continuing;
the same requests and results must survive without an unproved destructive effect. Source cache
variants and Attachment history remain separate frontiers. Coordinating and independent reviews
accept this bounded mapping. Focused implementation, review and validation evidence are recorded in
[ticket91](../issues/91-existing-profile-runtime-admission.md#comments).

## Accepted work: semantic lineage and immutable requests

The source queue is `bittery_pending_mutation_queues_v3`, a map from Account ID to ordered
[ItemSyncCommand](../../../packages/types/src/index.ts) arrays. Commands retain `id`, optional
`operationId` and `attemptId`, kind, source/target identities, ciphertext, base version, timestamp,
retry state, optional conflict copy and projection claim. The legacy normalization is
`operationId ?? id`, `attemptId ?? id`, and absent status means pending. Enqueue persists the command
before applying its optimistic projection. All durable statuses require an admission disposition:
`staged`, `applying`, `pending`, `retrying`, `conflicted`, and `failed`.

| Legacy kind | Actual request and Server identity |
| --- | --- |
| `create` | `PUT /api/v1/vaults/{vaultId}/items/{entityId}`. Server Operation identity is `operationId ?? id`; body order is category, encryptedData, encryptionIv, encryptionAlgorithm. |
| `update` | `PATCH /api/v1/items/{entityId}`. Identity is `attemptId ?? id`; body order is encryptedData, encryptionIv, encryptionAlgorithm. |
| `toggle_favorite` | `PATCH /api/v1/items/{entityId}/favorite`, the same attempt identity, body `{ favorite }`. |
| `delete`, `permanent_delete`, `restore` | Respectively DELETE Item, DELETE Item `/permanent`, POST Item `/restore`; same attempt identity, empty body. |
| `move` | `POST /api/v1/items/{entityId}/moves`; same attempt identity, prepared body in mode/sourceVaultId/targetVaultId/encryptedData/encryptionIv/encryptionAlgorithm order. |
| `cross_account_move` | A source-owned semantic workflow; target creation and source trash/delete use stable `${operationId}:create-target`, `:trash-source`, `:delete-source` identities. Attachment steps carry additional attempt-specific identities. Admission depends on ticket90's two-Account workflow under the accepted83 decision. |

Non-create Item requests retain strong `If-Match` from `baseVersion`. The sources are the
[queue dispatcher](../../../packages/sync/src/outbound-queue.ts) and
[API client](../../../packages/api-contract/src/client.ts), not UI reconstruction. On an acknowledged
version conflict the old queue can replace `attemptId` and `baseVersion` while retaining its semantic
Operation ID. Core's [OperationRecord](../../../packages/client-runtime/crates/bittery-client-core/src/replica/domain.rs)
instead freezes one request and fingerprint per Server Operation identity. These cannot be equated.

The Server fingerprint includes **raw body bytes**, route/path and normalized precondition; JSON
value equivalence is insufficient. Its
[tests](../../../apps/server/src/domains/operations/tests.rs) explicitly distinguish whitespace.
Legacy queues store fields, not the original HTTP body. A bounded Core compatibility serializer must
reproduce the supported legacy dispatcher's actual body bytes and path/precondition behavior, tested
against the real TypeScript API serialization and retained Server outcomes. Do not serialize through
an unordered map or assume Core's ordinary new-command serializer has the same field order.
Unsupported source variants remain blocked with their original evidence preserved.

Admission records the source semantic ID and current Server attempt identity separately. The
immutable request uses the latter where legacy did; retained semantic lineage, source status and
conflict/claim evidence remain available for projection and recovery. Do not generate new IDs,
restart a failed command as fresh work, or replay a UI command. Retained Server outcome lookup must
match the reconstructed fingerprint before applying an outcome. Missing acknowledgement after a
successful send must converge to that original outcome, not produce another write.

An old `staged` claim belongs to a departed popup/renderer. Retire that claim, retain its command and
allow only shared Core to establish its durable projection before dispatch eligibility. `applying`
requires the same reconstruction. Stopped `failed`/`conflicted` commands use the closed admission-only
holds below; they are never silently made pending or represented as proven Server rejections. The legacy queue does not retain every previous
HTTP attempt body: preserve what exists and prove the current attempt's outcome, without inventing a
complete history. Cross-Account re-add/authorization follows accepted ticket83: preserve the original destination
Server/User, target Item, semantic Operation and immutable accepted step identities. A replacement
destination Account remains blocked until explicit Core reauthorization; re-add/unlock alone is not
consent. Changed target content/attachments or unproven outcomes remain blocked with evidence intact.

### First stopped cross-Account proof path

After normal scheduling and original-child recovery pass, admit `failed` and `conflicted`
no-Attachment workflows with both original Accounts retained, an exact live captured source/base,
and an absent or exact captured target. Source status, retry/error/claim history and an optional
conflict-copy ID supply no child receipt. The actual queue excludes stopped rows from active Item
ownership; its cross-Account projection preserves the original cache and removes it only on whole
workflow acknowledgement. Admit a conflict copy only from its independently captured Create.
Changed, missing or trashed captured sources and Attachment history remain required later slices.

Extend the existing closed workflow admission disposition with `LegacyFailed` and
`LegacyConflicted`, requiring exact source-status agreement. Keep full immutable DTO optionality,
target-payload reference, original source/target records and all three original child reservations.
Begin at TargetCreate with only its fixed original child and no result. Initialize the existing
workflow schedule from the captured retry count/deadline; do not reconstruct child send counts.

Use an optional source overlay on the existing guarded `AdmitCrossAccountMove` mutation: normal
work requires its exact overlay, held work forbids one. Durable reread and streaming Recovery must
explicitly reject every held-owned overlay, independently validate the source/target and original
requests, and preserve physical row counts. A held workflow is inactive for source Item ownership.
Another active command may own that Item in either queue order, while all semantic identities,
endpoint-scoped identities and future-child reservations remain collision checked. Confirmed source
authority remains verbatim; an independently owned active overlay continues to project normally.

Held admission requires visible/readable retained source and destination Vaults. Runtime permits
proof recovery through a record-aware participant check with the same readable role requirement.
Normal acceptance, Attachment work and normal Resume retain writable Vault checks. Preserve both
current Account identities/incarnations, the exact Active destination binding, Ready/unlocked state,
Session/key access, cancellation, policy and Vault-retirement fences across asynchronous work.

Before every result-free held child replay, obtain a fresh lookup on that child's original endpoint
and ID, including retry count zero. Missing proof parks without sending, changing the record or
adding a polling deadline. Transient proof failure uses the existing persisted workflow backoff;
the captured future deadline delays lookup and external wakes may later revisit a parked hold.
No source status, semantic/attempt ID, Sync event or previous lookup can replace this fresh hint.
Validate an Applied hint's exact entity/version before replay. Replay the immutable request and
require the same outcome; changed or inconsistent proof cannot advance any later child.

Keep the current source/target guards from the preceding remote-progress path. Beyond a child's
own precondition, only original Applied proof permits replay; an equal Rejected proof may terminate
the workflow only where its current authority guards permit. Persist proof through the existing
sequential guarded transitions. In this no-Attachment mapping the captured DTO fixes all three
original request identities and bytes at admission, so materializing the next fixed result-free
child is a pure journal step after preceding proof. It does not prepare a new request or authorize
an undecided effect. Attachment encryption/upload preparation stays forbidden by the general hold.
Complete only after all original required proofs, durable Delete proof and fresh source absence.
Completion or rejection must preserve any separately owned newer active request/overlay. Sync can
update current authority but cannot fill in a workflow child's result or bypass its proof/deadline.

Project each nonterminal hold with the existing outer `LegacyFailed`/`LegacyConflicted` resolution
and a closed Rust-defined inner `CrossAccountMoveDisposition::LegacyHeld` (`type: "legacyHeld"`).
Hide its executable deadline and synthetic rejection; availability and durable blocked evidence
must not rewrite this projection into Ready/Waiting. Genuine Completed/Rejected results take
precedence. Regenerate the protocol and native bindings under ADR 0012.

The first implementation retains original binding revision zero while Active. Retirement preserves
the immutable hold and original target Account even after the binding revision advances. Refuse
held Prepare/Resume before proof requests, recheck under Account locks, and also refuse the guarded
reauthorization mutation itself. This is a temporary implementation boundary: the accepted
`DestinationReauthorized { prior_hold, binding_revision }` mapping below remains required. That
later explicit83 full-proof confirmation authorizes normal continuation; this slice neither
implements nor removes it. No automatic reopen/unlock/re-add may clear a hold.

Test first with failed/count-zero, absent target, locked admission and zero HTTP, unchanged source
authority, no overlay, full original bytes/history and source-free reopen; retain a normal overlay
control. Then prove public scheduler parking, independent work, both queue orders, read-only scopes,
original target-only/Trash/Delete proof prefixes, each missing proof, wrong/disagreeing and genuine
Rejected proofs, future deadline/backoff, Sync, retirement/Resume refusal, newer active ownership,
and a lost durable result reply across SQLite reopen. Use genuine maintained in-process Server
effects for the Runtime proof matrix and the actual TypeScript producer for source facts. These
focused tests do not claim external Server or full platform admission acceptance. Coordinating and
independent review accept this bounded mapping; ticket91 remains incomplete until later slices and
its required final checks pass.

### First stopped-work destination reauthorization

After the first stopped proof path passes, implement the already accepted83 confirmation through
its existing Prepare/Resume action. The first tracer retains no Attachments, the exact live captured
source and current source, and an exact existing target with genuine original TargetCreate Applied
proof. An original hold enters this path only at TargetCreate with its one fixed child and an actual
Retired destination binding. Absent-target/Missing-proof authorization and original holds already at
later stages remain required later mappings; this boundary does not remove accepted83 behavior.

Preserve the existing serialized `Normal`, `LegacyFailed` and `LegacyConflicted` unit-string forms.
Add workflow-only `DestinationReauthorized` as an externally tagged variant carrying a dedicated
map-only payload: closed two-case `priorHold` and canonical decimal `bindingRevision`. Reject unknown
or duplicate fields, positional arrays, a Normal prior hold and authorization revisions below two. Ordinary Operation
admission remains unchanged. Initial workflow binding/admission cannot produce this variant. Source
status must agree with its original prior hold. Active binding revision must equal authorization
revision; subsequent retirement preserves that evidence even though retirement advances the binding.

The specialized existing guarded Reauthorize mutation alone changes this admission disposition.
Atomically install the new Active destination binding, its authorization revision, and the exact
normal source overlay derived from the existing accepted record. Reject independent active source
ownership before proof work and in the guarded commit; never overwrite another owner's required
evidence. Subsequent Resume preserves the already-authorized workflow's own exact overlay and
excludes its own ownership from the collision check. Existing normal Vault-retirement rules may
legitimately remove an overlay; repeated Resume preserves that absence and does not recreate it.
Only the original held-to-authorized activation installs the new source overlay. Preserve the original DTO,
source/target records, child IDs/requests/results and scheduling; ordinary Advance still requires
immutable admission-evidence equality. Repeated successful confirmation preserves the original
`priorHold` while updating only the binding and authorization revision.

Resume requires current writable source and destination scopes even while the captured record is a
readable-only hold. Retain that explicit authorization requirement through every awaited proof,
commit callback and postcommit check. Keep identity, incarnation, lock/owner epoch, Replica revision,
Session, cancellation, policy and retirement guards. Preparation verifies eligibility without
mutating durable work. For an original hold's first authorization, confirmation repeats proof checks,
replays only the original decided target request with the same outcome, rechecks authority, and
commits through the existing atomic plan. Subsequent DestinationReauthorized Resume retains the
existing normal stage/proof rules, including replay of other already-decided children. Confirmation
cannot execute an undecided source request. Only successful confirmation permits normal dispatch
to continue the original fixed workflow. Readable held proof recovery keeps its existing policy.

The resulting active workflow uses normal ownership, scheduling and projection while retaining its
prior-hold evidence. Reopen, re-add or unlock cannot authorize it. A later retirement blocks execution
and preserves the previous authorization; only another valid explicit confirmation changes it.
Known rejection, missing original target proof, changed content, unavailable/wrong scopes, or a stale
confirmation leave the original hold and independently owned work unchanged.

Test first with a failed hold, genuine target effect, actual public destination removal/re-add,
nonmutating Prepare, explicit confirmation, and original-ID continuation through completion. Extend
to both holds, closed persistence/Recovery validation, independent owner refusal, ReadOnly and stale
scope refusal, wrong/rejected proof, locked source-free SQLite reopen, lost authorization commit
reply, and a second retirement/confirmation preserving the prior hold. Retain ordinary Resume
regressions. Coordinating and independent source/ownership review accept this bounded mapping;
focused implementation and passing checks are recorded in [ticket91](../issues/91-existing-profile-runtime-admission.md),
which remains incomplete until its other required paths and final checks pass.

### Stopped SourceTrash destination reauthorization

After the first authorization checkpoint passes, extend original held activation to SourceTrash
with no Attachments, exact original live source still present in the Ready active cache and current
Server, an exact existing target, and an actual Retired destination binding. Retain either of two
exact child shapes: one TargetCreate child with original Applied proof, or that same proved prefix
plus its fixed original SourceTrash child with no result. A retained Trash Applied/Rejected result
is outside this mapping. Both legacy prior holds remain eligible; source status proves no result.

Share the supported held-resume shape predicate between Runtime and the guarded domain mutation.
Keep first TargetCreate authorization unchanged. SourceTrash's durable TargetCreate proof must retain
its original identity/fingerprint and exact target version. An unmaterialized future Trash remains
unmaterialized through Prepare and confirmation; a materialized one retains its original bytes and
result-free state. No child or result is synthesized by authorization.

Allow Missing lookup only for that prospective SourceTrash child during an explicit destination
reauthorization attempt whose original held record is at SourceTrash. It is an undecided future
request, not missing proof of an earlier effect. Every other original held Missing lookup still
parks, including TargetCreate; ordinary held dispatch and the held send-without-hint guard remain
unchanged. Known rejection, wrong Applied proof, or a replay disagreement cannot authorize the
workflow. Confirmation replays only already-decided original requests and never sends the Missing
Trash request. Normal dispatch may send it only after the guarded authorization commits.

Check that the current source is exactly live in both Prepare and confirmation authority checks,
including the final reread. The normal Resume authority helper can also recognize a remotely trashed
source with Trash proof; that broader case remains outside this tracer. Ready-cache equality at the
commit is a separate requirement and cannot stand in for the current Server check. Keep exact target,
identity, current scope, writable role, ownership, cancellation and stateless confirmation fences.
Only first held activation restores its exact source overlay and pending Item projection. Preserve
all original DTO/history, child requests/results, schedule and the already proved target prefix.

Test first through real target proof recovery to SourceTrash, actual destination removal/re-add,
nonmutating public Prepare and explicit confirmation. Cover both holds and both child shapes,
including a materialized child whose original outcome is Missing. Assert unchanged evidence at
confirmation and original-ID source effects only through subsequent normal dispatch. Add a genuine
Rejected prospective Trash refusal and a fresh Applied Trash/currently trashed source refusal; no
authorization or source overlay may appear. Retain the existing held Missing-dispatch, first-path
proof/refusal, ownership, recovery and normal Resume regressions. Coordinating and independent
source/ownership review resolve this bounded mapping; focused implementation and passing acceptance
are recorded in [ticket91](../issues/91-existing-profile-runtime-admission.md).
SourceDelete, complete remote absence, absent-target authorization and changed captured/cache source
forms remain separate required decisions and implementation work under ticket91.

### Stopped SourceDelete destination reauthorization

After SourceTrash acceptance, extend original held activation to SourceDelete with no Attachments,
either prior hold, an actual Retired destination binding, and the original live captured source still
byte-exact in the Ready active-generation cache. Require the exact existing target and a current
Server source that is present and precisely trashed under the existing progressed-source matcher:
original encrypted metadata, favorite and Attachment set, original version plus one, and a present
trash marker. This does not require byte equality of changed Server audit timestamps.

Require the durable original TargetCreate and Trash Applied prefix, with original identities,
fingerprints, entities and exact versions. Admit only that two-child prefix or the prefix plus its
fixed original Delete child with no result. Retained Delete Applied/Rejected results are outside this
activation mapping. Share eligibility between Runtime and the guarded domain mutation. Keep first
TargetCreate and SourceTrash activation rules unchanged.

Allow Missing only for the prospective Delete during explicit destination reauthorization of an
original hold at SourceDelete. Ordinary held dispatch and send-without-hint retain their proof-only
rules. An unmaterialized Delete stays absent through Prepare and confirmation; a materialized one
retains its exact bytes and result-free state. Prepare does not mutate. Confirmation repeats proof
and current authority checks and never sends the Missing Delete. Both initial and final authority
reads must require the present, precisely trashed source independently of the live Ready-cache check.
Reject known rejection, wrong proof and replay disagreement under the existing rules.

Activation keeps the existing atomic binding/authorization transition and exact original source
overlay, preserving the DTO, schedule, requests and results. Explicitly retain normal workflow
projection: the already-visible cached live source becomes Pending until completion. Do not rewrite
the capture or invent a trashed overlay. Normal dispatch alone may prepare/send the original Delete,
prove absence, remove source authority/overlay and publish completion. Current writable roles,
ownership, identities, incarnations, revisions, cancellation and stateless confirmation fences remain
required through each await and guarded commit; already-authorized Resume retains its existing rules.

Test genuine target/Trash effects and actual held proof recovery to both child shapes, followed by
public destination removal/re-add, nonmutating Prepare, confirmation and original-ID completion.
Cover both holds, genuine prospective Delete rejection, valid Prepare followed by genuine original
remote Delete while the cache remains live, and source absence caused by a differently identified
Delete while the original Delete outcome is genuinely Missing. Each refusal preserves evidence and
creates no authorization or overlay. Retain SourceTrash, first-authorization, held Missing-dispatch,
ordinary/Attachment Resume and existing atomic SQLite/reopen regressions.

Coordinating and independent source/ownership review resolve this bounded mapping; focused
implementation and passing acceptance are recorded in [ticket91](../issues/91-existing-profile-runtime-admission.md).
Remote absence, even with original Delete Applied proof, remains a separate required
completion-reconciliation decision that must avoid temporarily resurrecting a live Pending source.
Completed/Rejected rows do not become resumable. Changed/captured/cache-progressed source, absent
target and Attachment forms remain required later work under ticket91.

### Stopped remote-completion reconciliation

After SourceDelete continuation acceptance, extend explicit destination confirmation to original
held SourceDelete workflows whose original remote effects have completed. Both prior holds remain
eligible, with no Attachments, exactly three materialized fixed Item children, durable original
TargetCreate/Trash Applied proofs, and Delete either result-free or retaining its exact Applied
result. Require an actual Retired destination binding and the original live captured source still
byte-exact in the Ready active-generation cache. Already Completed/Rejected rows remain terminal.
Missing or progressed capture/cache and unmaterialized Delete remain outside this mapping.

Use the existing public Prepare/Resume requests and stateless guard. Prepare reads the exact current
target and source absence, then freshly looks up the original Delete outcome. Require exact original
identity, fingerprint, source entity and base version plus two; durable target/Trash proofs retain
their existing exact versions. A stored Delete result must equal the fresh Applied outcome. Missing,
Rejected, wrong, unrelated or disagreeing proof refuses; source absence alone proves no operation.
Prepare performs no replay or persistence. Confirmation recomputes all checks and replays only a
result-free original Delete with its matching Applied hint, comparing the exact reply. A durable
equal Delete result requires no replay. After the fresh lookup and any replay, confirmation must
reread both the exact target and source absence in either branch, including the durable-result
branch without replay, before the guarded commit. Keep all current scope, writable role, identity,
incarnation, revision, cancellation and shared independent-owner fences through awaits and commit.

A private closed Runtime result distinguishes normal continuation from proved legacy completion.
Completion uses one internal combined domain mutation carrying operation ID, expected retired
binding revision, replacement destination Account/incarnation and verified original Delete outcome.
Domain independently validates the closed completion shape, exact live Ready cache and shared source
ownership, including inactive independent overlays. Reuse one private implementation of binding
increment and prior-hold authorization derivation. Fill only an absent Delete result, preserve an
equal retained one and all original DTO/history/requests/scheduling, and set Completed. Share the
existing ordinary completion cleanup to remove source authority and only this workflow's overlay.
Do not loosen ordinary Advance's immutable-evidence or retired-binding checks.

The combined mutation never installs a live Pending overlay. The existing Account-atomic plan and
final accepted-work diff persist and publish only completed authorization plus source removal, with
one source Replica revision. No new store, migration, persisted workflow variant, public protocol,
host retry owner or journal is introduced. Refresh/publish only the final projection: Applied with
no source Item. Existing Accepted acknowledges that final guarded commit.

Both commands recompute continuation versus completion from current evidence. A valid continuation
Prepare followed by genuine original remote Delete may confirm atomic completion under the unchanged
local guard. This explicitly extends the earlier SourceDelete-only genuine-completion refusal; its
test becomes a no-intermediate-Pending completion acceptance. The unrelated Delete/Missing-original
proof refusal remains required. Ordinary non-held Resume and SourceTrash activation keep their rules.

Test first with genuine original target/Trash proof recovery, materialized Delete, actual destination
removal/re-add and genuine original remote Delete before public Prepare. Cover both prior holds and
both local Delete result forms, as well as Prepare followed by remote completion. Assert nonmutating
Prepare, exact decided replay only, preserved prefix/history, one final durable revision, no overlay
write or Pending publication, and unchanged unrelated work. Inject actual committed reply loss and
reopen locked/source-free SQLite: recovery may reveal only the old hold or final completion, never an
intermediate authorization overlay. Direct guarded-domain tests reject wrong/replacement results,
invalid stage/shape/binding/cache and active or inactive independent ownership atomically. Retain
genuine Missing/Rejected/wrong-proof/current-target/refusal and normal continuation regressions.

Coordinating and independent source/ownership review seal this mapping; focused implementation and
passing acceptance are recorded in [ticket91](../issues/91-existing-profile-runtime-admission.md). All
other captured/cache-progressed source, absent-target, Attachment and Extension admission forms,
platform acceptance and final full-CI checks remain required under ticket91.

### Stopped absent-target destination reauthorization

After remote-completion acceptance, extend explicit confirmation to an original held TargetCreate
workflow whose target is genuinely absent and whose original Create outcome is Missing. Both prior
holds are eligible, with no Attachments, exactly one materialized original TargetCreate child with
no result, an actual Retired destination binding, and an exact live current Server source. The
guarded domain commit independently requires the Ready active cache to retain the exact original
live source, and keeps all existing independent-owner, identity, revision and binding fences.

Reuse the existing public Prepare/Resume commands, stateless guard, normal continuation result and
guarded reauthorization mutation. Prepare reads current participants and the original outcome
without mutation. Confirmation repeats verification, rereads both current Items even when there is
no replay, and authorizes only after the current writable scope and shared ownership checks hold
through every await and commit. Scope the held Missing exception to explicit destination
reauthorization, TargetCreate stage and its fixed result-free TargetCreate child. Ordinary held
dispatch still parks on Missing and held send-without-hint remains forbidden.

Missing plus an absent target is permission for a future original request, never an Applied proof.
Prepare/confirmation send no undecided Create. The existing atomic activation changes only binding,
authorization/disposition and exact normal source overlay, preserving original prior hold, DTO,
requests, child results and scheduling. Normal dispatch may send the original Create only after
commit, then finish the original Trash/Delete steps. No new wire type, persisted workflow variant,
host retry owner or guard classification is introduced.

Both commands recompute evidence. If an initially absent target appears with genuine original
Applied proof before confirmation, the existing exact-target proof path may confirm, including its
exact hinted replay. Appearance with Missing, unrelated or wrong original proof refuses. Applied
Create plus absent target refuses recreation; Rejected proof, changed/progressed source, invalid
cache, stale scope, ReadOnly authority and independent source ownership retain their existing
refusals. Ordinary non-held Resume behavior and later-stage rules remain unchanged.

Test first with the actual empty-target/Missing-outcome held fixture, public destination removal
and same-identity re-add. Cover both prior holds, nonmutating Prepare/confirmation, exact original
evidence/overlay and original-ID completion with Create sent once by normal dispatch. Test target
appearance under another identity after Prepare, original Applied proof with target now absent,
genuine rejection and progressed source, preserving complete snapshots/durable evidence without
replay or new effects. Reuse existing independent-owner/stale guard and atomic locked SQLite/reopen
acceptance; preserve the prior exact-present-target/Missing-original-proof refusal.

Coordinating and independent source/ownership review seal this mapping; focused implementation and
passing checks are recorded in [ticket91](../issues/91-existing-profile-runtime-admission.md).
Missing/newer/trashed captured source, progressed active cache, Attachments, Extension/platform
admission and final full-CI acceptance remain required under ticket91.

### Stopped completion after active-cache progress

After absent-target acceptance, extend combined remote completion to an already-admitted original
hold whose complete original live source capture remains intact but whose active cache has progressed.
Only completion changes: continuation/activation still requires the exact original live Ready-cache
row and retains its existing projection rules. Do not infer a continuation overlay policy for a
trashed or absent cache from this mapping.

Make the private domain mode gate explicit. Continue requires its existing exact original source
cache. Complete requires Ready state and a valid active generation; the active-generation authority
row for the same source Item may be valid but trashed, newer/different, or already absent. A present
row must still satisfy the existing authority validation and match its source Item key; this is not
permission to accept malformed or cross-key authority. No field from that row becomes accepted
source evidence, a child request/result or an overlay. The original full capture, all three fixed
children and durable target/Trash prefix remain unchanged.

Keep fresh exact original Delete Applied verification, stored-result agreement, decided replay only
when required, exact current target and final source-absence rereads, original identities, writable
scope, cancellation and every revision/independent-owner fence. Fresh absence uses the existing Sync
authority semantics: under the captured Replica revision it may remove stale cached authority
without inventing an absence version or comparing against an absent row. A racing Sync commit makes
the old guard stale. Retain all other accepted work and inactive generations; any independent source
owner or stored overlay still refuses completion. No Pending overlay is installed or published.

Test genuine target/Trash effects and held proof recovery, then actual destination retirement to
prevent background completion. Use actual Item-event Sync to install the Server's trashed source,
then genuinely apply original Delete before explicit completion. Separately Sync a real permanent
Delete to remove the active row before confirmation. Assert that Sync never changes the immutable
workflow/child evidence; Prepare remains nonmutating and confirmation uses one final revision with
no overlay write/Pending publication. Reopen locked/source-free SQLite and retain exact completion.
Test actual Sync between Prepare and confirmation refusing the old revision guard. Domain tests
cover valid newer-cache removal under the same guarded absence semantics, both prior holds and
both Delete-result forms; label newer-cache coverage as domain evidence unless a genuine producer
establishes that full history. Reject Cold/missing-generation/malformed-key authority and preserve
wrong/Missing/rejected original proof and active/inactive owner refusal.

Coordinating and independent source/ownership review seal this completion-only mapping before
implementation. Missing, newer or trashed source at original profile capture remains a separate
required model frontier: the target payload cannot reconstruct original source ciphertext or audit
fields. Continuation from progressed cache, Attachments, Extension/platform admission and final
full-CI checks also remain required under ticket91.

### Stopped SourceDelete continuation from a trashed active cache

After completion-cache acceptance, allow one additional explicit first authorization for an
original held SourceDelete whose full original live source capture remains intact. The source
has genuinely reached original Trash, and actual Sync has installed that exact current trashed
source in the active Ready generation. Existing exact-live-cache continuation and combined
completion keep their separate contracts; this mapping does not authorize absent or newer/different
cache with a present Server source.

The projection decision is explicit: activate this workflow without installing any source overlay.
The Item keeps its current trashed Authoritative projection; its Operation becomes Pending and
reserves the source through normal original Delete completion. An authorized nonterminal workflow
continues reserving its source during later destination retirement, even without an overlay;
retirement blocks execution. Reopen and ordinary repeated Resume preserve the absent overlay.
Do not revive a live Item or synthesize a trashed optimistic copy of the accepted source.

Use a closed private Runtime verification result and dedicated guarded internal PlanMutation/mode
carrying the existing complete verified-current AuthorityItemRecord. Share the existing binding and
prior-hold derivation; add no public protocol, persisted workflow variant or generic overlay flag.
The mode requires an original hold, no Attachments, SourceDelete, durable exact original target/Trash
Applied prefix, and either two children or its third fixed result-free Delete. Keep full source,
target, child requests/results, schedule and history unchanged; change only destination binding,
authorization lineage and disposition. Classify the mutation in the existing accepted-work diff.

The active source row must equal the complete freshly fetched current source DTO in both Runtime
authority passes, including confirmation's final reread. Domain independently checks Ready/valid
Bootstrap, exact active key and full equality with the supplied DTO. It also checks precise original
Trash progression: original identity/Vault/category/encrypted metadata/favorite/Attachment set,
original version plus one and a present deletion marker. Extract the existing precise progression
comparison into one shared cross-Account domain helper without changing its semantics; retain full
DTO equality as an additional requirement, including audit fields. Preserve all current identity,
writable-scope, owner/incarnation/lock/revision/cancellation fences and exact current target checks.
Any independent source owner or stored source overlay refuses. Validate before any state change;
confirmation writes neither source authority nor overlay and never sends a Missing Delete.

Actual original Delete between Prepare and confirmation may recompute into combined completion
with its full fresh proof and final absence checks. Missing original proof with source absence
still refuses. Ordinary Continue cannot bypass this witness-bearing mode, and initial admission or
ordinary Advance cannot manufacture its authorization.

Start test-first with genuine target/Trash effects, held proof recovery, actual retirement/re-add
and actual Trash Item-event Sync. Prove nonmutating Prepare, one-revision authorization without
Delete HTTP or source writes, unchanged trashed Item plus Pending Operation, active source ownership
and normal original-ID Delete completion. Cover both holds and both Delete child shapes; locked
source-free SQLite reopen before completion; a second retirement/Resume preserving absent overlay
and source reservation; same-Item public command refusal; independent active/inactive overlay
refusal; and actual Sync invalidating an old confirmation. Domain controls include full DTO audit
disagreement despite a matching progression subset, invalid stage/result/cache/generation, and exact
whole-state preservation. Keep completion and ordinary live-cache Resume regressions.

Coordinating review accepts the overlay-free projection after independent projection, ownership,
Recovery and interface review. Missing/trashed source at original capture, absent/newer-cache
continuation, Attachments, Extension/platform admission and final full-CI checks remain required
frontiers under ticket91.

### Stopped completion before the fixed Delete child is materialized

After trashed-cache continuation acceptance, extend the existing combined explicit completion path
to one additional predecessor: original held SourceDelete, no Attachments, exactly two fixed Item
children containing durable exact original target/Trash Applied proofs, and actual Retired binding.
The complete original source capture remains intact. This is a real checkpoint: legacy Delete may
have committed with a lost final-attempt response, while later Core held proof recovery commits Trash
before the separate pass that prepares Delete. Destination removal can retire between those passes.
Failed is the direct retry-exhaustion producer example; Conflicted is another eligible captured hold,
not a claim that lost transport alone produces that classification.

Keep the existing private LegacyCompletion result and combined guarded completion mutation. Make
its eligible two/three-child shapes explicit; do not add a generic child-recovery mode. Only when
initial current Server authority shows source absence may Runtime derive the missing original Delete
from the existing pure legacy_item_child helper. Its semantic suffix, original quoted base-plus-one
If-Match, encoded source path, empty body and fingerprint are already fixed and its ID is reserved.
Do not allocate an identity or write an intermediate child/Operation. Source-present two-child
continuation keeps its existing behavior and does not acquire a new speculative Delete lookup.
If absence first appears only on confirmation's final reread, refuse that attempt; do not derive or
look up another child mid-verification. A new explicit attempt may recompute from initial absence.

Prepare derives and looks up the original Delete ephemerally, requires its exact Applied identity,
fingerprint, source entity and original base-plus-two version, and never persists or replays it.
Confirmation repeats that proof, replays only the exact decided original request, checks equality,
and rereads exact target and source absence afterward. Apply all existing current writable-scope,
identity/incarnation/lock/owner/revision/cancellation fences. Missing, rejected, wrong or unrelated
Delete evidence refuses with the original two-child state intact; current absence supplies no proof.
A valid two-child continuation Prepare followed by genuine original Delete before confirmation may
recompute into this combined completion path.

Domain independently derives the one missing fixed child, attaches only the exact supplied Applied
outcome and validates the complete final three-child record before any cleanup. Share existing
binding/prior-hold derivation and final completion cleanup. Preserve source/target, both old children,
legacy DTO/history/scheduling and independent work exactly. Retain the existing Ready/valid Bootstrap
completion policy: current cached source may be original, trashed, newer/different or absent while
current Server source is absent. Remove only an existing active source row; absent authority causes
no fabricated source write. One revision contains final Completed authorization and necessary cleanup,
with no intermediate materialized child, optimistic write or Pending publication.

Ordinary Advance retains its result-free preparation, stage and Retired-binding restrictions. Earlier
stages without the durable target/Trash prefix, retained rejected Delete, Attachments and missing
original source capture remain outside this extension. Initial admission still reserves the original
future child identity, and Recovery still counts one workflow.

Test-first acceptance uses genuine original remote effects, held proof recovery to the actual
SourceDelete/two-child checkpoint, actual destination retirement/re-add and configured locked/source-
free SQLite reopen. Prove read-only Prepare, exact derived request replay, final current rereads,
one final revision/full-row equality, no overlay/Pending publication and exact completion reopen.
Cover both holds, continuation-Prepare then original remote Delete, missing/wrong/rejected
proof refusals, active/inactive owner exclusion, and unchanged two-child evidence on failure. Keep
materialized completion, lost-final-reply, ordinary Advance and live/trashed continuation regressions.
Coordinating and independent producer/proof review seal this bounded deterministic-child extension;
remaining admission frontiers and both phase-completion CI commands remain required under ticket91.

### Stopped full remote completion from an earlier Item prefix

After unmaterialized-Delete completion acceptance, extend one combined completion path across the
remaining reachable Item prefixes of an original hold with intact full source capture and no
Attachments. Genuine original target Create, source Trash and source Delete may all have committed
before Core proves any prefix; a lost final-attempt response can leave the original Failed command.
Admission starts at TargetCreate, and actual destination removal can retire before any next proof
pass. Conflicted is another eligible captured hold, not a classification inferred from transport loss.

Use explicit reachable shapes: TargetCreate has only its fixed result-free Create; SourceTrash has
Create Applied and Trash absent or fixed/result-free; SourceDelete retains its proved Create/Trash
prefix and absent, result-free or Applied fixed Delete. Every stored child must match its deterministic
original identity, endpoint, kind, request bytes, resource and fingerprint. Exclude other stages,
rejected results, foreign/corrupt prefixes and extra children. This extends full remote completion
only; source-present continuation and ordinary held dispatch keep their existing boundaries.

Upgrade the existing internal completion-mutation witness and private verification result to one
named three-proof payload with required targetCreate, sourceTrash and sourceDelete ObservedOutcomes.
Use closed map-only decoding with unknown-field, duplicate-field, missing-field and array refusal. No arbitrary child
list or caller-supplied request participates. The final persisted three-child Completed row and public
Resume DTO remain unchanged. Share a pure fixed-three-child candidate builder that derives original
requests, compares every existing immutable child before accepting it, and preserves retained results.
Runtime and Domain each obtain their own candidates through this domain-owned validation seam.

Only initial current Server source absence selects these completion candidates. Preserve the existing
freshness policy: durable Applied target/Trash proofs remain trusted and require no outcome GET;
missing/result-free target/Trash require fresh exact original lookup in Prepare and confirmation.
Delete always requires fresh original lookup, including exact agreement with any stored Delete proof.
All three supplied proofs must be Applied with their original identities/fingerprints, target version
one and source base-plus-one/base-plus-two versions. Prepare writes and replays nothing. Confirmation
first verifies the whole proof set and current authority, then replays only candidates without a
durable result, in original order, using their exact hinted request and requiring outcome equality.
Finally reread exact target and source absence. Absence first appearing on the final reread refuses
that attempt; it does not trigger further derivation, lookup or replay. Source-present continuation
keeps its existing lookup set, including no speculative unmaterialized Delete lookup.

Domain independently validates all three named proofs against its derived candidates, preserves every
retained result byte-exact, fills only missing results and appends only the fixed absent suffix. It
validates the final Completed record before cleanup. Share existing destination binding/prior-hold
derivation, current writable/identity/incarnation/lock/revision/cancellation fences and independent
owner exclusion. Keep the Ready/valid Bootstrap completion policy for original/trashed/newer/absent
cache. Remove only a present active source row and preserve unrelated work/inactive generations.
One guarded revision contains final authorization/completion and necessary cleanup, with no Pending
publication, overlay or intermediate child write. Ordinary Advance and initial admission do not gain
authorization or arbitrary append-with-result capability.

Test-first acceptance starts with genuine original remote effects and an actually retired/re-added
TargetCreate/result-free prefix, then covers both SourceTrash shapes and both prior holds. Assert
nonmutating Prepare, exact missing-result replay order/bytes, no GET/replay for durable target/Trash,
fresh Delete proof, final current rereads, complete old-prefix/source/target/history/schedule equality,
one final revision, no overlay/Pending, configured locked/source-free SQLite reopen and exact final
completion. Keep existing SourceDelete materialized/unmaterialized, lost-final-reply, live/trashed
continuation and ordinary Advance regressions. Refuse missing/rejected/wrong original proofs, retained
proof replacement, corrupt/unreachable prefix, target mismatch, stale guards and independent active/
inactive owners with exact local state preservation. Test the closed internal proof payload directly.
Coordinating and independent producer/proof review seal this single completion extension. Missing
original source capture, Attachments, remaining Desktop/Extension/platform admission and both final
phase CI commands remain required under ticket91.

### Parked admission after source-cache removal before queue acknowledgement

After full-prefix completion acceptance, admit one additional genuine Desktop capture: the original
normal Pending cross-Account Move remains in the durable outbound queue after the real reconciler
has durably removed its source cache row, but before queue acknowledgement is persisted. Use the
existing reconciler wrapper to pause after `AccountVaultReplica.acknowledgeItemCommand` returns and
before returning to `OutboundQueue`; do not throw or rewrite the command. First-attempt provenance
is Pending, retryCount zero and original operationId/attemptId equal to id. Freeze the actual settled
queue/cache/profile pages, including a possibly empty destination cache despite its real remote
Create. A test's knowledge that the executor observed no Attachments is not captured admission evidence.

Represent this command in the existing CrossAccountMoves owner/store under its original semantic ID.
Use a closed two-variant owner envelope: its Captured branch serializes existing CrossAccountMoveRecord
bytes unchanged; its new `legacySourceUnavailable` map stores version one, operation ID, source and
destination identities, original destination binding, the exact result-free original target Create
request, scheduling and existing legacy admission lineage. Initialize and preserve scheduling exactly
from the original retryCount/nextAttemptAt fields; do not replace retained values with fixed zeroes.
Preserve valid typed optional diagnostics, projection-claim and deadline fields as immutable lineage;
their presence is not retry, ownership or remote-proof evidence. The real producer fixture proves
their omission at its captured boundary; compatibility controls may exercise their preservation.
The Pending, retryCount-zero and equal original-ID restrictions still apply.
The request owns destination ciphertext
once; lineage retains its existing payload metadata reference. Source Item/Vault/baseVersion and
other command facts derive directly from lineage. Preserve any valid current destination cache
independently, including a present target with later changed content: parked admission does not use
that row as original target proof or require content equality before preserving accepted work. Test
both the first empty-target capture and present-target preservation. Existing full-source target
compatibility checks remain unchanged. Do not synthesize source or target AuthorityItemRecord,
source category/crypto/audit fields, historical Attachment manifest or remote outcome. Unknown historical
Attachment provenance remains unknown; the new form does not enter the existing no-Attachment execution
contract. No second ledger, ordinary Operation surrogate, caller-supplied child list or optional fake
source accessor participates.

Select this mapping only for an actually absent source in a complete valid frozen capture and the
normal first-attempt Pending producer shape above. Keep all currently supported full-source mappings
and wire bytes unchanged. Enforce original identity/account/Vault scope, original destination Active
binding revision zero, distinct source/destination IDs, positive checked base versions, exact Create
request bytes/resource/fingerprint, result-free evidence and exact captured scheduling/status agreement.
Reject cold/incomplete or malformed capture, missing required fields, unsupported versions, duplicate
or unknown fields, arrays, mixed full/missing-source envelopes, supplied source/target authority,
Attachment/result/child injection, and authorization lineage. Decode directly through strict map
schemas without a Value-map step that discards duplicate keys. In this new form, identity,
binding, scheduling, target Create, its step/resource, request and individual header objects require maps rather
than positional arrays; byte and header-list sequences remain arrays. The target Create result
field is required and null. These field-level rules leave the nested Captured decoders unchanged.

Normal Pending provenance reserves the source Item as active accepted work without creating any
optimistic Item. Preserve that reservation across destination retirement and source-free reopen.
Reserve the same original semantic and three deterministic future child IDs unconditionally; a
conflicting future ID refuses admission, and the entry counts as one workflow. The normal source
reservation is independent of whether current Sync authority contains that Item. Do not independently schedule children.
Admission, guarded persistence and Recovery reject every overlay claiming this parked workflow and
enforce the independent-owner and semantic/three-child-ID fences unconditionally. Recovery must
reject forbidden overlays and ownership/ID collisions in either row order; absence of a permissible
overlay fingerprint must not become a wildcard. Teach existing union row serialization, write
selection, accepted-work diff/classification and restore validation about this variant, retaining
one CrossAccountMoves row and no second store or index. Reuse the existing source/destination Account and Vault lifecycle policy:
destination removal retires the original binding monotonically without releasing the reservation;
re-add alone never rebinds; source Account removal cleans up the same owner. Source Vault retirement
retains accepted work under the existing lifecycle policy while removing visible authority and overlays.
Derive lifecycle/resource facts
from known scalar addresses, never a fabricated source/category witness.

Categorically skip the unavailable-source variant in the scheduler. Gate execution on the envelope's
Captured branch before scheduler deadlines/leases, AttachmentAccess,
HTTP, proof lookup or replay. Parked entries perform no remote work. Public Prepare/Resume refuses
without HTTP; ordinary admission/Advance/reauthorization/completion APIs cannot convert this evidence
into an executable record. Current Sync may update visible authority but does not recover the original
capture or activate the command. Keep OperationResolution Pending, its captured attempt count and no
next-attempt timestamp because no dispatch is scheduled, without changing its durable scheduling
fields; project TargetCreate with a new precise cross-Account blocked reason
MissingSourceEvidence while binding active, or existing DestinationRetired while retired. Set
sourceVisible=false throughout this representation: it has no captured source to render. Later
Sync authority never promotes this evidence or changes that workflow projection fact. Add no
invented optimistic source; regenerate the public projection contracts and bindings for the new reason.

Test first from the maintained producer acknowledgement crash boundary. Assert exact frozen DTO and
request preservation, one owner/count and three reserved child IDs, future-ID collision refusal,
nonmutating scheduler/Prepare/Resume with zero HTTP, no optimistic row or synthesized authority,
normal same-Item reservation independently of current authority, exact preserved scheduling with
no scheduled projection deadline, union persistence write selection/diff, Recovery refusal in both
row orders, strict wire/forbidden-mutation refusals, and exact whole-state
preservation. Reopen configured locked SQLite with no legacy-source provider, unlock, and verify the
same parked projection and reservation. Cover destination retirement/re-add and source lifecycle;
retain existing full-source admission, live/trashed continuation and completion regressions.

Held Failed/Conflicted missing-source variants, other normal producer histories and original
trashed/newer capture remain later mappings. Full exact original Create/Trash/Delete proofs causally
support completion of the producer's observed Attachment loop because original Trash follows it;
they do not reconstruct its manifest or validate unknown later target Attachment edits. Terminal
reconciliation based on that causal evidence remains a separately sealable policy frontier, not an
impossibility and not enabled by this parked-admission slice. Remaining ticket91 admission/platform
frontiers and final phase CI checks remain open.


### Parked admission after a successful retry and source-cache acknowledgement

After the first Pending missing-source behavioral acceptance passes, extend the same version-one
`legacySourceUnavailable` entry to one additional producer-proven history. A real transient
client-acquisition failure leaves the original cross-Account command `retrying`; a later successful
semantic execution and real `AccountVaultReplica.acknowledgeItemCommand` remove the source cache
before `OutboundQueue` persists queue removal. Pause at the existing acknowledgement wrapper after
that real acknowledgement returns, without throwing or rewriting the command. Freeze the actual
Account, record and Sync pages at that boundary.

Keep the existing Pending/retryCount-zero branch and serialized bytes unchanged. The additional
closed history branch requires status `retrying`, retryCount one through four, original queue id equal
to explicit operationId and the entry's semantic operation ID, a nonempty attemptId distinct from
that semantic ID, a present safe-integer nextAttemptAt, and a present lastError string. Preserve
lastError verbatim, including an empty string: the producer copies Error.message without imposing a
nonempty constraint. Preserve all other currently valid typed optional lineage fields under the
existing rules. Do not interpret deadline, diagnostics or projection claims as execution or ownership
proof. Reject mixed Pending/retrying history and every other status; Failed/Conflicted remain outside
this mapping.

Use version one because the wire fields, source-evidence absence and ownership semantics do not
change. Initialize and preserve scheduling from the captured retryCount/nextAttemptAt exactly.
Project the captured attempt count but no scheduled deadline, Pending resolution, TargetCreate and
MissingSourceEvidence while active, or DestinationRetired after retirement; sourceVisible remains
false. The attempt ID is immutable historical provenance, not a replacement semantic identity or
permission to invent Attachment registrations. Continue reserving the semantic owner and exactly the
same three deterministic original Item child IDs, derived from the semantic ID rather than attemptId.

Keep all existing missing-source gates: complete valid Ready captured caches, actually absent source,
original writable Account/Vault scopes, exact immutable target Create request and payload metadata,
original Active destination binding revision zero, strict closed map decoding, independent current
target preservation, active source reservation without overlay, and independent-owner/future-ID
collision fences. Preserve existing union persistence, Recovery, Account/Vault lifecycle and
whole-state refusal behavior. Introduce no new row, child list, manifest, authority record, outcome or
execution path. Scheduler, dispatch and public Prepare/Resume continue categorically refusing remote
work for the unavailable-source branch, regardless of the captured deadline or later Sync authority.

Test first through the maintained real producer fixture: enqueue normally, cause one actual
client-acquisition failure, inspect the persisted reminted attempt/history, advance the fixture clock
to its exact deadline, run the real semantic executor, and capture after real acknowledgement but
before queue removal. Assert original Create/Trash/Delete HTTP IDs remain semantic and the frozen
source cache is absent. Keep remote observations and original source records outside the pages
supplied to admission. Freeze a separate explicit artifact; do not rewrite random attempt IDs or
committed oracle files during ordinary tests.

Public acceptance must preserve the exact artifact lineage and request through admission and
source-free SQLite reopen/unlock, expose the nonzero attempt count with no projection deadline, and
prove zero-HTTP nonmutating Prepare/Resume and no Move HTTP or Replica changes from dispatch.
The combined public driver may issue its independently recorded Account-refresh requests; account
for them explicitly rather than hiding them in the test transport. Domain controls cover all supported
retry counts, empty diagnostics, strict history rejection, exact scheduling, same original three-ID
reservations and immutable recovery. Retain all first-Pending and captured-source regressions. This
slice does not authorize differing queue/semantic IDs, other producer statuses, held ownership,
source-evidence reconstruction or terminal reconciliation.

### Held admission after exhausted acquisition retries and independent source deletion

After normal retrying missing-source acceptance, preserve one additional genuine Failed capture in
version-one `legacySourceUnavailable`. Enqueue normally and exhaust five actual client-acquisition
failures through the maintained queue, advancing its clock to each recorded deadline. Preserve the
exact Failed command; never invoke a fake semantic executor, synthesize a result, or edit its status.
Reopen a fresh legacy repository and queue before independent source deletion: the live repository's
encrypted-command guard can retain source authority even after the queue marks the command failed.
Real queue restore retains the held row while skipping its projection. Then apply an independent
`item_permanently_deleted` event through actual Delta Sync and the real repository cache adapter.
Delta Sync advances the Sync checkpoint while the legacy cache can retain its earlier full-refresh
baseline; that intermediate capture remains Cold under the existing consistency rule. Complete an
actual maintained full refresh against the now-absent source and current Server cursor before the
Ready capture. Never rewrite cache metadata or checkpoints to manufacture agreement. Freeze complete
settled Account/cache/Sync pages with the source absent and held queue unchanged.
Do not replace this path with direct cache removal, Trash, or a fabricated acknowledgement.

Keep the existing Pending and retrying branches unchanged. The additional closed history requires
Failed status, retryCount exactly five, explicit operationId equal to raw id and semantic entry ID,
a nonempty attemptId distinct from that semantic ID, absent nextAttemptAt, present lastError
(including an empty string), and exact LegacyFailed admission disposition. Preserve other currently
valid typed optional lineage under existing rules and initialize scheduling exactly from the DTO:
attempt count five and no scheduled delay. Version one, exact result-free original target Create,
strict map decoding, valid Ready capture, actual source absence, original Active destination binding
revision zero and unconditional semantic/three original child-ID fences remain unchanged. Use the
existing captured-held visible-Vault scope on both Accounts, including ReadOnly; normal parked
branches retain their writable-scope gates. Current target authority remains independent evidence.

Classify this entry as inactive held work, matching captured legacy holds. It reserves its semantic
and three fixed child IDs and counts once, but does not reserve its source Item against independent
accepted work. Always reject any overlay claiming this unavailable workflow's own semantic ID.
Permit independent same-Item owners and their overlays only under the existing captured-held
coexistence policy, including Recovery in either row order. Absence of a permissible own-overlay
fingerprint must never become a wildcard. Normal Pending/retrying unavailable entries retain their
active source reservation and stronger same-source overlay prohibition. Later current Sync authority
never reconstructs source evidence or activates either representation. Keep source/destination
Account and Vault lifecycle semantics; destination retirement preserves exact held lineage and IDs.

Project LegacyFailed resolution with LegacyHeld disposition taking precedence over destination
retirement, sourceVisible=false, captured attempt count five and no projection deadline. No source
or target authority, source crypto/category/audit witness, Attachment manifest, child outcome or
ordinary Operation surrogate may be invented. Scheduler, Attachment access, HTTP, proof lookup,
Prepare/Resume, reauthorization and completion remain categorically unavailable for this entry.
An unrelated Account-refresh request from the public background driver is separate from workflow
HTTP and must be identified explicitly by tests.

Test first from the genuine producer/reopen/Delta Sync fixture. Domain and public behavioral RED must
precede implementation. Assert exact preserved DTO/request/history, one inactive owner/count, all
original ID fences, no own overlay, valid read-only capture, independent-owner coexistence and own
semantic overlay refusal in guarded persistence and both Recovery row orders. Reject mixed or
unsupported histories, including Failed with another retry count or a retained deadline, Conflicted
and other statuses. Verify exact projection and nonmutating public refusal through configured locked
SQLite reopen/unlock, later current-authority Sync and destination lifecycle. Retain normal parked
reservation, Pending/retrying wire, and captured-held regressions. This first one-held-command
capture does not establish arbitrary queue chains. Conflicted/copy histories, other Failed causes,
missing-original terminal reconciliation and historical Attachment recovery remain later frontiers.

### Held admission after a first-attempt conflict and independent source deletion

After Failed5 missing-source preservation closes, extend version-one `legacySourceUnavailable` with
one explicit first-attempt Conflicted history. Use the real queued cross-Account Move, actual executor
source-version mismatch, queue current-source reconciliation, and repository conflict preservation.
Retain the independently enqueued conflict-copy Create; do not synthesize it from a conflictCopyId.
Use the genuine WASM crypto implementation for this producer fixture, with the known 32-byte 0x47
Vault keys matching the protected host scaffold. The original target may remain opaque evidence,
but independent copy readability must be proved from actual producer encryption. Preserve the exact
producer Vault key, copy AAD and ciphertext; never rewrite ciphertext after capture. Test SRP/login
credentials may be current host fixture secrets rather than historical provenance, but their wrapped
Vault keys must unlock the exact producer key. The older in-memory toy cipher does not establish this
cross-runtime readability requirement. A test-only Core dependency on the maintained WASM package
may supply this real backend; application crypto ownership stays unchanged.
Let its real Create encounter a transport failure before any remote write, leaving its ordinary
retrying command durably queued. Reopen fresh legacy repository/queue, apply independent original
source permanent deletion through real Delta Sync, then complete the maintained full refresh before
freezing a valid Ready capture. The actual source and copy authority must remain absent, while the
original held command and real independent copy retain both queue indices and exact DTOs. Assert
matching cache-metadata and Sync baselines from actual maintained writes; do not repair cursors or
remove cached records by hand.

The new closed history branch requires Conflicted status, retryCount zero, explicit operationId and
attemptId both equal to raw id and the entry semantic ID, present lastError, absent nextAttemptAt,
nonempty conflictCopyId, and exact LegacyConflicted admission disposition. Preserve diagnostics
verbatim, including empty strings, and all other valid typed optional lineage under existing rules.
Keep Pending, retrying and Failed5 branches unchanged. Preserve exact initial scheduling and original
result-free target Create; all common scope, valid Ready capture, actual source absence, original
Active binding revision zero, strict-map, immutable request and semantic/three-child-ID gates remain.

conflictCopyId is historical provenance under existing captured-held semantics, not an additional
ownership key, receipt or proof of a surviving copy. Do not require a copy row to exist merely because
this field is present; do not invent or reconstruct one. Do not introduce a new inequality rule
against source or target IDs: captured-held validation requires only nonempty optional copy provenance.
Actual captured independent commands still undergo their own full identity, source ownership and
collision validation. The maintained producer fixture must retain its genuine copy; that acceptance
requirement does not create a general foreign-key invariant between historical lineage and current
accepted work. The tested two-command predecessor does not prove arbitrary chains or other conflict
histories, and neither does it imply that every untested combination must acquire a new parser refusal.

The unavailable Conflicted owner is inactive, permits independent owners under captured-held policy,
and categorically cannot own any overlay. Preserve all unconditional semantic and original three-ID
reservations. Project LegacyConflicted resolution, LegacyHeld disposition ahead of destination
retirement, sourceVisible=false, attempt count zero and no deadline. Visible/ReadOnly scope remains
permitted for the held owner; an actual independent normal copy retains its own writable-Vault rule.
Current target authority remains independent, and later source Sync never promotes unavailable
original evidence. Source/destination lifecycle and both-order Recovery follow existing held rules.

Admit the genuine copy through the existing ordinary Create path with its exact source-Vault
ciphertext, copy semantic ID, request, retry scheduling and own optimistic overlay. Preserve its
independent normal ownership; do not relabel it as held or include it among original Move children.
Do not add or change copy dispatch policy. The first public dispatch tracer observes the copy's
own outcome GET, responds Missing, and verifies its exact original Create PUT while keeping that
request pending. Count independent Account-refresh traffic separately; assert that no original Move
request occurs. This proves independent scheduling without claiming a completed Server effect.
Any ordinary copy HTTP is distinct from the original workflow's categorical
no-execution/no-Resume/no-proof/no-Attachment policy. No source preimage,
Attachment manifest, source category/audit fields, target authority or remote result may be invented.

Test first from the maintained real two-row producer artifact, with actual Domain/public behavioral
RED before implementation. Verify exact two owners/counts and queue indices, original held projection,
copy overlay readability, immutable request/history, absent original/copy authority, future-ID and
own-overlay refusal, and Recovery in both row orders. Reopen configured SQLite without the legacy
provider, unlock, and verify both preserved owners and unchanged held evidence. Distinguish original
Prepare/Resume and scheduling refusal from independently authorized copy scheduling or Account
refresh traffic. Keep normal missing-source reservations, Failed5 and full-source held regressions.
Other attempt/count histories remain outside the closed branch. Additional producer captures for
acknowledged copies or terminal reconciliation remain separate acceptance work; historical copy
provenance alone enables no reconstruction, proof or original workflow execution.

### Admission-only holds for stopped legacy commands

The preservation boundary is explicit. The legacy queue stops after five retries and excludes
`failed` and `conflicted` from both dispatch and projection restoration. Desktop and Extension expose
only a [terminal-command toast](../../../packages/i18n/messages/en.json), which says automatic retry
has stopped; there is no command Retry action to preserve. `failed` can mean exhausted transport
retries, local projection failure, an API error or an actual semantic rejection. Its `lastError`
string proves none of those Server outcomes. Encrypted conflicts can independently enqueue a Create
with semantic ID `conflict-copy:<original semantic ID>` and the retained `conflictCopyId`, through
[the existing conflict projection](../../../packages/core/src/services/account-vault-replica.ts).
That copy may fail before enqueue. Admit a copy only from its own retained command/evidence, never
from the original command's `conflictCopyId` alone.

Preserve these stopped commands under the existing typed Operation/Replica owner. This is an
admission-only exception to [09's ordinary accepted-work retry policy](../issues/09-transient-operation-retry.md),
not a new way for current Runtime commands to stop retrying. Admission, reopen, unlock, refresh,
authority changes and Account re-add cannot reactivate the command. Add no Resume, Retry or Discard
action for ordinary held Item Operations. The cross-Account mapping below preserves83's already
accepted explicit destination reauthorization under its full proof requirements. New user commands continue through normal Core admission and have their own
identities; they never mutate the held request into a replacement attempt.

The concrete Rust-defined persistence extension is:

| Existing owner / new closed field | Required shape and invariant |
| --- | --- |
| `OperationRecord.legacy_admission: Option<LegacyOperationAdmission>` | Omitted for ordinary Runtime work. Version 1 contains `admission_id`, original per-Account `source_queue_index`, `source_command: LegacyItemCommandV1`, and `disposition: Normal \| LegacyFailed \| LegacyConflicted`. The source-owned cross-Account workflow additionally permits only the explicit reauthorization variant below. Use the existing camelCase, decimal integer and unknown-field-rejection conventions. |
| `LegacyItemCommandV1` | Closed typed evidence for the supported [ItemSyncCommand fields](../../../packages/types/src/index.ts): Account ID/email, `id`, optional semantic/attempt IDs, closed kind, entity/source/target identities, optional category and encrypted-payload reference, optional favorite, base version, timestamp, retry count, optional status/error/deadline/conflict-copy ID and projection-claim ID/expiry. Preserve original optionality. Validate numeric ranges and every kind-specific combination against the compatibility serializer; no generic JSON value, opaque executable body or unknown kind is admitted. |
| Encrypted-payload reference | For an ordinary Operation, optional `ImmutableRequestPayload { encryption_version, encrypted_by_user_id }` records source envelope metadata omitted by HTTP; the closed kind-specific decoder obtains the original ciphertext, IV and algorithm from that Operation's already-owned exact request body. A source-owned cross-Account workflow uses `WorkflowAcceptedPayload` to reference its existing immutable accepted payload, including before a target child request exists. Do not duplicate ciphertext in admission metadata. An existing separately owned recovery artifact uses its typed owner/reference, with digest/identity validation, instead of a second ciphertext copy. Presence and source optionality must agree with the referenced existing owner and source manifest. |
| Initial disposition validation | Absent/`staged`/`applying`/`pending`/`retrying` source status maps to `Normal`; `failed` maps only to `LegacyFailed`; `conflicted` maps only to `LegacyConflicted`. Retained source claim fields are evidence only: all claims are retired. Cross-Account commands use ticket90's source-owned workflow and its corresponding closed admission disposition, never an ordinary child Operation disguised as the whole workflow. |
| Identity and request | `OperationRecord.operation_id` remains the actual Server identity in the mapping above. Reconstruct its immutable request and fingerprint from the typed source, and validate agreement with kind/target/Account. The source DTO separately retains `operationId ?? id` semantic lineage and original attempt optionality. The source DTO is immutable; live scheduling uses the existing scheduling fields and cannot overwrite the captured retry count or deadline. |
| `OperationReceiptRecord.legacy_lineage` | Optional compact version-1 lineage: admission ID, source queue index, original command ID, optional source semantic/attempt IDs, source status and conflict-copy ID. Copy it in the same completion plan that writes the genuine receipt. A receipt never receives the source payload, request ciphertext or invented rejection code; encrypted local evidence follows existing accepted-work completion/retention rules. |

The same source queue entry cannot become both an independently dispatched Operation and a ticket90
workflow child. An incomplete request, conflicting duplicate identity, malformed source shape, or
unsupported mapping blocks the whole profile admission with original evidence intact. A generic
"blocked record" is not a fallback for a command the typed model cannot represent. Admission
establishes the local disposition offline; Server outcome discovery happens after catalog publication.

For `cross_account_move`, put the same optional typed admission metadata on ticket90's existing
source-owned workflow record, not on a fabricated whole-workflow HTTP Operation. Preserve its
concretely supported stage, destination binding, fixed child requests/results and artifact owners.
A legacy hold prevents new request/Attachment preparation, upload and step effects; only already-fixed
accepted child requests may use the retained-outcome proof below. Sequential materialization of the
three original no-Attachment requests follows the [first stopped cross-Account path](#first-stopped-cross-account-proof-path).
Proving a child result does not clear the
hold or authorize the next effect. A workflow can reconcile its existing terminal stage only when
all required original results are proven, using its ordinary guarded completion; no missing child
or source deletion is synthesized. Unrepresentable legacy step evidence blocks admission instead
of being hidden inside a held row.

[83's accepted explicit destination reauthorization](../issues/83-runtime-cross-account-item-move.md#explicit-destination-reauthorization-accepted)
also applies to a representable legacy Move; it is not limited to newly created Core workflows.
The existing ticket90 Prepare/Resume action may authorize continuation when Core establishes the
actual retired destination binding and verifies both current Account scopes, the exact original
Server/User and target identity, unchanged expected source/target content and complete Attachment
set, required artifacts and all prior step outcomes. A source status or `lastError` string does not
prove this eligibility. A known terminal rejection, edited content, missing proof or unrepresentable
history remains blocked; changing credentials or repairing a binding alone is insufficient.

On successful explicit confirmation, the existing guarded
`ReauthorizeCrossAccountMoveDestination` plan atomically updates the destination binding and changes
the workflow-only admission disposition to
`DestinationReauthorized { prior_hold: LegacyFailed | LegacyConflicted, binding_revision }`.
The retained source DTO and original immutable requests/IDs remain unchanged. This variant is
invalid on ordinary Operation records and cannot be produced by admission or automatic retry.
While the destination binding is Active, its revision must equal this authorization revision before
continuation. Subsequent retirement preserves the old authorization evidence and `prior_hold`, but
the Retired binding forbids execution regardless of that old revision; it must not make the retained
workflow structurally invalid merely because retirement advanced the binding revision. Only another
successful explicit83 Resume can atomically bind a new Active revision and update the authorization
revision, preserving the original `prior_hold`. Use ticket90's existing retirement/reauthorization
fence, not another authorization history or registry. The normal workflow may then continue
only from its proven stage under existing guards. Do not introduce a second Resume action or use
this exception as a general retry of failed/conflicted commands.

Projection must distinguish local preservation from Server truth. Extend the existing generated
`OperationResolution` with `LegacyFailed` and `LegacyConflicted`; neither means `Rejected` or
`Pending`. Ordinary held Operations expose no executable retry deadline or action; the workflow
projection retains83's separate guarded destination Resume when its full eligibility is proved.
Do not expose raw `lastError`
as a trusted rejection code. Reconstruct normal pending projections from eligible source commands;
do not replay a held update/delete/move into a fresh optimistic change. Preserve actually captured
encrypted local/failed Item evidence separately from the confirmed baseline using the existing
typed Item-overlay owner, with `ItemProjectionStatus::Failed` when that evidence is visible. Keep
authority/read/hidden-Vault gates intact. Bind the overlay to the admitted Operation's actual owner
ID while retaining its original semantic lineage; this does not change any Server identity. A held
Operation and an overlay owned solely by that hold are excluded from active optimistic ownership,
same-Item queue blocking and executable-work counts, matching legacy `isActiveMutation`; they cannot
starve another command or prevent otherwise valid new work. This exclusion does not supply missing
Server authority for a new command. An independently retained
conflict-copy Create retains its own normal disposition and encrypted projection.

Held work can reconcile an outcome that the Server already retained. Reuse existing outcome lookup,
exact-request proof, Session renewal, scheduling and completion under captured Account/User/
incarnation/epoch and Replica revision guards. GET returns only a hint, because
[the Server outcome envelope](../../../apps/server/src/domains/operations/mod.rs) omits the request
fingerprint. Only a successful lookup for that original identity permits replay of the exact frozen
request through the existing proof path: the Server returns the retained answer or identity-reuse
failure before applying another effect. A missing outcome leaves the hold unchanged and sends no
mutation. Transport/authentication failure cannot fall through to mutation dispatch. Transient lookup
or proof failure uses existing persisted backoff; missing-outcome holds return a parked result with
no polling timer. Existing external wakes may probe them again, once per finite scan, without
reporting progress for an unchanged hold. A lookup hint is not durable permission to dispatch after
restart: restart redoes the lookup. There is no new lookup journal or retry owner.

Admission checkpoints include these typed rows, their dispositions, exact request/source digests,
any real encrypted overlays and independently queued conflict-copy work. Persist and read-validate
the complete mapping before whole-profile publication; lost acknowledgements reuse the same rows
and identities. After publication, loss before receipt commit leaves the original held row available
for the same proof again. Receipt, lineage and existing Item-evidence changes commit in one guarded
Replica plan. Recovery export/import includes and validates the admission fields on existing typed
Operation/receipt/Item records; partial evidence identifies a damaged or missing dependency rather
than dropping a hold or converting it to executable work. Ordinary Account removal and explicit
Device Wipe remain the existing destructive lifecycle owners.

Required tests cover every source status and stopped-command cause; absent outcome with zero
mutation requests across reopen/unlock; retained Applied and Rejected results with exact original
bytes; fingerprint mismatch; lost lookup/proof/receipt replies; Session and Account replacement;
unchanged conflict-copy lineage with and without an independently queued copy; visible local
evidence without fabricated authority; new same-Item and unrelated work proceeding without hold
reactivation; and exact recovery round-trip/crash preservation. Use the real TypeScript serializer
and Server retained outcomes for compatibility acceptance. These shapes require independent review
before ticket91 becomes ready; they specify delivery work and do not claim implementation.

### First stopped-Create admission path

Implement failed/conflicted Create first when its complete compatible command is retained and no
cached Item or failed overlay exists for that Item. Retain the exact request, original source fields,
category and corresponding local hold under the existing Operation owner; create no optimistic row.
The original request's ciphertext remains recoverable without claiming a visible local projection.
Require absent overlay evidence for this path and reject an overlay owned by that held Operation.
The generated Operations projection reports `legacyFailed` or `legacyConflicted`, with no executable
deadline, rejection code or action. Other stopped kinds and captured failed-cache rows follow after
this end-to-end path passes.

Keep Operation and receipt identity uniqueness, while excluding held work from active Item ownership,
same-Item queue blocking and executable-work counts. A held and normal Operation may name the same
Item. Recovery still counts and preserves every physical accepted row. When held work completes,
guarded reconciliation removes only its own overlay, preserves a later active overlay, and retains
the original compact lineage; it must not treat local hold status as a Server result.

Both dispatch and Sync require a fresh successful original-ID outcome lookup before exact mutation
replay, including an initial retry count of zero. Missing outcome parks the hold without a persisted
change or polling deadline; external wakes may probe once per finite scan. Transient lookup/proof
failure uses existing persisted backoff, honored before either dispatch or Sync probes again. Auth
failure and lost/cancelled scope cannot fall through to an effect. A Sync event alone is not proof
and an unresolved hold cannot advance its terminal page cursor. No lookup permission survives a
restart and no second retry owner is introduced. For held work, require the exact replay's result to
equal that fresh lookup hint before completion; inconsistent proof fails the Account under the
existing typed failure path while retaining accepted evidence.

Prove public locked admission/reopen with no overlay or HTTP, local hold projection, missing-outcome
parking across owner restart, unrelated and new same-Item work proceeding, retained Applied/Rejected
exact replay, request identity mismatch, lost replies/backoff, Session/incarnation fencing, Sync's
equivalent proof gate, and full persistence/recovery of held and active work on the same Item.

### Captured failed-Create cache frontier

After the no-overlay held path and first cross-Account path pass, admit the actual failed Create
cache produced by `AccountVaultReplica.rejectItemCommand`. Require one strict map-only
`optimisticFailure { operationId, code }` matching a retained `failed` Create's semantic ID
(`operationId ?? id`). Its code belongs to the closed Create rejection-code set; it is captured
local evidence, never a newly observed Server rejection or permission to replay. Reject unknown,
duplicate, null or orphan flags and unsupported status/kind combinations before Preparing.

Validate the entire cached Item against that command's canonical Create projection: exact request
ciphertext/envelope, Item/Vault/category, version and encryption version one, original writer and
lastModifiedBy, command timestamp for both timestamps, favorite false, no deletion and no Attachments.
Require the actual JavaScript ISO timestamp spelling (UTC with three fractional digits), equal to
the command instant; map it to the existing Core canonical timestamp when constructing the overlay.
This preserves normal admitted Create's durable representation and its computed fingerprint. Do not
accept arbitrary offset/precision spellings merely because they parse to the same instant.
Retain existing Account and retained-key/Vault checks. After the writable-Vault tracer passes,
ordinary held Creates (with or without a captured row) also admit a retained ReadOnly Vault: the hold
preserves readable evidence without granting write authority. Normal Operations and workflows still
require writable Vaults. Missing, hidden or unretained Vaults remain refused, independently of the
captured failure code. Existing retirement erases the visible overlay while preserving held request
evidence; role downgrade alone does not erase readable evidence. Partition the validated row out of confirmed Bootstrap
authority and bind its existing Item-overlay owner to the held Operation. Add an omitted-when-absent,
closed `capturedFailureCode` to `LegacyOperationAdmission`; no second ciphertext owner or overlay
digest is needed because the canonical row is reconstructible from the immutable request and DTO.
Durable validation and streaming recovery use that canonical fingerprint. A held Create without
this evidence still forbids its own overlay; with it, overlay absence is valid after replacement or
retirement. The source code remains immutable evidence as live work evolves.

The legacy producer overwrites the cached Item without invalidating its Sync baseline; an
ID-conflicting Create can overwrite a genuine confirmed version-one Item (the cache refuses a
strictly newer version). Therefore every such partition forces
the existing Cold cursor and RefreshRequired state, even when all captured baseline markers agree.
Keep the original metadata and checkpoint values unchanged, and add an omitted-when-absent closed
refresh reason to the existing `LegacyAdmissionOrigin`. Initial installation and durable reread
derive the same Cold cursor from that reason. Do not claim the remaining captured rows are a complete
Server baseline or create another refresh owner.

The visible held overlay projects Failed under ordinary authority/read/hidden-Vault gates and stays
outside active ownership/counts. Validate all source rows first; when a separately retained active
command owns the same Item, retain its overlay deterministically regardless of queue order. Preserve
the held request and failure evidence. Multiple competing captured failed overlays are outside this
first path. New work and genuine held completion keep the existing guarded ownership rules: an
Applied result removes only the completing Operation's overlay; a genuine rejection may retain its
own evidence, and neither may change newer work. The existing fresh-lookup-only held proof gate is
unchanged, and local failure codes never appear as a proven public rejection.

Prove the actual TypeScript producer's complete row and unchanged baseline, then public SQLite
admission/source-free locked reopen, forced refresh with retained original markers, strict field
tampering/orphan refusal, held-plus-active precedence in both source orders and ambiguous install.
Runtime tests prove Failed projection, parked missing proof and genuine Applied/Rejected completion
with and without newer work. Streaming recovery covers both row orders, tampering, absent retired
overlays and exact retained failure evidence. Cover captured VaultReadOnly on an actual ReadOnly
Vault, continued normal-write refusal and proof/visibility after actual Vault retirement.
This reviewed frontier introduces no new product action.

### Remaining ordinary holds with an exact confirmed base

After captured failed Create passes, start with failed/conflicted Update and an exact retained
confirmed cached base; then widen the same path to Favorite, Trash, Restore, Permanent-delete and
same-Account Move. The legacy queue excludes these statuses from projection restoration, and its
failed-cache producer handles only Create. Preserve the immutable original request, full typed DTO,
accepted category and hold, without synthesizing an Item overlay or an overlay hash. Held request
validation requires the witness to be absent and refuses an overlay owned by that hold. Normal
admission keeps its existing overlay and witness checks. Recovery retains and counts the physical
held request while excluding it from active optimistic ownership.

Retain existing source base/category/Vault/Attachment and request-field checks. Update/Move payload
encryption version must equal checked base version plus one; the confirmed cached encryption version
is independent. Freeze the current `attemptId ?? id` wire identity, exact request bytes/precondition
and semantic lineage. Metadata rebase may have changed attempt ID and base version before the
capture; never reconstruct an older attempt from semantic ID. Preserve original scheduling, claim
and conflict-copy fields as nonauthorizing source facts. A conflict-copy ID does not synthesize or
require another command; an independently retained Create has its own identity and disposition.

Require retained visible Vaults and matching keys, allowing ReadOnly for these inactive holds;
Move requires both source and target. Keep normal write gates unchanged. This first path deliberately
requires cached version equal to the source command's base. Real conflict handling can fetch a newer
confirmed Item before marking a command conflicted; that stale-base capture remains refused with
source evidence intact until its separate mapping is specified. Do not hide that limitation by
rewinding confirmed authority, manufacturing a projection or discarding the stopped command.

Items continue to expose confirmed authority under existing read gates. Held Update/Move ciphertext
is recoverable from its immutable request and is not projected as a new local change. Only Operations
reports the local hold. New active same-Item work may retain its own overlay; a held completion cannot
change that overlay. Reuse the kind-generic fresh original-ID lookup, exact replay proof, backoff,
scope fencing and guarded receipt/lineage completion in both dispatch and Sync.

First prove public SQLite held Update admission and source-free reopen, confirmed plaintext instead
of held payload, missing-proof parking, genuine Applied/Rejected current-attempt proof and active
same-Item coexistence. Then use a typed matrix for the other five kinds, both statuses, independent
versions, retired claims, exact requests and scope/refusal cases. Cover durable reread, streaming
recovery in either row order and either-Vault Move retirement before marking this frontier complete.

### Stopped Update with newer confirmed cache

After exact-base held Update passes, admit a failed/conflicted Update whose retained live cached Item
has the same Item and source Vault and a version greater than the original base. The actual legacy
conflict handler fetches and reconciles current authority before stopping a sealed Update; it leaves
the original base, payload and attempt identity unchanged. Extend only this held-Update source
comparison to cached version greater than or equal to the original base. Keep lower, missing,
trashed or moved-Vault cache refused, and retain the exact-base rule for normal commands.

Keep the cached row verbatim and the original request's payload version equal to original base plus
one, independently of current cached encryption version or writer. Retain the exact wire attempt,
If-Match, body, fingerprint, scheduling history and conflict-copy evidence. Do not create an overlay,
witness, refresh reason or additional recovery owner. Update has no historical category field: use
the captured cache's category and existing completion fence without claiming independent proof of
the earlier category. All existing visible Vault, key, live Item and Attachment checks still apply.

An original-attempt lookup remains necessary even if cached ciphertext happens to match the request.
After genuine proof, existing reconciliation may compact an Applied version seven using fetched
version eight while retaining cached version nine; fetched version ten may advance authority.
Fetched authority below the retained Applied version still fails its existing fence. Missing or
inaccessible current authority follows existing retained-result reconciliation and refresh behavior.
Completion removes only the original hold's owned projection and preserves newer active work.

Prove the actual TypeScript conflict producer's ordering and unchanged base-six/payload-seven request
against cache version nine/encryption version four. Public SQLite acceptance covers both holds,
read-only scope, source-free locked reopen and independent conflict-copy work. Runtime tests cover
missing proof, exact original-attempt replay, both outcomes, both current-authority version cases and
newer active overlays; recovery retains immutable lineage and physical counts in either row order.
Refuse lower or missing cache, missing keys, hidden or changed Vault scope, trashed cache, normal
commands with newer cache, and payload versions incorrectly derived from current authority.

Use cache version nine/encryption version four for the actual conflict producer and its missing or
Rejected proof cases. For an uninterrupted history where the encrypted Update genuinely applied at
version seven, later confirmed encryption version must be at least seven; seal the later cached
and fetched plaintext with its actual authenticated version. Establish the original retained result
against source-era version six before supplying current version eight or ten. A test Server accepting
an old precondition against newer authority does not establish that historical sequence.

### Held admission after a first-attempt semantic rejection and independent source deletion

After Conflicted0 admission acceptance closes, extend the same version-one unavailable-source owner
with one additional first-attempt Failed history. Run the maintained real cross-Account executor,
queue and reconciler against an original target Create response whose actual typed Operation outcome
is rejected, such as `vault_read_only`. Preserve its original semantic Create request and outcome
identity; do not substitute an HTTP exception, hand-edited Failed DTO, fake semantic executor or
acknowledgement. The real executor throws SemanticOperationRejected; the queue stores Failed without
incrementing retryCount or reminting attemptId, and does not acknowledge or splice the Move. Verify
no source Trash/Delete or target Attachment mutation. Test-only observation of that rejection is not
persisted proof in the admitted source pages and must never become a Core result or receipt.

The first rejection response is an exact HTTP protocol fixture exercising the real executor and
queue, not a claim of a running Server or actual permission mutation. Reuse the established opaque
cipher producer harness: only the original held target payload survives, and this path claims no
historical payload decryption. The genuine WASM copy fixture remains unchanged; add no crypto adapter.
Reopen the real legacy repository and queue, apply independent original-source
permanent deletion through actual Sync, then complete the maintained full refresh before freezing
Ready Account/cache/Sync pages. Keep the exact held queue and original target request unchanged,
source authority absent and baseline evidence consistent. Do not rewrite cache records/checkpoints
or treat Delta-only Cold evidence as Ready. The first capture may retain a visible ReadOnly target
Vault consistent with the rejection; existing held scope rules apply.

The additional closed Failed branch requires retryCount zero, explicit operationId and attemptId
both equal to raw id and the entry semantic ID, present lastError (including an empty string), absent
nextAttemptAt, absent conflictCopyId and exact LegacyFailed admission disposition. Preserve valid
typed optional lineage and exact initial scheduling, giving count zero and no delay. Retain Failed5's
existing reminted-attempt branch, Pending/retrying and Conflicted0 rules unchanged. No new evidence
version, identity, ownership relation or schema field is introduced. All strict-map, valid Ready
capture, actual source absence, visible held scope, immutable request, original Active binding
revision zero and unconditional semantic/three-child-ID fences remain intact.

Classify the new history under existing inactive held ownership: independent same-Item work may
coexist under captured-held semantics, but any overlay claiming this workflow's own semantic ID is
forbidden. Preserve Recovery in both row orders and Account/Vault lifecycle behavior. Project
LegacyFailed resolution and LegacyHeld precedence over destination retirement, sourceVisible=false,
original attempt count zero and no deadline. No source witness, historical Attachment manifest,
remote rejection proof, ordinary Operation surrogate or original workflow execution is invented.
Scheduler, Attachment access, HTTP, lookup/replay, Prepare/Resume, reauthorization and completion
remain unavailable for this evidence. Identify unrelated Account refresh separately in public-driver
traces; it does not constitute original Move traffic.

Use a separate immutable artifact from the actual producer boundary. Domain/public behavioral RED
must first refuse the new history under the current Failed5-only predicate. Then prove exact DTO,
request, one inactive owner/count, all original IDs, no own overlay or fabricated authority, correct
zero-count held projection and nonmutating public refusal through configured source-free SQLite
reopen/unlock. Domain controls cover empty diagnostics, mixed attempt/count/disposition/deadline/copy
histories, Recovery both row orders and unchanged prior branches. Reuse established generic held
coexistence and lifecycle coverage without changing their policy. The admitted fields express history,
not its cause: do not invent an error-text classifier or require an unretained rejection outcome to
recognize the closed shape. Other attempt/count histories and additional producer predecessors remain
separate acceptance work; nothing here enables original proof or terminal reconciliation.


### Held admission after acquisition retries and a terminal semantic outcome

After Failed0 acceptance closes, extend the existing version-one unavailable-source history rules
for one coherent batch: Failed and Conflicted after one through four actual source-client acquisition
failures. Use the maintained queue to persist every retry, read each exact deadline and advance the
fixture clock accordingly. Preserve original queue/semantic IDs and the genuinely reminted attempt;
do not synthesize statuses, attempt IDs or retry history. This is one history frontier, not a new
schema or separate ticket for each count.

Exercise two real terminal producer branches after that precursor. The Failed branch runs the actual
cross-Account executor against the exact typed target-Create rejection protocol fixture, awaits the
real queue rejection handling and preserves its Failed command without incrementing the retry count
or reminting the last attempt. Label this as an HTTP protocol fixture, not a running Server permission
mutation. It must not acknowledge the Move or perform source Trash/Delete or target Attachment mutation.
The Conflicted branch uses actual executor source-version conflict, queue current-source reconciliation
and real repository conflict preservation, retaining the independently enqueued copy. Use genuine WASM
producer crypto and exact known Vault keys/AAD/ciphertext for copy readability. Let the copy encounter
its independently demonstrated transport failure before remote effect; preserve its own ordinary
retry history and never modify its dispatch policy to simplify capture.

Both branches reopen a fresh legacy repository/queue, apply independent original-source permanent
deletion through actual Sync and complete maintained full refresh before freezing Ready pages. Keep
all captured queue rows and indices, Account/Vault facts, immutable requests and baseline records
exact; no source/copy authority or cursor repair is allowed. A copy may only be absent from authority
when the real producer state establishes that fact. Freeze two representative immutable artifacts,
Failed after one acquisition failure and Conflicted after four, and exercise the count range one
through four through parameterized genuine
producer and Domain tests. Retain existing successful retry-acknowledgement controls: counts one
through four already belong to that supported normal branch and need no new representation.

The new Failed history requires Failed status, retryCount one through four, explicit operationId equal
to raw id and semantic entry ID, nonempty attemptId distinct from semantic, present exact diagnostic
including empty strings, absent nextAttemptAt, absent conflictCopyId and LegacyFailed disposition.
The new Conflicted history uses the same count/semantic/reminted-attempt/diagnostic/no-deadline rules,
with Conflicted status, LegacyConflicted disposition and nonempty conflictCopyId. That field remains
historical provenance, not a receipt, ownership link or requirement to reconstruct a missing copy;
add no source/target inequality. Preserve valid typed optional lineage and initialize scheduling from
the captured fields exactly. Existing Failed0, Failed5, Conflicted0, Pending and normal retrying
branches remain unchanged, as do strict map decoding and version one.

All common valid Ready capture, actual original-source absence, visible held scopes, immutable target
request, original Active binding revision zero and unconditional semantic/three-child-ID fences remain.
Both new histories use existing inactive held ownership, allow independent work under captured-held
coexistence policy and categorically cannot own an optimistic overlay. Recovery enforces those rules
in either row order; absence of an own-overlay fingerprint never becomes a wildcard. Preserve source
and destination lifecycle. Project the corresponding LegacyFailed/LegacyConflicted resolution,
LegacyHeld precedence over destination retirement, sourceVisible=false, captured retry count and no
projection deadline. Normal unavailable owners retain active source reservations.

No original workflow execution, Attachment access, HTTP, proof lookup/replay, Prepare/Resume,
reauthorization or completion becomes available. No source authority/preimage, manifest, outcome or
ordinary Operation surrogate is invented. The real independent copy remains an ordinary accepted
Create with its original payload, owner, overlay, deadline and dispatch behavior. Distinguish its
legitimate HTTP and independent Account refresh from prohibited original Move traffic.

Domain and public behavioral RED must precede implementation. Parameterized Domain controls cover
both terminal statuses and counts one through four, empty diagnostics, exact scheduling and lineage,
semantic versus attempt-derived child IDs, inactive ownership, own-overlay and identity refusals,
Recovery in both row orders and malformed/mixed histories. Keep earlier-history positive controls
and reject unsupported combinations rather than broadly accepting all terminal rows. Public acceptance
consumes the two genuine representative artifacts and proves exact requests/DTOs/indices, held
projection at the captured count, source-free configured SQLite reopen/unlock and nonmutating original
Prepare/Resume. For Conflicted, prove copy readability and original normal copy dispatch through its
own outcome lookup then exact immutable request boundary; preserve held workflow rows throughout.
Reuse established generic held lifecycle coverage without broadening that policy.

Retries caused by reconciliation-read failure can retain the original attempt ID; this is a different
producer predecessor and remains a separate frontier. HTTP400 terminal failure can preserve a prior
deadline; this batch does not admit that shape. Do not classify history by diagnostic wording or
claim that all retry mechanisms remint attempts. Staged/applying missing-source capture, further
source-cache/Attachment variants, Extension/platform acceptance and whole-phase checks remain open.


### Held admission after reconciliation-read retries without attempt replacement

After the post-acquisition terminal batch closes, preserve two additional producer-proven terminal
histories in the same version-one unavailable-source entry: Conflicted after one through four failed
reconciliation reads, and Failed after five such failures. Start with the real queued original Move,
then make independent current source authority newer than its captured base while keeping the target
absent. The actual semantic executor raises source-version ApiError412 before target Create. Fail
only the subsequent current-source GET performed by the queue's real reconciliation path. That catch
increments retryCount and schedules retry without reminting attemptId or changing the original base.
Do not substitute client-acquisition failure, which has different attempt semantics.

Advance the fixture clock to each exact persisted deadline and repeat the real executor412 and
reconciliation-read transport failure. For counts one through four, let the next reconciliation GET
succeed and run actual repository reconciliation/conflict preservation, producing Conflicted at the
same count and attempt. Preserve the genuine independently enqueued copy and its own ordinary retry
history after the maintained transport-failure boundary. Use genuine WASM producer crypto and the
existing known Vault keys, exact AAD and ciphertext for copy readability; do not rewrite captured
ciphertext. For the exhausted branch, fail the fifth reconciliation read: the real queue persists
Failed5 with no deadline and no copy, without executing target Create or acknowledging the Move.
An opaque producer harness is sufficient for that branch if no historical payload readability is
claimed. HTTP/Server fixtures must be labelled honestly; actual executor/queue transitions are required.

Reopen fresh legacy repository/queue, preserving held rows while skipping their projection restore.
Apply independent original-source permanent deletion through actual Sync, then complete maintained
full refresh before freezing consistent Ready Account/cache/Sync pages. Preserve all original and
copy queue indices, exact command history and immutable requests; do not repair cached authority or
checkpoint bytes. Freeze representative Conflicted1 and Failed5 artifacts for public acceptance;
parameterize actual producer and Domain coverage across Conflicted counts one through four and the
five-step exhaustion sequence. Keep normal/source-free acknowledgement and prior terminal artifacts
unchanged.

The new Conflicted branch requires Conflicted status, retryCount one through four, explicit
operationId and attemptId both equal to raw id and semantic entry ID, present lastError including an
empty string, absent nextAttemptAt, nonempty conflictCopyId and LegacyConflicted admission disposition.
The new exhausted Failed branch requires Failed status, retryCount five with those same equal IDs,
present diagnostic, absent deadline and conflictCopyId, and LegacyFailed disposition. The diagnostic
is immutable history, not a cause classifier; do not inspect its text to distinguish acquisition and
reconciliation failures or require an unretained HTTP error/receipt as validation evidence. Preserve
other currently valid typed optional lineage and exact initial scheduling. Existing distinct-attempt
terminal histories, Failed0, Conflicted0, Pending and normal retrying rules remain unchanged.

Historical conflictCopyId remains provenance only: no copy foreign key, reconstruction requirement or
new inequality rule. Actual independent copy rows undergo their normal request, scope and owner
validation. All shared strict-map, valid Ready capture, actual source absence, visible held scope,
original Active binding revision zero, exact target Create and semantic/three-child-ID fences remain.
Both new histories are inactive held owners and categorically cannot own an overlay; independent
work coexists under captured-held policy. Recovery enforces these rules in both row orders. Preserve
source/destination Account and Vault lifecycle and the stronger active reservation of normal parked
entries.

Project the matching LegacyFailed/LegacyConflicted resolution, LegacyHeld ahead of destination
retirement, sourceVisible=false, exact captured retry count and no projection deadline. No source
preimage, category/audit witness, Attachment manifest, original remote result or ordinary surrogate
is invented. Scheduler, Attachment access, HTTP, proof lookup/replay, Prepare/Resume, reauthorization
and completion remain unavailable for the original workflow. The real ordinary copy retains its own
normal scheduling and immutable dispatch; distinguish its traffic and independent Account refresh
from prohibited original Move traffic.

Require actual Domain and public behavioral RED before production changes. Tests prove the exact
same-attempt histories and count boundaries, immutable requests/scheduling, inactive ownership, all
original identities, own-overlay refusal and Recovery in both row orders. Include empty diagnostics,
missing/mixed IDs, unsupported counts, deadline/disposition/copy mismatches and prior-history positive
controls. Public acceptance consumes both representative artifacts through configured source-free
SQLite reopen/unlock, verifies held projections and nonmutating original Prepare/Resume, and for
Conflicted proves the independent copy remains readable and dispatches only its original normal
request through the established tracer. Reuse existing generic held lifecycle coverage.

Conflicted5 remains unsupported: the fifth failed reconciliation read produces Failed and is not
runnable. This does not admit normal same-attempt retrying source-free captures, Failed1..4 with
unchanged attempts, or retained-deadline HTTP400 failures. A successful acknowledgement after an
original target Create and source CAS race needs its own genuine monotonic remote-progress trace;
do not roll back current source authority or invent a target to claim that acceptance here. Broader
source-cache/Attachment, staged/platform and whole-phase acceptance work remains open.


### Held admission after a terminal HTTP400 retaining its prior retry deadline

The real legacy queue has a distinct terminal transition after a scheduled retry: on a typed
ApiError400 it writes Failed and the new diagnostic, but neither increments retryCount nor clears
the prior nextAttemptAt or replaces attemptId. Preserve this closed source history for counts one
through four, after either of two actual predecessors. Source-client acquisition failure schedules
each retry and remints a nonempty attempt distinct from the original semantic ID. A source-version
ApiError412 followed by a failed queue reconciliation read schedules each retry while retaining the
original attempt ID. At the exact persisted deadline, let the real cross-Account executor receive a
typed HTTP400 on target lookup, before target Create or source mutation. For the reconciliation-read
predecessor, keep current remote source version newer than the original base throughout; do not roll
it back to force the terminal error. Use the maintained queue and executor transitions rather than
editing a command into Failed. These are HTTP protocol fixtures, not evidence of a running Server.

Reopen fresh legacy repository/queue, apply independent original-source permanent deletion through
actual Delta Sync, and complete maintained full refresh to consistent Ready pages. Freeze genuine
representative source-free artifacts from the two predecessor families while preserving exact queue
indices, original command bytes, cache metadata and Sync checkpoints. The original target remains
absent; there is no remote result, acknowledgement or conflict copy. An opaque producer payload is
sufficient because this branch claims no historical ciphertext readability.

The additional version-one unavailable-source history requires Failed, retryCount one through four,
explicit operationId equal to raw id and semantic entry ID, a nonempty attemptId either equal to
that ID or distinct from it, a present safe-integer nextAttemptAt, present lastError including an
empty string, absent conflictCopyId and exact LegacyFailed disposition. Keep other valid typed
optional lineage and require initial scheduling to retain both the captured count and deadline
exactly. The attempt relation reflects the retained producer history; diagnostic text is immutable
evidence, not a cause classifier. Do not require an unretained HTTP receipt or infer remote effect.
All existing strict-map, Ready/source-absence, visible held scope, exact target Create, original
Active binding revision zero, and semantic/three-child-ID fences remain. Pending, normal retrying,
Failed0, Failed5 without deadline, Conflicted and prior terminal histories retain their existing
rules; count zero, count five, missing/mixed IDs, absent or malformed deadlines, disposition and
copy mismatches remain unsupported for this branch.

The admitted original is an inactive held owner and cannot own an overlay or schedule execution,
even when its source nextAttemptAt has passed. Preserve that source deadline in the immutable DTO
and stored initial scheduling; project LegacyFailed/LegacyHeld with sourceVisible=false, exact
captured attempt count and no live projection deadline. Independent same-Item work follows existing
captured-held coexistence policy. No source preimage, authority, Attachment manifest, proof,
ordinary Operation surrogate or original workflow HTTP is invented. Prepare/Resume,
reauthorization, completion and original dispatch remain unavailable. Recovery in both row orders,
source/destination lifecycle and destination-retirement precedence follow existing held behavior.

Actual producer tests cover both predecessor families at counts one through four and assert the
unchanged attempt/deadline, typed terminal error, no target Create or original acknowledgement,
fresh queue restore, genuine independent Sync deletion and full refresh. Domain and public
behavioral RED precede production changes. Domain controls cover empty diagnostics, exact history
and scheduling, inactive ownership, own-overlay and identity refusals, Recovery in both row orders,
prior-history positive controls and malformed/mixed boundaries. Public acceptance consumes both
frozen artifacts through configured source-free SQLite reopen/unlock, verifies immutable requests,
held projection and original Prepare/Resume refusal without triggering original HTTP. Broader
source-cache/Attachment, staged/platform and whole-phase acceptance remain open.

### Source-absent staged and applying projection cuts

These are two distinct version-one queue histories, not evidence that an original Move child ran.
`ItemCommands.move` constructs the real cross-Account command while the local source still exists.
The Extension worker queue can then persist it with `stage(command, claim)` before the popup applies
its projection: `status=staged`, original `id=operationId=attemptId`, `retryCount=0`, a nonempty
`projectionClaimId` and its exact `projectionClaimExpiresAt`, and no `lastError` or `nextAttemptAt`.
This is existing shared/Core queue evidence from the Extension worker path, not ticket106/74 source
wiring or migration acceptance. The Core/Desktop direct queue path instead persists
`status=applying` before awaiting the real optimistic projection callback, with the same original
IDs and zero retry count but no projection claim, error or retry deadline. A departed projection
claim is historical local ownership only; neither status establishes a target Create, source
Trash/Delete, retained result or authority for a new remote attempt.

The next producer experiment must drive each path through the maintained `ItemCommands` and
`ItemSyncEngine` APIs, without editing a queue row into either status. For staged, use the worker's
real stage/claim shape and stop before projection activation. For applying, commit the queue's
durable applying write and hold its asynchronous storage acknowledgment before `storage.update`
returns. Keep the production projection callback unchanged: it must call
`repository.applyItemCommand` after that acknowledgment is released. Do not insert a new await
inside or ahead of the projection callback to manufacture an interleaving. The real projection
records the pending command before its first await, after which Sync retains the source evidence.
Desktop's pending queue update serializes other updates, but independent Sync checkpoints use
`set` and full refresh uses ItemCache/AccountStore, so those owners can still progress at the
storage-acknowledgment cut. While each owner is stopped at its cut, apply independent source permanent deletion through Sync with outbound
drain disabled, then complete the maintained full refresh to consistent Ready source and destination
pages. Prove the source cache is empty, the original queue bytes and claim/attempt fields are
unchanged, and no original semantic executor or remote child was called; freeze the raw source
artifact **before** reopening its queue or releasing the acknowledgment. After capture, release
the applying write, verify the genuine projection runs once and the source cache remains absent,
and clean up all held work even when an assertion fails. This reachability and exact artifact
content remain to be observed; a modeled primitive acknowledgment is not physical Tauri crash
acceptance. `restore()` deliberately leaves staged rows staged but replays and normalizes applying
rows to pending (or Failed on projection error), so a post-restore applying artifact would not be a
genuine stopped-owner capture.

Require Domain and configured public SQLite behavioral RED from those two producer artifacts before
admitting either history. Add only explicit source-unavailable staged/applying branches matching the
observed original attempt, zero count, claim pair and absent deadline/error; preserve the exact
source command and fixed target Create request with no result or optimistic source overlay. Both
project `Blocked(MissingSourceEvidence)`, `sourceVisible=false`, captured attempt count and no live
next-attempt deadline, including after locked reopen and unlock. Keep original semantic and all
three child IDs reserved, with no original HTTP, proof lookup, Prepare/Resume or invented source,
target, Attachment or receipt. Exercise malformed claim/attempt/status combinations and the existing
positive Pending/Retrying/held controls, without reopening completed normal scheduling or
original-child progress families. This bounded frontier does not establish Extension source wiring,
Desktop platform acceptance or ticket91 completion.


## One exclusive, recoverable admission

Use a trusted startup capability, separate from renderer RuntimeRequest. Platform primitives expose
an opaque source snapshot handle and bounded reads of the known source families; they do not export
a general secret-key reader to UI callers. Core owns the closed source-format decoder, inventory,
validation, Account binding, request reconstruction and phase journal. Normal Core commands,
dispatch, Sync and native material export remain unstarted until admission commits.

1. Acquire the platform's exclusive profile-owner capability before reading mutable source values.
   Stop and drain the old renderer/worker queue, Sync, native key reader and cached storage writer.
   A marker or same-process mutex alone is not proof that another legacy process has stopped.
2. Capture the complete source inventory with a stable identity and content digest. Keep secrets in
   their existing protected tier or a protected destination staging record; no plaintext secret
   archive. Recheck source identity before committing. Capture local and session Extension areas
   before the old worker disappears when Session preservation is possible.
3. Core validates every Account and required record, allocates durable destination incarnations once,
   and stages credentials, Replica, operation lineage/requests and security settings privately.
   Existing Core profiles cannot be silently overwritten or merged by email. A prior committed
   journal is authoritative; an unfinished matching journal resumes its recorded staging.
4. Verify destination evidence and publish the Core DeviceCatalog/admission commit marker through
   a recoverable ordered protocol. Cross-store writes are not falsely described as one SQLite or
   IndexedDB transaction: the journal must distinguish prepared, committed and cleanup-pending
   phases and reconcile crashes between OS secret writes and Replica/catalog publication.
5. Only after committed admission may normal Core work and projections start. New-owner Accounts
   begin locked. Remove/archive obsolete source references through scoped idempotent cleanup whose
   completion is recorded; failure remains visible and retryable. Never use a global OS-keychain
   wipe or discard accepted encrypted evidence because cleanup failed.

Any corruption, unsupported required source, changed capture, missing durable proof or failed
protected-store write fails closed with a bounded admission error and retained source. Do not
publish a partial empty profile or require Full sign-in as a workaround. Tests may isolate Account
validation, but production admission cannot silently omit an Account with unsupported pending work.

Desktop's current [startup](../../../apps/desktop/src-tauri/src/lib.rs) has no single-instance plugin.
On Unix its native IPC server removes the old socket path before binding, so that socket is not an
existing exclusive profile lease. A new lock that old binaries do not honor cannot establish safe
coexistence. Startup cutover must ensure the old process has exited, avoid mounting the old owners in
the new process, and reject admission when exclusive ownership cannot be established. Extension
cutover must similarly drain the old broker/worker and popup command leases before accepting the
new offscreen owner. Broker reattachment after migration is not another profile import.

Before commit, abort preserves the original source and can remove only this admission's private
staging. After commit, restore/retry uses the recorded Core owner and its current accepted work.
Copying archived legacy files back after Core accepts new work is not a supported automatic rollback:
the old dispatcher cannot understand that work or the new journal. Keep recovery evidence rather
than dual-writing both formats. This is a technical safety boundary, not a promise that an arbitrary
old executable is prevented from running; actual exclusive startup enforcement needs platform proof.

## Concrete admission lifecycle contract

The coordinating and independent reviews accept the following catalog-owned design. It is the
decision-complete specification for delivery91; it is not implemented behavior.
Use the existing DeviceCatalog, generation documents, Replica persistence and recovery-capable startup.
Do not add a second journal service, credential vault, scheduler or host Account interpretation.

### Closed persisted record

Add optional `profile_admission` to `DeviceCatalogDocument`, omitted when absent so ordinary existing
catalog serialization remains unchanged. Its value is a closed, versioned `ProfileAdmissionRecord`:
an `Import` arm containing the admission fields below, or the minimal `Reset` arm specified under
Device Wipe. These are mutually exclusive states of the same catalog lifecycle, not separate owners.
Use Rust-defined camelCase persistence shapes with unknown-field rejection and existing ID, digest,
decimal revision and secret-bearing document conventions. Unknown admission versions fail closed
before normal catalog reconciliation; absence alone is not proof that legacy sources are absent.

The compact completed record uses `kind: "import"`, `version: 1`, opaque nonempty
`admissionId`, canonical unsigned decimal-string `revision`, `phase: "complete"`,
`source: { format, profileIdentity, recordedCaptureId }`, lowercase 64-hex `manifestDigest`,
and opaque nonempty `completionId`. Identity strings retain the source-control 4096-byte bound;
`recordedCaptureId` is capture lineage, never a live capability. Each object rejects unknown and
duplicate fields and positional arrays. An omitted `profileAdmission` preserves the existing
catalog shape; a present `null` is malformed evidence. Catalog Account reconciliation, install,
replacement and removal preserve the lifecycle independently of whether any Accounts remain.
A validated Complete marker bypasses new source Begin/census work after any retained cleanup duty
has drained. Until the Reset path below exists, Device Wipe with a configured Legacy source returns
incomplete before destructive cleanup; Core-only Wipe keeps its existing behavior.

Preparing and Committed retain a required, non-null `progress` object with the complete manifest,
source-ordered Account bindings, exact destination document/Replica digests, Account checkpoints,
original Device-document expectations, and source-cleanup obligations indexed into that immutable
manifest. Original absence determines ownership of matching private staging even when a write reply
was lost; it is never an acknowledgement-dependent flag. Staging cleanup is derived from those
fixed Account references and digests plus original Device-document absence, with no second target
list. Every catalog transition reads back the entire expected document, including after an error.
Before any resumed staging, all present planned documents and Replica heads must match; missing
proof beneath a Verified checkpoint remains fenced rather than silently restaged.

Optional common `legacyPresentation: { selectedAccountId, syncClientId }` survives completion.
Its nullable fields preserve captured presentation/source evidence without selecting an Account
that has subsequently been removed. Optional Account metadata `legacyDesktopEvidence` retains
Account-list and Session biometric mirrors plus old biometric/background timestamps as
nonauthorizing observations. As required by the [exact security mapping](#exact-account-and-security-mapping),
Quick Unlock preserves the original master-password-entry timestamp and optionality; only old
biometric grace and background activity receipts retire at handoff.

The record contains:

- `version`, one random `admission_id`, a monotonic `revision`, and a closed `phase` described below.
  An interrupted attempt retains its ID and assigned Account incarnations. Revision guards admission
  progress only; existing Replica revisions still guard Account writes.
- `source`: `DesktopLegacyV1` or `ExtensionLegacyV1`, an opaque stable profile identity, capture ID,
  and a `SourceManifest`. These are compatibility-reader versions, not invented versions on old
  AccountStore values. The manifest records every required source family's presence, schema identity,
  exact content digest and length/count; scalar and credential references also retain their exact
  selector and presence. It contains no credential values, Session token, key or plaintext archive.
- `accounts`: the complete ordered source Account list, each canonical Server/User binding, its
  fixed destination incarnation, expected prior destination state, credential disposition and
  destination verification checkpoint. Preserve valid selected Account as a separate optional ID;
  selection is presentation state and never authorization. Retain nonprojected legacy metadata in
  the existing Account metadata/admission evidence rather than adding a host AccountStore.
- `device`: expected original Core DeviceKey presence/identity, the source DeviceKey reference and
  whether this attempt created its destination reference. Preserve the exact source key. An existing
  different Core key or unrelated Core installation blocks admission; do not replace it or merge by
  email. This record stores references/digests, never the key itself.
- `cleanup`: closed, exact source/staging obligations and their remaining/completed disposition.
  Each obligation fixes its source family or destination Account/incarnation/reference plus expected
  identity/content evidence. Completion receipts remain sufficient to distinguish already-deleted
  state from unreadable or changed state after a lost reply. No arbitrary path or deletion prefix is
  accepted from a renderer.

Reuse `PendingAccountInstallIntent` for the destination Account/incarnation reservation. All admitted
Accounts are reserved with their fixed identities in the same initial catalog write as this record;
an admission record does not maintain another independently authoritative active-generation list.
Its Account checkpoints verify the pending bindings and durable rows. For an ordinary unadmitted
legacy profile the expected destination Account is absent. Existing unmatched Core state, pending
retirement/installation or unexplained destination rows block preparation. A matching unfinished
admission is resumed through its recorded expectations, never treated as an unrelated fresh install.

An Account checkpoint is `Unwritten` or `Verified`, with the verified generation, Replica revision,
complete imported row digest/counts, required credential document identities, security settings and
source queue-disposition digest. Until whole-profile commit these writes are private. A lost write
reply is reconciled by reading and validating actual destination evidence, not by assuming failure or
reallocating identities. A checkpoint alone cannot override a later mismatching durable read.

Every queue entry uses the [closed typed admission mapping](#admission-only-holds-for-stopped-legacy-commands):
an ordinary Operation with its original semantic/Server attempt identities and `Normal`,
`LegacyFailed` or `LegacyConflicted` disposition, or the corresponding ticket90 source-owned workflow.
Only a proven Server result can become a receipt; local retry exhaustion, conflict or an error string
cannot fabricate terminal Server truth. There is no opaque blocked-record fallback. Preserve source
ordering and staged/applying claim retirement. Unknown required evidence that cannot be represented blocks the entire
admission. The complete Account mapping precedes workflow construction; original destination absence
or replacement produces ticket90's retired binding requiring explicit Resume, never a new destination
identity or an independently dispatched child Operation. Every accepted artifact and immutable child
request must have its corresponding existing durable owner before the Account checkpoint is verified.

### Complete destination inventory before staging

The admission frontier review found that an absent DeviceCatalog does not establish an empty Core
destination. Ordinary Replica reads require a known Account and cannot discover unknown Accounts
and their headless rows; artifact reads follow reachable metadata; platform storage has no
enumeration operation. Recovery's physical
inventory requires its separate maintenance state after normal-owner retirement, so admission cannot
borrow that state while retaining its startup owner. The accepted primitive extension is bounded
physical-key inventory through each existing store owner, with Core interpreting all ownership.
It applies to an applicable profile-admission attempt or recorded unfinished admission. Ordinary
CoreOnly startup retains its existing path and does not require these admission inventory ports.

| Existing owner | Complete physical inventory |
| --- | --- |
| Replica | Heads and every row independently, including headless rows and unknown stored discriminators. Web also enumerates every `recovery_input` composite key: Account, recovery ID, kind, store, record ID and chunk index. Ordinary/recovery record readers alone omit that object store. |
| PlatformStorage | `ListKeys { area, prefix, cursor }` enumerates every key in the exact Core namespace, including staging and orphaned Account references. It returns keys without values and reports the addressable-area equivalence described below. |
| Attachment artifacts | Every mapping, generation metadata/chunk and provisional metadata/chunk, including noncurrent, unsealed and orphaned entries. `RecoverUnavailable` is not proof of absence: a valid unsealed provisional generation also returns that result. |
| Vault images | Every legacy/protected metadata and publication-chunk key, including legacy empty publication identities, protected generations and chunks without metadata. |

Return closed table-specific physical key tuples, fixed family/schema identity, bounded entry counts
and control bytes, opaque continuation and explicit end. Core checks page progress and complete
family coverage. The primitive returns no ciphertext, arbitrary SQL or whole-database archive.
Enumerate raw tables/object stores rather than Account indexes or joins through reachable owners.
Malformed physical key types, unsupported schema or inaccessible storage fail the census instead of
being omitted. SQLite inventory reuses the strict closed-schema validator, including extra tables and
triggers; ordinary versioned Replica open does not currently establish that complete schema proof.

The PlatformStorage result also carries `backing_areas`: an ordered unique list containing the
requested area and naming all logical areas addressing the same key namespace. This is a primitive
topology fact, not credential classification. Web currently aliases DevicePlain and DeviceSecret;
native and separate-area fixtures use singleton groups. Sharing a database alone does not imply
shared keys. Across every page and area scan, the declarations must form a stable equivalence
partition within one live inventory pass. Core derives its planned logical selectors through the
existing value-to-area/key mapping,
unions them within each declared group and compares that group's physical keys once. A misplaced
native DevicePlain copy remains unexplained even when the correct DeviceSecret copy exists. Reads
and writes still use the prescribed logical area. No paths, service names, changed secret placement
or new backing registry are needed; Extension must declare its actual adapter mapping when added.

The concrete PlatformStorage wire extension is `ListKeys { area, prefix, cursor }`, with an explicit
nullable cursor, and `KeysPage { version: 1, family: PlatformStorage, backing_areas, keys,
continuation }`. Continuation is the closed `More { cursor } | End` union. Each page contains at most
128 keys and 262144 serialized JSON bytes, including its cursor. A key is valid Unicode, at most
4096 UTF-8 bytes, and begins with the exact requested prefix. Keys strictly advance in UTF-8 byte
order within and across pages. Web must reject lone surrogates before encoding and use that order,
not JavaScript's default UTF-16 or locale sort. A null `Storage.key(index)` inside the enumerated
range is a census failure, not an omitted key. `More` is nonempty; its bounded cursor binds the live
adapter instance, requested area, exact prefix and last included key. Oversized or unsupported keys
fail rather than disappearing. `backing_areas` follows DevicePlain, DeviceSecret, SessionSecret order,
with the membership and equivalence checks above. Custom serde visitors retain variant-specific
unknown/duplicate-field rejection, including nested continuation fields; buffering controls through
a generic JSON object must not collapse duplicate evidence before typed validation.

Native enumeration reads the existing protected keychain entry freshly through its current owner,
with strict duplicate-key, value-type and Unicode checks and temporary zeroizing secret buffers.
The cached map is not a fresh census. The existing single-blob format requires an internal whole-blob
read; returned key/control pages remain bounded without imposing a new whole-profile size quota or
adding another credential map. Native platform database opening must also establish an empty or
supported closed schema before creating tables or stamps, so inventory cannot discover foreign
state only after an earlier constructor has already mutated it.

Native pages stay under the existing storage mutex. The adapter owns one instance nonce and a
closed cursor containing the version, nonce, requested area, exact prefix and last included key;
it keeps no cursor registry. Core exposes only its shared page limits and contextual validation to
trusted Rust adapters. SQLite streams raw keys in byte order and validates physical types before
filtering; unordered session/protected maps retain only the next page and one lookahead key.
The adapter measures the complete serialized response, including continuation, and reports end only
after proving exhaustion. This adds enumeration to the existing owners, without another storage
service or lifecycle.

Under a freshly acquired exclusive startup capability and the existing catalog guard, finish this
census before writing the initial `Preparing` record. Reject unexplained destination entries; verify
the exact permitted existing global documents, including any matching DeviceKey, through strict
reads. Before every resumed `Preparing` pass, perform a new complete census and derive the allowed
physical tuples from the recorded admission and unchanged source. Already-written planned entries
can reconcile lost replies only when existing document reads, Replica reads and artifact hashes
match their recorded content and identities. Extra Accounts, keys, generations, headless rows,
orphaned chunks or same-key content mismatches block before cleanup or further staging. A verified
checkpoint cannot override current physical evidence, and old cursors cannot survive owner loss.
Every retry obtains a fresh complete partition and validates the planned logical selectors and
current content against it; neither the previous partition nor its cursors are persisted or reused.
The census is temporary evidence under the existing lifecycle, not another persisted registry.

The first admission refusal test crosses the existing Runtime/open and primitive-store seams:
an applicable admission with catalog absence and an unexplained physical row must not publish an
empty Ready result, initialize
a DeviceKey or delete evidence. Adapter conformance then covers every physical table, page progress,
unsupported schema/key types, Web `recovery_input`, area aliases and native wrong-area copies.
Preparing restart histories distinguish exact planned writes from extra or mismatching physical
state after actual owner loss. These checks extend the already accepted destination-collision and
crash matrix; they do not authorize profile merging or add a recovery owner.

### Capture and generated primitive envelope

The trusted startup composition supplies one exclusive source capability under research82's supported
launch/process boundary. A capability is live, owner-bound and nontransferable to renderer commands.
Every process restart reacquires exclusivity; a durable capture ID or journal is not a surviving lease.
The host exposes facts and bounded opaque bytes; Core defines selectors, decodes schemas and decides
whether captured evidence is sufficient. Generate the controls from Rust under ADR0012, separately
from public `RuntimeRequest` and ordinary general-purpose storage access.

The closed source families are `DesktopStore`, `DesktopSyncStore`, `DesktopCredentials`,
`ExtensionLocal`, `ExtensionSession` and `ExtensionRecords`. Core rejects a family inconsistent with
the selected source format. Source selectors are whole file/record-store inventory or exact typed
legacy global/Account-field references; they cannot name arbitrary filesystem paths, OS services or
browser databases. The platform resolves the fixed locations from its existing profile composition.
Record enumeration preserves opaque keys/values; it must not call permissive legacy loaders that
silently drop malformed work.

The generated request/response variants are:

| Primitive | Required control and result |
| --- | --- |
| `BeginSourceSnapshot` | Source format and live exclusive capability. Establishes/reuses the separately specified session-instance marker before first inventory, then returns a live snapshot handle, stable profile identity, capture ID, source-family inventory and optional Extension session-instance identity. One capability has at most one creating/live snapshot; retry joins or returns that same snapshot until it is closed. A subsequent new snapshot gets a fresh capture ID. It creates no imported destination data. |
| `ReadSourcePage` | Snapshot handle, closed family, typed selector and opaque continuation. Returns bounded bytes/record keys with the closed raw-value observations below, explicit end-of-family and next continuation. Absence, malformed present values and executor failure remain distinct. |
| `ReopenSourceSnapshot` | New live exclusive capability and recorded source manifest. Returns a fresh handle only for the same profile and matching retained source, with separately reported completed cleanup and session-lifetime changes. It never makes an old process-local handle valid again. |
| `VerifySourceSnapshot` | Live handle and manifest. Rechecks exact required source identity/content and returns `Unchanged`, `Changed` or `Unavailable`, plus the separately defined session-area observation. Core decides the resulting journal transition. |
| `DeleteCapturedSource` | Live handle, admission ID and one exact cleanup obligation authorized by committed Core state. Returns `Deleted`, `AlreadyAbsent`, `Changed` or `Unavailable`. An unreadable value cannot become `AlreadyAbsent`. |
| `CloseSourceSnapshot` | Closed selector `Exact { handle }` or `CurrentCapability`. The latter is trusted startup cleanup of the capability's one creating/live snapshot, including an issued Begin whose reply Core never received. Both fence/drain already-issued creation/page work and release only temporary readers/copies before acknowledgement. Neither commits admission nor changes legacy source or the new-owner lease. |

#### Snapshot lifetime across interrupted calls

The first implementation review closed an additional primitive-lifetime detail. Dropping an
`open()` future releases its catalog guard; it does not prove that an invoked native operation or
JavaScript Promise stopped. The source executor therefore retains the exclusive capability and its
one snapshot slot independently of request-future lifetime. Concurrent/repeated Begin joins the
same creating/live result, preserving handle and capture ID. Reopen uses that same single slot and
completion rule. The executor cannot accumulate captures, start a
successor while cleanup is pending, or resurrect a reader after a Close fence. Closing also drains
session-marker initialization belonging to the issued Begin, plus all issued snapshot operations,
including Reopen, page reads, verification and captured-source cleanup. Exact stale handles cannot close a
successor snapshot, and repeated Close after a lost acknowledgement is idempotent.

Before invoking Begin, the existing in-memory admission startup owner records a `CurrentCapability`
cleanup duty. After validating a successful response it may narrow that duty to the exact handle.
Malformed, oversized, unavailable or dropped responses leave the duty intact. Only a valid
`SourceSnapshotClosed` acknowledgement clears it. Retry reconciles that existing cleanup before
another Begin; an admission error cannot silently discard a failed Close or its duty.

Runtime shutdown uses its existing catalog serialization and the established
[recovery shutdown pattern](../../../packages/client-runtime/crates/bittery-client-core/src/runtime/recovery.rs):
retain the port and duty, retry idempotent cleanup with the existing capped DeviceTimer backoff, and
confirm release before `close_state_cleaned`/`close_complete`. No new scheduler, durable journal,
source-data deletion or public close result is introduced. Actual process/realm loss invalidates all
old handles; a new owner reacquires exclusion and obtains a fresh live handle instead of using the
old in-memory duty as a surviving lease. With recorded admission evidence it uses Reopen and observes
the old Session marker before any initialization, as specified below. Snapshot Close neither deletes
nor remints that marker; a completed marker write whose initial Begin reply was lost is reused.

The maintained public Runtime/source-port tests first lose Close after an ordinary refusal and
retry through open/close without another capture. Then lose Begin's reply after actual reader
creation, cancel an issued Begin/page future, and hold creation behind shutdown. Each history must
retain unchanged source/destination evidence, publish no Ready result, permit only one snapshot,
and prove reader release before close completes. Native and Web primitives must exercise their
actual blocking/Promise lifetimes; an in-memory counter alone does not establish platform release.

#### Bounded source pages and observations

The first Desktop implementation uses the existing source executor's single invocation with a
`(Zeroizing<String>, Option<Zeroizing<Vec<u8>>>)` result: closed control JSON and a separately owned
binary payload, following the existing recovery transport. Each has an independent 262144-byte
bound. Begin and Close accept no response binary. There is no unused binary request parameter,
Base64 payload or numeric-array JSON. Dropping delivery retains the same snapshot cleanup duty.

`ReadSourcePage` carries the snapshot handle, family, typed selector and explicit nullable cursor.
The initial selectors are `WholeFile {}` for DesktopStore/DesktopSyncStore,
`GlobalCredential { field: DeviceKey }`, and
`AccountCredential { account_id, field: SecretKey | SessionData | JwtToken | VaultKeys | EncryptedPrivateKey }`
for DesktopCredentials. Core derives the exact credential plan from the original Account list.
Account IDs remain opaque nonempty strings within the 4096-byte control bound; legacy IDs also have
an `acct_…` fallback, so UUID-only validation, normalization or reminting would lose supported IDs.
The adapter resolves only those fixed legacy references, never a caller-supplied path or OS service.

`SourcePage` echoes the exact handle, family and selector, and reports observation, offset,
byte_length and closed `More { cursor } | End {}` continuation. Offsets and lengths are Rust `u64`
using the existing canonical decimal-string wire helper. Observation is `Missing {}`,
`FileBytes { length }`, `StoredString { encoding: Utf8 | Utf16Le, length }`, or
`PresentUnsupported { value_kind }`. Native credential strings may use UTF-8 without rebuilding
their stored contents; browser strings require lossless UTF-16LE. Missing and unsupported values
carry no binary, zero offset/length and End. A present empty file/string carries an explicit empty
binary buffer. Core verifies exact payload length, contiguous offsets, stable observation/total,
overflow, forward progress and End exactly at the reported total. Ending a scalar selector does not
end the credential family until the complete Core-derived reference plan has ended.

Cursors bind the same snapshot slot, handle, family, selector and byte offset. Repeating a request
replays its page instead of advancing a hidden mutable reader position. Exact protected-map
extraction rejects duplicate keys and malformed containers; an existing null, number or object is
an unsupported observation, never absence. Whole-file bytes retain duplicate/unknown keys and outer
value types for Core's decoder. These choices preserve the complete Begin family inventory and the
existing source owner; later Extension selectors extend this generated vocabulary separately.

Use the existing bounded binary transport conventions for pages, with a maximum payload of 262144
bytes per response and decimal offsets/counts. A large source is streamed across pages, not rejected
merely for exceeding one response. Preserve exact original bytes across chunk boundaries. Secret
pages use the existing zeroizing transport/document ownership and never enter logs or ordinary UI
projections. JavaScript immutable/managed-copy limitations remain explicit. Core computes content
digests from consumed bytes, validates family completion and fixes its canonical manifest ordering;
an executor-supplied digest alone is not validation of a parsed profile.

Scalar observations distinguish `Missing`, `StoredString { encoding, length }` and
`PresentUnsupported { value_kind }`; a file is separately `FileBytes`. `value_kind` is the closed
primitive set Null, Boolean, Number, Array, Object or OtherUnsupported. Existing Chrome `readOne`
collapses non-string values to absence and is therefore unsuitable. Do not JSON-stringify a stored
object into a string that the compatibility decoder could mistake for a legitimate stored JSON
string. Browser stored strings use lossless UTF-16 code-unit bytes, tagged `Utf16Le`; physical files
remain their original bytes. Core validates decoding and fails closed on unsupported malformed values,
leaving the source intact. Digests include presence/type/encoding tags and lengths, not only payload.
IndexedDB inventory likewise preserves observed key type, row shape, unknown-field presence and each
key/collection/id/value field's type; a valid record object is distinct from a stored string or
malformed record object.
The host reports structural primitive facts, never Account policy or a permissively decoded record.

Desktop capture happens after old-process exit and before any old keychain cache is populated in the
new process. Use a fresh protected-store read. The source and destination share the physical
`bittery_vault` entry, so revalidation covers the exact legacy reference set and values; destination
staging writes must not invalidate capture by changing a whole-blob digest. Preserve unrelated map
entries during writes/deletes. Apply the same exact legacy-reference-set rule to ExtensionLocal and
ExtensionSession: exclude destination Core namespace writes and the lifecycle marker, retain missing
versus present observations, and detect changes to the captured legacy references. Never hash the
whole shared Chrome area as if admission's own staging were an external source change. For files and the legacy record database, retain their exact captured
identity and complete bytes/records until commit; no plaintext protected-secret file is introduced.

Whole-file/database cleanup is allowed only where the complete captured family is known to be owned
and its preserved evidence has a destination. Otherwise retain it with an explicit incomplete cleanup
obligation. Credential/browser scalar cleanup deletes only the captured exact references with matching
values. A changed reference is preserved. Multi-reference cleanup needs per-reference completion,
and lost replies are reconciled against each expected value/absence; do not erase the obligation
before the corresponding physical deletion can be established. Primitive adapters must serialize
verification and deletion against their supported writers under the retained profile capability;
a naked read/check/write sequence is not a claim of atomic exclusion against external writers.

#### Bounded manifest verification and Desktop reopen

The 2026-09-21 coordinating and independent implementation review fixes the bounded transport detail
for the existing manifest, Verify and Reopen primitives. A complete profile manifest is not bounded
by one source-control response. Sending the entire manifest in one request would impose an unintended
whole-profile quota. Retain the full nonsecret manifest under the existing DeviceCatalog admission
record; transmit verification as one compact header and a sequence of individually bounded entries.
This is a phase of the existing source snapshot slot, not another persistent journal or source owner.

The concrete shared Rust shapes are:

- `SourceManifestHeader`: version 1, source format, stable profile identity, `recordedCaptureId`,
  canonical decimal `entryCount` and lowercase 64-character `entriesSha256`. The capture ID retains
  lineage only; it is neither a lease nor part of the content equality that survives owner loss.
- `SourceManifestEntry`: closed family and the existing exact typed selector, its original tagged
  observation, optional stable file identity as an opaque nonempty UTF-8 string bounded to 4096 bytes
  (never an arbitrary JSON map), and lowercase 64-character `evidenceSha256`. Present
  Desktop files require a file identity; missing files and credential selectors forbid one. A valid
  preparing manifest contains only representable supported observations; `PresentUnsupported` still
  blocks preparation and cannot authorize deletion from a type-only digest.
- Initial Desktop order: DesktopStore/WholeFile, DesktopSyncStore/WholeFile, global DeviceKey,
  then Account IDs in UTF-8 byte order, each with SecretKey, SessionData, JwtToken, VaultKeys and
  EncryptedPrivateKey in that fixed order. Include Missing selectors. Core derives this complete
  plan from its validated Account list and checks exact coverage before starting verification;
  the primitive does not parse Account policy. Later source variants extend this closed ordering
  through a supported schema version rather than inserting arbitrary paths or selectors.

Use one versioned, domain-separated SHA-256 framing defined and tested in shared Core. For an entry,
hash UTF-8 `bittery.profile-admission.entry.v1` followed by a zero byte, the canonical identity JSON
byte length as an eight-byte unsigned big-endian integer, that JSON, the raw payload byte length in
the same integer form, and exact raw payload bytes. The identity JSON is a Rust-defined struct in
fixed field order `version`, `format`, `family`, `selector`, `observation`, `fileIdentity`; absent
file identity is explicit null. Serialize it with compact serde_json UTF-8, existing closed enum
shapes and decimal-string wire integers, without Unicode normalization. Thus evidence commits the
exact selector, observation tag/encoding/original total length and file identity as well as bytes.
Missing commits its distinct tag and zero payload length.

For the manifest, hash UTF-8 `bittery.profile-admission.manifest.v1` followed by a zero byte, then the
length and compact identity JSON with fixed fields `version`, `format`, `profileIdentity`, `entryCount`,
using that same length framing. Append each zero-based ordinal as eight unsigned big-endian bytes
and its decoded 32-byte evidence digest, in canonical order. Exclude transient handles, continuation
cursors and capture IDs. Never hash payload alone, join strings with an ambiguous delimiter or use
map iteration order. The normal generated contracts define controls; shared digest vectors prevent
host implementations from inventing another framing.

Keep the existing logical `ReopenSourceSnapshot` and `VerifySourceSnapshot` operations, expressed as
closed Start/Entry/Finish request steps. Reopen Start takes the header under the new live exclusive
capability and no old handle. Verify Start takes that header and the exact current live snapshot handle.
Both Start modes also carry a nonempty `verificationAttemptId` within the existing 4096-byte source
identity bound. Core generates it afresh for each intentional verification pass and retains it
through retries of that pass; it is transient call/receipt correlation, not a new durable owner.
The two modes cannot be interchanged. Start joins or creates verification inside the capability's
single snapshot slot and returns only an opaque verification cursor and next index. A provisional
Reopen slot is not authorized for ReadSourcePage or source cleanup. No fresh usable snapshot handle
is returned until successful Finish. A live Verify retains the same snapshot owner while its phase
serializes verification against other issued source work.

Entry takes the current cursor, canonical decimal index and one expected entry. The cursor binds
mode, verification attempt ID, live capability/slot nonce, profile, complete header identity and next
index. Each invocation
checks the expected selector against current fixed physical locations or protected references under
retained exclusion, compares complete observed identity/content, and advances one rolling digest and
count only on a match. Return a closed matched/changed/unavailable result; Changed and Unavailable
never advance verification or authorize publication. A current-source check must not merely rehash
the old retained file descriptor or captured credential copy: that would miss path replacement or a
changed protected reference. Every entry and response stays within the existing 262144-byte control
bound; source payloads remain streamed through the existing binary-page bounds.

Start with the same attempt ID replays the same provisional result after a lost response. A fresh
intentional Verify pass on the same live handle/header uses a fresh attempt ID, and may start only
after the prior pass finished and its issued work drained. It must perform fresh physical reads;
the previous pass's successful receipt cannot satisfy it. A different attempt cannot replace an
active Checking phase. Reopen retains single-slot semantics: a duplicate attempt replays its existing
provisional/final result, while a new Reopen requires closing the prior provisional/live slot first.
Late cursors from a finished pass cannot operate on a subsequent pass. Entry retains only the immediately
previous exact request/receipt for replay after a lost response; changed evidence at that index,
skipped indices, foreign cursors and out-of-order requests fail. Finish is also replayable. Finish
requires exact entry count, canonical order/coverage, complete content reads and matching rolling
digest before resolving verification. Successful Reopen Finish returns a freshly validated full
SourceSnapshot with its new live handle and fresh capture identity; the catalog retains the original
recorded source lineage. Successful Verify Finish reports Unchanged for its original live handle.
Failure leaves the slot cleanup-owned and cannot convert a provisional Reopen into a live reader.
No unbounded receipt registry or second source capability is introduced.

Core records CurrentCapability cleanup before issuing Reopen Start, as it already does for Begin,
and narrows it only after validating the complete successful snapshot response. Close fences and
drains Start/Entry/Finish work, including detached native blocking work and lost responses. A changed
header cannot replace a creating/checking/live slot; close the existing slot first. Process loss
invalidates every verification cursor and receipt; restart reacquires exclusion and verifies from the
recorded manifest again. Committed cleanup and Extension Session-loss exceptions still require their
separate recorded dispositions described below; an ordinary missing entry is not such an exception.

Present Desktop file identity must survive native owner loss and identify the filesystem object at
its fixed profile location. Extend Begin's file-family inventory and retained SourceFile with an
opaque stable filesystem identity, not a descriptor number or process nonce. Compare presence,
identity and full bytes on reopen/verify, including genuine end of file. Linux fixtures use device
and inode identity; other supported platforms require their corresponding stable file-object facts
and actual replacement/restart acceptance before enabling their source path. Profile identity is
likewise reacquired and compared, never inferred from a previously held path string.

Credential-family presence describes the shared physical map, not the exact legacy reference set.
Its original Missing-to-Present change may be admission's own destination writes. Across reopen,
compare every recorded legacy selector's tagged observation/digest; do not require original container
presence or a whole-map digest to remain equal. Core must also complete a fresh destination census
that explains all planned/staged Core keys and their contents. Within any one fresh snapshot, a
returned stored legacy string still contradicts that snapshot's Missing credential-family report.
Unrelated protected entries remain untouched and cannot be claimed as imported Account evidence.

Current catalog Get/Set uses the existing document transport and backend failure semantics without
an application-level 262144-byte quota. That bound applies to ListKeys inventory and source controls,
not ordinary catalog values. Native SQLite limits and browser storage quota failures remain explicit
storage failures; they do not permit truncating the manifest, publishing partial Accounts, or moving
it to a second journal. Required tests include manifests whose serialized size exceeds one control,
lost Start/Entry/Finish replies, count/digest/order mismatch, cleanup during detached verification,
file replacement with identical bytes, fresh-owner reopen and shared-map creation by own staging.

### Credential staging and Extension Session loss

Validate and stage QuickUnlock independently from optional complete CurrentSession. Reuse the existing
document validators and platform lifetime mapping, rather than the authenticated install helper's
requirement that both documents exist together. Stage metadata, preserved DeviceKey, QuickUnlock,
complete retained Session and local-security values before verifying the Account. All destination
references and expected pre-existing values are recorded before writing them. A failed/ambiguous
write remains recoverable; it cannot publish an Account as SignedOut to hide lost QuickUnlock data.

Session disposition is `AbsentAtCapture`, `Complete { source_session_instance }`,
`IncompleteRetained { source_session_instance }`, or
`LostWithSessionArea { previous_session_instance }`. The instance is absent for the Desktop source;
its protected Session is not subject to the Extension loss exception. Incomplete material
stays in its original protected tier with an explicit nonauthorizing disposition; it cannot become
a fabricated complete Session. Desktop's complete retained Session uses existing DeviceSecret
mapping. Extension uses existing SessionSecret exclusively, including any temporary staging.

The bounded Desktop implementation preserves a non-complete Session as one typed
`LegacySessionEvidenceDocument` value inside the existing PlatformStorage Account/incarnation
namespace. Its physical lifetime mapping is identical to CurrentSession. It is never returned by
`load_current_session`, and no authentication, refresh, biometric release, dispatch or bootstrap
path may use it as credentials. CurrentSession retains its existing complete-credential validator.
The evidence document is strict version 1 and binds Account, incarnation and the immutable source
manifest digest. It retains source SessionData creation time and required-nullable original
`expiresAt`, `serverExpiresAt`, `sessionId` and source-session-instance fields, plus required-nullable
token, validated Vault-key array and encrypted-private-key fields. Credential material follows the
existing zeroizing protected-document conventions. Original expiry optionality and relative values
remain evidence; recording admission supplies no new expiry or password-entry receipt.

Zero present credential fields maps to AbsentAtCapture with metadata-only evidence. One or two
present fields maps to IncompleteRetained. In either case the CurrentSession expectation is absent
and the exact evidence-document digest is present. Three present credential fields must use complete
CurrentSession and have no evidence document; the evidence document rejects that combination.
Preparing fixes the additional reference/digest before writing it, complete destination census and
readback verify it, and Abort removes only matching owned evidence. Source cleanup may remove the
old references only after their destination evidence is durable. Ordinary Account/incarnation
removal and Device Wipe already own its namespace deletion. Explicit SignOut also deletes this
protected evidence with QuickUnlock and CurrentSession; postcommit expectations are historical,
as they already are for ordinary credential replacement/removal. RefusedSession alone does not
delete this nonauthorizing evidence. A later complete Session never promotes
or fills this evidence into authority.

This refinement was independently reviewed against the existing protected-storage owner and
Session lifetime policy. When Extension admission is implemented, a genuinely lost session-area
instance may also lose metadata-only evidence: its AbsentAtCapture disposition remains unchanged
and grants no authority, while affected evidence expectations/checkpoints change atomically with
the other allowed session-loss records. Missing evidence in the same recorded instance fails
staging verification. No Extension loss exception is enabled by the bounded Desktop slice.

For Extension, a session-instance marker stored in the existing session area distinguishes worker
recreation from session-area loss; it is a nonsecret lifetime witness, not login authority or another
Session owner. Only trusted startup can access its closed `AdmissionSessionInstance` selector. Before
the first source inventory, reuse an existing valid marker or initialize it if absent and there is
no recorded snapshot whose lifetime must first be checked. Exclude the marker from the legacy
manifest and digest. Worker recreation reuses the same marker; it never remints a new lifetime.
On reopen, observe the old marker's presence/identity before any initialization. A missing marker with
recorded source evidence must first take the loss/changed-source decision below; initializing it first
would erase the evidence of loss. After Core records an allowed loss, a new capture may establish its
own marker. Snapshot/reopen reports marker identity/presence as a primitive fact. Same-instance
missing/changed required values are changed-source failures. If the area instance was lost and both
the original Session values and any staged Session values are absent, Core may durably change
`Complete` or `IncompleteRetained` to `LostWithSessionArea`, retain the original capture evidence and verify admission using
the preserved QuickUnlock material. It does not rewrite the original manifest as if Session values
had never existed. A partial/mismatching replacement area is not this exception and fails closed.
If required Device-bound values also disappeared, ordinary changed-source handling applies.

Record an allowed loss under the existing catalog guard before changing destination expectations.
Apply the disposition to every captured Account affected by that same lost session instance and
invalidate its Session-dependent Verified checkpoint in that same journal write. Then revalidate
the checkpoint without a CurrentSession requirement while retaining the same
Account/incarnation, QuickUnlock, source manifest and Replica/workflow evidence. Do not leave a
previously Verified checkpoint claiming the now-absent Session is present. Reconcile an ambiguous
loss-record write by reading the journal before proceeding. If no Account captured Session values,
their `AbsentAtCapture` dispositions remain unchanged; marker loss grants no new authority and the
exact legacy references must still match their recorded absence. Loss never allocates new Account
identities or restarts accepted work.

This exception preserves the existing browser-session lifetime: it neither extends Session survival
nor requires Full sign-in when password QuickUnlock remains valid. Do not persist the old token/key
in DeviceSecret to avoid the loss. After commit, ordinary Core Session loss/expiry policy applies;
admission must never reload a leftover legacy Session to revive newer authority. Preserved biometric
enrollment does not itself supply the now-absent retained Session or count as a successful prompt.

### Durable transitions and crash behavior

Use the closed phases `Preparing`, `Aborting`, `Aborted`, `Committed` and `Complete`.
`Committed` includes remaining cleanup obligations; a separate competing cleanup journal is not
needed. `Complete` is a durable admission tombstone, not absence of the record.

Abort is an explicit generated Runtime control, never an automatic consequence of failed open.
`InspectProfileAdmission {}` strictly reads the catalog under the existing catalog-transition guard
and returns only a closed `ProfileAdmissionInspection` state: `NotStarted`,
`Import { admissionId, phase }`, or `Reset { wipeId, phase }`. It performs no writes, source-provider
calls or readiness changes. A malformed catalog returns an error; it cannot be reported as absent.
This bounded startup inspection leaves the ordinary RuntimeStatus observation gate intact.

`AbortProfileAdmission { admissionId }` is available while startup is fenced and operates only on
the exact durable Import identity. Preparing first becomes Aborting; Aborting resumes its owned
cleanup; a matching Aborted record replays success. A different identity, Committed, Complete or any
Reset state refuses. The response `ProfileAdmissionAborted { admissionId }` is emitted only after
full durable Aborted readback. No source value, filesystem path or credential reference is exposed
by either control. Abort remains under Core's existing catalog and staging owners and keeps the
Runtime non-ready. Cancellation before intent has no destructive effect; after intent the catalog
owns retryable cleanup. The cross-host Runtime protocol supplies Desktop and Extension the same
control instead of separate host bridges. Coordinating and independent review accept this trigger
and inspection boundary for the lifecycle below.

Abort's exact remaining destination set is a closed subset of references derived from the existing
fixed progress: per-Account metadata, QuickUnlock, Account security, optional retained Session or
nonauthorizing Session evidence, Replica, and only originally absent Device key/global security.
It does not duplicate identity or content-digest authority. Original matching Device documents stay
untouched. Aborted retains enough progress to prove all old private staging absent before a new
attempt; each mutation compares the exact current catalog and expected destination evidence.

Replica abort deletion uses the existing persistence owner with
`DeleteAccountIfUnchanged { accountId, expectedHead, expectedRows }`. Core first matches the loaded
snapshot's canonical digest to the catalog and validates its complete typed reconstruction. The
adapter compares the complete head and canonical full physical rows in the same transaction that
deletes them. Row payload JSON remains opaque exact bytes at that adapter boundary; Account scope,
closed physical shapes and duplicate identities are checked there without duplicating Core domain
validation in TypeScript. A changed row with an unchanged head,
extra row, malformed physical row, duplicate key or unknown scope cannot pass by revision alone. Only a
completely empty head-and-row scope is AlreadyAbsent; all conflicts preserve the bytes. Deleted,
AlreadyAbsent and Conflict are closed outcomes, and an ambiguous response requires fresh physical
absence proof. Ordinary explicit Remove/Wipe deletion semantics are unchanged. Coordinating and
independent review accept this prerequisite within the existing Replica owner.

Protected destination Abort uses the matching existing-owner primitive
`PlatformStorage.DeleteIfUnchanged { area, key, expectedValue }`, returning a closed
`DeleteResult { result: Deleted | AlreadyAbsent | Conflict }`. Core reads once into a zeroizing
raw value, strictly decodes and validates the canonical document digest against Preparing, and
passes those exact raw bytes to deletion. Changed bytes conflict; only an absent key is
AlreadyAbsent. Native SQLite compares/deletes transactionally, and the credential/session owners
compare/delete while holding their existing mutation lock. The Web Storage host performs both
synchronous operations in one call under the sealed single-owner startup assumption; this is not
cross-window Storage compare-and-swap. It cannot enable a production path without that exclusion.
Ambiguous deletion still requires uncached absence proof before its catalog receipt. The native
PlatformStorage owner orders issued operations before dispatching a blocking worker and retains
that ordering ownership until physical completion, even if its caller future is dropped. A later
read/absence proof or write cannot overtake an earlier issued deletion. This is necessary for global
Device documents whose identical bytes may be reused by a fresh attempt; an exact-value check alone
does not distinguish those lifetimes. Account Replica deletion also checks the incarnation, which
changes on a fresh attempt. Existing exclusive host ownership still governs owner recreation.
Ordinary Delete, Account removal and Wipe retain their existing explicit lifecycle semantics.


| Transition | Required ordering and restart result |
| --- | --- |
| No admission → `Preparing` | Acquire/revalidate exclusive startup, capture and validate the full source, fix Account/incarnation mapping and owned references, then persist the record plus all pending installs before any destination write. A crash before this write leaves only original source and disposable readers. |
| `Preparing` → `Preparing` | Stage existing protected documents and guarded Replica rows; re-read actual evidence before each verified checkpoint. Keep normal startup, Sync, dispatch and native export gated. Existing Account install head alone cannot promote anything. A lost acknowledgement resumes from recorded expectations and durable reads. |
| `Preparing` → `Committed` | Verify every Account, workflow/artifact disposition, required credential/settings record and current source identity; then atomically promote all pending catalog Accounts and write `Committed` with exact cleanup obligations in the same DeviceCatalog document write. This is the sole ownership commit. |
| `Preparing` → `Aborting` | Persist abort intent and its exact remaining destination cleanup set before removing any staging. Preserve all original source. An uncertain commit write must first be read back: a committed record cannot be aborted. |
| `Aborting` → `Aborted` | Delete only this admission's matching private destination references/rows, verify each result, then remove its pending installs and record `Aborted` in one catalog write. Keep the fence while cleanup is incomplete. A new attempt may replace `Aborted` only after fresh capture and verified absence of all old staging. |
| `Committed` → `Committed` | Start the new owner locked and retry scoped legacy cleanup. Record progress after establishing each deletion; lost replies permit exact idempotent rechecks. Cleanup failure is visible and retryable, but never restarts the old owner or rolls back accepted Core work. |
| `Committed` → `Complete` | After all required obsolete-source cleanup is proven, retain a compact tombstone with version, admission/source identity, manifest digest and completion identity. Remove only temporary inventory/checkpoint material no longer required by preserved Account/workflow/recovery evidence. |

Read back an ambiguous catalog write before advancing. Unknown or conflicting catalog state leaves
startup fenced; it is not an invitation to replay the last phase blindly. Normal `open()` checks this
lifecycle before its current empty-catalog path and per-Account pending-install reconciliation, and
must not initialize a new DeviceKey during unfinished admission. Completed/committed admission is
authoritative even if some old files survive, the Core Replica later needs recovery, or all admitted
Accounts are subsequently removed. Neither leftover source nor an empty Account list means import
again. Every ordinary catalog transformation must preserve this lifecycle field: installation
stage/promotion, startup reconciliation, Account removal, replacement and future catalog updates
cannot reconstruct an accounts-only `DeviceCatalogDocument::new(accounts)` and silently discard it.
Only the specified whole-Device reset transition may replace it; reset is not admission rollback.

The whole-profile commit remains an ordered cross-store protocol: prior credential and Replica writes
are verified before one catalog commit, not atomically bundled with it. Use catalog serialization and
deterministically ordered Account fences throughout the relevant local transitions. Initial source
capture and cleanup remain subject to the supported platform exclusion proof on every restart.
New-owner projections stay locked and do not import old live keys, claims or prompt grace. Abort is
available only before commit; even before the first subsequent mutation, a committed owner resumes
through its recorded Core state rather than an automatic legacy rollback.

### Bounded cleanup after commit

Desktop cleanup uses a separate `ReopenSourceForCleanup` operation, never the ordinary admission
Reopen exception path. Its closed Start carries `verificationAttemptId`, `admissionId` and the
recorded manifest header. Entry carries the previous cursor, decimal index and exact expected entry;
Finish carries the final cursor. The single native snapshot slot checks the complete original
manifest order, count and digest and reacquires the same profile exclusion. Started and Accepted
receipts carry the next cursor/index; Finish returns a dedicated closed cleanup snapshot containing
only format, profile identity, fresh capture identity, fresh handle and admission ID. Unavailable
cannot produce a usable capability. Start/Entry/Finish use the same exact replay and close/drain
rules as ordinary verification.

This capability authorizes only cleanup: it cannot read source pages, verify admission, or supply
values to restore a Core Session. Reopen validates the expected manifest, not equality of current
source contents. Thus a source removed by an earlier acknowledged or ambiguous cleanup can reopen,
and an unreadable or changed target does not prevent checking independent targets. The native slot
retains the complete nonsecret expected-entry list for exact deletion membership; controls remain
individually bounded, and this deliberately introduces no total-profile quota or second journal.
No source payloads or file readers are retained for cleanup.

`DeleteCapturedSource` carries the cleanup handle, admission ID, decimal manifest entry index and
exact expected entry. The closed response repeats handle, admission ID and index and reports
`Deleted`, `AlreadyAbsent`, `Changed` or `Unavailable`. An originally Missing entry is never a target.
Before each call Core re-reads the entire expected Committed catalog under the catalog guard.
Native checks membership, then freshly reads the fixed location: files require the original stable
identity and complete content digest; credential references require the original exact scalar and
digest. Credential compare/delete holds the existing protected-map owner lock and preserves every
unrelated member, including Core values. A successful deletion requires fresh proof of exact target
absence. A foreign replacement is Changed and remains untouched; inaccessible or malformed evidence
is Unavailable. Proven absence at that exact scope is AlreadyAbsent, including after a lost deletion
reply. Ordinary Preparing reopen retains its strict equality requirement.

Core records each proven absence in the existing Committed progress and reads the entire catalog
back even after a failed write response before advancing. It retries every obligation, including
previously Absent targets, before compaction; a replacement resets that target to Pending. Changed,
unavailable, lost replies and absent providers leave Committed authoritative and ordinary Core
startup/operations available. Runtime status exposes optional pending admission cleanup with its
`pendingObligations` count (zero can mean compaction awaits proof); successful Complete readback
removes that status. A new open retries pending cleanup when the matching provider is available. When every exact target is proven absent,
Core atomically increments the record revision, assigns a completion identity and removes temporary
progress in the compact Complete record while preserving the current catalog Accounts and legacy
presentation evidence. Removing every Account does not remove or recreate the lifecycle.

### Device Wipe and unreadable catalog recovery

Existing Device Wipe deliberately operates when `open()` failed and does not parse the catalog.
Preserve that recovery ability. Its current Runtime-namespace deletion would erase an admission
tombstone while legacy files/credentials survived; suppression alone would also leave data that
this explicit whole-Device action must erase. Wipe must cover both the existing Runtime stores/private
staging and the profile-owned legacy source families before reporting success.

The same `profile_admission` field has a closed `Reset` arm containing version, random `wipe_id`,
`Wiping` or `Wiped` phase, a durable nonsecret `ProfileResetScope` and the fixed remaining family-cleanup
set. `ProfileResetScope` fixes the primitive scope version, stable current-profile/namespace identity,
and either `CoreOnly` or `LegacyProfile { source_format, families }`. Each legacy family identifies
its fixed physical namespace and Core selector-plan version; these are closed descriptors, not
arbitrary paths, Account-derived deletion lists or process-local handles. It has no required old capture,
Account list, credential or parsed admission metadata. Under existing Wipe/catalog/retirement fences,
prepare a closed whole-profile reset scope, then write a known empty catalog with `Reset/Wiping`
before destructive steps. This write does not require decoding old catalog bytes. It suppresses
legacy reimport and normal startup while recording the already-authorized Wipe intent durably.

The persisted Reset arm uses `kind: "reset"`, version 1, nonempty `wipeId`, canonical unsigned
string `revision`, `phase: "wiping" | "wiped"`, closed `scope`, and `remainingFamilies` in source
family order without duplicates. The scope is `coreOnly { namespaceVersion: 1 }` or
`legacyProfile { scope: ProfileLegacyResetScope }`. Wiping requires an empty catalog Account list.
Wiped requires an empty remaining-family list and may later preserve newly installed Core Accounts.
Every receipt change increments revision, and ambiguous writes require equality with the complete
expected catalog document before proceeding. Unknown versions, phases, fields and positional arrays
are refused; no old journal decoding is needed to establish a fresh independently complete scope.

The source capability is optional on hosts where this compatibility source format does not apply.
Such an existing Wipe uses `CoreOnly` after the trusted composition/Core platform mapping explicitly
establishes that no applicable legacy family exists; Web or another ordinary Core-only fixture must
not require unrelated Desktop/Extension primitives. For an applicable Desktop/Extension format,
every family must be observed present or absent through its provider: missing provider, failed read
or unknown format is not proof of absence. An applicable but empty legacy profile may record those
explicit absence results. Normal Runtime storage/artifact cleanup is required in every case.

Trusted startup distinguishes `CoreOnly` (this compatibility source does not apply) from
`LegacyUnavailable { format }` (it applies, but no live provider is available). The latter refuses
fresh and Preparing startup and whole-profile Wipe, while a validated Committed or Complete record
remains authoritative for ordinary Core startup; Committed cleanup remains visibly pending. Native
and Extension composition must retain this applicability declaration when acquiring their legacy
capability fails. This does not activate their upgrade entrypoint before the old-owner exclusion
proof is established. A known legacy admission/reset marker overrides a later CoreOnly declaration
for reset purposes. Genuinely CoreOnly fixtures retain damaged-catalog recovery within the existing
Runtime namespace; an absent applicable provider never becomes that trusted non-applicability claim.
An ordinary trusted CoreOnly Wipe with a valid catalog lacking any lifecycle (or no catalog) keeps
its existing namespace cleanup behavior. Any known lifecycle or applicable legacy declaration uses
the durable Reset path; damaged catalog bytes on a trusted CoreOnly host can be replaced by an
independently established CoreOnly Reset. A known Import or LegacyProfile Reset scope cannot be
silently downgraded to CoreOnly when its provider is absent.

Replacing a damaged old record is safe only when the reset scope independently covers every required
source and staging location. AdmissionV1 therefore permits source locations only in its fixed profile
families and all private staging only in existing Runtime-owned storage/artifact namespaces; it may
not hide a uniquely addressed cleanup target solely inside a journal that Wipe cannot parse. The
startup-owned `PrepareLegacyProfileReset` primitive establishes those fixed physical family scopes
without loading Account data. If a scope cannot be established independently, preserve the old bytes
and return incomplete before replacement or destruction; never discard the only exact cleanup identity.

The bounded Desktop reset controls use `PrepareLegacyProfileReset { wipeId, format, expectedScope }`,
where expectedScope is required and explicitly null for initial preparation, or the full durable scope
on retry. The prepared result contains a fresh reset-only handle, the same wipe ID and the independently
validated scope. The live slot binds the wipe ID before any family mutation. A scope contains version 1,
format, stable profile identity and exactly the Store, SyncStore and Credentials family descriptors in
that order. Each descriptor contains its stable namespace identity and selector-plan version 1.
The two files additionally carry closed original `absent {}` or `present { fileIdentity }` evidence;
the credential family carries `notFile {}`. File presence is not a nullable identity. Reset preparation
requires no Account list, valid file contents, source digest or old catalog parsing.

`ResetLegacySourceFamily { resetHandle, wipeId, family }` returns the same scope identifiers and
`Reset`, `AlreadyAbsent`, `Changed` or `Unavailable`. Fresh profile and namespace identity must match
before each deletion. For files, an originally present file may disappear after an ambiguous deletion,
but a present different file object is Changed; an originally absent file that becomes present is also
Changed. Never follow a symlink or delete a nonregular replacement. No file content digest is needed
for this explicitly authorized Wipe. Credential namespace identity fixes the exact protected service
and entry independently of the evolving blob, because Core's own namespace cleanup changes that blob.
Its raw map must still be strictly readable before scoped deletion can be proven.

Desktop credential selector-plan version 1 deletes exactly `bittery_device_key` and every reference
with prefix `bittery_account_` and an anchored recognized suffix `_secret_key`, `_session_data`,
`_jwt_token`, `_vault_keys` or `_encrypted_private_key`. The intervening segment may be empty or any
string: Wipe covers malformed and orphaned legacy references without invoking Account identity policy.
Near-miss suffixes, unrelated keys and Core references survive the raw-preserving locked rewrite.
There is no total-profile byte quota on this legacy reference scan. Exact family absence is freshly
proved before an acknowledgement can advance the reset journal; lost responses repeat the same scope.

The prepared durable reset descriptor is written in `Wiping` in the same catalog replacement;
it is the restartable scope evidence. On every retry, reacquire a fresh live exclusive capability and
revalidate the descriptor against the current profile and exact fixed namespaces. A scope-version,
profile or namespace mismatch remains incomplete with the marker preserved. Do not resume deletion
through an old handle, silently retarget a changed directory/database, or infer remaining scope from
an already-erased legacy `accounts_list`. A matching retry reuses the same wipe ID and remaining
obligations; an ambiguous initial suppression write is read back before destructive work proceeds.
Proven absence at the exact recorded scope after a lost deletion reply is a valid cleanup result;
a present foreign replacement or inaccessible namespace is not equivalent to that absence.

`ResetLegacySourceFamily` takes that live reset capability and one closed family from the source
format, with Core-defined legacy selectors. It requires no valid old values or content digest:
explicit Wipe authorizes removal of all Accounts in those owned families, unlike ordinary admission
cleanup. Desktop covers the fixed legacy store/sync files and legacy references within the existing
protected credential map. Extension covers legacy reference namespaces in local/session areas and
the fixed `bittery_records` database. Include orphaned Account references, Sync identity/queue/
checkpoint keys and the admission session marker. Use the inventory's actual global names and
Account/Sync namespaces, not a best-effort list derived from a possibly damaged `accounts_list`.
The host executes Core's closed selector plan, and does not rediscover Account ownership policy.
Preserve unrelated OS credential entries and unrelated browser keys; no global keychain clear,
arbitrary file deletion or browser-area clear is introduced. A malformed/inaccessible protected map
that prevents proving scoped deletion remains incomplete, not permission to clear its whole service.

The existing platform `DeletePrefix` primitive gains optional exact `preserve_key`, omitted for
ordinary calls. During Wipe only DevicePlain namespace deletion preserves the catalog key containing
`Reset/Wiping`; other Runtime data and secret/session namespaces are deleted normally. Each backend
must enforce exclusion within its deletion operation, never delete the marker then restore it in a
later write. This is primitive key selection, not a second host reset policy. Legacy family deletion
and existing Replica/artifact/host cleanup remain under the one Wipe lifecycle; their failures retain
`Wiping` with a visible incomplete result. Lost acknowledgements recheck the exact family for absence,
and neither an unreadable family nor an IPC close counts as successful deletion.

Before any prefix deletion, Core completely enumerates all three PlatformStorage logical areas and
validates their stable, symmetric `backingAreas` equivalence partition. A single representative may
be deleted per physical group. Preserve the exact DeviceCatalog key only in the group containing
DevicePlain, including every logical alias used for that group; a same-named key in an unrelated
Secret group is ordinary Runtime-owned residue and must be removed. Do not preserve that key
unconditionally across distinct backing stores. A fresh complete census after deletion must show
exactly the reset catalog in its own group and no other Runtime-owned keys before Wiped. The
adapter's preserve-key exclusion is atomic with its prefix deletion; no remove-then-restore window
is permitted.

Only after all existing Runtime and legacy source/private-staging cleanup is proven may the empty
catalog transition to `Reset/Wiped` and Wipe report success. `Wiped` permits a genuinely empty new
Runtime and later ordinary new Accounts, but never reimports leftover or newly rediscovered legacy
material. All ordinary catalog updates preserve it. Restart during `Wiping` remains recovery-gated
and allows the existing Wipe retry without parsing the discarded catalog; it cannot expose an empty
success or reactivate legacy admission. Suppression persistence failure remains an incomplete Wipe,
as other existing physical storage failures do. This is recovery ordering within the existing explicit
Wipe action, not a new reset command, credential owner, background journal or rollback route.

### Required review and maintained crash matrix

Independent and coordinating review checked these concrete record/control shapes against actual
adapters before ticket91 became ready. Generate persistence/primitive schemas and conformance vectors during
implementation; do not hand-maintain parallel TypeScript policy. In addition to the following slices,
maintain crashes before/after the initial catalog intent, each protected/scalar/Replica write and
readback, each Account checkpoint, the whole-profile commit, abort intent, every staging deletion,
each legacy cleanup deletion/receipt and tombstone compaction. Include failed replies after successful
writes, inaccessible stores, changed source, a partial multi-Account profile, destination collisions,
Session-only loss versus same-instance corruption, and tombstone restart after removing every Account.
Cover marker creation before inventory, unchanged marker across worker recreation, source hashes
unaffected by destination writes, malformed non-string Chrome values and malformed IndexedDB rows.
Crash Wipe before/after its suppression write, each legacy/Runtime family deletion and the final
Wiped write; include malformed catalog, inaccessible legacy credentials, orphaned source references,
successful physical deletion with lost reply, and repeat/restart with zero unintended reimports.
Verify reset descriptor reacquisition after process loss, changed/unsupported physical scope, a
CoreOnly host without a legacy provider, and an applicable format whose missing provider cannot prove
absence. Cover multi-Account Session loss invalidating all affected verification checkpoints in one
journal transition. Reauthorize a held legacy workflow, retire its destination again, reopen it with
the old authorization evidence retained but inactive, and require a fresh valid83 Resume before work.
Prove two source workflows referencing one removed destination retain all child/artifact identities
and require ticket90's explicit reauthorization. No production path may enable a supported source
variant before its required representation, process/packaging primitives and acceptance are complete.

## Dependency-ordered implementation and evidence

The first slice is a populated, locked Desktop Account with no pending work: real source files and
isolated OS credential references enter private Core admission; interrupted credential/catalog
writes resume; restart preserves Account identity, password-only QuickUnlock prerequisites and exact
security settings. Use existing crypto vectors plus byte comparison, then real local biometric
release with the retained Session on supported OS. Never replace that gate with new password sign-in.

Next admit confirmed encrypted Item/Vault/Attachment metadata and Sync baseline for offline reads,
then each single-Account pending kind with exact serialized bytes, original IDs and failed/staged
states. Test a real Server response lost before old queue acknowledgement and prove one retained
outcome after admission. Ticket90 supplies cross-Account work before whole-profile admission is
enabled. Shared Core code handles both source families; Extension adds primitive snapshots and its
session-area/browser-owner lifecycle after Desktop acceptance.

Crash every boundary: source capture, protected credential staging, Replica/Operations commit,
catalog promotion, legacy cleanup, and restart before first unlock. Test independent Accounts,
empty versus malformed source, missing/expired Session, negative/zero preferences, conflicting
identities, unreadable keychain, concurrent source writes, an already-running old process, and
repeated admission. Scope cleanup to the fixture; do not erase the developer's profile.

Actual populated-profile upgrade in the Desktop app belongs to
[73](../issues/73-desktop-production-acceptance.md); actual Chrome upgrade, broker reattachment,
browser restart and owner loss belong to [77](../issues/77-extension-production-acceptance.md).
Final required checks remain `pnpm check:ci` and `pnpm check:ci:rust`. Neither fresh-profile sign-in
acceptance nor compilation establishes this upgrade path.

### Real Server lost-Create acceptance path

Use the existing opt-in native foundation harness and a scoped throwaway Server Account. A dedicated
legacy browser owner prepares real Item ciphertext and a persisted command through the production
ItemCache, Vault crypto, OutboundQueue and generated API client. Give source command, semantic and
attempt identities distinct values. The test proxy forwards that exact Create to the development
Server, retains its applied response and prevents acknowledgement delivery. Prove the captured source
files and protected map remain byte-identical while the response is held, then close that browser
owner before admitting the snapshot through isolated native files, OS credentials and SQLite.

Admission and locked Core-only reopen send no HTTP. Ordinary password QuickUnlock then enables the
existing Core dispatcher to replay the same semantic Create identity and exact bytes. Assert the
Server returns its retained original outcome, only one Item exists, one compact receipt retains
source lineage, the Operation and overlay are removed, and public Items decrypts the expected Item.
Verify the retained outcome endpoint and both observed requests. Existing scoped cleanup removes
the throwaway Server Account and fixture OS entry/directory and preserves unrelated credentials.
This proves real Server convergence after loss of a legacy JavaScript owner; OS process exclusion,
supported launch routes and production upgrade acceptance remain separate required evidence.

## Web comparison and readiness

The completed Web composition opens Core's IndexedDB `bittery_replica` and platform namespace while
transitional AccountStore initialization/cleanup still exists. The
[Worker composition](../../../packages/client-runtime/src/web/worker-entry.ts),
[host composition](../../../apps/web/src/lib/crypto.ts), and Core startup do not contain a legacy
AccountStore/queue import. Historical Web completion therefore offers no populated-profile admission
implementation to reuse. Its shared Core crypto, document validation, durable installation,
guarded publication and recovery seams are reusable.

The technical ownership and failure contract above is recorded. No new product choice is needed to
preserve credentials, preferences, exact request identities or fail-closed exclusive admission.
Ticket83 resolves destination removal/re-add with explicit same-identity reauthorization; ticket90
supplies its shared workflow capability. Whole-profile admission still requires that capability and
a concrete sealed exclusive-startup mechanism; platform feasibility can be investigated without asking another product
question. No production profile migration is implemented or accepted by this document.

### Ordinary-request serialization probe

Question: can the current legacy request bytes be captured from its actual queue/API implementation
without restating the serializer? Verdict: yes. A throwaway Bun probe drove public
ItemSyncEngine.enqueue/drain and createApiClient with synthetic primitive queue storage and a fetch
capture that returned no network response. Eight actual Request objects cover Create, Update,
Favorite false/omitted, Trash, Permanent delete, Restore and same-Account Move. The retained
[vectors](fixtures/legacy-request-serialization.json) contain exact body strings, path, strong
precondition, semantic-versus-attempt identity and source hashes. The deliberately reversed synthetic
ciphertext-field insertion order is normalized by the actual queue to its production body order;
Unicode/newline/quote/backslash bytes and omitted Favorite becoming false are explicit. Numeric source
baseVersion appears in If-Match, not in these ciphertext-only bodies.

This is serialization evidence only: synthetic ciphertext is intentionally invalid, storage is a
primitive fixture, no Server/network/profile/crypto was exercised, and no migration or retry acceptance
is claimed. The initial probe fixture lacked SyncStorage.update and was corrected before captures;
all eight requests then captured successfully. The temporary probe implementation is removed after
recording its question/verdict.

The maintained [legacy request-byte test](../../../packages/sync/src/__tests__/legacy-admission-request-bytes.test.ts)
now drives those same production entry points against twelve vectors: the original eight plus
Create/Update opaque path-parameter encoding and missing semantic/attempt ID fallback to the
original command ID. Each vector has
an exact typed source command in `sourceCommands`, including preserved optionality and envelope
metadata omitted from HTTP, for the Rust compatibility reader to consume. The original probe's
source hashes remain historical provenance; the maintained test checks the current implementation's
actual bytes. Cross-Account/Attachment step vectors, full admitted command behavior and real retained
Server outcome proof remain delivery work.
