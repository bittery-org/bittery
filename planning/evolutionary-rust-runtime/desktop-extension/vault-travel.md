# Vault mutations and Travel mode

This refines the [host specification](spec.md) for [70](../issues/70-runtime-vault-update-and-delete.md)
and records the remaining frontier for [71](../issues/71-runtime-travel-management-and-erasure.md).
Ticket status remains in the tracker. This document is a contract, not implementation evidence.

## Vault frontier and evidence

Question: how do Desktop's existing Vault metadata edits and deletion become durable Runtime work
without introducing another Vault service or losing image cleanup and previously accepted Item work?

Answer: extend the existing shared Operation protocol with `update_vault` and `delete_vault`, retaining
Server outcomes and using Core's existing guarded Replica, scheduling, image ingress and cleanup.
Preserve current Server commit-order metadata semantics; do not invent a Vault version or key rotation
for a rename. This is the durable scope already recorded in ticket 70, not a new Desktop editor.

The actual Desktop [Vault route](../../../apps/desktop/src/routes/vault/route.tsx) submits name, optional
icon, optional image File/removal, and stable Account/Vault IDs; deletion navigates away after success.
The shared [VaultService](../../../packages/core/src/services/vault-service.ts) currently owns validation,
image presign/PUT, PATCH and DELETE. Its [mutation refresh](../../../packages/core/src/hooks/vault/mutation-utils.ts)
updates wrapped-key metadata and removes deleted Vault Items. Those behavioral callers move to Core.
Desktop has no conversion editor to migrate. Web/Mobile still use shared update/delete/conversion
hooks: inventory those callers before deleting the transitional service.

Current [Server catalog](../../../apps/server/src/domains/vaults/catalog.rs) permits metadata edits for
owner/admin and deletion for owner only. PATCH trims the name, preserves omitted fields and clears
nullable icon/image on explicit null. The maximum name length is 200 characters; the existing Desktop
service additionally rejects names shorter than two after trimming. Deletion removes Items,
Attachments and memberships, emits deletion/access-revocation events, and attempts image cleanup.
Neither existing mutation retains an Operation outcome. The Vault has no optimistic version validator.
The current image presign route is not a durable staged-image contract.

## Closed Runtime commands

Add Rust-defined `UpdateVault` and `DeleteVault` requests, generated across bindings under
[ADR 0012](../../../docs/adr/0012-one-generated-definition-per-cross-language-type.md). Both require explicit
`accountId` and `vaultId`; neither accepts a Server URL, key, authorization header or host-generated
policy decision.

`UpdateVault` carries optional name, a three-state icon patch (unchanged / clear / set), and an image
change (unchanged / remove / source). A source is the existing `VaultImageSourceInput` capability,
content type and byte length. It is never a file path, upload URL or caller-supplied object-storage key.
Reject conflicting changes before acceptance. Preserve the existing trimmed-name minimum and Server
maximum. A no-field patch has no domain effect; retain the existing ability to submit an unchanged
name without inventing a rename conflict. `DeleteVault` carries only the explicit scope.

Return distinct `VaultUpdateAccepted` / `VaultDeletionAccepted` responses with Operation ID, Vault ID
and Replica revision. Acceptance proves a durable intent, not a Server effect. Core's Operations
projection reports pending/applied/rejected state; the host must not turn an acceptance ACK into a
"deleted successfully" notification. Existing metadata and readable Items remain authoritative until
confirmed change. Pending deletion prevents new Item/Import/Attachment/share work targeting that
Vault, but does not silently cancel previously accepted work. A rejected deletion releases that fence.

Core checks unlocked Account/incarnation, current visible Vault authority and appropriate role before
acceptance. Server rechecks current authority at execution. The same Account execution/publication
barriers used by existing commands fence lock, teardown, Travel erasure and source capabilities.

## Immutable operations and Server compatibility

Use `ResourceRef::Vault` with two new closed Operation kinds. Metadata-only changes and deletion
freeze request method/path/content type/body/fingerprint atomically with acceptance. Authorization is
attached from the current Session at dispatch, never persisted in the immutable request. Reconnect,
renderer loss and process restart resume the existing scheduler; no host retry loop is added.

Expose retained mutations as `POST /api/v1/vaults/{vaultId}/metadata-updates` and
`POST /api/v1/vaults/{vaultId}/deletions`, both requiring `Idempotency-Key`. The first body is an explicit
immutable metadata patch with omission/null/value preserved; deletion uses an empty JSON object.
The dedicated resources let still-unmigrated Web/Mobile callers keep existing PATCH/DELETE response
contracts during the host migration. Both entry points must call one Server implementation of each
effect, authorization check, transaction and cleanup obligation. Do not copy the old catalog functions
into an Operation handler. Remove compatibility entry points only after their last production caller
has migrated.

Extend the shared Operation outcome schema, database enum/shape constraints and outcome lookup with:

- `update_vault`: applied `{ vaultId }` or rejected `{ code: vault_access_denied }`.
- `delete_vault`: applied `{ vaultId }` or rejected `{ code: vault_access_denied }`.

The existing bounded denial includes missing Vault, lost membership and insufficient managing/owner
role; it does not disclose inaccessible resource existence. Syntactically invalid requests fail
before execution and do not become accepted valid commands. Session failure remains authentication
handling, not a permanent semantic rejection. Transient storage/transport failure is retried through
the existing Runtime schedule. The same Operation ID with a different fingerprint is rejected under
the existing `OperationIdReused` contract.

Commit each domain effect, retained outcome, audit entry and Sync events in the same Server
transaction, with current authority locked in the established user/Team/Vault order. Outcome lookup
must answer a repeated applied delete after its Vault/membership rows are gone. Never cascade-delete
Operation outcomes with a Vault. A new delete ID against an inaccessible/absent Vault is denied;
absence alone is not evidence that this Device's earlier deletion applied.

A retained applied result identifies the completed action, not the latest Vault metadata. Core must
obtain current authority under the existing guarded bootstrap/Sync contract before projecting changed
metadata; replay of an old update outcome cannot roll back a newer rename or recreate a deleted Vault.
Update and delete use existing Server commit order, including concurrent legacy callers. No new
cross-Device user-order promise is introduced.

## Retained Item outcome after later authority loss

[Research88](../issues/88-retained-work-current-authority.md) and
[implementation89](../issues/89-retained-results-current-authority.md) refine this path under the
[retained-result/current-authority contract](retained-current-authority.md). Exact accepted replay
proves the original Server result independently of a later edit, Move, deletion or visibility change.
Keep the original receipt/version. A current Item may legitimately have a later version or another
visible Vault; validate its exact identity/category, non-regressed version, current key scope and
ciphertext before installing it under the captured generation/Replica guard. Never overwrite a newer
cached Item or rebase an earlier authenticated404 over subsequently installed current authority.

When current visibility cannot safely support direct installation, commit only the original receipt,
remove only its owned Operation/overlay/preparation, abandon pre-proof staging and require fresh
Bootstrap. Preserve every current authority row and other Operation's data. This receipt-only path
must not reuse absence reconciliation's Item deletion effect. Applied Import and Create-Vault use the
same receipt/RefreshRequired model; their original batch count or creation result need not match
currently visible data. Current crypto validation precedes fresh publication, not a historical receipt
that installs no data. Hidden responses never borrow old wrapped keys or accepted creation material.

This applies to Create, Update, Favorite, Trash, Restore, Move and permanent deletion. Lookup remains
a hint and must be proved through exact immutable replay. An applied permanent deletion with a
present contradictory Item remains an invariant failure; lower versions, wrong categories and corrupt
present data on the direct visible path retain their validation failures. A404 without a matching
terminal result cannot finish accepted work, and a403 cannot prove Item absence. Authentication and
transport failures retain bounded Runtime-owned handling.

Failed or stale receipt commits preserve accepted bytes and indispensable Move/image artifacts.
After a successful receipt, existing cleanup owners retain their physical deletion/retry obligations.
Sync must reach bounded hydration after receipt invalidates its ordinary or structural page, without
advancing an obsolete cursor or waiting indefinitely for the already-proved action to complete.
Vault-wide visibility, key erasure and capability retirement remain the shared authoritative
Vault/Sync lifecycle. No second receipt owner, completion checkpoint or persisted crypto format is added.

## Images and deletion convergence

Generalize the existing create-Vault image preparation/staging/checkpoint/cleanup machinery for
update rather than introducing a second artifact format. Reuse `SqliteVaultImageArtifactStore`, the
browser artifact port, `VaultImageIngressFacade`, verified upload grants, and immutable published
metadata. Preserve existing encrypted-at-rest formats and existing published image representation.
The current staging binding already includes Operation/Vault identity, length, content type and digest;
its `/create/` object-key spelling is persisted format, not a reason to duplicate the staging owner.
Keep existing keys compatible when reusing or extending the machinery.

A source must be fully prepared into the existing durable image artifact before acceptance. Persist
its bound intent and progress; freeze the final metadata HTTP request only once the existing staged
upload is confirmed. Grant URLs and live source handles are ephemeral and never serialized into the
Operation. Missing capability, failed preparation or cancellation before acceptance leaves no accepted
mutation. After acceptance, renderer detachment cannot abandon the artifact or immutable intent.
Server commits the replacement image reference with the outcome. Core retains local and staging
cleanup obligations until confirmed complete; the Server owns deletion of the superseded public
object. Repeated outcomes or retries cannot delete the newly referenced image. Image removal and
Vault deletion also perform the existing old-image cleanup through that same Server owner.

The Server records superseded public images in a genuine Vault-image cleanup outbox in the same
transaction as reference replacement or deletion. The existing Vault-image cleanup job drains it;
there is no additional runner and no fabricated staging or Attachment Move record. These objects
can outlive Vault and Operation rows, so cleanup obligations have no cascading owner foreign key.
One exact object-key advisory fence coordinates assignment, staging reuse and cleanup. Acquire
multiple keys in sorted order; while holding the fence, cleanup rechecks both current references and
live staging before deleting and completing the obligation. A current reference cancels obsolete
cleanup. Failed deletion or commit retains the obligation. Legacy assignment of a different raw
image key must prove the object exists under that fence, preventing assignment after cleanup has
already deleted it. Retained creation/update and staging cleanup share this lifetime boundary;
a completed Operation cannot regrant its consumed stable staging key.

Deletion is not Account teardown. Purge the deleted Vault's authority from every generation, wrapped
key entry and projection after authority confirms deletion, and retire its unused source/sink/image
capabilities. Keep immutable encrypted accepted Operations and indispensable encrypted artifacts
until each outcome is reconciled, following [65](../issues/65-hidden-vault-durable-work-contract.md).
If an Item mutation commits first, its retained outcome remains recoverable after deletion. If Vault
deletion wins, the Item mutation reaches its existing authoritative denial; never manufacture local
success or discard its accepted evidence. Work requiring erased keys cannot resume transcryption.
Other Accounts and Vaults retain their authority, artifacts and accepted work.

Incoming personal/shared conversion remains an authority refresh, using the Server's existing roles,
key wrapping and membership rules. Core must remove obsolete authority and install only the current
Account-visible key material. This slice does not add a Desktop conversion editor or migrate unrelated
Web/Mobile team-management callers by implication.

## Vault acceptance and dependencies

Start with no-image rename through real Core request, retained Server outcome and current Replica
projection. Then extend clear/set icon, image replacement/removal and deletion. Test-first checks must
include exact immutable replay, same-ID/different-body refusal, dropped response, restart before/after
remote effect, same-Account metadata races, empty Vault deletion, denied roles, Account isolation,
image failures at each staging/commit/cleanup boundary, deletion racing previously accepted Item and
Attachment Move work, and retained outcome lookup after Vault rows disappear. A failure must leave
a truthful pending/rejected projection and recoverable evidence.

Share Server effect tests between legacy and retained entry points. Regenerate OpenAPI and generated
contracts, add the required database migration/shape constraints and route-count assertions, and run
SQLite/IndexedDB conformance and recovery tests for both kinds. Real Desktop acceptance includes
edit dialog name/icon/image/remove-image, delete confirmation/navigation, offline acceptance,
reconnect convergence and another client observing the final authority. Compilation and mock outcomes
alone do not establish it. Ticket 69 supplies real native image/file capabilities. Core/Server
capability implementation precedes production Desktop routing under ticket 66; that later cutover
and ticket 73 must provide the actual dialog/application evidence. Capability tests cannot stand in
for those later gates.

### Accepted-image retirement prerequisite

Research92 selected protected local Vault-image artifacts using an artifact key wrapped by the existing
Device key, with opaque portable recovery and compatible legacy readers. Independent review passed;
[delivery93](../issues/93-protected-vault-image-artifact-storage.md) is ready. Ticket70's protected-image
retirement variant depends on93 before erasure can retain those indispensable bytes as encrypted
evidence. This does not retroactively block70's no-image retirement vertical slice or change existing
image HTTP/public bytes. Existing raw image storage is not itself protection acceptance.

## Travel mode capability contract

Existing Desktop [Travel settings](../../../apps/desktop/src/components/travel-mode-settings.tsx)
use [shared hooks](../../../packages/core/src/hooks/use-travel-mode.ts) to observe policy, save the hidden
Vault selection while disabled, enable a nonempty selection, and disable after password proof.
[Server routes](../../../apps/server/src/domains/vaults/http/travel_mode.rs) are GET `/travel-mode`,
PUT `/travel-mode/hidden-vaults`, POST `/travel-mode/enable`, and POST `/travel-mode/disable`. The
[service](../../../apps/server/src/domains/vaults/travel_mode/mod.rs) rejects selection changes while
enabled, checks Vault access, preserves the hidden selection on disable and commits Sync metadata.
These are currently foreground responses, not retained Operation outcomes.

The disable route consumes `attemptId`, `clientPublicKey` and `clientProof` through
`verify_login_proof_for_user`; it does not finish login or create a Session. Core must expose a closed
password-taking disable command and reuse the existing crypto derivation/proof rather than call
password Quick Unlock or return a proof to the renderer. Password, Auth key and one-use proof must
remain ephemeral. Any password-timestamp update must follow the existing successful-password
ceremony rule, not occur merely because a request was queued.

Expected command names are `SetTravelModeHiddenVaults`, `EnableTravelMode`, `DisableTravelMode`,
plus `TravelMode` observation with explicit Account scope. Actual local enforcement must replace the
current active-generation-only filtering with ticket 65's all-generation/key/capability erasure.
Core live Sync must consume verified policy changes before readable projection publication and
before new-work admission; a hidden accepted artifact is never key authority. Incoming policy and
local command responses must converge through the same guarded owner, including retained Session
wrapped keys, restart, biometric access and Desktop–Extension transfer.

The maintainer resolved [command lifetime81](../issues/81-travel-command-lifetime.md): preserve
foreground configuration under Core ownership. Reconcile an ambiguous disable response against
current Server policy. If another disable attempt is needed, require fresh password entry and a fresh
one-use proof; no persisted proof, new login secret, automatic SRP replay or durable disable Operation
is introduced. If reconciliation cannot obtain current policy, report uncertainty and retain the
existing verified policy and erasure obligations. A lost response cannot release hidden authority.
Current disabled policy may establish the desired configuration without proving which Device changed
it; fresh ordinary authority still governs key/data re-admission.

The following command and reconciliation contract implements that accepted decision. The Export
bridge review and the discovered plaintext-image artifact gap remain explicit readiness gates below;
ticket71 is not ready merely because the foreground lifetime is resolved.

### Actual ownership to replace or reuse

Core currently has only [GET Travel policy](../../../packages/client-runtime/crates/bittery-client-core/src/auth_http.rs),
the shared [verified-response validator](../../../packages/client-runtime/crates/bittery-client-core/src/authentication_installation.rs),
and persisted `AccountMetadataDocument.verified_travel_mode`. Sign-in obtains that response;
[local access](../../../packages/client-runtime/crates/bittery-client-core/src/runtime/local_access.rs)
reuses it for biometric/native verification, allowing cached policy only for the existing retryable
transport failures. Biometric/native release presently refuses newly hidden retained authority;
that refusal is not all-generation erasure. Preserve the conservative refusal until the common
retirement owner has completed its duty.

Desktop settings still obtain Account API clients, list Vaults and invoke the TypeScript enforcer.
Replace these callers with Runtime Account identity, the Account-scoped Vault metadata projection
and the commands below. Any currently readable Vault can be selected, including read-only/shared
Vaults; configuration does not require the owner role used by Vault deletion. While enabled, render
the hidden count and available current metadata without retaining hidden Vault names for the picker.
Mobile still uses the shared Travel hook and enforcer. Delete shared TypeScript policy only after
its remaining callers migrate; remove Desktop-local competing ownership at its cutover.

The Extension's current [Vault source merge](../../../apps/extension/src/background/vault-utils.ts)
trusts Desktop snapshot filtering while separately filtering local records. Its Runtime replacement
must instead apply the shared policy to its own Replica and source authority. Desktop filtering is
not proof that the connected Extension erased its separate cache, pending plaintext or dormant
independent Session wrappers. No Extension Travel editor was found; preserve policy enforcement
without inventing a new editor.

### Closed commands and observation

Generate these Account-scoped definitions from Rust under ADR0012. Hosts provide no Server URL,
token, key, proof or policy timestamps.

| Entry | Input and required behavior |
| --- | --- |
| `SetTravelModeHiddenVaults` | `accountId`, `hiddenVaultIds`; at most100 distinct nonempty IDs, all from current Account-visible Vault authority. Empty selection is allowed. Require verified disabled policy; Server remains authoritative if it changed concurrently. |
| `EnableTravelMode` | `accountId`, `hiddenVaultIds`; the same bound and authority validation, with a nonempty selection as required by the existing Desktop action. Send one enable request containing the selected IDs; do not silently split this into save-selection and enable requests. |
| `DisableTravelMode` | `accountId`, `masterPassword`; derive one fresh proof within Core and send it only to the existing disable endpoint. No renderer-visible SRP intermediate or Session creation. |
| `RefreshTravelMode` | `accountId`; an explicit foreground current-policy read for settings refresh and recovery from an uncertain answer. It does not replay an earlier mutation. |
| `TravelMode` observation | `accountId`; last verified configuration, its existing Server/local verification timestamps, and enforcement state derived from existing policy, retirement and Bootstrap owners. No verified policy means unknown, never default-disabled. |

Settings mutations require the current unlocked Account and ordinary lifecycle admission. Internal
policy verification and pending erasure may also run while locked when their existing Session/storage
capabilities permit it. An import-only Account lacking the existing Secret Key/KDF material cannot
perform the password proof: return typed `CredentialUnavailable`, never store a new secret
or substitute Quick Unlock, biometric release or automatic full Sign-in. This differs from
`AuthenticationRequired`: an already Unlocked Account with a valid Session can lack the existing
local proof material, and hosts must not infer that distinction from an error message.

Use one closed `TravelModeCommandResult`: `Confirmed { policy, enforcement }`,
`RetryRequired { policy }`, or `Uncertain { lastVerifiedPolicy }`. The result carries explicit Account
scope. `Confirmed` means the authenticated response or subsequent current read establishes the
requested configuration, not which Device caused it. `RetryRequired` means current policy was obtained
but does not establish the requested configuration; another disable request always needs new password
entry. `Uncertain` means current policy could not be established. Definitive input/permission failures
retain their typed Runtime errors rather than being mislabeled as applied policy.

The enforcement states are `Unverified`, `Retiring`, `Ready` and `Refreshing`: unknown policy;
known policy with unfinished local erasure; completed enforcement; and disabled/currently visible
policy awaiting ordinary verified authority restoration. They are projections of existing owners,
not a second persistent state machine. Settings may show the verified enabled state while erasure is
pending, but may not report local protection complete until `Ready`. A disabled confirmation does not
promise that previously hidden Items are readable before `Refreshing` completes.

### Password proof, cancellation and ambiguous responses

Extract the existing pre-finish SRP/KDF proof construction from
[authentication](../../../packages/client-runtime/crates/bittery-client-core/src/authentication.rs)
once. Keep the existing profile pin/downgrade checks, Secret Key validation, legacy auth-key string
conversion, SRP group/hash/iterations and wire proof. Do not call `authenticate` or `finish_login` as
a convenience: they create a Session. Discard the derived MUK and all password/auth-key/proof material
after the invocation; never persist them in an Operation, settings cache or retry closure.
The existing TypeScript proof does not update the password-entry timestamp; preserve that behavior.
A reconciled disabled policy cannot count as a successful local password ceremony.

Serialize policy exchanges and application through the existing Account execution owner, with an
internal already-fenced helper to avoid recursive acquisition. Thread the existing cancellation and
bounded authentication-renewal allowance through each foreground attempt and reconciliation. Do not
add a Travel mutex/cache/runner. Local-access and native callers reuse the same apply boundary rather
than overwriting metadata with replies fetched before a newer policy. Account incarnation/replacement,
owner loss and captured scope still fence delayed replies. Server timestamps are evidence, not a
strict monotonic revision: events omit them and millisecond parsing can collapse distinct values.

Once a disable POST has been dispatched, do not automatically send that proof again, even after an
authentication-looking failure. Its one-use consumption cannot be inferred from transport status.
For a lost/ambiguous answer, perform one bounded current-policy reconciliation using the existing
Session path. Disabled policy can confirm the requested configuration; enabled policy requires a
fresh password gesture; unavailable current policy reports uncertainty. Save-selection and enable
ambiguity follow the same read/reconcile rule, without a durable mutation replay promise. A differing
current selection is reported truthfully and is not overwritten to manufacture this caller's success.

Cancellation before dispatch creates no remote effect. Cancellation after dispatch means the caller
no longer waits; it cannot promise rollback. Drop transient proof material, retain only previously
verified policy, and let the existing Sync/current-policy owner discover the actual state. If a valid
response has already established policy, apply it under its captured scope even when the caller loses
its wait: once persisted, erasure is an existing lifecycle duty, not cancellable foreground intent.
No background password retry is created. Clear host password input after every attempt/cancellation,
including `RetryRequired`/`Uncertain`; a retry obtains fresh user entry.

### One verified-policy and erasure owner

Reuse `prepare_verified_travel_policy` for command responses and authoritative GET. Validate the
existing100-ID bound and reject malformed/duplicate identity or inconsistent timestamps before
installing metadata. Preserve verified cached policy on transport failure; malformed, unauthorized or
unverified responses must not become cached-offline success or disabled policy.

The Server's [Travel Sync event](../../../apps/server/src/domains/vaults/travel_mode/mod.rs) contains
only `enabled` and `hiddenVaultIds`. Treat it as an invalidation requiring the bounded authoritative
GET, not as a complete metadata document with invented timestamps. Process it before ordinary Item
publication, native authorization, new-work admission or cursor advancement past that event. If the
read cannot finish, retain the old verified policy and pending refresh; do not expose authority from
a later Bootstrap as though Travel had been verified. The existing live-Sync owner handles quiet SSE,
reconnect and restart; do not add host polling. Settings replies, sign-in, biometric/native checks
and incoming Sync converge through the same policy-installation and retirement boundary.

For newly hidden IDs, begin the existing70 `Retiring` fence and invalidate plaintext/key authority
before any awaited metadata/purge write. Persist the verified policy in the exact Account incarnation
before acknowledging it. That document is71's durable pre-purge proof; restart reconstructs retirement
from it before unlock/publication. A failed proof write reports storage failure, leaves the live fence
closed for a bounded retry, and cannot claim durable completion. The command is not a durable Operation.
Follow the reviewed70 ordering below for atomic all-generation purge/journal, concurrent host/Core
drain, exact Session replacement and cleanup acknowledgement. A later disabled response does not
skip an earlier erasure duty or revive its old grants: finish cleanup, then perform fresh re-admission.

Erase hidden Vault/key/Item authority in every active, staging and historical generation; decrypted
projections and queued deliveries; source/sink/image selections and claimed resources; protected Share
results; and unnecessary local files/artifacts. Keep unrelated Vaults and Accounts usable. Prune both
effective borrowed and dormant independent Session wrappers, including Vault keys without cached
rows. Preserve the Account MUK/private-key envelope only as already authorized for other visible
Vaults; no host retains a separate hidden key. Advance native source key authorization and sequence
through the existing68 owner. A connected Extension applies its own purge and Session pruning before
accepting the new source authority; stale transfer replies, disconnect/reconnect or broker restart
cannot restore hidden authority. Desktop retains lock authority over the connected Extension.

Decision65's sole exception remains immutable encrypted accepted-work evidence and indispensable
encrypted artifacts. It grants no reads, new work, resumed transcryption or key recovery. Exact
already-frozen ciphertext dispatch/outcome reconciliation may continue without erased keys through89;
an accepted preparation requiring those keys waits. Preserve original IDs/bytes and required recovery
coverage until the shared outcome/cleanup owner releases them. Do not hide this work by deleting it,
and do not decrypt a hidden optimistic overlay merely to render pending status.

Disabling preserves the configured hidden-ID selection. It first establishes current disabled policy,
then uses ordinary complete Bootstrap/current wrapped-key authority and existing guarded Session
replacement to restore access. Rebuild effective/dormant key material from verified current authority,
never from an old Session clone or accepted creation wrapper. Open new86 capability generations only
after prior cleanup and current validation; old picker, export and native scopes stay retired.

### Retrying a selected retirement before its proof is durable

A failed or lost metadata-write acknowledgement must not strand an already-fenced Vault or let a
newer disabled response erase its cleanup scope. The existing transient
`VaultRetirementProof::VerifiedTravelPolicy` may retain the original validated policy as shared
immutable evidence, bounded by the existing100-ID response contract. This is solely evidence for
retrying the exact metadata proof → atomic `RetireVaults` journal → cleanup duty. It is never current
policy authority, a pending-verification answer, cached GET fallback, or permission for reads, new
work or native export. No additional map, policy cache, queue or runner is added.

Under existing Account execution, reread durable Replica/journal first. If all captured Vault IDs
already have journal duties, replace the transient proof with `DurableJournal` and resume those
duties without rewriting superseded Account metadata. Otherwise persist/reload the captured exact
policy for that incarnation before creating its journal. Replace the shared payload with the
existing durable-journal proof immediately after journal success. A newer reply waits for this
original duty; continuing storage failure keeps its exact scopes closed under the existing retry
owner. Never rebind an old cleanup scope merely to the fingerprint of a different current policy.

Startup reconstructs this same retirement from persisted verified policy before Ready when a crash
followed metadata success but preceded the journal, including Session-only Vault IDs. If neither
metadata nor journal committed before owner loss, do not claim that transient attempt was durable.
Every same-incarnation policy-metadata writer, including local and native installation, must obey
prior-duty ordering. The shared response/document validator enforces100 IDs before retaining proof.
Test metadata failure/acknowledgement loss, journal acknowledgement loss, changed or disabled later
responses and both crash windows; original accepted work remains exact and old grants never revive.

### Pending verification before an incoming policy is known

2026-09-09 reviewed refinement: a known policy invalidation must prevent new authority publication
while its bounded authoritative GET waits. This is a control state in the existing Bootstrap and
foreground admission owners, not another policy cache, Account Lock or speculative Vault retirement.
The last verified policy remains the only policy document; the invalidation event is not a replacement.

Add `policyVerificationPending: boolean` to the existing Bootstrap metadata record and corresponding
`BootstrapAuthority` field. Missing field in an older valid record defaults to `false`; that default
means no recorded invalidation, not verified-disabled policy. Explicit `null`, strings and malformed
records do not receive this fallback. New serialization includes the boolean. The bit can coexist
with Cold, Bootstrapping, Ready or RefreshRequired and does not alter their generation/cursor
invariants. A Cold head with the bit set is control state and must persist its metadata row. Keep the
existing closed metadata validation, physical-adapter schema generation and recovery validation in
agreement; do not add a separate row, database, journal or host-owned flag.

The guarded set/clear transition carries the existing Account/User/incarnation, expected Replica
revision and lock epoch. Set is idempotent and does not advance the Sync cursor, discard accepted work,
change lock state or claim a hidden Vault. An older reply cannot clear a successor's pending state:
serialize exchange/application through the existing Account execution owner, then check its current
captured guard. A fresh full Sign-in installation has its own verified policy and incarnation; old
pending work cannot touch that replacement. However, generic `prepare_install`/`bootstrap_clear_writes`
must not silently erase the pending duty during same-Account replacement. Preserve it in the new Cold
head until the common verified installation boundary consumes the fresh policy proof; do not preserve
old active/staging authority just to retain the bit. Existing retirement-journal duties still survive
replacement and must complete. A failed, interrupted or unverified install cannot clear either duty.
Account removal/Wipe may remove the old control row as part of their existing complete teardown.

Preserve this bit through every same-incarnation head transformation: begin/stage/promote/abandon or
cleanup Bootstrap, mark RefreshRequired, ordinary cursor advance, direct/structural Sync, retained
receipt reconciliation, selective Vault purge/journal acknowledgement, reload, and guarded recovery
or re-Bootstrap. None is an implicit policy-verification success. Bootstrap promotion and cursor
advancement past the invalidation are refused while pending; merely preserving the bit beside newly
published authority is insufficient. Recovery must not replace a live pending bit with an older
archive's false/default value. If its authority rebuild discards the head, retain the gate or require
fresh verification before publication. Include the field in physical row round trips and recovery
coverage; malformed control metadata cannot silently become an offline verified success.

At invalidation detection, begin an admission-only fence for the exact Account incarnation inside
the existing foreground registry/publication boundary before awaiting the guarded marker write. It
contains no policy payload or inferred hidden IDs. Keep it until the durable bit has taken over; a
failed or ambiguously acknowledged write keeps live admission closed while the existing owner reloads
and retries. Do not start the GET before this durable boundary. A failed write cannot claim durable
knowledge across a crash. The unadvanced cursor and startup/current-policy ordering must prevent a
later Bootstrap from swallowing the unprocessed invalidation.

Both this short precommit fence and the durable bit gate fresh plaintext Item/protected-result
projection construction and final delivery, new read/work admission, and native key authorization or
final encoding. A callback queued before invalidation must recheck before beginning; cached data is
not an exemption for a fresh plaintext response. Already-delivered confirmed UI and already-admitted
loans may remain until verified selective retirement; do not cancel them or erase keys merely because
the current answer is unknown. Nonplaintext Account/Operation status and Sync/control admission remain
available; exact already-accepted ciphertext dispatch remains eligible under the pending gate. The bounded policy GET
still holds the existing Account execution lock, so same-Account dispatch cannot execute concurrently
through that lock. After a failed/cancelled bounded check releases execution, prove that eligible
ciphertext dispatch progresses while the durable pending bit remains set. Other Accounts can progress
during the hold. In particular, the Sync owner must not block its own target-free foreground lifetime.
No broad Account/Vault retirement or fabricated locked projection represents this wait.

Native admission and established source authority are distinct here. Preserve the already exported
source state and key generation while policy is unknown. Do not broadcast
`key_authorization_available = false` for this pending gate: `apply_source_snapshot` currently treats
that flag as established authority loss and retires the consumer Account, including existing loans.
Instead, check the same Core pending-admission gate when beginning a new export and at final encoding,
without withdrawing existing grants. Verified selective retirement owns the later actual generation
advance, Session pruning and stale-grant retirement. Test a connected consumer with an existing loan:
pending verification refuses new exports/encoding without a false unavailability update or broad
consumer retirement, then the verified selective change retires exactly its proved authority.

On unavailable GET, cancellation or owner loss, preserve the bit, old verified document and cursor;
resume through existing Sync reconnect or explicit refresh, without a cached-policy success or host
poller. On reopen, reconstruct its admission gate before normal ready/native/local-access publication.
On a fresh valid response, establish selective fences for the now-proved hidden IDs and persist the
exact verified-policy proof before clearing the pending-verification bit under the captured guard.
Once those durable duties exist, clear the Account-wide verification gate promptly; the exact Vault
fences/journal own their remaining cleanup, so unaffected Vault admission can resume subject to the
existing Account execution lock. This does not promise new same-Account work during a held execution
section or require another cleanup runner. A later disabled policy never skips an earlier erasure duty. A crash after proof but before clear safely rechecks;
a crash after clear resumes the already durable proof/journal. No pending-state transition itself
reopens old picker, Export or native generations.

Test the ordering before integration: hold the marker commit and GET independently, queue a plaintext
callback before invalidation, and attempt fresh Items/read/work/native delivery while held. None may
begin. Nonplaintext status and unrelated-Account work progress during the held GET; after bounded
failure/cancellation releases Account execution, same-Account exact accepted ciphertext dispatch must
progress with the persisted pending bit still set. Sync/control remains admissible and preexisting
UI/loans are not broadly revoked. Verify old-record missing-field default, strict malformed-field
rejection, Cold pending persistence and preservation/refusal across every head transform above.
Race delayed replies and Account replacement, including `prepare_install`/`bootstrap_clear_writes`
and interrupted same-Account installation; restart after marker, after verified proof and after
clear; lose GET and storage acknowledgements without clearing the gate. Finally prove that after
verified proof clears the pending gate and existing execution ownership permits admission, unaffected
Vault work resumes while the selected Vault remains fenced. Reuse the unchanged real incoming-policy fixture and its existing deadlines after these controlled tests pass.

### Export plaintext lifetime

The actual [archive builder](../../../apps/web/src/lib/runtime-vault-export.ts) retains a frozen Items
projection, downloaded plaintext and ZIP state across awaits. The
[export hook](../../../apps/web/src/hooks/use-vault-export.ts) then retains the completed Blob for a
later Download gesture. Both currently observe only Account departure. Ticket71 must bind all captured
Vaults and exact Account incarnation before handing plaintext to this work, even with zero Attachments.
The lifetime continues through the ready Blob until output, reset, dismissal or cancellation; all
URLs and app-owned plaintext references must be released when it ends. A hide/readmit cycle cannot
revive it. No attempt is made to revoke a file already deliberately exported by the user.

The accepted seam deepens the existing observation/subscription owner with a fixed export snapshot
and existing foreground guards; it does not add an export registry or host visibility policy. Its
initial plaintext uses ordinary delivery tokens. Its terminal retirement signal is nonplaintext and
must be delivered before foreground drain, including Runtime close: revoked plaintext tokens cannot
suppress this cleanup signal. The host latches cancellation, clears ready output, waits for active
builder cleanup and closes its connection-owned observation handle to acknowledge release. Actual
connection/realm loss uses existing bridge-handle cleanup. Merely closing subscriptions after waiting
for their foreground guards would deadlock and is forbidden.

Final output needs admission on that same exact scope after the last await, not a cached cancellation
flag or current Account-ID comparison. A narrow handle operation takes the existing Core foreground
finalization lease under publication; retirement drains an already-admitted output and refuses a new
one. The host releases the lease in `finally` after synchronous browser output; native filesystem
output uses the existing scoped sink finalization. Preserve current ZIP, JSON, category and Attachment
representations; this is lifetime ownership, not a new export format.

The Rust-defined private bridge extends existing observation controls with the following closed
messages, generated under ADR0012 for native and Worker bindings:

- `ObserveVaultExport { accountId, vaultIds }` creates one connection-owned `ObservationHandle`.
  Core resolves and captures the exact Account incarnation and all current visible Vault generations
  under the existing publication owner before releasing a fixed export snapshot. The ordinary
  subscription entry owns its foreground guards; no global export-ID registry is introduced.
- `VaultExportRetired { observationId, reason }`, where reason is `ScopeRetired`, `RuntimeClosed` or
  `ConnectionClosed`, is a terminal nonplaintext control delivery on that connection. It cancels
  queued work before drain and is independent of revoked plaintext delivery tokens. The handle stays
  owned until host cleanup acknowledges by existing unsubscribe/close. A reentrant unsubscribe is
  idempotent and cannot await its own callback; actual connection loss releases its owned handles.
- `BeginVaultExportOutput { observationId }` validates the live handle on the same connection and
  takes its existing foreground finalization lease under publication. It returns an opaque
  `outputLeaseId` stored within that subscription entry, not transferable across connections or
  Runtime incarnations. Missing, closed, retired or already-outputting handles refuse admission.
- `FinishVaultExportOutput { observationId, outputLeaseId }` releases only that admitted lease and
  closes the completed export lifetime. Host `finally` handles output errors; reset/dismissal uses
  ordinary unsubscribe after cancelling ZIP work and releasing Blob/URL references. Connection
  cleanup also releases an output lease after realm-owned work ends. Stale finish cannot release
  another generation's output.

Ordinary unsubscribe is the existing acknowledgement that all work owned by that observation has
ended, including any admitted output. It may therefore abandon a lost Begin reply when the host has
cancelled without starting output; it must not acknowledge while output or builder cleanup still runs.
There is no separate closing-entry registry. During orderly Worker/bridge close, terminal controls and
cleanup acknowledgements for already-owned handles remain available until those lifetimes drain;
only then may the connection detach its listeners. Duplicate close is harmless, and an incorrect
output lease identity cannot release a live observation.

The Core retirement sequence fences first, emits terminal controls outside the publication mutex,
then waits for existing foreground loans/finalization to drain. Browser output admission happens
after the final asynchronous ZIP work; the synchronous URL/anchor operation runs while that lease is
held. Native output holds the same scope through existing sink finalization. Tests cover retirement
winning before admission and admission winning before retirement, held ZIP/Blob cleanup, reentrant
close/unsubscribe and connection loss. Root reviewed and accepted this ordering; it does not promise
to retract a file whose output was already admitted and completed.

### Observable acceptance and readiness

| Scenario | Required evidence and boundary |
| --- | --- |
| Save/enable/disable | Real Core plus Server: empty saved selection, nonempty enable, all-visible/read-only/shared Vault choices, enabled-selection refusal, max100 validation, retained selection after disable, correct/wrong password and no new Session row/token or stored proof. Actual Desktop settings gestures remain66/73. |
| Ambiguous foreground result | Physically lose the disable response after Server commit and before commit; bounded GET confirms disabled or reports fresh-password retry. Make GET unavailable and prove uncertainty preserves prior verified policy. Repeat for conflicting save/enable state, caller drop and Runtime loss; no automatic POST/proof replay. |
| Policy ordering | Hold older GET/command/native/local-access replies across later policy and full Sign-in replacement; no rollback of verified state. Process real `travel_mode_updated` events before cursor/publication; no synthesized timestamps, quiet-SSE or reconnect bypass. |
| Hidden accepted work | SQLite and generated IndexedDB histories with all Item categories, pending Create/Import/Move and nonempty encrypted Attachment artifacts. Hide while offline/preparing/dispatching, reopen and reconcile exact outcomes. Inspect all generations, journal and both Session documents separately from accepted evidence. Include all-hidden and Session-only keys. |
| Native and Extension | Two Core owners/Replicas, then actual native messaging: Desktop enable while Extension has its own pending work; old borrowed reply, independent Session fallback, disconnect/reconnect, broker recycle and actual Worker loss cannot reveal hidden data. Another Account/Vault survives. Extension autofill/passkeys must not use retired scope. Browser/platform scope remains62/77. |
| Export and other plaintext loans | Actual Web archive with zero and nonzero Attachments: hide during download, ZIP, ready Blob and final output admission; hide/readmit, cancelled tokens, Runtime close, reentrant unsubscribe and lost connection drain without publication/deadlock. Guard actual later Download and revoke stale URLs. Native scoped-file checks supplement, not replace, these application paths. |
| Disable restoration | Fresh verified policy plus current Bootstrap/key authority restores only still-accessible Vaults. Lost membership, changed keys, corrupt data, failed cleanup and stale Session writeback cannot re-admit old scopes. Biometric stays local and does not create a Session. |

Run targeted Core/crypto/transport/lifecycle tests, SQLite/IndexedDB/recovery/conformance and generated
ADR0012 checks, affected host types and isolated Extension Bun files, then required full `pnpm check:ci`
and `pnpm check:ci:rust`. Real Server/native/browser application evidence is separate from controlled
storage/HTTP pause tests. No Travel acceptance test was run while writing this specification.

Prerequisites65/81/86/87/89 are resolved. Native authority68 and convergence70 remain open at this
specification checkpoint. The newly discovered
[plaintext Vault-image artifact frontier92](../issues/92-protected-vault-image-artifacts.md) must also
close: the current SQLite image port stores raw image chunks, so those bytes cannot be called encrypted
accepted evidence. Public Server image representation supplies no local-retention exception. The
selected protected-image mechanism passed independent review and92 is resolved; its delivery
prerequisite93 is ready but remains unimplemented. Ticket71 is now `ready-for-agent` because its
decisions are sealed, with68/70/93 still blocking implementation. Do not declare production acceptance
from a filtered Vault list or from prerequisite specification alone.

## Retirement publication and drain integration frontier

2026-09-09 actual owner review (root, native transfer and selective-capability agents): the durable
journal alone does not fence the interval before its awaited physical commit. Item projections read
`unlocked_items`, and native final encoding can acquire a new delivery token after invalidation.
Use the existing Core foreground Vault-fence owner for transient intent, with `Retiring` and `Retired`
phases rather than another native availability map. Both phases refuse affected new work and
projections. Only unfinished `Retiring` or a durable pending journal blocks source key authorization;
a permanently hidden Vault must not prevent later transfer of the remaining visible Vault keys.
Completing physical cleanup marks `Retired`; only fresh verified authority removes that fence.

Begin intent synchronously against the current Account incarnation, invalidate old plaintext
publication, and advance source key authorization. New projection construction and native final
encoding must read the shared fence, so neither can revive old authority in the pre-commit interval.
Items, writable Vault catalog and pending Share results all participate. Remove affected unlocked
projections using existing exact Operation/Vault ownership, including a Move touching a retired
source whose optimistic target is still visible. Do not merely filter current Vault IDs and leave
those owned effects or protected Share results deliverable. Other Vaults remain unlocked.

Preserve native-state -> publication lock order. Release the foreground registry mutex before
calling the existing native generation hook; native readiness/final encoding may read that registry
under their existing locks. Never retain a synchronous publication mutex over storage or host awaits.
Account replacement/teardown admission and exact incarnation checks fence an old retirement attempt
before it can affect replacement scopes.

A claimed Upload source can be awaiting its platform response while Core owns its foreground loan.
Do not wait for Core drain before initiating host retirement: platform cleanup may be what releases
that response. Start all matching host retirement and Core foreground drain work together, with every
intent fenced before waiting. Retain the existing late-handle cleanup owner and wait for it; dropping
the claim future is not proof that the eventual platform handle was closed. The86 controlled
held-claim regression fixes this consumption order. No additional foreground runner is introduced.

Commit the all-generation purge/journal under the exact current authority proof, complete the matching
resource drains, prune both effective borrowed and dormant independent Session wrappers through87's
guarded replacements, and acknowledge only the captured journal head. A failed commit or cleanup
keeps the duty and fence; the existing Runtime driver resumes it with bounded retry. Full Bootstrap
promotion and explicit verified policy retirement reuse the same owner. Include Session key IDs
without cached rows when deriving retirement, and replay pending duties before unlock/Bootstrap
publication. A retained Delete outcome alone remains insufficient evidence of current Vault absence.

After successful cleanup, native source authorization may resume with filtered Session keys while
hidden-Vault fences remain. Advance the source key generation for that newly usable authority;
ordinary source snapshot sequence is not key-generation identity. Fresh re-admission obtains current
wrapped keys and new scope generations and cannot revive any old picker, accepted-work projection,
queued delivery or transfer reply.

This is a reviewed integration contract for70/71;86/87 capabilities and89 convergence precede its
implementation/acceptance. Required tests include a held physical purge commit with concurrent reads
and native export, held claim cleanup, restart between each journal/Session phase, another visible
Vault, hidden-source Move, dormant independent credentials, and exact-source regrant after cleanup.

### Reviewed 70 implementation refinements

The existing foreground fence payload carries `Retiring`/`Retired` plus its captured Account
incarnation. For an uncommitted 70 retirement it also identifies the already durable, complete
Bootstrap staging generation that proves absence. This is a deeper payload in the existing owner,
not a separate pending-task map. A retry validates current Account incarnation and that proof;
it never substitutes a replacement Sign-in incarnation or reinterprets an incomplete/new staging
catalog as the old proof. Account Lock preserves the same-incarnation Vault fences. A new Account
installation cannot be purged by an old attempt; fresh verified authority owns its re-admission.

For 70, begin the pre-commit retirement intent only after the complete Bootstrap authority has been
staged durably. `hydrate_bootstrap_generation` already stages its final page before promotion. If
promotion fails before the purge/journal commit, leave that complete staging generation available
and keep `Retiring`. The existing driver retries from this persisted proof, and restart reconstructs
the same intent before any unlock, plaintext Bootstrap publication or native key authorization.
It can finish an already complete staged generation without another HTTP request or an unexpired
Session. Inspect current durable state on retry: a lost commit acknowledgement may mean the journal
already landed, in which case resume it rather than invent another promotion. A retained Delete
receipt or a lone Item/Vault GET response is not this durable complete-authority proof.

The 71 explicit-policy path instead uses its existing persisted `VerifiedTravelModeMetadata` as the
durable proof before retirement is acknowledged; its foreground command/lost-response lifetime follows
resolved ticket81. If no proof write succeeded, do not claim the retirement was accepted or completed.
Neither path requires a second pre-purge journal or a new login-equivalent secret.

Promotion must include Session-only key identities in the same atomic purge/journal commit. The
current pure `promote_bootstrap` derives absent IDs only from `bootstrap.vaults`; that misses wrapped
keys with no cached rows. Extend its existing guarded plan with Core-supplied additional candidate
IDs from both the effective borrowed and dormant independent Session documents, captured under
Account execution. Validate their identity shape and absence from the complete staging Vault set,
union them with the existing old-generation IDs, and use the existing 87 journal/persistence shape.
Do not infer deletion from arbitrary cache absence. Do not call standalone `RetireVaults` before
promotion: that existing mutation abandons staging. Do not journal Session-only keys afterward:
a crash in that gap would lose the cleanup duty. A restart has no borrowed in-memory grant, but must
still prune any dormant persisted independent Session before releasing the journal.

#### Retiring a captured complete stage while verification remains pending

The 2026-09-09 pending-stage reproducer requires a retirement-only exception to the preceding
promotion rule. When the existing registry retains the exact complete-stage absence proof but a
known pending policy prohibits authority/cursor publication, the same retirement owner may atomically
replace that proof with its existing purge/journal without promoting the stage. Reuse one omission
selector with ordinary promotion: validate the exact current complete staging generation, collect all
omitted authority-generation IDs plus effective/dormant Session-only IDs and previously captured IDs
for that same proof, and reject any candidate present in the complete stage. Release every captured
Session before fencing or awaiting persistence/cleanup. Local cache absence alone supplies no proof.

The existing guarded `RetireVaults` commit may abandon that stage only in the same atomic transaction
that purges and journals every selected omitted scope. Preserve the active cursor, aggregate pending
marker and exact indispensable accepted ciphertext. Upgrade the original registry proof/lifetimes to
that observed durable journal, then continue the existing cleanup and policy-application owner; do
not publish staged authority, bypass pending admission, add a persistence wire/schema or introduce
another runner. On failed or lost commit acknowledgement, reload exact current durable state and
resume either the still-complete stage or its committed journal. Startup must honor the same proof
and existing verified-metadata reconstruction before admitting current authority.

The same omission adoption must preserve an omitted scope that already owns a different selected
retirement proof. Keep each existing handle and lifetime; capture only missing omitted scopes under
the complete-stage proof. Its durable absence evidence authorizes one atomic purge/journal for the
entire omission union, after which each retained handle adopts the observed journal. Do not rewrite
transient policy metadata merely to adopt that already durable duty, and do not replace an existing
proof before the joint journal is observed. Selected scopes present in the stage remain outside this
omission union with their original proof and ordinary retry. During live verification, this early
path requires an already captured omitted duty so normal first-hide admission ordering remains
unchanged; fresh-owner reconstruction uses the private startup phase. Rejected commit retains the
complete stage, while lost acknowledgement must recover the entire committed omission journal.

A newly observed policy whose first proof write never became durable retains the explicit
no-durable-acceptance limit above; this refinement does not fabricate persistence for it. Its existing
live registry payload still survives caller loss. After the first pending-stage path passes, verify
failed/lost commit and reopen at this replacement boundary, together with unknown/Session-only and
mixed policy/native scopes. The exception preserves an already durable omission duty; it is not a
general permission to discard a complete stage before replacement proof is durable.

Run retirement resume before ordinary dispatch eligibility. `dispatch_eligible_operations` currently
skips Accounts without Operations or image-cleanup receipts and parks reauthentication-required work;
those conditions must not park transient proof-backed retirement or a durable retirement journal.
Use the same Runtime driver wake/backoff and Account execution/lifecycle fences. Resource cleanup and
wrapped-key removal do not require Server authentication. Preserve exact guarded Session replacement;
its internal cleanup access must remain usable while source key *authorization* is blocked. A source
readiness predicate is not the cleanup primitive's admission predicate.

Begin the target fence, invalidate existing plaintext delivery tokens, and evict/filter affected
unlocked projections in one short `publication` critical section. The lock order remains publication
before the foreground registry; never acquire native state while retaining either mutex. After that
section, the existing native generation hook may take native-state then publication: final native
encoding must independently reject `Retiring`, closing the interval before the hook runs. On
completion, advance native key generation while still `Retiring`, then mark the captured cleanup
`Retired`; no old reply becomes usable between those steps. Both phases still exclude target
projections and new target work until explicit fresh-authority re-admission.

Projection construction and final decrypted-cache installation both consult the shared fence.
`decrypt_visible_items_with_publication` currently computes outside publication and later writes
`unlocked_items`; its final install must revalidate/filter under publication so late computation
cannot restore evicted plaintext. Filter affected optimistic effects by exact accepted Operation
ownership, including a Move whose source is retired and target remains visible, and filter protected
Share results before decrypting/publishing them. Add the transient fence to the existing shared Core
Vault-admission check used by Create/Update/Move/Import and Vault mutations; the durable snapshot
journal check alone cannot cover the pre-commit interval.

Writable Vault catalog deliveries currently have no delivery token. Reuse the existing Account
`DeliveryToken` owner for zero/one/multiple contributing Account tokens: Items/Share use their one
Account, the multi-Account catalog captures each contributing Account, and delivery enters all
required tokens before invoking the callback. Thus an already queued catalog cannot expose retired
Vault names after invalidation. This needs no fake Account identity or separate catalog policy owner.
Existing callback/invalidation lifetime rules, including reentrant delivery, continue to apply.

Startup integration uses the existing exclusive catalog/open transition. Load and validate the
Account Replica/catalog identities, install the private restored cache while public readiness remains
false, then resume complete staging and cleanup before setting ready. Deepen the existing guarded
Session replacement primitive to support that initialization phase under the same exact incarnation
and document checks; public authentication/admission still requires an open Runtime. Do not temporarily
mark the Runtime ready to reuse a cleanup helper. Opening failure retains durable proof and permits
retry; no plaintext observation or native key authorization can escape the incomplete open.
The internal cleanup accessor reuses the existing Account execution lock map with not-closed and
validated private-cache incarnation checks; the ordinary accessor still requires readiness. Resume
must not reacquire the catalog transition already held by open. Close records its intent before
waiting for that catalog guard, so held storage/capability responses recheck close before writes.
Final publication uses the cache after cleanup, never the original restored snapshot vector that
could overwrite a newer purge or acknowledgement.

### Test-first integration order

1. Hold/fail actual SQLite promotion after complete staging. While its journal is absent, query
   Items, writable catalog and protected Share results, and encode a previously prepared native
   reply. The affected authority is unavailable; another Vault remains usable. Release/fail the
   commit, drop the initiating waiter, and prove the existing driver retries without an Operation
   or valid Server Session. Also cover lost commit acknowledgement by reloading physical state.
2. Add a Session-only hidden key with no cached Vault/Item rows, in both effective and dormant
   Session documents. Promote complete authority excluding it and crash immediately afterward;
   reopen must find its ID in the existing journal. Reproduce failed Session replacement, stale
   refresh writeback, and restart before/after each prune and journal acknowledgement.
3. Pause after capturing the complete staging proof, perform a full Sign-in replacement, then
   resume the old attempt. No replacement-generation authority, wrappers or capabilities may be
   changed. Also test same-incarnation Lock/unlock preserving hidden fences and explicit new
   verified authority obtaining fresh scopes only after cleanup.
4. Reuse 86's held asynchronous upload-claim regression with composed host retirement and
   foreground drain. Include a held read/write/accepted image and a hidden-source Move; unrelated
   Vault/Account loans survive, and indispensable accepted ciphertext remains durable.
5. Pause decrypted projection computation before its final install and queue Items, protected
   Share and multi-Account writable-catalog deliveries before intent. None may reappear after the
   fence; reentrant callbacks and invalidation still drain safely. Run native export at each
   pre-commit/journal/prune/completion boundary and verify a fresh post-cleanup source generation
   can transfer remaining keys while the hidden Vault remains fenced.
6. After the bounded tests and SQLite/IndexedDB parity, rerun the real native/Core/Server deletion,
   reconnect/restart and Desktop–Extension authority paths. Supported UI/OS acceptance and full
   phase CI remain separate required gates; the controlled pauses do not establish those paths.

Native final-encoding detail: `deliver_reply` currently calls `require_source_channel_in` while
holding native state, then `deliver_account_scoped` acquires publication and creates a delivery lease.
Checking `Retiring` only in the former leaves a check-to-lease race. Revalidate source key generation,
retirement/journal readiness and exact scope inside the same publication section that acquires the
existing delivery token. A narrow validation callback in the existing scoped-delivery helper can
reuse its Account/epoch/token/reentrancy rules; do not duplicate them in native encoding or widen
ordinary Device setup policy unnecessarily. A lease acquired before the fence remains subject to the
existing invalidation/drain rule; no lease acquired after it may authorize old source keys.

### Selective Attachment artifact cleanup refinement

The existing Attachment `SweepOrphans` primitive proves an exclusive Account startup boundary and
scans all Account generations. A Vault-only retirement cannot assert that boundary while an unrelated
Vault preparation is active. Existing physical artifact and provisional rows identify Account,
Operation, Attachment and generation; they contain no independent Vault identity. Never infer that
identity from an opaque artifact ID or delete another preparation's unpublished rows.

Extend that existing store with a closed `SweepOperationOrphans` primitive, scoped to sorted unique
Operation IDs selected by Core from the exact captured Replica. Select retained preparations and
embedded Move recovery when either source or target Vault is retired; terminal Move receipts whose
recorded target Vault is retired also prove a now-unowned cleanup scope. Keep all exact encrypted
owners returned by the existing accepted-work ownership helper. Additionally preserve the exact
provisional Attachment scopes of retained `Pending` progress: a writer may already have completed a
recoverable publication before its Replica checkpoint acknowledgement was lost. Its ciphertext is
accepted-work recovery evidence even though the Replica has not yet recorded `Encrypted` progress.
Preserve all generations of those pending scopes conservatively; this does not authorize new reads,
transcryption or key recovery after retirement.

Invoke the scoped cleanup only after selected host capabilities and Core loans have drained, while
holding the existing Account execution fence and validating the captured incarnation. It leaves all
rows outside the selected Operation IDs untouched, preserves every retained owner/generation, and
reuses existing physical stores and formats. Store failure keeps the Vault retirement journal pending
for the existing bounded retry owner. Do not silently fall back to an Account-wide sweep.

Orphan-only Operation IDs with no surviving Replica scope, and old target-only receipts that cannot
prove a hidden source Vault, remain the existing exclusive-startup orphan owner's responsibility.
Their Vault identity is not reconstructed by guesswork. The selected live source/sink capability
owner separately drains unaccepted foreground files. Protected Vault-image cleanup uses its existing
exact Account/Operation scope and ticket93's storage owner; do not sweep an unrelated active ingress.

The reproducer uses real store writes/publication/recovery primitives: one selected retained encrypted
generation, a selected pending recoverable publication, a selected unowned terminal Operation, and an
unrelated held writer. Cleanup must erase only the proven unowned rows and remain retryable after an
injected physical failure, with SQLite and generated IndexedDB contracts agreeing.

### Retirement progress across Accounts

The existing dispatch owner retains per-Account retirement attempts across wakes. A held execution
fence, foreground loan or native file drain for Account A must not prevent a later independent
Account B's retirement or eligible work from being discovered. The ordinary scan skips only Accounts
with active retirement attempts or pending retirement fences, and uses the existing bounded backoff
for failed local duties. Account-scoped attempts share the existing execution fence; a second
retirement scheduler, host timer or copied cleanup policy is not introduced. Closing the dispatch
owner drops its retained attempts, while the durable journal and existing foreground retirement
proof preserve recoverable duties. Test A held, B admitted later, B completes before A is released;
also retain the physical apply-then-acknowledgement-loss and startup recovery cases.

A completed local retirement keeps its `Retired` fence until fresh verified current authority names
the Vault again and all selected host readmission acknowledgements finish. Physical promotion can
precede a failed host readmission acknowledgement: therefore the existing driver also derives retryable
readmission work from `Retired` IDs intersecting the current authoritative generation. Its retry
deadline remains in that existing fence entry and its captured proof must match when a failed attempt
defers. No new persisted readmission record, scheduler or host policy is introduced. Account execution
orders fresh authority, host acknowledgements, final publication validation and removal of the selected
fence; a stale callback cannot readmit a newer hide cycle. Old foreground publications stay cancelled
when fresh work receives a new scope. This reconciliation runs without Session/Operation eligibility.

If both the image checkpoint and its durable retry write fail, the same Operation dispatch lease may
retain a bounded retry deadline. The existing scan continues unrelated work and waits for the earliest
lease deadline; another wake cannot bypass it. Lease release/defer checks an opaque registration
identity in the existing entry, so an expired handle cannot mutate its successor even when clock
saturation gives equal deadlines. This supplies no additional scheduler, persisted retry document or
host responsibility. A genuine staging contradiction is resolved inside its captured Account execution
scope through the same guarded failure/retry helper as retained Create-Vault replies.

### Prepared browser Runtime capability cleanup

Actual combined-Worker startup may resume a durable Vault retirement before the Web host commits
its prepared Runtime incarnation. The existing two-phase capability owner must permit only
`retireVaults` and `completeVaultRetirement` (alongside its existing `retireRuntime`) for that exact
prepared incarnation. It continues to refuse foreground capture/grant/claim and every foreign or
retired incarnation. This is local cleanup under Core authority; it does not publish an unlocked
Runtime or admit new work during `open()`.

Reset the prior Runtime's Vault scope epochs after successful prepare drains its old capabilities,
before Core startup can issue cleanup. Commit preserves the new incarnation's startup retirement
fences. Resetting at commit would silently readmit a Vault after startup cleanup. A real Chromium
crash/reopen history and source/sink tests must prove the selected Vault remains fenced across commit,
unrelated Account/Vault scopes remain independent, and only later explicit Core readmission clears
the selected fence. Failed preparation or foreign callbacks cannot clear an existing fence.
