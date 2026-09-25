# Cross-Account Item Move

This specifies the shared Core capability required by Desktop's existing Move dialog and drag/drop.
[Research83](../issues/83-runtime-cross-account-item-move.md) records actual callers and the accepted
explicit destination reauthorization decision. [Ticket90](../issues/90-runtime-cross-account-item-move-workflow.md)
records the reviewed implementation contract below; its dependencies still gate implementation. This document does not establish application acceptance.

## Decisions and existing seams

A Move may cross both Accounts and Servers. Core owns one source-Account workflow, including target
creation, bounded Attachment transfer, source trash/delete, retry and reconciliation. Hosts submit
intent and render its projection. Filtering destination Accounts from Desktop is not a substitute.
All existing Item categories and shared/private Vault permissions use the shared Item/key helpers.
The same-Account Move remains its existing operation; it must not acquire an unnecessary second
workflow owner.

The destination Item ID is allocated once. Every accepted HTTP step keeps its original operation
identity, method, route, strong precondition and exact body bytes. Server fingerprints are over raw
bytes, not equivalent JSON values. A retry never regenerates destination ciphertext, target IDs or
accepted Attachment registration identities. Existing Session selection, including borrowed native
Session provenance, remains the only network-authorization owner; no Session or live key is persisted
inside workflow evidence.

Reuse the retained-result/current-authority separation from
[89](../issues/89-retained-results-current-authority.md). A successful retained create proves that
step's result; it does not authorize recreating a currently missing target. A GET 404 does not prove
that the source destructive step succeeded. Applied source trash and permanent-delete receipts must
be checked rather than treating any successful HTTP exchange as semantic success.

Reuse shared artifact/recovery and binary capabilities from
[69](../issues/69-desktop-native-binary-and-recovery-capabilities.md), shared-Vault key access from
[85](../issues/85-shared-vault-item-creation.md), and selective Vault retirement from
[70](../issues/70-runtime-vault-update-and-delete.md). The existing
[AttachmentMoveTranscryptor](../../../packages/crypto/core/crates/bittery-crypto-core/src/attachment_move.rs)
already supports distinct source and target scopes. Preserve the existing AES-GCM/AAD envelopes,
metadata encoding and Item encryption; no new cryptographic algorithm or whole-file host decryptor.

## Admission and durable evidence

The public intent names source Account/Item and destination Account/Vault. Extend the
existing Move intent with an optional destination Account whose absent value means the source. Core, not the UI, decides which
existing implementation owns the intent. Admission captures both canonical Server/User identities,
current incarnations and access generations, source version/category/Vault, destination permissions,
the fixed target Item identity and encrypted Item payload. Source projection remains visible pending
completion, as in Desktop today.

The workflow must represent:

- Stable semantic Operation identity and source ownership, independent of child HTTP attempt IDs.
- Original canonical source/destination identities, original target Item identity and accepted source
  baseline, plus the current destination binding and a revision for explicit reauthorization.
- An accepted Attachment manifest and bounded immutable encrypted artifact references, with their
  source and destination AAD scopes and exact registration metadata.
- Individually immutable prepared HTTP steps, fingerprints, scheduling and retained semantic results.
  Target creation and source trash/delete retain their original stable child identities; legacy
  Attachment steps retain their actual attempt-specific identities.
- Bounded phase/wait/block reasons sufficient to distinguish transient lock/offline, destination
  removal requiring explicit reauthorization, changed content, missing proof and terminal rejection.

An umbrella fake HTTP request must not stand in for a two-Server workflow. The current
[OperationRecord](../../../packages/client-runtime/crates/bittery-client-core/src/replica/domain.rs)
assumes one immutable request. Use the closed source-owned workflow row specified below, preserving existing ordinary
Operation bytes and permitting atomic source projection/workflow admission. Do not serialize a mutable request into that existing immutable field.

Both Account fences are acquired in deterministic order for shared admission/finalization. Async
network and file work carries both scopes and rechecks them after awaits; synchronous publication
locks are never held across I/O. Retirement of either Account or participating Vault prevents new
plaintext release and remote dispatch under that old scope. Retained encrypted evidence grants no
permission to reopen hidden or removed Vaults.

## Execution order

1. Admit the no-Attachment vertical slice durably before widening. Reconcile authoritative source
   and destination state and retained child outcomes. Existing target content must match the exact
   accepted identity, Vault, category and encrypted payload. Source must match the accepted version
   or the precisely proven subsequent source step; ambiguous or changed state blocks further work.
2. Prepare/reuse the immutable target create request and retain its result. A rejected target create
   preserves the source. An already-created matching target is reused only with sufficient retained
   evidence; do not overwrite or delete its content.
3. For Attachments, capture an exact accepted manifest and prepare bounded target ciphertext once.
   Use the shared authenticated transcryptor; provisional output cannot become dispatchable until
   authenticated finish succeeds. Seal the encrypted artifact and exact registration request before
   upload/registration dispatch. A crash resumes the same artifact/step. Changed or extra target
   Attachments block the workflow; never reproduce legacy retry's deletion of every target file.
4. Verify the complete expected target Item and Attachment set, original source baseline and both
   current authorization scopes before preparing source destruction. Retain exact source trash and
   permanent-delete requests and inspect each semantic result. A rejected or unproven step leaves
   the workflow blocked with its evidence; it cannot synthesize completion from absence alone.
5. Publish completion only after every required result is proven. Shared Sync supplies current
   authority; old retained receipts cannot reintroduce deleted data. Release workflow artifacts only
   when their exact evidence/cleanup duties permit it. No cancellation or local removal compensates
   by deleting an already-created destination Item.

This is a distributed workflow, not an atomic transaction across Servers. The Server's strong
preconditions protect individual writes. Target verification before source deletion cannot lock out
an unrelated Server writer indefinitely; tests and UI must not claim a stronger cross-Server atomic
move guarantee than the supported API can provide. A detected edit or unproven outcome stops further
steps and preserves the available source/evidence.

## Retirement and explicit resume

Transient lock, offline state or actual Runtime loss retires live work and preserves accepted
ciphertext for normal guarded retry. Destination Account removal/replacement is different: its
binding becomes retired. Re-add or unlock alone must not resume remote mutations.

The accepted explicit Resume command names the source workflow and proposed current destination,
with a Core-issued workflow/binding revision guard. Core verifies the exact original normalized
Server URL and Server User ID, both current Accounts' generations and permissions, original target
Item identity, unchanged expected Item/Attachment content, retained child outcomes and required
artifacts. It durably replaces only the destination binding after all checks succeed. A different
Server/User, stale confirmation, target edit or missing proof leaves the workflow blocked. The
semantic Operation, target Item and accepted child request identities do not change. Hosts do not
compare identities or decide whether a recovered workflow is safe to resume.

Source removal ends source-owned local work and artifact ownership, while preserving normal teardown
failure reporting. Target removal must preserve source-owned accepted evidence and stop dispatch
before target key retirement completes. Use the catalog retirement ordering specified below: durably record target-incarnation retirement
intent, then record the retired destination binding in each affected source workflow before reuse,
then complete target removal through existing Core lifecycle fences. A failed source-store write
must fail closed and remain recoverable; it cannot permit a later re-added target to resume silently.
Startup must detect absent or changed destination incarnation even if removal crashed before the
workflow write. No second host retirement registry or global keychain reset is introduced.

Encrypted transcrypted artifacts belong to the source workflow even when their crypto scope is the
destination Vault. Use the existing artifact contract's distinction between durable owner and source/destination
authorization, as confirmed below, so target teardown cannot discard the only accepted ciphertext.
Use the same artifact backend, cleanup and recovery journal; do not create a cross-Account file cache.

## Existing-profile admission

[82](../issues/82-existing-profile-runtime-handoff.md) must decode the real legacy queue into this
owner before production startup enables normal dispatch. Preserve semantic identity separately from
replaceable HTTP attempt identity, original target Item and accepted step IDs. Prove exact legacy
body serialization against TypeScript-produced vectors, including Unicode, numbers, omitted fields
and property order. Unsupported or unknowable in-flight evidence remains blocked and recoverable;
do not guess a new mutation. The legacy executor is removed only after its final caller/queue owner
migrates, including remaining applications that still consume shared transitional code.

## Review gates and test sequence

Before ticket90 becomes ready, independently review the closed persisted workflow/child-step shape,
source-owned artifact scopes, target teardown durability and exact public Resume guard. These are
routine engineering frontiers under the accepted product decision; no further product choice is
currently identified. Record the selected concrete shapes and migrations before writing production
code. Dependencies must be complete before starting a vertical slice.

Test first in this order:

1. Real durable source/destination Replica, no files: stable target ID, target refusal, interrupted
   target create, lost retained response and exact trash/delete outcomes across restart.
2. Both Account and Vault fences: source/target lock, owner loss, removal, replacement, wrong identity,
   same-identity re-add without Resume, successful explicit Resume and stale confirmation. Verify
   neither target edits nor unproven outcomes trigger deletion/recreation or source disappearance.
3. Nonempty bounded Attachment artifacts: partial input/output, authenticated finish refusal, dropped
   dispatch, restart at every sealed step, source/target file edits, teardown and recovery ownership.
   Include a file larger than transport chunks and assert preserved plaintext/metadata after transfer.
4. Different Servers and independent Accounts, every supported Item category, shared/private Vault
   roles, permission/plan rejection, offline reads/writes and reconnect convergence. Exact outcomes
   must come from real Server paths in acceptance, not only mock APIs.
5. Actual Desktop dialog and drag/drop after cutover under
   [73](../issues/73-desktop-production-acceptance.md); Extension only where its inventoried callers
   expose this action, under [77](../issues/77-extension-production-acceptance.md). No Desktop acceptance
   from compilation or a direct Core test alone.

Run affected Core/storage/conformance/generated-contract checks and required full `pnpm check:ci`
and `pnpm check:ci:rust` before phase completion. Record actual artifacts and remaining blockers.

## Independent engineering review (2026-09-09)

The bounded review selects a closed source-owned workflow row alongside existing durable preparation
rows, atomically admitted with its source overlay. Use fixed target-create, Attachment-index,
source-trash, source-delete and terminal stages. Each immutable child records a Source/Destination
endpoint role and the existing request/fingerprint/result representation. One workflow scheduling and
claim owner uses existing dispatch/auth/outcome primitives; child requests are not independently
scheduled Operations in different Account stores. Freeze each child checkpoint before dispatch.
This preserves ordinary Operation request bytes and avoids an umbrella pretend HTTP operation.

Persist destination Account/incarnation, binding revision and Active/Retired state. Per-attempt access
and lock epochs remain temporary guards; ordinary lock/unlock must not retire the durable binding or
require Resume. Explicit Resume includes candidate Account/incarnation and expected binding revision;
one source commit replaces that binding after verification and retains all children/artifacts.
Verification includes expected current Item version, favorite/trash flags and exact Attachment
identities/metadata, in addition to ciphertext, category and Vault. Otherwise a metadata-only edit
could evade the accepted no-edited-target rule.

The existing artifact publication contract already separates durable ownership from cryptographic
scope: ProvisionalAttachmentArtifactScope/AttachmentArtifactOwner bind source Account/Operation/file,
while AttachmentPublicationIdentity can retain that owner with the destination User and Blob scope.
Reuse those existing validations and backend; no new artifact schema/cache is necessary merely because
the target User differs. Both Account authorizations still guard preparation and dispatch in Core.

The review identified the following durable retirement gap; the accepted catalog solution follows.
Current pending teardown is memory-only and the DeviceCatalog has no removal intent. An absence check
at startup misses a crash after removal intent but before the first source workflow write while the
target incarnation remains intact. The accepted minimum is an exact-incarnation pending retirement
in the existing Account catalog/lifecycle owner, durable before cross-source binding retirement.
Under teardown admission, catalog ownership and sorted affected Account fences, mark referring source
bindings Retired before deleting target state/catalog. Failures retain that intent. Startup, dispatch
and re-add drain/check it before admitting new authority; Account replacement/Full sign-in crosses the
same barrier. An unreadable source store cannot mean that no workflow references the target. Reuse
existing lifecycle recovery, not a new host registry or scheduler. The accepted shape is recorded
below; this paragraph is not an implementation claim.

Add deterministic crashes before/after retirement-intent persistence and each source binding write,
with two source Accounts and a source-store-open failure. Prove a sealed source-owned artifact survives
target removal and explicit verified same-identity Resume. Existing no-file lost-response and actual
Server acceptance gates still apply.

### Catalog retirement verdict

Parent architectural review accepts an optional `pending_retirement` field on the existing
DeviceCatalogAccount, omitted when absent so current persisted documents remain unchanged. Its closed
value binds the exact active incarnation and a `Remove` or `Replace` purpose. Validate incarnation
agreement; reject simultaneous contradictory pending installation/retirement. Persist this intent
under existing catalog transition/teardown admission before touching any referring source workflow
and before `stage_catalog_install` may begin replacement. It contains no credential or live key.

Acquire the affected Account fences in sorted order, retire every referring workflow binding and
preserve its encrypted evidence. A source-store read/open/write failure leaves the catalog marker
and a visible incomplete lifecycle result; it never counts as an empty reference set. Startup drains
this intent before normal installation/dispatch and target identity reuse. After all reference retirement is proven, retain a Remove marker through target cleanup until
catalog removal consumes it. Atomically consume a Replace marker into pending_install when
`stage_catalog_install` begins; never clear the marker as a separate write before the next durable
lifecycle state. A failed
replacement still requires the existing verified installation path; the intent does not authorize
new credentials or bypass installation validation. Recovery uses this catalog/lifecycle owner, with
no independent host fanout registry or task runner.

The concrete public Resume and workflow schema contracts follow. The selected ownership,
retirement ordering and product policy are settled; ticket90 must not start until its dependencies
are complete.

### Concrete workflow and confirmation contract

The selected persisted `CrossAccountMoveRecord` is a closed source-owned Replica row, separate from
ordinary `OperationRecord`, and uses existing encrypted Item/Attachment, immutable HTTP request,
fingerprint, result, artifact-reference and scheduling types wherever their contracts already fit.
Its required fields are stable semantic `operation_id`; immutable source/destination canonical
Server/User identities; source Item/Vault/category and accepted version/content/metadata evidence;
fixed target Item/Vault and accepted encrypted payload; destination binding; accepted Attachment
manifest/checkpoints; fixed child requests/results; workflow stage; bounded wait/block disposition;
and the existing `OperationSchedulingState`. It contains no Session, password or plaintext file/key.
Use camelCase/closed generated persistence shapes consistent with adjacent Replica records. Old
ordinary Operation records retain their current serialization unchanged.

The destination binding stores current local Account ID/incarnation, monotonic `binding_revision`
and `Active`/`Retired` status. Incarnation replacement/removal retires it; lock epochs belong only to
current attempt guards. Child steps are a closed `TargetCreate`, `Attachment { source_attachment_id }`,
`SourceTrash`, or `SourceDelete` identity, with Source/Destination endpoint role, original Server
operation ID, immutable request/fingerprint and optional retained result. Attachment checkpoints
retain original source identity, fixed target identity, exact encrypted registration evidence and
sealed source-owned artifact publication proof. Transient transfer URLs/Session capabilities remain
in existing binary/HTTP primitive lifetimes rather than becoming workflow authority.

Stages are `TargetCreate`, `Attachments { next_index }`, `SourceTrash`, `SourceDelete`, `Completed`
and `Rejected`. A temporary wait or blocked-evidence reason does not discard the stage/children.
Only one existing scheduler/claim owner drives this row; there are no independently scheduled child
Operations in separate Accounts. Source overlay plus initial workflow are committed atomically.
Use closed `AdmitCrossAccountMove`, `AdvanceCrossAccountMove`, `RetireCrossAccountMoveDestination`
and `ReauthorizeCrossAccountMoveDestination` plan mutations. Validation fixes semantic identity,
canonical identities, target Item and already-prepared children permanently; a child can transition
from absent to immutable prepared to retained result, never to a replacement request under the same
Server identity. Plans check the expected source Replica revision and current binding revision.
Generated persistence schema/conformance histories must cover this row and its strict transitions.

Public Rust-defined controls are:

- Existing `MoveItem` gains optional `target_account_id`; absent or source Account means the current
  same-Account path. A different Account admits the new workflow and returns its normal accepted
  source-owned Operation identity/projection.
- `PrepareCrossAccountMoveResume { account_id, operation_id, target_account_id,
  expected_binding_revision }` verifies the candidate and returns a stateless
  `CrossAccountMoveResumeGuard` with source/target Account IDs, incarnations and lock epochs,
  Operation ID, binding revision, captured source Replica revision and the existing random Core
  owner incarnation (`native_authority.owner`).
- `ResumeCrossAccountMove { guard }` is the explicit reauthorization action. It revalidates both
  current scopes, canonical identities, complete retained evidence, original target metadata and
  exact Attachment set, then performs one guarded source commit. The source Replica revision also
  fences child-state changes while confirmation was pending; do not add a redundant workflow
  revision counter. The owner incarnation rejects guards retained across actual Core loss even if
  durable lock epochs/data are unchanged after reopen; never use a process address or local counter. The guard is stale-input evidence, never authorization by itself. There is no
  new secret token or pending-confirmation registry.

The workflow projection exposes current phase, original destination display identity, source
visibility and bounded wait/block/rejection reasons. The host does not compute eligibility or infer
success from Item absence. Preparation does not itself resume work, and ordinary re-add/unlock cannot
call the guarded reauthorization implicitly. A stale guard leaves the durable workflow unchanged.
The exact generated Rust field types reuse existing public IDs/decimal revision conventions.

For a nonterminal workflow whose durable disposition is Ready or Waiting, Core derives current
availability through the same read-only scope check used by execution. Project pending policy first,
then a locked participating Account, then public-only `AccessUnavailable` if either current scope
is unavailable: pending Account retirement, non-Ready or failed Replica, or missing, ReadOnly or
retired Vault authority. A missing destination snapshot is unavailable. When both scopes pass,
retain the durable disposition, including an existing Offline wait. Do not rewrite accepted rows,
bindings or child requests for this projection; terminal, Blocked and Rejected states retain their
existing meaning. Independent review accepted this bounded refinement after a review found that
execution safely parked cases which the original projection still described as Ready.

The lock reason requires an explicit Locked or SignedOut state for a participant with a current
snapshot. A missing access-map entry or a stale entry for a removed destination does not prove a
lock; scope unavailability handles that case. An explicitly locked source still has priority over
a missing destination. Independent review confirmed this ordering without adding a durable state.

Reuse the existing participant check for accepted source/destination User IDs and both current
Account/Vault scopes. Bound execution and projection additionally require the Active binding's
exact destination Account/incarnation. Prepare/Resume must retain its existing ability to verify
a Retired binding against a new candidate, so the bound check does not belong in its shared attempt
check. Attempt cancellation and target optimistic-Item conflicts keep their existing separate
meaning. Canonical Server authority remains the durable endpoint/Resume metadata check, never
display-only Account presentation. Independent review confirmed this internal helper boundary.

Startup first reconciles pending installation and validates each surviving catalog Account against
its durable metadata/Replica head. Under the existing catalog and sorted Account execution fences,
it drains recorded retirement intent, then inventories every surviving source Replica and compares
each Active binding with that reconciled catalog. An absent destination or a different current
incarnation retires the original binding through the existing exact guarded mutation; it never
selects a replacement. A catalog-listed destination whose own storage is missing or inconsistent
is a startup failure, not evidence of absence. Any source read/write/guard failure blocks Ready;
completed partial retirement remains idempotent on the next open. Reload changed snapshots before
publication, preserve markers and accepted source/child/artifact evidence, and do not adopt orphan
stores as new owners. Independent review confirmed this refinement of the required startup scan.

Operations subscriptions must also deliver destination-only availability changes while preserving
the public source `replica_revision`. Reuse the existing Device revision as a private delivery
dependency, captured under the publication lock with the Operations projection. Within the existing
generation/token scope, order deliveries by that dependency and then source revision; reject an
older captured frame even if it is enqueued after a newer availability frame. A refused frame may
clear only its exact captured delivery identity. Other projection kinds keep their existing ordering.
Pending Account retirement gate entry, purpose change and release advance the existing Device
revision under the same publication lock when the gate changes. This adds no counter, authority
owner or cached plaintext. Independent review and parent review accepted the constant-size witness;
the tradeoff is an additional identical Operations frame on unrelated Device changes. Public
Lock/QuickUnlock observation and delayed/refused-frame histories must prove the behavior before
acceptance.

Parent architectural review approved this public shape and source Replica revision guard. Independent
review accepted the record/child immutability, source-owned artifact and retirement ordering, and
identified the owner-loss confirmation gap. The existing random Core owner incarnation above resolves
it without a registry. Add abrupt loss → same durable data/lock epochs → fresh unlock → old Resume
refusal. Ticket90 is ready with its incomplete dependencies still blocking implementation.

Final self-review found that clearing the marker after fanout but before physical removal/installation
would lose retirement intent on crash because the prior pending teardown is memory-only. Parent
accepted the refined consume ordering above: Remove stays until catalog deletion, Replace is consumed
atomically into pending installation. Add crashes after the last source binding commit and before/
after each final catalog transition. No standalone marker clear is permitted.

## Accepted Attachment upload prerequisite

During ticket90's no-file implementation, investigation found that ordinary Attachment Upload always
allocates a new ID, embeds a 15-minute expiration in its storage key, and deletes expired reservation
rows. Same-Account Move staging requires existing files under the same Server/User and cannot provide
new destination files on another Server. The accepted fixed-ID/restart requirements therefore need
an additional engineering decision before the Attachment slice.

[Research103](../issues/103-durable-attachment-upload-renewal.md) specifies an optional durable request
on the existing grant route, with a client-selected target Attachment ID, sealed ciphertext digest,
retained reservation fingerprint and stable storage key. It reuses the current reservation owner,
exact upload signing and object backend. Immutable original scope survives teardown while nullable
live references make that claim permanently nonrenewable. Expired-object cleanup retains the identity
and a bounded scheduled recheck duty for late PUTs. Renewal, registration and cleanup share one global
Attachment-ID lock across the object I/O decision. Consumed/published IDs cannot
receive overwrite grants. Required signed headers reach the existing binary transport without
becoming durable workflow authority.

Parent and independent review accepted the refined Server contract, including global identity claims,
exact lock order, permanent live-reference retirement and retained scheduled cleanup for late PUTs.
[Delivery104](../issues/104-durable-attachment-upload-renewal.md) owns the required real Server,
cleanup-race and signed-header acceptance. Its readiness is not capability acceptance. The existing
Move product behavior and source-owned artifact requirements continue to govern the Core workflow.

## Attachment implementation refinement

Fresh Attachment refusals are not retained Item results. Parent and independent review select
durable `Waiting(AttachmentAccessDenied)` for source grant denial or target permission/plan 403,
`Waiting(AttachmentQuotaExceeded)` for the existing quota Problem Details code, and
`Waiting(AttachmentSizeRejected)` for the existing typed grant size refusal. These retain the
current stage/index, binding, fixed IDs, artifact bytes/hash, requests and child evidence, changing
only disposition and the existing bounded retry schedule. Permission and plan share the Server's
FORBIDDEN code and cannot be distinguished by parsing the detail string. Preserve quota at the
existing registration HTTP parser, rather than introducing a parser in the Move driver. Malformed
local grant/evidence is refused before this classification. A 403 does not renew a Session.

Reconcile current registration authority before classifying refusal or ambiguity: exact matching
metadata can prove an earlier successful request, whereas an unavailable read never proves absence.
Registration 400 is not itself a size refusal; it also covers reservation and ciphertext errors.
After proven absence, resolve the original same-ID grant to distinguish a renewable request from
a current-plan size wait or permanent claim conflict. Preserve Problem Details `retryable` for 409:
signing/lock timeouts use existing backoff, while a definite nonretryable consumed/fenced identity
with a proven missing required effect remains blocked under the existing contract. Never allocate
a replacement ID or synthesize an Item outcome. Source/target mismatches keep their existing blockers.

Policy, explicit Account lock and derived `AccessUnavailable` keep their existing projection
priority over these durable waits; restored scopes reveal the retained wait until a successful
retry advances work. Verify each refusal and restored access/quota/plan with identical accepted
requests, registration reply loss plus exact/missing/unavailable authority, retryable versus
permanent 409, and restart with the original retry deadline. A pass before its deadline sends no
request; repeated refusal stays within the existing five-minute backoff cap. The size case must
use a structurally valid fixed file refused by the current plan, then accepted after upgrade.
This records the engineering frontier; implementation follows the first nonempty Attachment path.

Parent and independent review selected a closed tagged child representation: `ItemOperation` keeps
the existing Item request, real Server operation ID and `ObservedOutcome`; `AttachmentRegistration`
keeps its source Attachment identity, immutable actual registration request/fingerprint and optional
registration evidence. The real registration POST has no Server operation ID, so do not synthesize
one or encode its result as an Item outcome. Ordinary `OperationRecord` bytes remain unchanged; the
unreleased90 workflow representation and its new conformance history may evolve with this slice.

Registration evidence distinguishes the actual acknowledged Attachment ID from a fresh, fully
matching `AuthorityAttachmentRecord` that proves the effect after a lost reply. Commit an observed
acknowledgment before any later authority read. Once recorded, evidence is immutable; it never
substitutes for the complete current target Item/Attachment set before source destruction. Reuse the
existing authority fetch/parser and exact Upload metadata comparison. Refused or ambiguous legacy
registration responses require current-authority reconciliation; they are not retained Item
rejections. A consumed or fenced identity whose required current effect is absent remains blocked.

The reviewed concrete checkpoint keeps the fixed target ID and `PreparedMoveAttachment` encrypted
metadata from admission, then a closed Pending or Encrypted state. Encrypted retains the existing
artifact reference and exact durable grant request; metadata is not duplicated in progress. The
first grant's storage key fixes the registration child before binary dispatch. A subsequent attempt
first reconciles current registration, then renews the original grant and transfers the exact sealed
bytes only after proven current absence and no retained registration proof. Unavailable authority
waits or fails; retained proof with a missing required effect remains blocked. A consumed grant
cannot authorize a replacement upload.
This needs no separate persisted binary-upload flag: repeating identical bytes at the same renewable
key before registration preserves accepted intent. Parent and independent review accepted this
refinement, including acknowledgement persistence before later authority reads.

For explicit Resume, the verifier collects fresh full authority only for existing fixed registration
children without evidence. Prepare discards these candidates; explicit Resume recomputes them and
passes `verified_attachments: Vec<AuthorityAttachmentRecord>` into the existing guarded source
reauthorization commit. Domain validation resolves unique fixed target IDs, verifies every accepted
registration field and destination scope, and permits only None to VerifiedPresent. Duplicate or
unknown IDs and changes to existing proofs are refused. Item outcomes, requests, checkpoints, stage
and index remain unchanged; Resume creates no registration child and sends no grant, PUT or POST.

Attachment-bearing Prepare and Resume acquire the existing source Attachment Account lease before
the sorted Account execution locks and retain it through validation/commit. Re-read current work and
scopes under those locks, honor cancellation/lease loss, and check the lease at the final guard.
Contention returns the existing retryable request error without changing durable scheduling. Verify
Encrypted artifacts with bounded existing chunk reads and their full digest/length, and inspect
Pending publication through read-only Recover. Absent or incomplete Pending preparation remains
resumable. The no-file path requires no Attachment ports. Parent and independent review accepted
these refinements without adding a validation request, artifact owner or scheduler.

Capture each fixed target Attachment ID and exact encrypted key/name/type at admission. Mint the
target Attachment key once and retain only its wrapped form. After authenticated artifact seal,
retain the exact durable grant request bytes; after the first grant, retain its storage key in the
immutable registration request before binary dispatch. Renewal must preserve all these accepted
values. Signed URLs and headers remain invocation-scoped.

Extract the existing scanner, two-pass transcryptor, chunker and authenticated finalization into one
internal module accepting a source-open interface, explicit source/destination blob scopes, zeroizing
keys, publication identity and the existing provisional writer/store. The two actual adapters are
same-Account preparation and cross-Account execution. The latter uses the existing source Endpoint
authentication budget and scope checks. Publication identity combines source Account/Operation
ownership with destination User/Attachment identity. Acquire the existing source Attachment Account
lease before sorted participating execution locks, and retain that lease and both existing
foreground registrations through the attempt. Lease loss or either scope retirement cancels it.

The independently reviewed extraction separates scan from transcrypt/finalize so ordinary Move
continues resolving its secret bundle after the first pass. Scan parses and hashes the envelope;
authenticated finish in the second pass creates the publication proof. The shared byte helper returns
only the finalized owner and preserves typed source-open, stream, crypto, storage and invariant
failures for caller classification. The cross-Account source adapter borrows the attempt's existing
Endpoint, Session, renewal budget and cancellation for both passes. Begin/recovery, encrypted
metadata, checkpointing and scheduling remain in their current owners, including ordinary Move's
existing key and uploader semantics.

Independent plumbing review selects immutable retention of the existing primitive facade in the
preparation scheduler, with a read-only accessor, and acquisition through the lifecycle's existing
Account lease port. This adds no Runtime registry or second scheduler. Clone the existing owner
handles before awaiting, acquire the source lease before Account locks, and retain it through the
guarded checkpoint. Lease contention uses the existing bounded resource wait; it is not an Offline
failure. Require these ports only for Attachment-bearing work, preserving no-file composition.

Review found a specific recovery gap: a completed artifact whose separate Replica checkpoint was
lost can be removed by full startup sweep, and a fresh Begin can replace that fully published
generation. Preserve exact accepted pending source-owned target Attachment scopes through the
existing full sweep, and explicitly Recover before Begin. The internal Rust `SweepOrphans` request
can carry a pending vector; empty callers retain existing behavior. SQLite passes it to the existing
selection algorithm and validates Account scope. WASM uses existing `ListArtifactOwners` when scopes
are pending and retains `ListArtifactIds` for the ordinary empty case. No new backend or persisted
sweep registry is needed.

Add a closed recovery-unavailable response only for proven absence or an incomplete state0 scope.
Published state1/state2 uses existing ResumeRecovered; storage failure, corruption, foreign scope
or contradictory current mappings remain errors and must not lead to Begin. Extend the existing
recovery `RequiredAttachment` inventory and live artifact inventory with source-owned target IDs,
including pending checkpoints and retired destination bindings.

The independent Resume review confirms that Recover can validate a present publication without
writing or adding a host primitive. Reuse existing metadata inspection and bounded ciphertext
validation, hashing both sealed state1 and published state2. Require the exact current generation,
canonical owner, seal and completed mapping where applicable; reject duplicate current rows, invalid
states, missing/extra chunks and digest or length mismatches. Recheck identity after awaited reads.
Only proven absence or valid incomplete state0 returns unavailable. This checks the stored
authenticated seal's integrity; it does not introduce a new cryptographic proof. Prepare must not
call ResumeRecovered or Finish; those publication steps remain in normal execution.

Independent review confirms that a shared live/pending inventory can also enumerate ordinary Move
preparations and embedded recovery, whose Pending scopes are already protected during selective
Vault retirement. Full sweep consumes the complete inventory; selective cleanup filters it by the
selected Operation identities. Only file-bearing cross-Account workflows contribute artifact cleanup
duties; a no-file workflow never requires an Attachment storage port. Completed file-bearing
workflows still select their original Operation scope so orphan cleanup can finish. Empty pending
inventories retain existing orphan reclamation. Keep
the store's explicit Begin/redo contract unchanged; the cross-Account adapter's Recover-before-Begin
policy is separate from that primitive contract.

The decisive regression is actual committed Finalize, lost separate workflow checkpoint, then
reopen/full sweep and recovery of the identical generation/hash/bytes without retranscryption.
Exercise SQLite and actual IndexedDB/WASM, distinguish absent/incomplete recovery from errors,
preserve pending evidence through target retirement and unrelated source sweeps, and retain scoped
source removal and ordinary orphan reclamation. An injected rollback inside Finalize alone does not
exercise this failure history. These refinements are reviewed decisions, not implementation or
acceptance;104 and the no-file verification gate still precede the Attachment slice.

Implementation review refines the lease boundary at the existing persistence invocation. An issued
JavaScript persistence Promise cannot be cancelled by dropping its Rust future. Recheck current
scope after the uncached read and immediately before issuing the existing guarded Commit. Once
issued, drain that Commit while retaining both foreground registrations, both Account execution
locks and the lease object. Recheck scope before adopting a returned snapshot, reloading into cache,
publishing progress, acknowledging Resume or dispatching another step. The already-admitted atomic
write may complete; it does not authorize a late cache update or another request. Factor the existing
exact Replica commit behind a synchronous current-scope callback, with ordinary callers retaining
their existing unconditional behavior. No new host cancellation primitive, durable owner or wire
result is required. Verify loss during the final read separately from loss during an issued Commit;
a gate inside the host executor is already past Core's Commit admission boundary.

After a successful Commit, the source scope check must recognize the exact returned Replica revision.
Use the current cached source with the original incarnation and lock epoch, the unchanged captured
target scope, and the same lease/cancellation checks. Before Commit admission, continue checking the
original source revision. A stale result may refresh the cache and retry; it does not publish or
acknowledge acceptance. Comparing a successful write against its old source revision would park
valid work immediately after its first checkpoint.

Read-only Recover must also distinguish a valid incomplete current generation from a missing current
mapping. A valid state0 generation can coexist with an older published generation after explicit
ordinary redo. If no current provisional row remains while a provisional-backed publication for the
same scope survives, Recover cannot prove which generation was current; return an error and never
select the older generation or authorize Begin. A state0 row pointing to its own already-published
physical generation is contradictory and also fails. Exact absence with no such publication remains
unavailable. Preserve the store's explicit Begin/redo behavior and all valid older publication bytes.

Actual Chromium shutdown testing found that dropping the preparation future and releasing its
Account lease before Core close drains permits another normal owner to acquire that lease while
an already-invoked orphan deletion is still pending. The reproduction uses a real state0 orphan,
IndexedDB, two pages and the actual Web Lock; it establishes ordering, not accepted-artifact loss.
Parent and independent review select only a Web close ordering change: cancel public requests,
await the existing Core close, then close Attachment resources. Core fences foreground work and
drains the existing sorted Account execution guards while the sweep and lease remain alive. Existing
transfer cancellation stays available during that drain, and closed eligibility prevents another
preparation pass. Concurrent and reentrant close cannot pass the existing state-cleaned boundary
before those guards drain. Preserve synchronous Drop's existing best-effort behavior; add no lease
registry, durable owner, host primitive or broader change to lease-loss semantics. Verify the actual
held-host-callback history plus existing configured Worker and binary-cancellation compatibility.
