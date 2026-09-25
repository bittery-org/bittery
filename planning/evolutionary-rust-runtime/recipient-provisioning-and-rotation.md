# Runtime recipient provisioning and Key rotation

Status: frontier accepted by independent and coordinating review on 2026-09-23.
[Ticket 107](issues/107-runtime-recipient-provisioning-and-rotation.md) remains `needs-triage`
until [105](issues/105-web-team-recipient-runtime-operations.md) is resolved.
[100](issues/100-recipient-key-verification-policy.md) and
[29](issues/29-rotation-operation-outcomes.md) are completed prerequisites;
[101](issues/101-runtime-recipient-key-verification.md) still needs this migration for its
joined browser acceptance. [102](issues/102-authenticated-invitations-and-team-key-trust.md)
is separate and adds no capability here.

## Existing behavior to preserve

The first Team read is [105](web-team-recipient-runtime.md). The remaining Web callers are
`components/teams/invite-dialog.tsx`, `pending-invitations-list.tsx`,
`components/vaults/add-member-dialog.tsx`, `vault-member-list.tsx`,
`hooks/use-vault-key-rotation.ts`, and `lib/vault-key-rotation-adapter.ts` under `apps/web/src`.
The current Invitation gesture sends an unprovisioned Invitation, uses the returned existing User
ID/public key for [101's exact-key verification](recipient-key-verification.md), wraps each
current Team Vault key, cancels the first Invitation, then sends a replacement with wrappers.
Cancellation of verification can leave the first Invitation pending without Vault access; it
must never be presented as a completed provision. New-recipient Invitations have no key to wrap.
Composer Vault/seat/entitlement reads, owner/admin invitation list, resend/cancel, authenticated
current-User pending list/accept/decline, Vault available-Member/member/access reads, Add-Member
and Vault role PATCH must migrate with their actual callers. Public token preview/accept/signup
remain public, and 105's Team page read remains the source for its existing display.

The Rotation ceremony has three closed intents: Vault-member removal, administrative Team-member
removal, and voluntary Team leave. It starts plans, drains `member`, `item`, and `attachment`
preparation pages, stages encrypted outputs, finalizes, invalidates old local key/cache state, and
refreshes authority. The current User's new key copy is MUK-wrapped; every other Member's is
wrapped only to the exact approved recipient key. Item data and Attachment key envelopes are
reencrypted under each new Vault key. Server plan IDs, expected Vault-key versions, page record
IDs/versions, and Attachment context version/AAD remain authoritative. Empty Team plan sets are
valid. The six distinct start/finalize Operation kinds, exact rejection sets, and Team-leave
`personalTeamId` are fixed by 29, including renewal under the same User after departure revokes
the prior Session.

## Proposed closed Runtime workflow

Core owns request construction and Session renewal, live MUK/Vault-key access, private crypto,
bounded pagination, exact verification lookup, mutation submission, and authoritative refresh.
Web owns display, the independent fingerprint prompt, and one-time invitation-link delivery. No
request accepts a URL, bearer, private key, prewrapped Vault key, arbitrary crypto operation, or
host-selected Server outcome. Generate Rust-owned Web/native types and selected Server DTOs under
ADR 0012. Reuse Runtime's Account execution, foreground cancellation/drain, live-key,
Replica/Sync, and retained-Operation owners; do not mirror legacy key storage.

The closed Invitation operations are `ReadInvitationComposer`, `CreateTeamInvitation`,
`ProvisionTeamInvitation`, `CancelTeamInvitation`, `ResendTeamInvitation`,
`ListMyTeamInvitations`, `AcceptMyTeamInvitation`, and `DeclineMyTeamInvitation`.
The closed Vault operations are `ListAvailableVaultMembers`, `ListVaultMembers`,
`ReadTeamMemberAccess`, `AddVaultMember`, and `UpdateVaultMemberRole`. Names may be normalized
with the existing protocol, but each has fixed Account and resource IDs and a typed result.
Reads share a bounded page/item budget and one Session renewal budget, as in 105. Role and
entitlement checks use current Server authority, with the Server still deciding writes.

`CreateTeamInvitation {accountId, teamId, email, role}` sends once without wrappers. Its result
contains the one-time `token`, `invitationId`, and, only for an existing recipient, a nonsecret
candidate `{recipientUserId, publicKey, fingerprint}` plus an opaque continuation ID. Core
retains the *exact* first Server response binding (Account ID/incarnation/lock epoch, Team,
Invitation ID, recipient User ID and candidate public key) **together with the normalized email
and role from the accepted request**, not fields inferred from the first response, in a typed
`InvitationContinuationLease` map added to the existing `ForegroundAttachmentRegistry` state.
Neither candidate User/key nor one-time token is accepted back as a host field; the token is
delivered once and never stored in that lease. The registry permits one live lease per
Invitation and at most sixteen per Account, with a finite ten-minute deadline. It retires the
lease on explicit UI release, Lock, Account removal/Wipe, Runtime close, or expiry. Current
`ForegroundAttachmentGuard` registrations end with the request; they cannot observe loss of a
caller **after** `CreateTeamInvitation` returns. Add a closed
`ReleaseInvitationContinuation {accountId, continuationId}` request, idempotent for its bound
Account generation. The Web `InviteDialog` owner holds the ID and an `AbortController` for each
live request; dialog close, component unmount, Account selection change, and verification cancel
abort in-flight work and call release for a returned lease. If the host disappears before that
release reaches Core, only Lock/Account/close or the deadline can retire the lease; immediate
post-response caller-loss detection is not claimed. The already created unprovisioned Invitation
remains pending after lease retirement.

Web obtains the fingerprint out of band and calls the existing `VerifyRecipientKey`; a
cancelled/wrong/changed verification does not submit wrappers.
`ProvisionTeamInvitation {accountId, continuationId}` loads only Core's bound candidate,
requires the same live Account generation, checks the original Invitation is still pending with
the same Team/email/role, re-reads current Team Vault authority, and calls the existing verified
recipient lookup with the exact stored User/key. It atomically reserves the lease so a second
caller cannot race the same cancel/replacement. A failure before any authenticated mutation may
restore the reservation only while the same generation and deadline remain; once cancel or
replacement send is attempted, the lease is consumed and cannot be reused. Core unwraps each
currently accessible Vault key and seals it internally, retiring each private key before
submitting the replacement. It rechecks authority and foreground lifetime before cancel and
before replacement send. No Account execution lock or private key is held during the human
fingerprint prompt. Add-Member follows the same exact-key check against the current
available-Member User/key and obtains its Vault key inside Core before the existing `PUT`.
Its role comes from the closed Server role set.

`PrepareRotation {accountId, intent}` names exactly one of the three intents. Before accepting
its start Operation, Core uses the existing Sync owner to force a complete, version-capable
bootstrap and catch-up for this Account. From `Ready`, the Sync owner explicitly submits a
guarded `BeginBootstrapPlan` with the existing `Ready` fallback, because
`hydrate_bootstrap_generation` otherwise returns early; from `Cold`, ordinary bootstrap
supplies it. Failed forced refresh abandons its exact staged generation through the existing
guarded `AbandonBootstrapPlan`. It must not overwrite a newer generation or an independently
required authority refresh. A preexisting staged generation must finish or be discarded
before a new opted-in generation can count as preflight. If any present
Vault lacks a positive authenticated `keyVersion`, any Vault page lacks the capability marker,
or full catch-up cannot
finish, return a typed version-evidence-unavailable/retryable refusal **before** any start
Operation or private staging. This conservatively refuses even a Team intent that might later
produce zero plans; the start response is the first place that plan set is known. It avoids
stranding a finalized rotation on a Server whose bootstrap cannot later prove fence release.
A later Server downgrade/failure can still leave an already accepted finalize fenced until a
compatible Server and Sync return; preflight is not a promise about future availability.

With that preflight complete, Core creates plans with a Core-minted stable start Operation ID.
Core freezes and accepts the exact start request as a `replica::OperationRecord` in
`ReplicaSnapshot.operations` before HTTP dispatch;
the existing Server outcome reconciliation/receipt path gains explicit closed 29 kinds. The
durable target is `ResourceRef::Vault {vaultId}` for Vault-member removal and a new
`ResourceRef::Team {teamId}` for Team-member removal/leave. Team plans may be empty; neither the
first Vault nor a sentinel Vault ID can stand for the Team. Replace generic total
`ResourceRef::vault_id()` assumptions with target-aware validation/dispatch/receipt helpers and
use the frozen plan list, rather than the Team target, for affected-Vault checks.

An applied start response carries the authoritative plan IDs and expected key versions. The
existing `OperationReceiptRecord` retains only a compact terminal result and cannot reconstruct
those plans after its `OperationRecord` is removed. Therefore a closed
`PlanMutation::ReconcileRotationStart {observedOutcome, validatedPlans}` must atomically retain
the start receipt, write an Account-local `RotationAttemptRecord` in
`ReplicaSnapshot.rotation_attempts`, and remove the start Operation in **one** guarded Replica
journal commit. The plans come only from Core's parsed, exact-request-proved Server result;
validate their IDs, target, uniqueness, bounds and versions inside that commit. A rejected start
commits its typed receipt without an attempt. A crash before the commit leaves the immutable
start Operation available for exact replay/reconciliation; a crash after it leaves the receipt
and full attempt together. No ordinary completion may remove a Rotation start Operation first.
After start, each returned plan must name a Vault present in the preflight authority with a
positive version equal to the plan's expected version. A mismatch or newly inaccessible Vault
aborts before key generation/staging and leaves only the already accepted, expiring plans to
abandon or expire; it cannot silently switch to a different authority source.
The attempt contains Account scope, intent, start Operation ID, plan identities and a phase; no
key or ciphertext. The returned
Account-generation-bound selection `{accountId, incarnationId, lockEpoch, intent,
startOperationId, plans:[{planId,vaultId,expectedKeyVersion}],
candidates:[{userId,publicKey,fingerprint}]}` includes bounded other-Member candidates from
the immutable preparation manifest. Prompt and persist missing/changed-key verification
through 101 before any new Vault key is generated.
`CompleteRotation {accountId, selection}` re-reads the plan/member manifest, requires the exact
verified key for every other-Member candidate, and refuses a changed plan, recipient, Account,
or authority. A Replica compare-and-swap changes the matching `RotationAttemptRecord` from
`prepared` to `consumed {attemptId}` *before* generating a new key or staging one byte. A
second completion, reused selection, or restart after consumption cannot generate different
ciphertext into a partly staged plan; it can only inspect/abandon the existing plans and start
new plans under a new Operation ID. This two-step boundary keeps private keys and the Account
execution lock out of the human prompt. One foreground attempt then owns the old/new keys and
exact stage ciphertext, retiring them on every exit. Core bounds all three page streams and
encrypts/stages each closed record kind under the current plan/version/context rules. An
unexpected unverified recipient stops before staging its wrapper and requires a new
verification pass; it never gets an
unverified wrapper.

## Continuation, lost replies, and publication

Each active foreground request captures Account ID, incarnation, lock epoch, its own
`RequestCancellation` and current authority. Lock, Account removal/Wipe, active request caller
loss, changed recipient or permission, and plan expiry retire private work before another
wrapper or staged page is sent. The post-response Invitation prompt uses the explicit lease
release/deadline rule above, rather than pretending that a completed request still has a live
caller guard. Already accepted Server effects are not described as undone. Core drains held
external work before publishing cancellation, uses the existing retained Session only for
explicitly permitted in-flight work, and rechecks generation/current authority before
publishing a result.

Invitation `send` and `resend` deliberately reject idempotency because they return a one-time
token. Never replay either after a lost reply or rerun cancel-and-recreate as a unit. A lost
first send is typed `uncertain`: refresh the Invitation list to identify possible pending work,
without claiming a recoverable token. A known first Invitation remains pending if verification
is cancelled; its ID is returned as `created_unprovisioned`. If cancel succeeds but replacement
send fails or loses its reply, return a distinct incomplete/uncertain state and reconcile the
current Invitation list; a token can only come from a confirmed send or explicit later resend.
Resend lost replies have the same one-time-token limitation. Add-Member `PUT`, role PATCH,
cancel, and authenticated invitation accept/decline lost replies reconcile against current
member/invitation/Team authority and Sync, rather than claiming rollback or blindly resending.
Accept-by-ID may change membership and Vault access; refresh through the existing Replica owner.

Rotation start/finalize use the six 29 Operation kinds and stable IDs. Extend the existing
`run_operation_dispatch`/`OperationSchedulingState` owner: there is no fixed attempt limit and
no discard merely because transport attempts accumulate. The first attempt sends the frozen
request; after a retryable/lost answer it persists backoff, then later attempts look up the
retained outcome as a hint **before** exact immutable-request replay. Lookup alone lacks the
request fingerprint, so it cannot prove success or justify a new Operation ID. Sync's retained
outcome path follows the same lookup-then-exact-replay proof. Reauthentication parks the same
accepted Operation until the same Account/User has a usable Session. This is the existing
dispatcher contract, not a special one-replay budget for Rotation. Server staging is an
exact-payload-hash `PUT` per plan/kind/entity. A lost stage reply may retry only the identical
staged ciphertext bytes still held by the current attempt; reencryption would conflict. If
that attempt disappears, abandon the unfinished plan when authorized or let its bounded Server
expiry close it; do not reconstruct a different key/ciphertext into that plan. Best-effort
abandon also covers cancellation before finalize.

The existing durable owner is `ReplicaSnapshot.operations` (`replica::OperationRecord`, accepted
through `PlanMutation::AcceptOperation`) and its terminal `OperationReceiptRecord`; the closed
Rotation kinds/target and outcome parser require explicit extensions, not a generic HTTP proxy.
`RotationAttemptRecord` is a small Account-local Replica journal checkpoint, not another
scheduler. Before sending finalize, one guarded `PlanMutation::AcceptRotationFinalize` freezes
and accepts the exact finalize `OperationRecord` (`ImmutableHttpRequest` with the exact plan IDs,
Team/Vault target and one stable Operation ID) and changes the matching attempt to
`finalizing {finalizeOperationId, affectedVaultIds, expectedKeyVersions}`. The accepted
Operation and phase move atomically; no finalization HTTP is sent before that durable commit.
An interrupted attempt before this point is abandoned/expired, never resumed with newly
generated ciphertext.

The **selective unavailable-Vault fence** is derived on every load from attempt phases
`finalizing`, `appliedAwaitingRefresh` and `rejectedAwaitingRefresh`; it is not
`MarkRefreshRequiredPlan` (Account-wide)
or `RetireVaults` (deletes authority). The same Replica snapshot/journal commit that freezes
finalize therefore installs the fence, including after process restart. Add one shared
`require_vault_rotation_available(accountId, vaultId)` guard to public Vault/Item projections,
Vault-key unwrap and decrypt, Attachment read/upload/reencryption, foreground mutations and
ordinary Operation dispatch. It checks every affected Vault before returning old cached
material or sending work; an empty Team plan set fences no Vault. Existing accepted work for
an affected Vault parks without losing its immutable request. The exact retained Rotation
finalize dispatch/replay/outcome lookup and authoritative Sync are allowed through the fence;
otherwise the fence would deadlock its own resolution. Account/Device Lock and retirement still
apply separately. The fence does not hide unrelated Vaults. Existing full bootstrap temporarily
pauses ordinary Account mutations while `Bootstrapping`; this workflow retains that behavior.

A lost finalize reply leaves `finalizing` and its selective fence in place while the existing
dispatcher resolves the exact retained Operation under a valid same-User Session. A closed
`PlanMutation::ReconcileRotationFinalize` atomically writes the terminal receipt, removes the
finalize Operation and changes the attempt phase. A proved applied outcome stores the Server's
per-plan `{planId,vaultId,keyVersion,rotationId}` results as
`appliedAwaitingRefresh`; the fence remains. A proved rejection stores its 29 reason/detail and
changes to `rejectedAwaitingRefresh`; no new key is installed. A rejected finalize proves only
that this Operation did not rotate, not that another Device left the old key current. Its fence
releases after a forced full authoritative Sync confirms the prior-or-newer key generation, or
proves that a departed Vault is absent and purges its old key. No generic completion
may remove a Rotation finalize Operation without its attempt transition.

Current Server bootstrap Vault rows (`sync/records.rs` and `sync/shape.rs`) and Core
`AuthorityVaultRecord` omit `keyVersion`; member RSA Vault-key wrappers are bare base64, so
their bytes cannot supply an authenticated version. Add the existing Server
`vault.key_version` to the **existing authenticated `/sync/bootstrap` Vault pages only when**
new Core sends the exact `Accept: application/vnd.bittery.sync-vault-key-version+json` value on
every Vault-page request in every new generation; the host cannot select another value. This
existing CORS-safelisted header is ignored by
old Servers; a new query parameter would fail their `BootstrapQuery` unknown-field check, and
a new custom header would fail old browser CORS. New Servers keep ordinary bootstrap response
bytes and shape unchanged unless opted in, because old Core's generated
`BootstrapVaultSummary` rejects unknown fields. Each opted-in Vault page also carries
`vaultKeyVersionIncluded: true` so even an empty page proves that the Server supports this
capability; old Servers leave the marker absent. The new generated Server DTO and durable
`AuthorityVaultRecord` use an optional/defaulted positive `keyVersion`, omitted from ordinary
Server JSON; old Server responses and old Replica rows decode as **unknown**, never as version
zero or proof of freshness. The page marker is likewise optional/defaulted for old responses.
Core requires it on every opted-in Vault page and rejects mixed, missing or nonpositive row
versions for Rotation preflight or fence release. This is an additive authenticated authority
fact, not a new route, key format, or 102 trust protocol.

An applied or rejected terminal outcome records a durable refresh duty in the attempt phase.
That duty makes the existing Sync owner explicitly start a guarded **new full opted-in
bootstrap after the terminal outcome**, even if the Replica is Ready and `/sync/changes`
would return an empty delta. If an older generation is already staging, finish or discard it,
then start this new generation; it cannot discharge the duty. The selective affected-Vault
fence and durable retry duty remain in the attempt after a failed refresh and after restart.
Do not persist Account-wide `MarkRefreshRequiredPlan` solely for this duty: a forced bootstrap
from `Ready` retains its valid fallback and abandons only its own failed staging through the
existing guarded plan. Unrelated Vault reads remain available, and ordinary mutations become
eligible again when that valid fallback is restored. During active `Bootstrapping`, the existing
Account-wide mutation pause still applies. Independently required authority refreshes retain
their own freshness gates; this retry must never restore stale authority over them.
Structural events in `catch_up_changes` already trigger another full bootstrap rather
than a Vault-row delta merge; they must finish before the duty is satisfied.

The bootstrap's pinned sync Cursor does **not** snapshot its Vault rows. A Vault can rotate
after watermark `W` while later pages are fetched. Therefore promotion alone never releases
the selective fence: require `run_bootstrap` to report full `catch_up_changes == true` after
that new generation, with any structural-event-triggered refresh completed. Server Rotation
finalization and its Sync event use the existing transactional event-order lock, so catch-up
after `W` can observe a committed intervening rotation instead of treating mixed pages as a
single old snapshot. At the guarded final authority check, each still-present affected Vault
must have a positive current authenticated version **at least** its proved applied result's
`keyVersion`, or, for a rejected finalize, at least the pre-finalize baseline version. A
strictly newer version is valid only with the complete current wrapped key, Item, Attachment
and Account-role authority promoted from that catch-up; lower/missing versions, partial pages,
or an incomplete catch-up keep the fence. For Team leave, a complete authoritative refresh
proving the departed Vault absent and purging its local key is the release condition. Only
then may `completed` or the typed rejection publish. Otherwise return `refresh_required` with
the applied identities or rejected-but-unavailable without claiming old keys are current.
Team leave may revoke the old Session, so outcome lookup and refresh use a renewed Session for
the same Account/User, not another Account.

## Acceptance groups and dependencies

1. Contract/Core: generated closed request/result and Server types; bounded reads/pages;
   authenticated Session renewal; exact 101 verification before wrappers; new and existing
   recipient Invitation, cancelled/wrong/changed key, partial/changed Team Vault authority,
   Add-Member and role/entitlement refusal. Test Lock, caller cancellation, Account retirement,
   held external work and key retirement at each private/HTTP boundary. Forge or swap a
   continuation ID/User/key/email, race two provisions, expire its lease, and prove none can
   redirect the original Invitation's verified recipient. Close/unmount/change Account during
   the fingerprint prompt and prove the explicit release retires the lease; if the release is
   lost, prove the finite deadline/Lock/Account/Runtime-close purge instead of claiming
   instantaneous caller-loss observation.
2. Invitation recovery: initial unprovisioned pending state; confirmed replacement; lost first,
   cancel, replacement and resend replies; one-time token never invented or replayed; standalone
   Account pending list/accept/decline and public token/signup routes remain correct.
3. Rotation: all three intents, six 29 outcomes/rejections including empty Team plan set,
   all `member/item/attachment` pages and AAD/version checks, exact-stage replay, partial stage,
   expiry, abandon, lost start/finalize replies, Session revocation on leave, stale Vault fencing,
   and completed versus committed-but-unavailable refresh. Assert old Server ignores the exact
   `Accept` capability and leaves old JSON unchanged, old strict Core still parses new Server's
   default response, and new Core decodes old Server/Replica Vault rows as unknown. Missing
   capability marker (including an empty Vault page), zero, mixed-page or unsupported versions
   refuse before start; a changed plan/preflight version refuses before private staging. Prove
   crashes immediately before and after the atomic start receipt-plus-plan commit, after durable
   attempt consumption, and after atomic finalize acceptance. Reuse of a selection must not
   produce different ciphertext for
   the same plan. While finalize is ambiguous and after restart, assert affected-Vault public
   projections, decrypt/key access, Attachments, mutation and queued dispatch are fenced while
   unrelated Vaults remain readable. Prove unrelated mutations remain eligible in `Ready` and
   after a failed forced refresh restores its valid fallback, while retaining the existing
   temporary Account-wide mutation pause during active bootstrap. A failed or stale refresh
   cannot clear the selective fence, its retry duty, or another authority refresh requirement.
   Prove both applied and rejected terminal outcomes force new
   opted-in full bootstrap despite Ready/empty changes; promotion before full catch-up keeps
   the fence. Rotate after pinned `W` during later Vault/Item pages, then emit a structural
   event: catch-up must refresh again before release. Applied release needs current
   `keyVersion >= proved`, rejected release needs `keyVersion >= baseline`, with complete
   current wrappers/Items/Attachments/role authority; lower or missing versions remain fenced.
   Complete Team-leave absence purges old keys. Exercise Team-target Operations with zero plans
   through dispatch, Sync reconciliation and receipts, without a fake Vault target. Test
   unbounded scheduled retries with lookup as hint followed by exact replay. No private key
   crosses ordinary Runtime projection/request boundaries.
4. Caller closure: migrate the named Web gestures and remove their legacy MUK/Vault-key/cache
   imports only after the import graph proves no remaining caller. Keep 105 Team read and public
   invitation routes; run actual new/existing-recipient, Add-Member,
   resend/cancel, standalone pending-invitation, Vault removal, Team removal and Team-leave
   browser paths. The existing `teams.spec.ts` covers resend/cancel, three rotation paths and
   standalone pending invitation; add explicit existing-recipient provisioning coverage.
   Run affected Core/crypto, generated contracts, dependent types, targeted host/Server tests,
   both full CI commands, and independent Spec/Standards/simplification review before closure.

## Frontier resolution

The nonmember candidate key comes from the first Invitation response, and the authenticated
Invitation list cannot reread it. Server production code inserts the User identity key at
registration (`domains/auth/registration.rs`) and has no ordinary key-update route;
`domains/teams/invitations.rs` reads that stored key for the first response. This contract keeps
that response's exact User/key binding in Core's lease for this gesture, matching the existing
caller and 100's requirement to verify that *exact* key out of band. It adds no unapproved
freshness endpoint or 102 trust-directory protocol. A future User identity-key rotation
feature would reopen this boundary.

The one-time Invitation token cannot be recovered after a lost `send`/`resend` reply. Preserve
the current generic incomplete/failure presentation and existing explicit Invitation list,
resend and cancel controls, while reporting honest `uncertain`/`created_unprovisioned` state
from Core. No automatic replay or invented link is a routine migration consequence; a new
token-recovery policy or richer copy would be a separate product decision.

Independent frontier review verified the typed lease's explicit host release/deadline behavior,
start/finalize atomic Replica journal transitions, Team target handling, and the selective
rotation fence against actual projection/dispatch/Sync owners. Implementation must still prove
the acceptance groups above. The
opted-in authenticated Sync Vault `keyVersion` is a required authority fact for preflight and
fence release; compatibility with old Server, old strict Core and old durable rows is part of
that review. It does not alter the Rotation ciphertext format or add a trust-directory
endpoint. No production work starts before 105 closure.
