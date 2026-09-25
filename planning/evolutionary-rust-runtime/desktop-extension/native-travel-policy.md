# Connected native selective Travel policy

[Research99](../issues/99-connected-native-selective-travel-policy.md) is resolved. This document
records source evidence and the accepted shared Core contract for the connected variant of
[71](../issues/71-runtime-travel-management-and-erasure.md). It is not implementation or acceptance
evidence. Existing [native transfer](native-transfer.md), Extension-local reads under
[79](../issues/79-connected-extension-item-read-authority.md), [selective capabilities](selective-vault-capabilities.md)
and [durable retirement](vault-retirement.md) remain the owners. Coordinator and independent review
accepted this technical boundary; implementation and the listed acceptance remain outstanding.

## Source-backed failure and constraints

The actual [Core native owner](../../../packages/client-runtime/crates/bittery-client-core/src/runtime/native_authority.rs)
currently supplies `NativeAccountAuthority { scope, unlocked, key_authorization_available,
key_generation }`. `NativeAccountAuthority::authorizes` requires exact generation equality;
`require_destination_channel` reuses it for effective borrowed Session access and guarded Session
replacement, as well as import ceremonies. `apply_authority` sends either generation mismatch or
false availability to `retire_scopes`, which calls `fence_account_access(...Locked)` for the entire
consumer Account. False availability also locks a matching independently unlocked consumer Account.

Source `native_vault_authorization_available` returns false during any pending Vault retirement.
`advance_native_source_authority` increments the Account generation at retirement and later cleanup/
readmission. Thus selective Desktop hide cannot currently preserve another Vault in the same consumer
Account. Merely ignoring a mismatch in `apply_authority` leaves effective Session/refresh checks
rejecting the grant; simply assigning the new generation would let an unexplained snapshot renew
old authority. Neither is a complete correction.

`NativeTravelEvidence` currently accompanies only `NativeTransferReply`. Destination import verifies
its own current Travel policy, with the existing narrow cached-policy match on retryable offline
verification. There is no connected policy control or consumer cleanup acknowledgement. Extending
this evidence to revoke already-transferred access is a new closed native-control capability; do not
claim that current code already trusts an unsolicited source policy as its current Server policy.

The [framed source adapter](../../../apps/desktop/src-tauri/src/runtime_host/native_source_transport.rs)
uses a watch wake and constructs a fresh source snapshot at writer delivery. Wake coalescing is
intentional. Snapshot sequence orders actual snapshots, not every policy transition: hide then disable
can occur before one snapshot is written. An added latest-policy field alone can omit the hide.
Existing old-sequence rejection, exact owner/channel/transport identity, bounded frames/calls and
EOF retirement remain necessary but do not conserve skipped selective retirement duties.

The [current retirement owner](../../../packages/client-runtime/crates/bittery-client-core/src/runtime/vault_retirement.rs)
already owns all-generation purge, the durable journal, foreground/host drains, borrowed and dormant
independent Session pruning, accepted-image/Move artifact cleanup, retry and exact acknowledgement.
The [visibility boundary](../../../packages/client-runtime/crates/bittery-client-core/src/runtime/vault_visibility.rs)
already fences affected Vaults before awaited storage and filters projections. The consumer must
invoke these owners against its own Replica; it cannot use Desktop Items or erase local Operations.

## Considered options and accepted decision

1. Keep whole-Account retirement and obtain another grant. This preserves the existing broad native
   lock behavior but fails71's unrelated-Vault requirement; it is not an acceptable normal hide path.
2. Send only latest policy or an invalidation followed by consumer GET. This keeps transport small,
   but a coalesced hide/disable loses the earlier observed duty and an unavailable GET cannot explain
   which generation change may continue an existing grant. GET remains current-policy convergence,
   not a substitute for conserving source-established revocations.
3. **Accepted:** add bounded, acknowledged restrictive controls to the existing native channel.
   Source Core retains an unacknowledged revocation obligation; consumer Core admits it into its
   existing durable retirement journal. An explicit nonexpanding continuation preserves only the
   unaffected part of an existing live grant. No payload grants keys, creates a Session, restores a
   hidden Vault, or replaces consumer Item authority. A hard source Lock/EOF still retires the Account.

This is an authorization restriction from the already-trusted Desktop Core, not a host assertion of
Server policy. The source may prove an irreversible cleanup obligation using its already validated
policy; the consumer's current-policy observation/GET remains separate. Source evidence cannot be
used as fresh consumer GET success, a cached-offline fallback, or permission to re-admit hidden data.
The coordinator accepted this restrictive-only trust boundary for the technical refinement;
independent review and the acceptance below remain required.

## Closed control and first-fence ordering

Use the existing generated private native interface, source attachment and channel record. No public
RuntimeRequest variant, broker policy parser, second transport, persisted credential or host timer.
The source Account control distinguishes `HardUnavailable`/Locked from Unlocked with transfer
admission Ready or SelectiveCleanup/PendingVerification. Existing challenge `source_key_generation`
equality remains mandatory for preparation, export, import and final reply encoding. A selective
continuation never supplies that equality to an old challenge.

Each immutable `NativeRestrictionBatch` contains:

- source owner/channel/transport and original Account scope;
- contiguous channel `batch_id`, previous chain digest and resulting chain digest;
- `from_key_generation`, `to_key_generation` and a closed cause of an actually established selective
  retirement; its validated policy evidence and exact sorted/unique hidden IDs;
- a batch-content digest over only the scope, batch identity, generation interval, cause, policy
  evidence and IDs. Use existing SHA-256 over a domain tag plus deterministic Rust encoding, with
  decimal generations and sorted IDs. Generate the wire record once; hosts forward its bytes.

The separate resulting chain digest commits to a distinct domain tag, previous chain digest, batch
identity and batch-content digest; neither digest includes itself.
The channel's initial chain digest is defined from its full owner/channel/transport identity. Hashes
provide exact replay identity, not peer authentication; existing authenticated native transport does
that. Snapshot sequence remains independent: it orders delivered snapshots, not every restriction.

A newly attached channel has not observed earlier transitions. Before its first consumer delivery,
seed its bounded baseline atomically from the source's existing enforced `Retiring`/`Retired` Vault
fences under native state → publication → registry ordering. The closed batch evidence is either
`VerifiedPolicy` for a newly established policy retirement or `ExistingRetirement` for these already
enforced exact scopes. The latter binds current source scope/generation and IDs; it does not invent
an old policy response or historical generation chain. It authorizes only the same consumer-local
revocation/journal adoption, never Server current-policy success or key restoration. Thus an already
unlocked independent consumer cannot retain a hidden Vault merely because Desktop completed its
hide before attachment. Unknown/over-cap baseline is unavailable, with no remote cleanup claim.

Do not use `AccountPresentation.verified_travel_mode`: that copy is explicitly display-only. No
duplicated asynchronous metadata lookup/cache is needed for this enforced-scope baseline. It does
not turn an ordinary unexplained generation change into a continuation. Existing baseline ACK means
durable local adoption, just as for live batches, and does not claim physical completion.

The FIRST source selective fence, classification, retained batch and key-generation increment are
one synchronous admission under the existing lock order **native state → publication**. No await,
foreign callback or cleanup starts inside that section. In particular, `source_snapshot` cannot see
an old generation plus newly false availability in the interval between
`begin_vault_retirement_publication` and a later `advance_native_source_authority`. Refactor those
existing boundaries to share the required locked operation; never reverse the lock order or add a
second synchronization owner. Reserve bounded batch capacity before changing this source authority. The source Account publishes a closed
`RestrictiveContinuity { from_generation, through_generation }` only for an interval whose changes
all belong to retained selective batches or their maintenance. Carry the channel-wide restriction
frontier and chain digest once on the enclosing authenticated snapshot with its complete retained
prefix. The Account interval is inseparable from that exact source owner/channel/transport snapshot.
Before any grant-generation update, validate the complete prefix against the captured destination
channel and install every affected local fence. This permits only nonexpanding continuation; it does
not imply durable adoption. Journal ownership or an explicit captured disposition advances the ACK
frontier, and fresh import checks the matching Account batches and their exact digests/dispositions.
Hard/unclassified changes invalidate the interval. This is a summary in the existing source Account/
channel state, not an unbounded generation history. A receiver cannot bridge outside it.

Only an actual new retirement lifetime creates a batch. Re-reading identical enabled policy with a
new `verified_at` timestamp, duplicate cleanup retries and later acknowledgement do not create new
revocations. A reappeared unfiltered staging row can require another physical purge while the same
Vault fence lifetime remains enforced; that is maintenance, not fresh authority or another native
restriction. Use the existing registry lifetime rather than ID/proof-payload equality to distinguish
it from readmission. Associate maintenance generation changes with the same established restriction frontier;
those changes cannot erase an exclusion or silently authorize a new grant. A hide after actual fresh
readmission is a new retirement even if its IDs equal an earlier batch. Do not deduplicate that history
merely by comparing ID sets or policy timestamps.

Every fresh snapshot carries the complete unacknowledged batch prefix and classified maintenance
frontier needed by this channel, even when current policy is disabled or the originating Account has
since locked or been removed. A current Account omission is hard authority loss, not permission to
discard an earlier restriction. Hard Lock/removal, source owner/channel loss and unexplained authority
changes can never be retroactively classified as selective continuations.

## Destination binding, durable adoption and ACK replay

At channel attachment, Core captures the matching existing local Account incarnations and explicit
absence for other source identities under the existing Account/catalog lifetime. This is routing
state in that same bounded channel, not a host Account catalog. Match normalized Server/User identity,
then retain the captured local lifetime. A batch must not bind afresh to a removed/re-added Account
merely because its Server/User matches. An explicit fresh import may install a successor channel target
binding through its ordinary challenge guards, with a new generation baseline; old batches continue
against their original capture or receive a proved terminal no-owned-target disposition.

Consumer admission validates the batch against that channel and captured target, then establishes its
selective foreground/delivery fence synchronously before any await. The affected private delivery,
ceremony, new-work and key scopes retire; unchanged MUK and unrelated Vault access can remain live.
Old-generation import challenges and held replies still fail. Channel state marks this exact batch
in flight; duplicate delivery joins that result rather than starting a second retirement.

Under existing Account execution, the common retirement boundary accepts the authenticated source
restriction as revocation-only evidence and commits the same `RetireVaults` journal. Do not add a
native persistence receipt or overwrite a newer consumer `verified_travel_mode` with historical source
metadata. The policy payload is transient proof until the journal commits, then the existing durable
journal becomes the local retry owner. Failed storage retains the exact existing fence/proof and
bounded retry, with no ACK. Reload physical state after a lost commit acknowledgement. A later source
policy or response cannot substitute for the original batch's exact IDs.

A matching consumer may already be retiring those scopes under its own verified proof. Preserve that
unfinished proof and its existing Account execution/retry. The bounded native adoption can wait for
that same retirement lifetime; once its exact journal commit or retained completed `DurableJournal`
evidence is observed, adopt it without a second purge or replacement proof. Equality of Vault IDs is
insufficient: pin the local incarnation and the existing fence lifetime, and prove there was no
intervening readmission or new authority. A hide after actual readmission creates a new duty even
when the IDs match. Ordinary fresh transfer cannot install authority or clear exclusions past an
unadopted restriction required for that source Account; its existing challenge/final import guards
must check the current captured adoption boundary.

The live destination channel owns one contiguous adopted frontier and a replay ring for its last16
batches. Each ring entry contains batch identity/content digest/chain digest and the captured terminal
adoption disposition: `JournalOwned { account, incarnation }`, `NoTargetAtCapture`, or
`TargetRemoved { original_account, original_incarnation }`. JournalOwned is recorded only after the
exact durable commit is observed; later journal cleanup need not retain a native marker.
NoTargetAtCapture follows the actual initial routing capture, not a fresh absence guess.
TargetRemoved requires completed existing local teardown of that exact incarnation; incomplete Remove
cannot acknowledge, and no old restriction is applied to its successor. The ACK distinguishes these
results; absence/Remove does not claim erasure of an unrelated or later Account.

Validate the bounded outstanding prefix against the adopted frontier and each preceding chain
digest. Different Account batches may persist/clean up concurrently through their existing Account
owners; an earlier held Account must not block a later Account's selective fence or unaffected work.
Keep a later completed adoption in the same bounded outstanding window until preceding holes finish.
Only `frontier + 1` advances the ACK frontier: atomically record its replay entry and new frontier
under that channel's generation guard, then consume the next contiguous completed entry if present.
An equal duplicate in the ring must match all immutable content; resend the current ACK without
re-journaling, re-fencing, cancelling new handles or repeating cleanup. Changed content is refused.
A batch older than the16-entry ring is explicitly stale and refused without side effects or an ACK
claim for that unknown content. The source's16-outstanding bound means such a batch cannot be a
legitimate still-unacknowledged request from this same channel. This bounds replay memory after years
of cleanup rather than retaining an unbounded receipt history.

`AcknowledgeRestrictions` binds both owners/channels/transports and the exact contiguous frontier plus
chain digest. Source validates it against retained immutable batches (or its last identical accepted
frontier), removes only the proved contiguous prefix, and never skips an unadopted hole. Same frontier
with another digest is refused; older ACKs cannot clear later batches. If ACK is lost after local
cleanup, the ring still proves an identical replay. Owner/channel restart loses this ring AND the old
authority; a new channel cannot reuse its receipt. The existing durable local journal survives and
finishes independently. There is no persisted native grant or Session restoration capsule.

ACK means exact durable local ownership or the explicit no-owned-target disposition, **not physical
cleanup complete**. Only the existing local cleanup completion may support an erasure-complete claim.
Source local Travel completion does not wait for every Device to be online, and missing remote ACK
never means remote protection succeeded.

## Bounds and overload

Reuse existing native frame limits:64KiB browser request and1MiB source response, including all
serialized envelope overhead. A channel holds at most16 outstanding batches and at most1,600 total
hidden-ID occurrences across them; every validated policy remains bounded to100 IDs. One Runtime
owner admits at most16 live native channels and64 total outstanding batches/6,400 ID occurrences.
Replay rings hold at most16 fixed digest/disposition entries per admitted channel, not full old
policy payloads. Existing length/frame validation applies before allocation. These are reviewed
implementation bounds, not new user-facing settings or policy durations.

A borrowed grant or independent source authorization also holds at most1,600 distinct cumulative
excluded Vault IDs; the Runtime-wide total across these live authorizations is6,400. ACKing a batch
never clears exclusions to regain capacity. Exceeding this authorization bound retires that affected
Account's continuation and requires a fresh explicit source authorization boundary before access can
resume. The durable cleanup duty still adopts/retries; capacity must not erase the only proof. Source
batch/channel/frame capacity exhaustion retires that exact channel through existing unavailable/EOF
handling before an unexplained continuation is exposed. Reject excess new channels without changing
already admitted peers; never evict arbitrary duties or block unrelated channels indefinitely.

This exceptional bounded transport/authority failure preserves existing Account-wide loss behavior.
An unobserved batch lost with the actual channel/owner has no remote physical-erasure guarantee;
do not infer one from local source cleanup. A batch already admitted by the consumer retains its
existing proof/journal despite channel loss. Disconnected Devices keep their own Server/Sync recovery.

## Existing Account authority with monotonic exclusions

The current grant is Account-scoped, including its MUK and Session; it is not an import-time whitelist
of Vault IDs. Preserve its existing ability to use a newly created/received Vault after ordinary
current-authority verification. A continuation records only monotonic exclusions plus the checked
source generation/frontier in the existing `BorrowedGrant`. The original import challenge remains
immutable. Effective Session selection and exact borrowed Session replacement use that same Core
continuation validator, so cleanup/refresh do not encounter an old broad generation mismatch after
publication has accepted a selective transition.

Continuation requires the same live owners/channels, Account incarnations/lock epochs and already
installed Account grant, a complete restrictive chain, and no hard retirement. Current Vault/role/
pending-policy guards still apply. The continuation cannot add key material, remove exclusions,
renew Session expiry, change credential provenance or restore a retired handle. A disabled policy,
unlocked snapshot or ACK alone cannot clear an exclusion. Borrowed scope restoration requires fresh
current authority and the existing explicit generation-bound transfer; only successful completion
starts a new bounded exclusion lifetime. A held old transfer cannot act as that boundary.

An independently unlocked matching Account has no BorrowedGrant. Its existing native channel target
binding holds the same bounded source exclusions without creating borrowed credentials, and common
local Session/authority guards still apply. The coordinator accepted provenance-preserving restoration through the same native challenge owner:
add a closed challenge purpose `Transfer` or `RevalidateIndependentRestrictions`, not another map or
runner. The latter carries both owners/channels/incarnations/epochs, current source generation,
current restriction frontier and the bounded exact exclusions requested (at most1,600 IDs and the
existing request frame limit). Source checks fresh current visibility; consumer separately verifies
its own current policy and fresh readable authority. Its nonsecret result echoes that same immutable
transcript and the proved visible subset, together with the source Session's nonsecret authoritative
expiry. Source encoding and consumer completion both reject expired source evidence; consumer
completion also rechecks its own captured Session validity after awaited persistence. These checks
reuse the existing usable-Session expiry semantics and do not renew either Session. The single-use
completion clears only those requested IDs proved visible by both owners under final guards, installs
no key/Session and changes no lock state.
Cancellation, old source generation, successor restriction, owner/channel loss and local replacement
refuse the result. Reuse existing challenge capacity/cancellation and Core verification; neither host
selects eligibility or retries. This internal explicit request is not a new user gesture or an
unlocked-snapshot shortcut. Borrowed grants still require ordinary fresh transfer, and this purpose
cannot operate on one. It preserves independent provenance without unnecessary borrowed imports.

## Shared pending reasons and hard retirement

Deepen the existing Account pending-admission entry with closed reason identities:
`ServerVerification { revision }` and `NativeVerification { channel, source_scope, revision }`, bounded
by the admitted channel count. They are selectors for one gate, not separate policy state or runners.
The durable `BootstrapMetadata.policy_verification_pending` bit conservatively represents any such
unresolved admission duty; it is not cleared while any live reason remains. On restart, a true bit
reconstructs a conservative ServerVerification reason requiring the existing fresh authenticated GET,
because the old channel's transient reason identities are gone. No archive can restore an older false
bit over that duty. A false bit with a live reason still refuses admission, including a failed write.

A new Server invalidation advances its reason revision before awaited work. A source Pending control
uses its captured source verification revision and creates/advances only that channel's reason.
It carries no hidden IDs, changes no established grant generation and advertises no hard availability
loss. The matching source Verified control binds that reason revision and the required restriction
batch frontier; the consumer can resolve it only after adopting that prefix locally. Source retry
timestamps cannot mint a new reason; a new invalidation must do so before any awaited read.
Resolution removes only the exact captured reason: a native verified result cannot clear a
Server reason, a newer native pending revision, or another channel's reason. Persist final false only
under existing Account execution plus current publication/reason guards when the set is empty;
recheck after awaits so a successor invalidation wins. A fresh local GET can resolve its captured
Server reason; it cannot declare the Desktop's still-pending source reason resolved. Lock/EOF retires
that source authorization and its native admission reason, while an independently pending Server
reason remains. If the aggregate durable bit cannot be updated, retain the conservative gate and use
the existing verification/retry owner; no false cached success.

New plaintext/new work/export/final encoding follow that one gate. Already-delivered UI and admitted
loans retain their existing lifetime until a proved selective/hard fence. Nonplaintext status/Sync
and exact accepted ciphertext dispatch retain existing Core eligibility, including usable Session
selection while pending. A restriction batch adopts the cleanup duty, but does not itself resolve a
pending current-policy reason; the source's matching verified control resolves only its own reason.

Hard Lock/removal/EOF fences Account access immediately, even while a restriction write or cleanup is
held. It cancels grants, old challenges and continuation/revalidation responses. It does **not** erase
already-observed exact restriction evidence, discard a durable journal, or cancel the only cleanup
retry owner. Same-incarnation Lock changes live epoch but does not invalidate that irreversible duty.
If the native channel survives a source Account Lock/removal, it continues carrying its outstanding
batches and may receive ACK for their durable adoption even though no grant survives. Such ACK does
not authorize access and validates original batch/captured local incarnation, not current Unlocked.
Actual channel/owner loss invalidates its outgoing ACK capability; admitted local cleanup still runs.
Here owner loss must distinguish process destruction from a live transport retirement. Port/channel
loss while the Runtime survives preserves an already-observed transient precommit proof in the
existing fence. Actual Runtime process loss before any `RetireVaults` commit destroys that memory;
the old channel cannot reconstruct it and no ACK, durable-ownership or physical-erasure claim was
made. A process loss after the physical commit preserves the existing journal, including when its
commit acknowledgement or outgoing native ACK was lost. Test rejected/uncommitted writes separately
from commit-then-lost-ACK. No native persistence record is added to make transient memory durable.
Actual destination Remove/replacement follows the captured disposition rule above and never transfers
an old duty to the replacement incarnation. Broker recycle with a surviving port remains74 reattach;
actual port loss remains68 Account retirement and actual Worker loss starts Locked.

## Required evidence before connected71 acceptance

Start with two real Core owners and separate physical Replicas, a matching Account containing hidden
VaultA and visible VaultB plus another Account, a borrowed Session and a dormant independent Session.
Accept local Operations in both Vaults and hold a private foreground delivery/Attachment or image IO.
A real source verified hide must removeA from consumer Items/catalog/autofill/private ceremony scope,
retainB unlocked/usable, preserve original accepted bytes and pruneA from both Session documents.
Inspect all authority generations, the journal, indispensable accepted artifacts and exact physical
cleanup separately from UI observations.

The first behavioral red is the actual source snapshot→consumer ApplyAuthority path: after source
selective retirement,B currently becomes Locked. Widen that tracer to held old transfer reply,
initial attachment after source hide with an independently unlocked consumer,
coalesced hide→disable before writer delivery, duplicate/stale/reordered/missing batch, tampered
interval/prefix combinations and unrelated Account continuity, lost consumer
journal acknowledgement, overlap with an unfinished local proof and its completed journal, lost
ACK after that cleanup, new hide after actual readmission, crash before/after journal and
acknowledgement, Session replacement races,
local independent access and all-hidden selection. Prove a later disable cannot skip an acknowledged
duty or silently restore the old grant. Prove unrelated Account/channel progress when one cleanup is
held, and explicit channel overflow/refusal rather than unbounded storage or omitted obligations.

Then exercise actual framed source socket/native binary with the same Core owners and held writes,
Cancel, EOF and source/runtime loss. Later74/76/77 use actual Chrome combined Worker/native Port,
local Replica projections and autofill/passkey paths. Protocol1/97 retains its actual coarse
consumer Lock behavior during migration; this new protocol2 control must not claim selective
legacy-consumer acknowledgement or delay Desktop acceptance behind Extension implementation.

## Decision and remaining acceptance

2026-09-09: coordinator review accepted option3 and its concrete first-fence, record/ACK, bounded
continuation, pending-reason and restoration contract. Independent final review rechecked all six
identified gaps against actual source and found no further blocking correction: atomic source
classification; immutable import versus Account continuation; bounded replay after journal cleanup;
independent pending reasons; captured local incarnation/terminal disposition; and duty conservation
through hard authority loss. The independent simplification review retained existing native channel,
challenge, Session and retirement owners rather than another cache, durable receipt or runner.

Research99 is resolved and supplies the connected71 implementation boundary. No new product gesture
or user question was needed. This is not implementation or native/Tauri/Chrome acceptance; all actual
physical, transport, concurrency and downstream host cases above remain required. Local Markdown
links and diff validation pass. Generated records must come from the same Rust definitions when the
capability is implemented.
