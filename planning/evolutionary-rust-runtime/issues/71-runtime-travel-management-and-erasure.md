# Runtime Travel mode management and local erasure

Type: task
Status: resolved
Blocked by: 65, 68, 70, 81, 86, 87, 89, 92, 93, 99
Spec: ../desktop-extension/vault-travel.md#travel-mode-capability-contract

## Contract

Implement the sealed foreground settings/current-policy contract in the spec: closed observation and
save/enable/disable/refresh commands, bounded authenticated policy reads, one fresh SRP proof without
`finish_login`, and uncertain-response reconciliation without automatic proof replay. Preserve
existing picker/role/password behavior and keep biometric unlock local. Core owns policy ordering,
durable verified metadata, retirement and restoration; hosts render projections and execute scoped
platform cleanup.

Follow65 exactly. Erasure covers all authority generations, Session-only and dormant/borrowed keys,
native key publication, projections, plaintext loans and unneeded capabilities. Keep only indispensable
encrypted accepted evidence, unavailable to reads, decryption, new work or resumed transcryption.
The connected Extension has its own Replica and must retire it; filtering Desktop's list is insufficient.
Export's existing observation owns its exact Vault scope through ZIP, the ready Blob and final output;
nonplaintext retirement controls precede drain, and final output requires the same connection-owned
handle's publication lease. No separate Export registry or host Travel visibility map is introduced.

## Acceptance

Use the spec's observable acceptance table: real Server foreground ambiguity before/after mutation,
fresh-password retry, no extra Session/credential writes, out-of-order current-policy replies, real
Travel Sync events, SQLite/IndexedDB all-generation histories and Session-only keys, all Item categories,
pending Operations/preparations and protected artifacts, restart and reconnect. Verify erasure and
accepted evidence independently. Include two Core owners then actual Desktop–Extension messaging,
Extension autofill/passkeys, broker reattachment versus actual owner loss, and unrelated Account/Vault
survival. Actual Export tests cover zero/nonzero Attachments, ZIP/ready Blob/Download retirement,
reentrant close and both finalization-admission orders. Disable restores only fresh current authority.

Run targeted/generated/conformance/host checks and full `pnpm check:ci` and `pnpm check:ci:rust` before
phase acceptance. Controlled races and compilation supplement actual application paths; neither
establishes Travel production acceptance alone.

## Current acceptance status

The shared Travel capability is accepted after the required histories, independent review and both
literal full CI commands pass. The chronological
evidence below distinguishes controlled histories from actual host/Server runs and preserves failed
attempts and cleanup disclosures. Neither application migration is claimed by this ticket.

- Native Core/SQLite/keychain/Server assembly passes incoming Travel and foreground Save/Enable,
  lost Disable replies before/after execution, unavailable reconciliation and wrong-password/fresh
  retry. Empty/all-visible saves, shared/read-only choices, empty/over100 refusal and
  enabled-selection refusal also pass on the real Server assembly. Maintained acceptance requires
  scoped public User deletion; the failed read-only setup/reset exception is recorded below.
  Actual settings caller/process-loss histories pass2/2, including current-policy reconciliation
  without automatic mutation or proof replay. Tauri gestures remain66/73.
- Shared retirement passes captured-stage overlap, rejected/lost commits and fresh-owner recovery.
  Empty-omission startup, differing-proof adoption, retained-Move notification and physical
  retirement/readmission fixtures pass in the current full Core suite,1068/1068. Regenerated
  SQLite/IndexedDB conformance and recovery evidence remains current, including15,278 IndexedDB
  assertions; authority/Session erasure is checked separately from indispensable accepted work.
- The fixed Export observation and Begin/Finish bridge pass the current complete joined-Worker browser
  file, including zero/nonzero-Attachment Web archive, repeated Download, selective hide through Finish,
  hide/readmit, throwing output, Close and actual Worker loss. Independent cleanup review and affected
  Web types and the final literal full host CI pass. That CI run includes all38 maintained joined
  browser cases with574 assertions; literal Rust CI also passes.
- Connected Core tests cover selective restrictions, existing/mixed journals, complete-stage
  classification, cancellation, pending reason overlap, failed multi-Account adoption, replay and
  captured completed removal. The complete native namespace passes76/76, including source/consumer
  replacement, independent revalidation, expiry and capacity limits. Actual framed
  native messaging passes the complete pending-Move, borrowed restoration and independent
  restoration history with supported disconnect/unlock/fresh-port reattachment, original Lock/EOF/
  owner-loss checks and both scoped public User deletions under
  [the shared contract](../desktop-extension/native-travel-policy.md).
- Final independent simplification and acceptance review found no remaining capability blocker.
  Literal `pnpm check:ci` and `pnpm check:ci:rust` both pass.
  Desktop production remains on its existing composition. Actual Chrome combined Worker/native
  Port, broker reattachment and production autofill/passkey cutover remain74/76/77; Extension
  production has not migrated.

## Comments

2026-09-08: dependency-ordered delivery scope recorded. No implementation or acceptance is claimed.

2026-09-09: selective file/image/foreground retirement depends on
[ticket 86](86-selective-vault-capability-retirement.md). Hidden-Vault erasure must retire only exact
Core-supplied targets and preserve unrelated Vault activity. This foundation does not settle the
remaining Travel operation/proof/durable-erasure frontier or make this ticket implementation-ready.

2026-09-09: research88 resolved the retained-result/current-authority frontier through one existing
receipt-and-refresh transition. [Implementation89](89-retained-results-current-authority.md) now gates
remaining convergence; a proved old action must neither overwrite newer authority nor use hidden keys.

2026-09-09 ownership follow-up: actual Web `createRuntimeVaultArchive` retains the Items projection
through asynchronous ZIP construction and observes only Account departure. Ticket86 now scopes its
Attachment grants before the first await and releases unused sinks. Ticket71 must also cancel an
archive when Core retires a captured Vault (including an archive with no Attachments), without
inferring Travel policy in the host or allowing hide/readmit to revive that old plaintext attempt.
Include this real existing export caller in hidden-Vault projection/foreground acceptance; current
Account-lock tests alone do not establish selective erasure.

2026-09-09: the maintainer resolved81 in favor of existing foreground settings. Core reconciles a
lost disable response against current Server policy and requires fresh password entry/proof if
another attempt is needed. No durable disable Operation, persisted login secret or automatic proof
replay is added. Detailed command/projection and acceptance mapping plus70/89 remain prerequisites;
this decision alone does not make71 ready or claim Travel integration.

2026-09-09: actual Core/Server/Desktop/Extension/Web ownership inspection sealed the detailed71
command, proof, policy-ordering, native and Export lifetime contract. Root approved the generated
connection-owned Export control seam, including nonplaintext cancellation before foreground drain,
ready-Blob cleanup and output publication admission. Legacy Mobile Travel callers prevent premature
shared-hook deletion. Prerequisites65/81/86/87/89 are resolved;68/70 remain open.

The actual image backend still persists raw image chunks. Research92 and delivery93 separately gate
protected accepted-image retention; public Server bytes give no plaintext exception. This technical
frontier keeps71 `needs-triage` until its mechanism is independently sealed. No Travel implementation
or acceptance was performed in this documentation slice;70's no-image foundation remains independent.

2026-09-09 final frontier verdict:92's protected-image mechanism and93 delivery contract passed
independent review. The Travel/Export capability contract is now decision-complete, so71 is
`ready-for-agent` with its incomplete68/70/93 dependencies still blocking implementation. Readiness
does not mean those capabilities or Travel acceptance are complete. No additional product question
remains in this specified slice.

2026-09-09 real incoming-policy prerequisite evidence: the shared four-process native fixture accepted
protected Create/Update images offline, restored their locked encrypted archive exactly, then used a
separate real SRP Device to enable Travel for the pending Update Vault. Actual run2 reached enabled
Server policy and its `travel_mode_updated` User event but failed the unchanged60-second combined
hidden-authority predicate while Ready/Unlocked (`/tmp/bittery-protected-image-native-hidden-four-process-2.log`).
It did not prove hidden erasure. Read-only Server request evidence includes Sync changes and Bootstrap
responses after enable (`/tmp/bittery-hidden-run2-server-evidence.log`).

Independent source audits establish the missing integration boundary: Server Sync Bootstrap deliberately
queries `vault_key` membership, not Travel policy (`apps/server/src/domains/sync/records.rs`,
`fetch_user_vault_ids` and `fetch_bootstrap_vaults`). Core live Sync recognizes structural User events
and re-Bootstraps, but that path does not yet fetch/apply fresh verified Travel policy. Existing verified
policy handling is in authentication/local unlock/native import. Therefore a Travel update does not
mean Server Bootstrap omits the hidden Vault. Ticket71 must implement its already specified policy
ordering/retirement/restoration capability; adding a host filter or changing artifact storage would
not implement that contract. This observation does not start71 ahead of its incomplete dependencies.

The actual history is retained as the distinct named Playwright case
`native Runtime consumes incoming Travel policy while retaining protected images`, sharing the existing
native four-process fixture. It retains all original hidden assertions, zero-upload counter, exact
ciphertext, unrelated Move, proof-backed restoration and final image convergence; it is an explicit
current integration red, with no expected-failure declaration or new skip. The independently named70/93
baseline retains Create/Update image recovery, lost Delete result and Move convergence. Both use the
existing native-toolchain opt-in. The diagnostic run3 never executed native acceptance because a
concurrently edited68 test failed compilation; no additional policy evidence is claimed. Both run2/3
Users were subsequently deleted through existing public Web Runtime sign-in/deletion with actual
HTTP200 against the retained isolated database, before any new launcher reset.

2026-09-09 read-only first-slice implementation map, reviewed by the phase owner; no implementation
or status change. The existing real hidden-policy red and all deadlines remain unchanged. Start only
after the incomplete capability prerequisites and required full checks close.

- Deepen the existing Account execution boundary. `runtime/live_sync.rs::sync_authority` already
  holds it while calling `bootstrap.rs::run_bootstrap`; use an internal already-fenced policy helper,
  not another mutex/runner. Route authoritative GET, foreground responses, local access and native
  import through one validated installation boundary. `biometric.rs` and `native_authority.rs`
  currently fetch policy before acquiring Account execution and later overwrite metadata; preserve
  their ceremony semantics while preventing an older reply from replacing newer verified policy.
- Handle `SyncEventType::TravelModeUpdated` as invalidation before ordinary Item/Operation page
  publication, native authorization or advancing the cursor past it. Current `run_bootstrap` hydrates
  before catch-up, and the structural branch reconciles Operation events before re-Bootstrap. Both
  ordering points need the sealed policy gate, including reconnect/quiet-stream/full-refresh paths.
  The event carries no policy timestamps. Reuse `prepare_verified_travel_policy` and add the specified
  100-ID validation there; its current duplicate/identity/timestamp checks are not the complete bound.
  `AuthHttpClient::get_travel_mode` bounds bytes but has no elapsed deadline, so compose existing
  cancellation/timer facilities for the specified bounded read and existing authentication allowance.
  Local access's cached-policy transport fallback cannot satisfy a known incoming invalidation.
- Begin the existing selective retirement/publication fence before awaited metadata or purge writes.
  Persist verified metadata for the exact incarnation as the explicit-policy proof, then reuse
  `PlanMutation::RetireVaults` for atomic all-generation authority removal and the existing journal.
  Extend the existing `VaultRetirementProof`/resume payload for that proof; do not fabricate a complete
  Bootstrap or add a second journal. `runtime/open.rs` already keeps restored Accounts private until
  cleanup; reconstruct policy-backed duties there before `ready` publication, even if a crash occurred
  after metadata persistence but before the purge journal. Failed proof storage cannot claim durable
  acceptance, and a later disable cannot skip unfinished prior erasure.
- Reuse `vault_retirement.rs` for concurrent host retirement/Core loan drain, native source generation,
  effective borrowed and dormant independent Session pruning, artifact cleanup and exact journal
  acknowledgement. Include Session-only keys. Refresh or prune the caller's captured Session too:
  later renewal/writeback must not restore hidden keys. Keep exact encrypted accepted work and required
  protected image/Move artifacts while refusing their decryption or resumed transcryption.
- Make Bootstrap admission and `readmit_current_vault_authority` obey the same verified policy. Server
  membership pages intentionally contain hidden Vaults; a one-time purge followed by current unfiltered
  hydration would re-admit them. Preserve real Server page/cursor/fingerprint validation. Disabled
  policy requires finished prior cleanup and fresh current wrapped-key authority before opening new
  capability generations; old picker, export and native scopes remain retired.

Smallest test-first sequence: extend the actual Core Sync history with a Travel event and concurrent
Item/Operation events while authoritative GET is held; prove no publication/cursor bypass, then exact
fence → metadata proof → purge/journal → drain/Session pruning → acknowledgement. Exercise unavailable
GET without cached-offline success, delayed older local/native replies, and restart after proof but
before purge and after purge but before Session cleanup. Keep the original protected image intent and
ciphertext exact and prove unrelated accepted work progresses. Then run the unchanged maintained real
`native Runtime consumes incoming Travel policy while retaining protected images` case, using its
existing second Device enable/proof-backed disable, 60-second hidden predicate, zero image PUT attempts,
exact retained ciphertext, unrelated Move and later exact PNG convergence. This first incoming-policy
path reuses the common owner needed by later foreground commands; it does not substitute for the full
connected Extension, Export lifetime, foreground ambiguity or actual application acceptance matrix.

2026-09-09 the phase owner accepted the bounded [pending-verification refinement](../desktop-extension/vault-travel.md#pending-verification-before-an-incoming-policy-is-known)
for independent review before implementation. It uses one boolean in existing Bootstrap metadata plus
the existing foreground owner's precommit admission fence, with strict old-record default/validation,
exact incarnation/revision guards and preservation across every same-incarnation head/recovery
transformation. Known pending verification refuses fresh plaintext delivery and new read/work/native
authorization; only already-delivered confirmed UI and admitted loans may remain until proved selective
retirement. Nonplaintext status, control/Sync and exact accepted ciphertext dispatch remain available.
Fresh durable policy proof and selective duties replace the verification gate promptly so unrelated
Vault admission resumes; prior journal duties remain binding. The spec now records controlled commit/
GET/delivery races, restart/acknowledgement loss and schema tests before the unchanged real history.
No implementation, schema mutation, test run or ticket status change accompanies this refinement.

2026-09-09 independent review refined two pending-state boundaries. Keep established native source
state/key generation unchanged while policy is unknown; do not broadcast false
`key_authorization_available`, which currently retires the connected consumer Account. The same Core
gate refuses new exports/final encoding, and only verified selective retirement advances authority.
The bounded GET holds existing Account execution, so same-Account accepted ciphertext is eligible but
cannot execute through that held lock. Prove its progress after bounded failure/cancellation releases
execution while pending remains durable; unrelated-Account progress is tested during the hold. New
unrelated-Vault admission likewise respects existing execution ownership after the gate clears. The
spec and test sequence now state these distinctions without adding another lock, runner or policy.

2026-09-09 implementation handoff prepared read-only while final prerequisite checks run. The phase
owner approved the first public-seam reproducer and internal helper boundary below; implementation
still waits for explicit closure of the incomplete prerequisites.

The first controlled red extends `runtime/live_sync_tests.rs`, using its existing scripted HTTP and
commit gates with actual `Runtime::run_live_sync`, `Runtime::observe(Items)` and ordinary requests.
After confirmed visible authority and exact accepted ciphertext are established, deliver a real-shaped
`TravelModeUpdated` followed by Item/Operation events. Hold authoritative GET and prove it starts
before any new plaintext delivery or cursor/Bootstrap promotion. Current code re-Bootstraps without
that GET. The test then covers pending admission versus status/control, bounded failed verification
followed by eligible ciphertext dispatch, and an unrelated Account during the execution hold. No
foreground Travel command or new public test API is needed to reproduce this missing integration.

Incoming-policy ownership: add `runtime/travel_policy.rs` and focused tests; change
`runtime/bootstrap.rs`, `live_sync.rs`, `live_sync_tests.rs`, `open.rs`,
`foreground_attachment_lifecycle.rs` and `vault_retirement.rs`; deepen `replica/domain.rs`,
`persistence_contract.rs`, `recovery.rs` and their focused persistence/retirement tests. Own narrow
policy callsite adaptations in `local_access.rs`, `biometric.rs` and `native_authority.rs`, plus the
existing `authentication_installation.rs::prepare_verified_travel_policy` validator. Preserve other
work in those files. The phase owner owns foreground `authentication.rs`/`auth_http.rs`, public
`protocol.rs`, generated outputs and `runtime.rs` request/observation integration. Supply exact
module/admission/projection hunks for `runtime.rs` to that owner rather than editing it concurrently;
coordinate any additional file before widening ownership. The real native/Web fixture remains the
existing maintained case, with no deadline/assertion change or new runner.

Proposed internal methods, all requiring the caller's existing Account execution fence:

```rust
async fn begin_travel_policy_refresh_fenced(
    &self,
    expected: &ReplicaSnapshot,
) -> Result<ReplicaSnapshot, RuntimeError>;

async fn read_current_travel_policy_fenced(
    &self,
    expected: &ReplicaSnapshot,
    http: &AuthHttpClient<'_>,
    session: &mut CurrentSessionDocument,
    cancellation: RequestCancellation,
    renewal: Option<&mut OutcomeResolutionAuthBudget>,
) -> Result<VerifiedTravelModePolicy, RuntimeError>;

async fn apply_verified_travel_policy_fenced(
    &self,
    expected: &ReplicaSnapshot,
    policy: VerifiedTravelModePolicy,
) -> Result<ReplicaSnapshot, RuntimeError>;
```

The read is fresh and bounded. `Some` shares the foreground/Sync invocation's existing renewal
allowance; `None` preserves local/native retained-Session behavior without Session creation or renewal.
Offline local fallback remains a distinct existing ceremony result and is forbidden when a known
pending invalidation requires fresh verification. Apply owns selective fencing, durable metadata
proof/journal, pending-bit clearing and existing retirement wake/resume; it accepts no password/proof
material, and caller cancellation cannot discard an already durable duty. Its returned snapshot is
current local control evidence, not a promise that unfinished physical cleanup completed. Foreground
responses derive enforcement from that snapshot and the existing owners.

After apply, every caller must discard or reload its captured Session before further authority use,
renewal or writeback. Apply prunes both effective borrowed and dormant independent wrappers; the
mutable Session passed to an earlier GET does not receive those replacements automatically. This is
mandatory for `run_bootstrap`'s held local Session clone as well as settings/local/native callers.
Reload the effective Session under the same incarnation/execution guard; never write back the old
clone after selective retirement.

Serialization callsites: `live_sync.rs::sync_authority` already holds Account execution, so Bootstrap
calls the internal helpers without recursive acquisition. `biometric.rs::release_biometric_target`
currently fetches policy before its execution lock and later stores that reply; move bounded fresh
verification/application inside its existing guarded execution section, retaining cancellation,
local-only proof and post-prompt scope checks. Native import similarly fetches before its catalog/
execution section and overwrites reloaded metadata: move that exchange inside its existing admission
ordering and reuse the common apply boundary. A new native destination has no Replica snapshot yet;
keep its existing catalog/installation guard and use the same bounded lower Session exchange before
installation, then the common verified apply boundary once the real snapshot exists. Do not fabricate
a snapshot or grant a general unguarded policy write to fit the installed-Account helper signature.
Full Sign-in/Quick Unlock installation likewise consumes its already verified policy through the
common installation boundary, preserving replacement pending/journal duties until that proof applies.

2026-09-09 implementation began after68/70/93 and the other named prerequisites resolved with the
required full checks. The first public Runtime seam reproducer executed exactly one test and failed
at its intended assertion: `incoming_travel_invalidation_blocks_fresh_plaintext_until_current_policy_is_verified`
reported that incoming Travel must verify current policy before replacing or publishing authority
(`/tmp/bittery-travel-incoming-policy-first-red.log`, 2.01 seconds, exit101). The initially short filter
with `--exact` selected zero tests and is not counted; the recorded red uses the fully qualified test
name. It uses existing `run_live_sync`, Items/Operations observations and ordinary request interfaces,
with scripted Server/physical commit boundaries. The first implementation tracer handles unavailable
verification and durable admission gating; successful verified-policy installation/retirement and the
unchanged real incoming history still require their subsequent red/green checks. No phase completion
is claimed by this first reproducer.

2026-09-09 foreground proof tracer: the new pre-finish capability first failed its actual SRP
proof test (`/tmp/bittery-travel-password-proof-first-red.log`). The existing authentication
construction was then extracted once, preserving Secret Key/KDF validation, pinning, legacy lossy
Auth-key conversion, SRP group/hash/iterations and wire proof. The new proof is accepted by the
actual Rust SRP Server verifier without `finish_login`, Session creation or authority fetches.
All seven authentication tests passed (`/tmp/bittery-travel-password-proof-authentication-green.log`).
Independent review passed; a bounded follow-up hides the derived MUK/KDF/Session fields from the
Travel caller and exposes only a borrowed client proof. No password timestamp or persisted secret
was introduced. This establishes the proof capability, not foreground Travel commands or application
acceptance; their integration and the required new full checks remain outstanding.

2026-09-09 independent first-gate review found and reproduced two foreground publication defects:
an Attachment on Account A could bypass Account B's paused delivery token in a mixed writable
catalog, and a temporarily refused foreground catalog remained deduplicated after admission resumed
at the same revision. Both actual Rename/public-observation regressions failed behaviorally in
`/tmp/bittery-71-foreground-catalog-red.log` and passed in
`/tmp/bittery-71-foreground-catalog-green.log` (2 tests). The fix admits every represented Account's
token, forgets exactly the refused queued generation/revision/token set on either admission failure,
and releases short token loans before an admitted foreground host callback. The existing test hook
runs before those loans. Three final-boundary lifecycle tests and the cross-thread reentrant callback
matrix passed in `/tmp/bittery-71-foreground-lifecycle-green.log`; lifecycle still does not drain an
already admitted foreground host callback.

The bounded source review also accepted snapshot/registry pending inheritance by new delivery tokens,
stable native source availability while new export/final encoding is refused, and separate scoped
fresh-work admission versus target-free Sync/control and existing loans. The first incoming gate
reproducer is green in `/tmp/bittery-travel-incoming-policy-first-green.log` (1 test). This proves the
pending/unavailable tracer; verified application, physical selective cleanup and real history remain
subsequent acceptance work.

The exact disable endpoint200 wire test failed against its stub, then passed with one POST and no
Session creation or retry (`/tmp/bittery-71-travel-disable-auth-red.log` and
`/tmp/bittery-71-travel-disable-auth-green.log`). Independent review required synchronous request
preparation: the generated client proof is wiped before the method returns, and even an unpolled
returned future owns only zeroizing serialized proof bytes. Its first poll transfers bytes directly
through existing execute_json/HttpDispatch before suspension; header/URL preparation errors also drop
the zeroizing body. That final ownership refinement passes source review and awaits the next already
scheduled compile/check. This evidence does not establish definitive/ambiguous response classification,
foreground command integration, whole Travel acceptance or phase completion. Ticket status is unchanged.

2026-09-09 the first positive incoming-policy tracer is green in
`/tmp/bittery-travel-incoming-policy-apply-final-green.log` (1 exact Core test). Its public
`run_live_sync`/Items observation/Create path holds an already-admitted host callback, queues a
pre-invalidation plaintext frame, and proves that pending verification refuses that queued frame
without draining the earlier callback. A valid current-policy reply then removes the selected
Vault/Item authority and Session wrappers, keeps the exact accepted Operation and ciphertext, consumes
the event, resumes the mounted observer and permits new work in an unrelated Vault. Server Bootstrap
continues to return full membership; Core filters only verified hidden authority while retaining the
raw response fingerprint. The intended application red is
`/tmp/bittery-travel-incoming-policy-apply-second-red.log`; the earlier setup run had an invalid string
Bootstrap cursor, corrected to the actual `{ id }` response. A later diagnostic also corrected the
expected unrelated-Vault set: the shared fixture already contains `vault-2`, which must remain visible.
Neither correction changed the production contract or deadlines.

This green is bounded to the first successful selective application. Durable proof-write failures,
restart reconstruction, a missing retained event/cursor reset, post-watermark policy verification,
later hidden-Item events, local/native common-application wiring, foreground commands and the unchanged
real incoming-Travel history remain open. In particular, a fresh GET only before Bootstrap cannot
prove the policy applicable to its later captured watermark: policy may change in between. The next
controlled sequence must verify after that watermark and before promotion, rebuild stale staging when
policy changes, and process later events from the pinned cursor before plaintext publication. No
pre-Bootstrap GET or timestamp equality is being claimed as an ordering guarantee.

2026-09-09 implementation and independent frontier review sealed the bounded
[transient verified-policy proof retry](../desktop-extension/vault-travel.md#retrying-a-selected-retirement-before-its-proof-is-durable)
refinement. A bare fingerprint cannot reconstruct a failed metadata attempt; rebinding to newer
policy loses old cleanup IDs in the metadata-before-journal crash window. Retain the original
validated policy only in the existing transient retirement proof, shared and bounded, and replace
it with the existing journal proof on commit. It never authorizes current reads or GET fallback.
Journal-first reread after acknowledgement loss, startup reconstruction from durable metadata,
serialized metadata writers and the shared100-ID validator are required. This records the routine
mechanism before its failure/restart implementation; no new owner or acceptance claim is introduced.

2026-09-09 foreground disable transport classification is green at the existing typed HTTP seam
(`/tmp/bittery-travel-disable-classification-green.log`,2 tests). One generated proof request uses
the existing retained Session and no finish-login. Authentication-looking/ambiguous replies require
current-policy reconciliation; the POST helper neither renews nor replays. Definitive400/403 refusal
remains typed, and synchronous preparation wipes the raw proof even if the returned future is never
polled. The foreground commands and actual Server ambiguity histories still require implementation.

2026-09-09 independent lifetime review found that Sync retained a full Session document while
opening a stream and indefinitely during quiet SSE after hidden wrappers were pruned. Two focused
regressions reproduced one live old snapshot at each boundary
(`/tmp/bittery-travel-sse-session-lifetime-red.log`,
`/tmp/bittery-travel-sse-session-held-open-red.log`). A scoped, nonserialized `cfg(test)` witness at
the existing platform-storage decode seam follows actual Clone/Drop and contains no credentials.
Core now retains only the existing secret token before every opening await and throughout SSE;
renewal still reloads current authority under the same Account execution guard and budget.
All23 live Sync tests passed, including both lifetime histories, current-wrapper renewal, incoming
selective apply, opening authentication, quiet-read preservation and lifecycle cancellation
(`/tmp/bittery-travel-sse-session-lifetime-final-green.log`). Coordinating source review passed:
the witness has no production wire/equality or global-registry effect, and no retry owner was added.
This is supporting Core evidence; complete71 and actual connected-host acceptance remain open.

2026-09-09 the later hidden-Item Sync variant is red/green in
`/tmp/bittery-travel-hidden-item-progression-red.log` and
`/tmp/bittery-travel-hidden-item-progression-green.log` (1 exact test, green0.05s). After a verified hide,
the actual-shaped Server still answers membership Item authority. Core now checks that returned
record's current Vault against durable verified policy before visible-Vault validation or application;
it does not infer current location from an older event. A later visible Item in the same page reaches
the mounted plaintext observer and advances the cursor, while no hidden Item row returns.

The first original-proof retry variant is also red/green:
`/tmp/bittery-travel-policy-proof-write-failure-red.log` and
`/tmp/bittery-travel-policy-proof-write-failure-green-2.log` (1 exact test, green0.03s). An injected
platform metadata SET failure leaves incoming Sync pending and selected scopes fenced. A newer
disabled reply through public `RefreshTravelMode` first retries the original validated policy proof,
purges and completes its journal, then stores disabled metadata. The storage-boundary assertions keep
the original accepted Operation exact and the old selected scope retired until fresh Bootstrap.
The existing transient retirement proof now owns shared immutable original response evidence solely
for that storage duty and releases it to `DurableJournal` before awaiting cleanup. The first green
compile attempt was blocked by an unrelated new Travel projection match arm; it provided no behavioral
evidence. The required100-ID response/document bound, lost acknowledgements, startup proof
reconstruction and complete local/native writer integration are still subsequent checks; this single
write-failure result does not claim those variants or phase completion.

2026-09-09 the first public foreground `RefreshTravelMode` tracer passed after its intentional
unavailable-command red (`/tmp/bittery-travel-foreground-refresh-first-red.log`,
`/tmp/bittery-travel-foreground-refresh-first-green.log`,1 test). It performs a fresh authenticated
policy read and shared application without accepting an Operation or replacing a usable Session.
The public Account-scoped `TravelMode` observation also failed its unavailable stub, then passed
(`/tmp/bittery-travel-observation-first-red.log`,
`/tmp/bittery-travel-observation-first-green.log`,2 foreground tests). It distinguishes no verified
policy from verified disabled settings. Configuration is a display-only copy in the existing Account
presentation; enforcement derives from the existing pending, retirement and Bootstrap owners. It
adds no policy authority/cache or plaintext delivery capability. Failure/retirement observation
variants, all settings mutations, generated consumers and application acceptance remain outstanding.

2026-09-09 [research99](99-connected-native-selective-travel-policy.md) is resolved after
coordinating and independent review. Its [connected selective contract](../desktop-extension/native-travel-policy.md)
now governs this ticket’s connected variant: atomic first source fence, bounded acknowledged
restrictions, exact consumer journal adoption, monotonic grant exclusions, provenance-preserving
independent revalidation and separately scoped pending reasons. All use existing Core owners.
Desktop hard Lock/EOF remains Account-wide; no connected implementation or acceptance is claimed
from the decision. Dependency99 is complete, so existing71 and its connected tracer may proceed.

2026-09-09 unavailable foreground refresh now returns the explicit `Uncertain` result with the
unchanged last verified configuration; it does not persist a failed response or replay a request.
The public test failed with RetryableTransport before the mapping
(`/tmp/bittery-travel-refresh-unavailable-first-red.log`), then all3 foreground request/observation
tests passed from the fresh100-ID validation binary
(`/tmp/bittery-travel-refresh-uncertainty-green.log`). Cancellation, malformed response, permission
and storage failures remain typed. Independent source review accepted the existing owner reuse,
Session drop and display-only projection, and found a missing mounted-observer pending transition;
that additional held-GET regression is the next tracer. No whole71 acceptance is claimed.

2026-09-09 the shared policy selection bound is red/green in two maintained tests:
`/tmp/bittery-travel-policy-boundaries-red.log` and
`/tmp/bittery-travel-policy-boundaries-green.log` (2 tests, green0.02s). Public refresh accepts100
configured IDs and rejects101 before selecting a retirement scope or replacing verified metadata;
a physically damaged101-ID metadata document is rejected on load. Server preparation, stored-policy
validation and common apply use the same bounded ID validator, retaining nonempty/duplicate checks.
This bounds the existing transient proof payload; inconsistent stored activation timestamps, lost
acknowledgements and startup proof reconstruction remain explicit subsequent variants.

2026-09-09 the held selective-cleanup Session lifetime regression failed with one retained GET
snapshot, then passed after both incoming-event and pending-Bootstrap callers drop their Session
before common apply and reload the effective document after cleanup
(`/tmp/bittery-travel-held-cleanup-session-red.log`,
`/tmp/bittery-travel-held-cleanup-session-green.log`,1 exact test). The existing calibrated lifetime
witness and a real admitted Item guard hold cleanup after the durable journal; no new lifetime owner
or artificial policy path is used. This proves the incoming-event held-drain history. The separate
full-Bootstrap promotion captures, local/native verification writers and post-watermark verification
still need their own maintained variants; this result does not close those paths.

2026-09-09 Export lifetime first slice: the public fixed Export observation plus public current-policy
Refresh now retains a zero-Attachment snapshot's exact foreground scope until host cleanup closes its
existing observation handle. A terminal nonplaintext retirement control is delivered before waiting
for that acknowledgement; unrelated Vault projection remains available. The first run supplied an
invalid enabled-policy fixture without `enabledAt` and is setup evidence only
(`/tmp/bittery-vault-export-lifetime-first-red.log`). The corrected history reproduced the actual gap:
Refresh reported Ready while the host still retained its snapshot and had received no retirement
control (`/tmp/bittery-vault-export-lifetime-second-red.log`). The same maintained test now passes1/1
(`/tmp/bittery-vault-export-lifetime-first-green.log`). It uses the real Core observation, foreground
retirement and policy-apply owners with the existing HTTP/storage primitive fixture; this is not yet
Worker/ZIP/ready-Blob/native output acceptance. Final-output admission, host forwarding/cleanup,
reentrant close and connection-loss variants remain required. The shared spec now makes explicit
that ordinary unsubscribe acknowledges completion of all observation-owned host work, including any
admitted output; orderly close must still carry terminal controls and those cleanup acknowledgements.

2026-09-09 the mounted Travel observation regression reproduced a missing pending transition
(`/tmp/bittery-travel-observation-pending-red-2.log`,1 test). Entering the existing live admission
fence now advances Device revision and publishes nonplaintext settings state before the awaited
durable marker write. All4 public foreground request/observation tests pass
(`/tmp/bittery-travel-observation-pending-green.log`); the earlier compile attempt only corrected a
borrow in the new test assertion and is not behavioral evidence. No new observation owner was added.

The connected99 first implementation tracer now uses two actual Core/SQLite assemblies, public
RefreshTravelMode and Items observations, actual key transfer and generated ApplyAuthority control.
It fails at the expected consumer state: Desktop selectively hides VaultA but consumer Account/VaultB
becomes Locked (`/tmp/bittery-native-travel-selective-first-red.log`,1 test,9.34s). Native continuation
implementation is underway under the sealed99 contract. This is a maintained capability reproducer,
not production Extension/Tauri or remote-erasure acceptance.

2026-09-09 the no-retained-event Bootstrap tracer failed because full membership authority promoted
without a fresh policy read after its captured watermark
(`/tmp/bittery-travel-bootstrap-watermark-first-red.log`). After the bounded incoming fix,
`policy_apply` passed3/3 (`/tmp/bittery-travel-bootstrap-watermark-first-green.log`) and all3 Session
lifetime tests passed (`/tmp/bittery-travel-session-policy-lifetimes-green.log`). Hydration persists
pending verification before staging or resuming an old final stage and reads current policy after
capturing the Server watermark, before promotion. A changed effective hidden set invalidates the old
filtered stage before policy metadata replacement; the existing Sync retry rebuilds it without
changing raw response fingerprints. Repeated verification preserves already completed exclusion
lifetimes while still purging authority present in any physical generation. The test retains the
exact accepted Operation and verifies hidden-row absence plus unrelated authority convergence.
Existing event-policy fixtures now explicitly answer both the event GET and its subsequent
post-watermark GET; their held-read and lifetime assertions and deadlines remain intact. Explicit
disable readmission outside a staged Bootstrap, startup proof reconstruction, remaining writer
integration and actual application acceptance remain separate unfinished variants.

2026-09-09 the first `SetTravelModeHiddenVaults` request now passes at the public Core/HTTP seam
(`/tmp/bittery-travel-save-selection-first-red.log`,
`/tmp/bittery-travel-save-selection-first-green.log`,1 test). It requires current visible Account
Vaults and verified disabled policy, sends one PUT, and stores the verified configuration without
hiding authority or accepting an Operation. The generated existing Server request DTO is reused;
generator8/8 checks pass (`/tmp/bittery-travel-settings-server-generator.log`). Save and Disable
share one HTTP dispatch/response-classification implementation; both existing proof/one-use dispatch
tests pass after extraction (`/tmp/bittery-travel-settings-proof-dispatch-regression.log`,2 tests).
The next tracer covers a lost save response through bounded current-policy reconciliation, without
reposting. Enable/Disable commands, cancellation/role/failure variants, generated runtime consumers
and real foreground Server/application acceptance remain open.

2026-09-09 Export finalization primitive: the next public history first refused valid Begin at the
unavailable implementation (`/tmp/bittery-vault-export-output-first-red.log`). Both Core Export tests
now pass (`/tmp/bittery-vault-export-output-first-green.log`,2/2): a current delivered snapshot admits
one output lease; later Lock emits retirement but waits; an incorrect Finish releases nothing, and
exact Finish closes the same observation lifetime. The coordinator independently reviewed the first
scope registration/callback/drop ordering. Review also identified fixed-frame delivery/retry and
pending Move source-lineage gaps; their maintained regressions and corrections remain required,
alongside actual bridge/archive/Blob/output acceptance. This primitive result does not close71.

2026-09-09 explicit verified disable/readmission failed because the public result reported Ready
before fresh authority (`/tmp/bittery-travel-disable-readmission-first-red.log`). The corrected
`policy_apply` matrix passed4/4 (`/tmp/bittery-travel-disable-readmission-first-green.log`). When
previously hidden IDs become eligible again, common application persists `RefreshRequired` before
newer policy metadata, preserving hydration duty across either side of that write. Old scopes stay
fenced; only fresh complete Bootstrap, post-watermark policy verification and existing readmission
allow new work in the Vault. Configuration-only edits while disabled do not request hydration.
This current-authority path reuses Bootstrap's direct unwrap of current Vault authority; it does not
restore old Session wrappers or revive old handles. Other crash/fault and connected-native variants
remain separate work; this is not whole-ticket acceptance.

2026-09-09 real incoming-Travel rerun: the maintained command with package `web` executed the native
child, but stopped during sign-in with a default test-thread stack overflow before Travel assertions
(`/tmp/bittery-native-incoming-travel-runtime-second.log`). Public Runtime scoped Server User deletion
was proved by actual HTTP200; restricted local fixture files were retained for diagnosis. An earlier
command using `@bittery/web` matched no package and is not evidence. The same native binary reproduced
the overflow offline in under a second (`/tmp/bittery-native-stack-offline-probe.log`). A diagnostic-only
16MiB test stack instead reached the expected authentication transport error
(`/tmp/bittery-native-stack-larger-offline-probe.log`). Disassembly identified nested large async frames:
roughly476KiB in command dispatch,602KiB in the composed sign-in acceptance path and495KiB in its
parent phase. The request boundary now heap-pins its existing dispatcher, retaining caller polling,
cancellation and policy ownership; default-stack regression and real acceptance rerun are pending.
No production stack setting was increased and no incoming-Travel acceptance is claimed from this run.

The default-stack native executable now reaches the expected offline authentication transport error
without overflowing after the shared request-boundary pin
(`/tmp/bittery-native-stack-pinned-offline-probe.log`; fresh native build
`/tmp/bittery-native-request-frame-build.log`). This is positive evidence for the reduced stack
regression only: the deliberately unavailable Server still makes the acceptance test return failure.
Independent source review confirms unchanged caller polling/drop, cancellation and request ownership.
The real maintained Server history still needs rerunning before native Travel acceptance.

After the scoped HTTP200 deletion and completed stack diagnosis, the failed-run credentials/control
files and all three isolated empty-Account diagnostic stores were removed by exact file/directory
cleanup. Diagnostic logs remain; no retained test credentials or local Account stores are needed for
the next independently provisioned acceptance run.

2026-09-09 Export fixed-frame regression reproduced a later accepted Item edit replacing the captured
Bank snapshot (`/tmp/bittery-vault-export-fixed-frame-first-red.log`). The existing Subscription now
owns that single captured frame before publication locks release, retries the same frame after a
paused admission with a current delivery token, and drops its Core payload after successful delivery.
It never reprojects later Items for this Export. The four public Core Export histories pass
(`/tmp/bittery-vault-export-fixed-frame-third-green.log`,4/4): concurrent Item edit preserves the
original title/password; incoming policy verification pauses initial delivery and denies Begin;
unchanged policy and unrelated Vault hide both resume the original frame exactly once; previous
cleanup and output-lease histories remain green. The unrelated-hide case also replaces the invalidated
Account delivery token without changing the captured Export scope.

Intermediate runs are not additional production failures: the first paused fixture incorrectly
expected a fresh settings GET to establish incoming-policy pending admission, and the concurrent test
hook held its own test-only mutex across its callback. The fixture now sends an actual incoming
User/SSE invalidation, and the hook clones before calling outside its mutex. A subsequent cursor wait
released only the incoming policy GET; it now also releases the required post-watermark verification
with the same policy, preserving the original timeout. No production policy or timeout was weakened.
Exact pending-Move source scope, bridge terminal delivery/close acknowledgements, archive/ready Blob
ownership and actual application final-output acceptance remain unfinished; this four-test result
covers the Core observation primitive only.

2026-09-09 pending verification versus accepted ciphertext dispatch: the public live-Sync/dispatch
history reproduced an Applied Item receipt also installing freshly fetched authority while a failed
current-policy GET left verification pending
(`/tmp/bittery-travel-pending-dispatch-first-red.log`). Both Applied and rejected Item reconciliation
now consult the existing aggregate pending gate before choosing current-authority reconciliation;
the existing retained-result commit still completes the original accepted work. The exact test passes
(`/tmp/bittery-travel-pending-dispatch-first-green.log`,1/1): after bounded verification releases Account
execution, public dispatch proves the original Applied receipt and fingerprint, preserves the Sync
cursor and authoritative Item rows, and continues refusing fresh Item observation. This does not claim
progress while the same Account execution lock is held. Connected-native reason separation, final
publication interleavings, startup proof reconstruction, all local/native policy-writer migration and
full acceptance remain unfinished. No new receipt kind, retry loop or policy owner was introduced.

2026-09-09 foreground enable first path: the public command's meaningful stub RED
(`/tmp/bittery-travel-enable-first-red.log`) now passes together with all six earlier foreground
Travel tests (`/tmp/bittery-travel-enable-first-green.log`,7/7). One POST carries the complete selected
Vault set; common Core policy application erases selected authority and Session wrappers, preserves
unrelated Vault authority, and accepts no settings Operation. Save and Enable share one command
implementation, validation and HTTP body owner. The first attempted build had only a fixture field
name error and is not behavioral evidence. Independent review passed this shared first path and found
a remaining case: HTTP200 JSON with invalid policy semantics must enter current-policy reconciliation,
rather than exit before fencing the potentially committed remote mutation. That regression/fix,
Disable wiring, held cancellation/publication variants and generated bindings remain unfinished.

2026-09-09 actual incoming-Travel attempt3
(`/tmp/bittery-native-incoming-travel-runtime-third.log`) passed default-stack native sign-in and
performed real Server Bootstrap/changes requests, then stopped before the Travel scenario with
`Observation failed: AuthorityMissing`; the Account was Unlocked with no reported failure. Public
Runtime scoped Server User deletion again returned actual HTTP200, and the retained credential/
control directory was removed afterward. Source review confirms that post-watermark policy verification
intentionally refuses fresh Item observations while pending, while the native harness's bounded
Item wait currently propagates that transient error immediately. The phase-only log does not establish
which Item sample failed. A narrow typed harness correction is underway: only bounded convergence
waits may retry `AuthorityMissing` when the same Account's public Travel projection is `Unverified`;
other errors and one-shot assertions remain strict, with unchanged deadlines. Exact stage diagnostics
and a further real rerun are required; this attempt establishes neither incoming erasure nor restoration.

2026-09-09 pending-Move Export scope: the corrected public regression proved Refresh could report
Confirmed/Ready while a destination export retained the pending Move's source-derived plaintext
(`/tmp/bittery-export-move-source-second-red.log`). Its first run lacked the artifact retirement
capability and stopped at StorageUnavailable; that was fixture setup, not the behavioral red. The
fixture now uses the existing SQLite artifact store and Account lease primitive, allowing a real
selected cleanup query to establish that this zero-Attachment Move has no artifacts.

Export now derives a fixed Vault union from each captured overlay's exact extant Operation or
Attachment Move preparation, reusing the existing accepted-request Vault parser. Registration,
resumed frame delivery and final output all use this captured union. A matching Operation ID must
also name the captured Item and target Vault. Later authoritative Items do not inherit historical
Move scope. Existing Failed local overlays without extant accepted/preparation work continue to use
their current Vault, matching ordinary projection retirement filtering; a Pending overlay missing
its promised owner fails closed. The first five Export histories and five existing Vault visibility
regressions passed (`/tmp/bittery-vault-export-move-source-first-green.log`,
`/tmp/bittery-vault-export-move-scope-regressions.log`). Coordinator source review accepted the shared
parser/guard ownership and requested the explicit Item/target equality checks, which are now present;
the final guard rerun is tracked separately. Early terminal control while Account execution is held,
bridge/host cleanup and actual archive/Blob/output acceptance remain outstanding.

The semantically invalid HTTP-success case now has a meaningful public-command RED
(`/tmp/bittery-travel-malformed-settings-first-red.log`) and GREEN for both Save and Enable
(`/tmp/bittery-travel-malformed-settings-first-green.log`, all8 foreground tests pass). Failed semantic
verification enters the existing pending fence and single bounded current-policy read, preserving the
verified document until a valid policy is obtained; no mutation replay or additional policy owner is
introduced. Generated bindings, Disable and held cancellation/application variants remain pending.
The final explicit-owner-guard rerun passed5/5 with no warnings
(`/tmp/bittery-vault-export-move-source-final-green.log`).

2026-09-09 Disable input/error review: the public password input uses existing `SecretString` with a
string wire schema, so caller drop before first polling or while waiting for admission still clears
its owned Rust secret. Missing existing local proof material has typed `CredentialUnavailable`,
distinguishing it from a locked Account without host message parsing or automatic Sign-in. The first
public proof test is registered; independent review requires a fresh scope/pending/unlocked check
after SRP awaits and synchronous HTTP serialization followed by dropping password/QuickUnlock/proof
before polling POST. Lost response, wrong password, missing material and cancellation variants remain.

2026-09-09 actual incoming-Travel attempt4
(`/tmp/bittery-native-incoming-travel-runtime-fourth.log`) progressed through native sign-in,
authoritative initial Items, offline Vault rename, exact image replacement/removal, and Attachment
upload/rename/verified download/delete against the real Server and native stores. It stopped at the
newly identified `Sign-in Vault creation` wait with transient `AuthorityMissing`, still before incoming
Travel assertions. Scoped User deletion returned HTTP200 and its retained credential/control files
were removed. The complete native acceptance-module audit now routes all bounded Items waits through
one public-projection sampler, preserving original deadlines, strict one-shot/Operations/physical
checks and exact stage diagnostics. The sampler permits temporary refusal only under the same
Account's public `Unverified` state; if verification has already completed between samples, it retries
Items once strictly. This harness correction still needs the next actual run. No OS dialog, renderer,
connected Extension or incoming-Travel acceptance is established by these intermediate results.

2026-09-09 complete-Bootstrap Session lifetime: the public live-Sync history with a real structural
Vault event, complete membership omitting that Vault and unchanged disabled post-watermark policy
reproduced two retained Session snapshots while selective cleanup waited on an already admitted
Item loan (`/tmp/bittery-travel-bootstrap-session-first-red.log`). Promotion now keeps only the
selected omitted Vault IDs and drops its independent/effective Session documents before the first
retirement wait. All four existing Session lifetime histories pass
(`/tmp/bittery-travel-bootstrap-session-first-green.log`,4/4), including this exact held-cleanup case,
policy-GET cleanup, quiet SSE and held stream opening. The omitted Vault's stored wrapper is removed
after drain while the unrelated Vault's wrapper remains. No new lifetime witness, registry, cleanup
runner or Session reload was added; the existing caller reloads after completed promotion. This is
bounded Core lifetime evidence, not connected-native or whole-ticket acceptance.

2026-09-09 Export early-Lock control: the maintained public history holds the existing Account
execution mutex and polls a real Lock request to its first await. The meaningful RED observed no
terminal control until execution released (`/tmp/bittery-export-lock-control-first-red.log`). Lock now
hands off the existing Account foreground-retirement notification immediately after its explicit or
exact-generation first fence, outside publication/native/registry guards and before lifecycle or
execution waits. The refused-Session path still proves its captured Session before fencing and uses
the existing drain notification. No callback registry or retirement owner was added. All six Core
Export histories pass (`/tmp/bittery-export-lock-control-first-green.log`), including fixed-frame
publication, paused delivery, exact admitted output and pending-Move source lifetime. This does not
claim native hard-retirement handoff, generated bridge delivery, archive/ZIP cleanup, ready Blob or
actual browser output acceptance; those remain the next explicit variants.

The bounded independent Disable implementation review passed its successful path: the existing
pre-finish SRP/KDF helper creates no Session, captured Account scope/current admission is checked
after the awaited proof ceremony, synchronous HTTP preparation zeroizes the copied one-use proof,
and proof/QuickUnlock/password owners drop before polling the POST. Disable uses the same Save/Enable
semantic-response reconciliation and verified-policy application, and drops its pre-prune Session
before cleanup. Cancellation or caller loss after a possibly admitted POST remains an explicit
required variant; the successful proof history does not cover that ambiguity.
Coordinator independent review also passed the early Lock handoff: the existing first fence proves
its current/exact scope, callback invocation is outside authority guards and precedes unrelated
waits, and the existing retirement owner retains cleanup responsibility.

2026-09-09 actual native incoming-Travel attempt 5 reached the complete pre-Disable erasure
sequence (`/tmp/bittery-native-incoming-travel-runtime-fifth.log`). The real second-device policy
Enable produced an incoming `travel_mode_updated` event. The native helper then verified selected
Vault authority absent across physical generations, current and previously opened image pickers
refused, new Update refused, exact accepted protected ciphertext retained, and zero signed uploads
through the retained Operation's actual retry deadline. Unrelated accepted Delete/Move work and the
Move Attachment's exact readable bytes converged while that restriction remained enforced. These
assertions precede the fixture's Disable call in `native_hidden_image_acceptance.rs`.

Disable's real SRP proof, HTTP mutation and response validation also completed, but the fixture then
incorrectly called `DELETE /sessions/{sessionId}` with its own Session; the Server deliberately
returned HTTP400 for self-revocation. Consequently the native restoration assertions did not execute
and the actual case failed. Existing final public User deletion returned HTTP200 and proved scoped
remote cleanup. The fixture now clears its local credentials before acknowledging verified Disable
and uses that mandatory final User-deletion proof for remote Session cleanup; missing proof still
fails cleanup. A distinct pre-Disable erasure log marker separates this completed work from later
restoration/cleanup failures. Attempt 6 remains required; this evidence does not establish complete71,
connected two-owner native policy propagation, actual Tauri/Chrome, or phase acceptance.

2026-09-09 public Disable first path now passes its real-SRP primitive history
(`/tmp/bittery-travel-disable-command-first-green.log`,1/1), following the meaningful stub failure
in `/tmp/bittery-travel-disable-command-first-red.log`. The test proves one fresh start-login proof,
one Disable POST, no finish-login or replacement Session, unchanged Quick Unlock secret/envelope/
password-entry timestamp, and no accepted settings Operation. Shared Save/Enable/Refresh regression
remains8/8 green (`/tmp/bittery-travel-disable-shared-settings-regression.log`). These bounded tests
precede caller-loss, wrong-password, missing-material and ambiguous-response variants. Travel UniFFI
mappings are now registered under the existing Rust-defined protocol; generated outputs and binding
checks are still pending. Attempt5's exact retained local credential/control files were removed after
its proven public Runtime Server cleanup.

2026-09-09 maintained actual native incoming-Travel attempt 6 PASSED: one Playwright case,2.0minutes
case time/2.6minutes total, exit0 (`/tmp/bittery-native-incoming-travel-runtime-sixth.log`). Command:
`BITTERY_NATIVE_FOUNDATION=1 pnpm --filter web exec playwright test runtime-native-foundation.spec.ts --project=cloud --workers=1 --grep 'consumes incoming Travel policy'`.
This uses the actual linked native Core, SQLite, OS keychain, separate fixture Device's Server policy
requests and real incoming Sync. Enable and fresh-proof Disable both completed. Selected authority
was erased across physical generations; old/new image capabilities and new Update were refused;
accepted protected ciphertext remained exact without signed uploads through its retry deadline.
Unrelated accepted Delete/Move and the Move Attachment remained usable. After Disable, current
authority restored and the original protected Create/Update uploaded exact original PNG bytes,
reconciled current Vault authority and completed terminal artifact cleanup. The existing encrypted
recovery/process-restart sequence and lost Delete reply with five rejected accepted Item categories
also passed. Final public User deletion returned HTTP200 and fixture cleanup succeeded.

The bounded polling correction only tolerates absent/AuthorityMissing Items when the same Account's
public Travel projection is Unverified, with one strict recheck when verification completes between
reads. The second-device fixture clears local credentials before acknowledging Disable and requires
final User-deletion proof for remote Session cleanup. Its Web package-root types passed11/11 tasks;
Biome/rustfmt and whitespace checks passed. This actual case completes the maintained incoming
native history, not all71: connected two-owner selective propagation, remaining foreground ambiguity
and Export output variants, fresh full phase checks and actual Tauri/Chrome production acceptance
remain outstanding. The subsequent99 first selective implementation is registered for targeted
compilation and has no GREEN result yet.

2026-09-09 caller-loss and bridge regressions now reproduce their intended failures. The public
settings/HTTP/storage history aborts a request after its mutation reaches a held Server primitive,
then starts the existing Sync driver without an SSE hint. It fails because no durable pending
verification remains (`/tmp/bittery-travel-settings-drop-first-red.log`,1 failed). This first history
covers driver startup after caller loss; an already-running quiet stream remains a separate variant.
The existing binding buffer also drops terminal Export retirement while Account delivery is suspended
(`/tmp/bittery-export-buffer-first-red.log`,1 failed). Their respective fixes will reuse the existing
pending/Sync and observation owners. Earlier compile errors were module visibility, a test Duration
qualification and UniFFI's required callback declaration; they were corrected before either RED ran.

2026-09-09 the first public settings caller-loss history is GREEN, with all9 public Travel settings
cases passing (`/tmp/bittery-travel-settings-drop-first-green.log`). The same build passed6 Export,
4 Session-lifetime and3 Disable regressions. Before first polling Save/Enable/Disable transport,
the existing foreground registry captures a nonrepeating Server verification episode and the
existing Bootstrap metadata acknowledges its pending marker. The first live fence wakes the existing
Sync owner before marker I/O. A valid settings response or bounded current GET carries that exact
episode through common policy application; it cannot resolve a successor. Disable retains only the
existing zeroizing serialized HTTP body across the marker wait, after dropping its password, Quick
Unlock document and prepared SRP proof. The existing quiet-stream wake branch now recognizes Server
verification and a dirty durable marker; it does not require a new runner or accepted Operation.

This GREEN proves an acknowledged marker followed by dropped mutation caller and Sync startup with
no hint. It does not yet prove an already-running quiet stream, committed marker with lost storage
acknowledgment, or Native reason overlap. Native pending hooks remain external until their separate
public overlap RED. A lost true-marker ACK must dispatch no mutation and recover from the exact
physical head; a lost false-marker ACK must also publish the already persisted verified policy to
settings observers when its known resolved marker is flushed. Both are separate required fault
histories. The valid-additional-restriction response held behind older cleanup, persisted
`enabled`/`enabledAt` consistency, and startup metadata-before-journal proof reconstruction remain
separate required work; this Server episode implementation does not count as their coverage.

2026-09-09 Export bridge terminal buffer: the meaningful supporting RED received no control during
nested Account suspension (`/tmp/bittery-export-buffer-first-red.log`). The same buffer now carries
closed Projection/Control events, latches retirement exactly once, discards queued and later private
frames, and delivers the nonplaintext control outside its locks even while ordinary delivery is
suspended. A reentrant callback/order variant passes with the existing buffer regressions. The Web
observation slot forwards controls on its existing lifetime and rejects Export admission without a
control callback; initial Export callback failure removes only its exact slot. Native mappings remain
shallow Core observation/handle conversions. UniFFI's rejected default callback implementation was a
compile-only setup error, corrected to its required method signature before the behavioral RED.
All51 binding tests pass (`/tmp/bittery-export-buffer-first-green.log`), and all6 Core Export histories
remain green (`/tmp/bittery-native-travel-export-regression.log`). Coordinator successful-path review
passed queue ownership and outside-lock delivery. These are supporting checks, not actual Worker or
archive acceptance. Delayed/control callback failure, idle Worker loss, orderly close acknowledgements,
fixed-frame forwarding admission and final output remain explicit; callback failure cannot itself
acknowledge disposal of a host snapshot or Blob.

2026-09-09 independent first Export-buffer review passed the successful terminal-delivery lane in
`observation_buffer.rs`, `WebObservation` and `ObservationSlots::remove_if`. The existing queue,
observation slot and Account retirement ledger remain the owners. Nested suspension preserves the
terminal nonplaintext event, while the latched terminal state permanently rejects queued and later
private frames. The existing drain guard prevents callback reentrancy from consuming the queue;
callbacks run after releasing its mutex. A terminal event raised by an already-admitted callback
removes remaining private frames and follows that callback. Initial failure cleanup compares the
exact installed Arc, so a reentrant unsubscribe/reopen under the same external ID preserves the
replacement. No additional registry or simplification was needed. This is a source review supported
by the reported51 binding and6 Core Export tests; it is not a new execution or evidence for delayed
callback failure, cleanup after a throwing terminal callback, Worker/realm loss, archive output or
whole Export acceptance. Those maintained next variants remain required.

2026-09-09 the public lost true-marker acknowledgement history reproduced the intended failure
(`/tmp/bittery-travel-pending-true-ack-first-red.log`,1 failed). The primitive executor committed the
pending marker and withheld only its acknowledgement; the command failed and sent zero settings
mutations. Existing Sync then failed its bounded no-hint recovery because its cached pre-ACK revision
could not guard the already advanced physical head. The narrow pending retry now reloads through the
existing Replica owner and replaces its cache only under publication after checking exact Account,
incarnation, User, lock epoch and nondecreasing revision. Its original Server episode remains the duty;
no mutation replay, policy cache or retry runner is added. GREEN remains pending. The separate
already-running quiet-stream caller-loss history and all10 public settings cases passed
(`/tmp/bittery-travel-quiet-caller-drop-first.log`); false-ACK display remains a subsequent RED.

2026-09-09 the lost true-marker ACK regression is GREEN1/1
(`/tmp/bittery-travel-pending-true-ack-first-green.log`), and all10 public Travel settings histories
remain GREEN (`/tmp/bittery-travel-ack-settings-regression.log`). The test proves the physical pending
marker survived its missing acknowledgement, zero settings mutations were dispatched, and the
existing Sync owner reloaded and verified the original duty without an SSE hint or mutation replay.
Root independently reviewed the exact Account/incarnation/User/lock-epoch/nondecreasing-revision
checks and reuse of the existing Replica cache owner. These are targeted checks, not full phase
acceptance. The separate false-clear-ACK display tracer is prepared externally and remains
unregistered during the generator/WASM/Worker acceptance freeze; its RED must precede any display
or clear-marker publication fix.

2026-09-09 connected-native first selective slice now has bounded Core/SQLite GREEN evidence.
Both public/physical cases passed (`/tmp/bittery-native-travel-fixture-selective-regression.log`,2/2):
verified source hide retains the borrowed consumer Account and unrelated Vault access while pruning
selected effective/dormant Session keys and physical authority; initial attachment after completed
source hide selectively retires an independently unlocked consumer without importing credentials.
Original accepted Operation IDs and every immutable field survive live cleanup and reopen; mutable
retry scheduling is checked separately. The existing unclassified-generation regression also passes
(`/tmp/bittery-native-travel-unclassified-fixture-first-green.log`,1/1), preserving held-reply rejection,
whole-Account borrowed-grant retirement, no dormant-Session fallback and fresh transfer behavior.

Its first attempted run failed before generation advancement because the legacy offline fixture's
installation Bootstrap now correctly leaves policy verification pending. The fixture establishes its
unchanged initial policy through public RefreshTravelMode and the HTTP adapter before returning to
its original offline/HeldTravel behavior; no production pending rule or generation check was weakened.
Root's bounded source review accepted that setup correction. The native first-fence Export handoff
also passed independent source review, but its held-token acceptance remains required.

This first slice does not close connected71. Required follow-ups include asynchronous progress when
one Account's host delivery is held, exact retirement-lifetime overlap and lost ACK/new readmission,
source/consumer pending-episode propagation, independent authorization-only restoration, Remove and
owner-loss variants, bounded replay/overflow and real framed/native transport integration. Fresh
cross-language generation, Worker/host tests, full phase checks and later actual Tauri/Chrome
production acceptance remain separate gates. No ticket status changes are made by these results.

2026-09-09 generated boundary refresh: persistence and platform-storage contracts regenerated.
Native generation initially stopped because AJV rejected Rust's newly emitted `uint8` format annotation
on32-byte restriction digests (`/tmp/bittery-travel-native-authority-generation.log`). Rust already
supplies explicit integer0–255 and exact32-element constraints. The generator now recognizes that
informational format while preserving those constraints. A new validator test first rejected the
new valid shape against stale artifacts (`/tmp/bittery-native-digest-schema-first-red.log`); fresh
native/runtime-protocol generation and all20 generator tests now pass
(`/tmp/bittery-travel-native-runtime-generator-tests.log`), including wrong digest lengths, fractions,
negative/overflow bytes and strings. Existing numeric-generation fixtures include the required new
source restriction envelope. This is generated-boundary evidence; fresh WASM and actual Worker
retirement delivery remain the next checks.

2026-09-09 fresh WASM compilation exposed an unconditional `Send + Sync` retirement callback
capturing the intentionally Worker-local Runtime (`/tmp/bittery-vault-export-joined-bindings.log`).
The existing callback slot now uses a platform-specific alias: native retains both thread-safety
bounds, while WASM permits its local callback. Independent review confirmed the existing platform
trait convention, unchanged once-only/outside-lock handoff and no unsafe code or additional owner.
The corrected fresh build is being validated before the actual joined Worker retirement test.
The next native held-delivery and false-clear-ACK display regressions are now registered for their
first RED runs; neither fix nor acceptance is claimed yet.

2026-09-09 retained-policy validation regression first failed through the serialized platform-storage
load boundary (`/tmp/bittery-travel-retained-activation-first-red.log`): enabled policy with no
activation timestamp was accepted. The existing policy validator now owns the activation invariant
alongside selection validation; authenticated Server-response preparation uses that same validator.
The regression also preserves valid older documents with an omitted update timestamp. Independent
review required valid activation fields in the older malformed-selection tests so the new check
cannot mask selection-validation regressions. The refined regression passes1/1
(`/tmp/bittery-travel-retained-activation-first-green.log`), and affected platform-storage22/22
and authentication-installation12/12 checks pass (`/tmp/bittery-travel-retained-policy-storage-regression.log`,
`/tmp/bittery-travel-retained-policy-installation-regression.log`). This preserves the optional persisted
update field and the required parsed Server update timestamp through one semantic validator;
fresh phase-wide checks remain required.

2026-09-09 actual joined Worker Export terminal delivery is GREEN1/1 with14 assertions
(`/tmp/bittery-vault-export-joined-first-green.log`), using the freshly rebuilt real Core WASM
(`/tmp/bittery-vault-export-joined-bindings-second.log`) and existing Chromium/IndexedDB Worker
composition. The first browser run failed on a fixture assumption: empty Attachments are omitted by
Core serialization, so the generated optional field must count as zero. That failure is not behavioral
RED. The corrected history produced the intended RED (`/tmp/bittery-vault-export-joined-second-red.log`):
the actual same-channel nonplaintext retirement control arrived while the host retained the fixed
single-Item, zero-Attachment snapshot and public Lock remained unfinished, but the facade callback
received nothing. The test discarded its snapshot, unsubscribed and awaited successful Lock before
asserting, so failure did not abandon cleanup. Unknown HTTP requests and browser errors remain fatal.

The minimal fix keeps projection and optional control callbacks in the same existing observation Map
entry and routes the two typed envelopes by exact observation ID. Failed installation removes only its
own entry; no policy, registry, queue or retry owner was added. The same real history now receives one
`vaultExportRetired/scopeRetired` control before cleanup, then completes Lock with the expected Account
and balanced SSE cancellation. Existing Worker runtime regressions also pass47/47 with255 assertions
(`/tmp/bittery-vault-export-worker-facade-regression.log`); scoped Biome and `git diff --check` pass.
This is fixed-snapshot/terminal delivery evidence, not ready-Blob, archive building, final-output
Begin/Finish, throwing delayed callback, orderly closing or abrupt Worker-loss acceptance. Those
remaining lifetimes must pass before host Export caller activation or whole71 acceptance.

2026-09-09 the false-clear-marker ACK display history reproduced its intended failure
(`/tmp/bittery-travel-pending-false-ack-display-first-red.log`,1 failed). Public settings committed
one selection and its physical false marker, but lost the clear acknowledgement before copying the
verified policy into AccountPresentation. Existing Sync flushed the resolved marker without another
GET, yet the mounted settings observer never received Ready with the persisted selection. The narrow
fix copies/publishes display-only verified policy after metadata and any selected journal are durable,
before clear-marker I/O. The existing pending owner publishes a device-revision transition when its
acknowledged or reloaded aggregate completion restores admission. This uses no new policy read,
cache or retry owner. GREEN is pending; the separate additional-restriction/older-cleanup caller-loss
history remains external and has no implementation yet.

2026-09-09 false-clear-marker ACK display is GREEN1/1
(`/tmp/bittery-travel-pending-false-ack-display-first-green.log`), with all10 public Travel settings
histories still GREEN (`/tmp/bittery-travel-false-ack-settings-regression.log`). The public observer now
receives the already persisted selection as Ready when existing Sync flushes the known resolved
marker; the test proves zero additional policy GETs and exactly one settings mutation. Root reviewed
that AccountPresentation stays display-only, its update follows durable policy/journal, and aggregate
admission publication runs outside the publication lock. The next public two-Export caller-loss
history is registered for RED only: a new validated restriction must survive while an older Export
cleanup acknowledgement is withheld. No fix or acceptance claim for that next history is included.

2026-09-09 native selective adoption independent-progress regression is GREEN3/3
(`/tmp/bittery-native-travel-held-delivery-first-green.log`,21.17s), including the two existing
selective/initial-attachment cases. The new public native-control/SQLite history first failed
(`/tmp/bittery-native-travel-held-delivery-first-red.log`): one Account's held cross-thread Items
delivery synchronously blocked another Account's durable restriction adoption. The existing
DeliveryToken now supplies an asynchronous wait using the same lease counts and an additional Notify;
only native adoption switches to it. The wait registers before checking counts, retains the original
reentrant thread identity, and lease release wakes both existing synchronous and asynchronous waiters
after unlocking. Root and independent review passed cancellation, lost-wakeup and same-owner scope.
No scheduler, thread pool or retirement owner was added. Five existing native/hard-retirement and reentrant
delivery regressions also pass individually (`/tmp/bittery-native-travel-delivery-regression.log`),
including old-epoch queued delivery, inflight close and callback reentrancy. Native pending
episodes, exact overlapping retirement lifetime adoption, restoration and framed transport variants
remain unfinished.

2026-09-09 orderly joined Worker Export Close is GREEN alongside Lock
(`/tmp/bittery-vault-export-joined-close-final-green.log`,2/2 with32 assertions), using the same fresh
WASM artifact and shared real Chromium fixture. Proper Close RED
(`/tmp/bittery-vault-export-joined-close-first-red.log`) received the actual `runtimeClosed` control
through both the raw existing channel and facade while the fixed snapshot remained held and Close
was pending; the same observation's cleanup acknowledgement then failed with `closed`. The failing
fixture first discarded host plaintext and explicitly terminated its actual Worker, returning bounded
failure evidence rather than pretending Close drained. GREEN requires no forced termination: host
cleanup/unobserve succeeds during Close, Close resolves, and the existing owner terminates once.

The existing shared Worker owner now admits only the exact Runtime `unobserve` cleanup envelope
during closing and preserves its pending response. A Core close acknowledgement cannot terminate the
Worker before that response settles. The Runtime service reaches only its already-created Runtime
for cleanup, never startup or replacement; ordinary commands retain their existing terminal-failure
classification. The facade preserves the same observation callbacks until successful close, removes
an unsubscribed entry only after its exact acknowledgement, and public composition Close uses that
facade. Failed host cleanup retains callbacks and the existing owner's retry: a focused RED first
proved premature callback detachment on rejection (`/tmp/bittery-vault-export-close-retry-first-red.log`).
No new registry, policy or closing owner is introduced.

Owner/service/composition regressions pass106/106 with539 assertions
(`/tmp/bittery-vault-export-close-owner-service-final-green.log`), including cleanup admitted before
and during Close, deliberately earlier Core close acknowledgement, refusal of new work/decorated or
wrong-channel cleanup, and successful-close-only listener disposal. Scoped Biome and diff checks pass.
These tests still do not prove abrupt Worker loss, delayed throwing callbacks, ZIP/ready-Blob cleanup,
final output Begin/Finish or full host caller migration; those remain required before Export activation.

2026-09-09 the required `pnpm exec turbo -F @bittery/client-runtime check-types` passes
(`/tmp/bittery-vault-export-close-final-check-types.log`). Fresh generated observation variants exposed
one missing registry switch: the reusable store now explicitly excludes connection-owned fixed
`VaultExport` at its typed boundary and keys display-only `travelMode` by Account. No Export caller
was activated. Existing registry tests pass12/12 with39 assertions
(`/tmp/bittery-vault-export-shared-registry-regression.log`). The cleanup transport classifier accepts
only own data properties, without invoking supplied getters; before/during-Close tests explicitly
prove zero getter calls and pass2/2 with22 assertions
(`/tmp/bittery-vault-export-close-own-property-green.log`). Runtime service parsing remains behind the
existing router's checked plain-data copy. These are boundary checks, not additional authority policy.

2026-09-09 the two-Export additional-restriction history reproduced a meaningful RED
(`/tmp/bittery-travel-additional-restriction-first-red.log`,1 failed). Public Refresh first hid Vault A
and committed its journal while A's Export withheld cleanup acknowledgement; that caller was then
dropped. A second public Refresh verified A+B but did not notify B's Export before awaiting A's old
cleanup. Dropping that caller lost the new restrictive evidence. The narrow fix pre-captures only
newly selected, unfenced IDs when an actual existing selected retirement is present in the registry
or physical journal. It preserves older overlapping proofs and lets the same retirement resume owner
adopt and drain the captured original policy; no stale pre-adoption handle is reused afterward.
Normal first-hide ordering and its prompt admission-clear boundary remain unchanged. GREEN is pending.

This is a bounded selected-retirement caller-loss slice. A complete-Bootstrap cleanup without an
existing selected retirement, and unrelated-Vault admission while older cleanup remains held, need
separate public REDs before widening. Native exact-lifetime overlap has its own registered public
tracer and the existing differing-proof rejection is unchanged. None of these broader variants is
claimed by this fix; the accepted71 lifetime and selective-admission contract continues to apply.

2026-09-09 independent orderly Export Close review passed the bounded owner/service/facade lane.
Only the exact own-data Runtime `unobserve` envelope receives the transport cleanup exception;
closing service handling uses its existing Runtime task, never startup. The same pending request
entries preserve cleanup acknowledgements after Core's close acknowledgement and before Worker
termination. Exact facade entries survive failed unobserve and are removed only after acknowledgement;
callbacks detach only after successful composed Close. No separate closing registry or simplification
was needed. The demonstrated retained-Worker retry is specifically main-thread
`beforeWorkerTerminate` cleanup-hook failure; a Core/service close-ack error retains its existing
terminal semantics and is not claimed as a retryable cleanup variant. This read-only review adds no
execution evidence beyond the reported joined2/2 and owner/service/composition106/106 checks.
Abrupt realm loss, delayed throwing callbacks and archive/output lifetime remain separate work.

2026-09-09 the additional-restriction/older-selected-cleanup regression is GREEN1/1
(`/tmp/bittery-travel-additional-restriction-first-green.log`). A fresh verified A+B policy now
retires B's public Export before A's old cleanup acknowledgement arrives; dropping that caller does
not lose B's original restrictive proof. After host disposal and a later verified disabled reply,
both selected authorities and Session wrappers are erased, accepted CreateItem ciphertext intent
remains exact, and old Export handles cannot begin output. This is the tested existing-selected-duty
path only. Prior complete-Bootstrap cleanup and unrelated-Vault admission while older cleanup is
held remain external next variants, with no production widening or full caller-loss claim.

2026-09-09 actual foreground acceptance is now a separate maintained native-foundation case:
`native Runtime reconciles foreground Travel settings after a lost Disable reply`. It adds public
native Core Save/Enable/Disable to the existing real Server/SQLite/keychain/four-process fixture,
without changing the incoming-policy or baseline cases. The HTTP proxy consumes a real successful
Disable response then destroys its client socket; assertions require one Disable POST, no login
finish during the attempt, a current-policy GET after the lost reply, retained selection, selected
Vault absence before Disable and restoration afterwards with the same unrelated Item readable.
Independent review tightened both temporal witnesses. Existing scoped public User deletion remains
mandatory. Web package-root type checking passed11 tasks and the native test binary compiled;
actual run1 is underway (`/tmp/bittery-native-foreground-travel-first.log`). No real foreground
acceptance result or production application acceptance is claimed from those compilation checks.

2026-09-09 actual foreground run1 passed1/1 (`/tmp/bittery-native-foreground-travel-first.log`,
1.9minutes total). The real native Core/SQLite/keychain/Server history confirmed the configured
selection, physically lost one real successful Disable reply, observed a later current-policy GET,
made exactly one Disable POST and no login finish during the attempt, preserved the selection and
restored selected authority after its observed absence while the same unrelated Item stayed readable.
The unchanged four-process accepted-Operation, five-category deleted-Vault, protected-image recovery
and exact convergence baseline also passed. Final scoped public Server User deletion proved HTTP200;
fixture cleanup succeeded. No retained failed-run credentials require follow-up. This is the first
native foreground lost-after-commit capability case: lost-before-commit, unavailable reconciliation,
fresh-password retry and actual Desktop settings gestures remain required variants. It does not
establish renderer/OS/Chrome production acceptance or replace fresh full phase checks.

2026-09-09 actual abrupt Worker-loss Export history is GREEN with the existing Lock and Close
histories (`/tmp/bittery-vault-export-joined-loss-first-green.log`,3/3 with41 assertions). The real
fixture Worker throws a fixed error after delivering its actual Core snapshot; the browser error
event and existing owner's termination are positive witnesses. Proper RED
(`/tmp/bittery-vault-export-joined-loss-second-red.log`) showed no retirement control and the idle
host snapshot still retained at actual Worker termination. The fixture discarded that copy before
returning failure, without manufacturing a Core reply or successful cleanup acknowledgement.

The same channel subscription entries now carry an optional terminal callback. Connection failure
fences and detaches them before notifying once and before existing termination. The facade uses its
same observation entries to emit the Rust-defined nonplaintext `connectionClosed` control only for
Export captures, latch retirement, and reject later private delivery. This is a transport lifetime
signal, not Core success. A throwing consumer cannot suppress siblings' retirement; its throwing
callback is not considered a cleanup acknowledgement. No new registry, retry runner or owner exists.
The real history now disposes its idle snapshot before actual termination. Owner/service/composition
regressions pass106/106 with543 assertions
(`/tmp/bittery-vault-export-loss-owner-service-first-green.log`); the additional focused duplicate-error,
throwing-sibling and late-frame guard passes1/1
(`/tmp/bittery-vault-export-loss-channel-retirement-green.log`). Package turbo type checking passes
(`/tmp/bittery-vault-export-loss-check-types.log`), with scoped Biome and diff checks green.

This evidence does not cover ordinary reusable client stores: they still require a bounded
ObservationRegistry/transport terminal-error history to dispose stale projections. Delayed WASM
callback failure, ZIP/ready-Blob lifecycle, exact final-output Begin/Finish and host Export caller
activation likewise remain outstanding. No whole Runtime-owner-loss or whole71 acceptance is claimed.

2026-09-09 existing-journal native overlap is GREEN with the complete native Travel subset4/4
(`/tmp/bittery-native-travel-existing-journal-first-green.log`,16.68s). Its public Export/Refresh/native
control history first failed (`/tmp/bittery-native-travel-existing-journal-first-red.log`): a matching
source restriction retired the consumer Account instead of acknowledging an already-owned local
retirement while Export disposal remained held. The bounded fix proves every exact current selected
fence retains DurableJournal under native→publication→registry, conserves that original duty and
records the native ACK without awaiting cleanup or writing another journal. Actual readmission removes
eligibility under publication. Root and independent review passed; no stored selector, owner or runner
was introduced. The test also verifies unchanged physical overlap evidence, exact lost-ACK replay after
cleanup and immutable accepted Operations. Policy-failure regressions separately pass6/6. Pre-journal
and mixed overlaps, fresh readmission and pending-control propagation remain outstanding; this is not
whole connected-Travel or phase acceptance.

2026-09-09 native foreground before/after-loss acceptance passed2/2
(`/tmp/bittery-native-foreground-travel-before-and-after-first.log`,3.4minutes total). The maintained
lost-after case passes again with exact one proof-start/POST/real successful reply, no login finish,
and a current-policy read after socket loss. The new lost-before case closes the client socket before
constructing an upstream request, receives exact RetryRequired/current-enabled selection, proves
selected absence plus the unrelated Item, then supplies a separate fresh password gesture. It proves
two proof starts and POST attempts, one prevented request, one real successful Disable response and
zero login finishes across those attempts. Both retain selection and restore fresh selected authority;
both unchanged four-process accepted-work/image baselines and scoped public User DELETE HTTP200
cleanup pass. Native compilation and Web package-root types11/11 also pass for this variant.
Unavailable reconciliation/uncertainty and wrong-password variants, remaining retirement/Export cases,
fresh full checks and actual Desktop/Chrome production acceptance remain open.

2026-09-09 the complete-stage caller-loss variant reproduced a separate ordering gap
(`/tmp/bittery-travel-complete-stage-first-red.log`,1/1 failed at the intended Export notification
assertion). Through public Sync, an existing storage-port gate holds the metadata read after a
physically complete stage has verified policy, a cleared pending marker and no selected journal.
After that Sync caller disappears, a public Refresh learns a new restriction. Core previously resumed
the older complete stage and waited for its omitted-Vault Export before retaining the new restriction;
losing this second caller could discard that verified duty. The test disposes its retained frames and
reaps callers before reporting the failure, then checks later disabled policy cannot cancel the new
restriction or alter accepted ciphertext.

Review found that generic resume would adopt the new policy first and abandon the older stage's
absence proof. The test now also requires the original omitted Vault's authority and Session wrapper
to be erased. The bounded common-apply fix captures the new restriction before existing promotion,
then resumes normally. This added branch requires cleared aggregate verification and a nonempty new
selection wholly present in that exact complete stage, with no existing selected fence. Its selection
cannot overlap the stage's omitted-Vault proof. No ID is discarded from the captured full Server
policy, and no older proof is replaced. A complete stage with pending verification cannot promote,
so ordinary first-hide application keeps its journal→clear-admission→cleanup ordering.

Targeted GREEN is pending. Missing, Session-only and overlapping selected scopes remain immediate
required variants, as does native propagation for those scopes; this disjoint branch does not establish
them or change their previous behavior. The separate public unaffected-Vault admission variant is
prepared externally and remains unregistered. No additional cleanup owner or exclusion API was added.

2026-09-09 the actual joined Worker ordinary Items-store loss history first failed at its intended
assertion (`/tmp/bittery-runtime-items-owner-loss-first-red.log`): the real Worker error and termination
occurred once, but the existing reusable store still held ready plaintext at termination. The narrow
fix carries an optional terminal error callback through the existing Runtime transport/facade entry.
The same ObservationRegistry checks its exact minted observation identity, drops the data and publishes
the existing mapped failure; it neither reopens the observation nor creates another lifetime owner.
Export retains its separate typed terminal control on those same facade entries.

The final actual Lock, orderly Close, abrupt Export loss and ordinary Items loss histories all pass
in fresh Bun processes against the retained joined WASM artifact
(`/tmp/bittery-runtime-owner-loss-{lock,close,loss,store}-final-green.log`, four tests,50 assertions).
The ordinary store is failed without data before the actual Worker termination. Two combined-process
attempts timed out before the fourth `chromium.launch()` resolved; bounded diagnostics showed no
fourth Chromium child or Runtime/harness execution. This launcher limitation is not counted as a
Runtime behavior failure or waived by longer timeouts. Temporary diagnostics were removed; each
maintained assertion was exercised unchanged in its own fresh process.

Affected client/Worker/service regressions pass121/121,598 assertions
(`/tmp/bittery-runtime-store-terminal-regressions-final-green.log`), including terminal loss while an
installation ACK is held, suppressed late projection, no retry with retained subscribers and exact
released/replacement observation isolation. Package-root Runtime types and scoped Biome pass
(`/tmp/bittery-runtime-store-terminal-types-final-green.log`). Source review preserves once-only,
outside-owner failure fanout and original error mapping; independent review is pending. Delayed
throwing callbacks, successful final-output forwarding/admission, and application Export cutover
remain distinct unfinished variants; this result does not acknowledge host cleanup after a throw.

2026-09-09 the corrected disjoint complete-stage caller-loss history is GREEN1/1
(`/tmp/bittery-travel-complete-stage-first-green.log`,0.06s; fresh matched Core no-run passed).
It now positively verifies both the original stage-omitted Vault and the newly policy-selected Vault
lose their all-generation authority and Session wrappers, while accepted ciphertext Operations remain
exact. The new Export receives its retirement control before older cleanup acknowledgement; later
caller loss and disabled policy do not discard either duty. Source review rejected the intermediate
ordering that would have abandoned the older stage before promotion. The final bounded branch uses
its existing promotion first after capturing the disjoint restriction; no generic proof replacement
or second cleanup owner was added. Overlapping, unknown and Session-only selected scopes are prepared
as separate public RED variants and remain unregistered, along with unaffected-Vault admission and
corresponding connected-native propagation. This targeted result is not full71 or phase acceptance.

2026-09-09 pre-journal overlap is GREEN with the native Travel subset5/5
(`/tmp/bittery-native-travel-prejournal-first-green.log`,18.42s). The public Export/Refresh/native
control RED first showed the borrowed Account becoming Locked while the original local metadata
acknowledgement was held (`/tmp/bittery-native-travel-prejournal-first-red.log`,1 failed). The existing
retirement registry now captures exact per-Vault, process-local nonrepeating scope identities, retains
them through proof/journal/cleanup transitions, and wakes its waiters after journal adoption or scope
removal. The existing pending native batch retains that capture across duplicate snapshots. It joins
the same bounded adoption work, awaits the original proof without Account execution, then validates
current Account/incarnation/Server/User and the exact journal-owned capture under native→publication
before ACK. Actual readmission invalidates the capture. The original proof and Export cleanup owner
are conserved; no policy cache, persistence namespace, map or runner was added.

The test proves no native ACK before the physical journal, preservation of the borrowed Account and
an already-delivered unrelated Export loan during pending verification, and ACK after journal adoption
while the original selected Export still holds cleanup. Root and independent integration/registry
reviews passed. Policy-failure tests separately pass7/7
(`/tmp/bittery-travel-stage-policy-regression.log`). Channel/Runtime waiter cancellation is wired to the
existing destination lifetime and its explicit retirement; its actual bounded test remains external
and unexecuted. Mixed-new scopes, same-ID readmission histories, pending-control propagation and the
remaining framed/native production matrix are still unfinished. No whole71/phase acceptance claimed.

2026-09-09 independent review of the new existing-retirement native wait lane passed. The channel's
pending adoption retains its original opaque Account/incarnation/Vault lifetime capture across duplicate
snapshots. Waiting for the original journal takes no Account execution, native-state or publication
lock; channel removal and Runtime native reset cancel that existing owner's wait token. Final adoption
rechecks destination identity and exact captured lifetimes under native→publication before recording
ACK. Exact prior ACK replay reports its immutable disposition without a new purge, even after later
readmission/removal. The same registry allocates checked nonrepeating entry identities, preserves them
through proof/journal/Retired transitions, and notifies after journal upgrade or scope removal outside
its mutex. No additional registry, policy cache or retry runner was introduced. This source review is
limited to the existing-scope path; mixed/new scopes and re-hide/readmission behavior remain separate
acceptance variants. Policy-failure regression7/7 passed on the matched source
(`/tmp/bittery-travel-stage-policy-regression.log`,0.06s); fresh full phase checks remain outstanding.

2026-09-09 actual native foreground uncertainty acceptance passes1/1
(`/tmp/bittery-native-foreground-travel-uncertain-first.log`,2.0minutes total). The proxy consumes a
real successful Disable response and loses that socket, then prevents current-policy GETs before
upstream dispatch. Public Core returns Uncertain with the exact previously enabled selection and
projects Unverified. A separate public Refresh after network restoration confirms current disabled
policy without password input or proof replay, retaining selection and restoring fresh selected
Vault authority alongside the unrelated Item. Network evidence requires one proof start, one Disable
POST, one real successful response, one lost reply, at least one prevented policy read and one real
successful post-loss read, with no login finish. This does not fabricate a Server outcome.

The unchanged four-process deleted-Vault/accepted-work and protected Create/Update image/recovery
baseline also passes, followed by mandatory scoped public User DELETE with actual HTTP200. No failed
fixture User or credential directory remains. Independent native-fixture review passed; Web types
pass11/11 (`/tmp/bittery-travel-uncertain-web-types.log`). Native no-run initially found a test-only
Option move in a pattern guard; borrowing the retained policy corrected it, and compilation passes
(`/tmp/bittery-native-foreground-travel-uncertain-build-second.log`). Wrong-password, remaining
retirement/Export variants, fresh full checks and actual Desktop/Chrome production acceptance remain
open; this native assembly evidence does not activate Desktop.

2026-09-09 independent review found a narrower ordinary-store release race: release grace can publish
Idle while an installation ACK still holds the per-key queue. A subsequent terminal callback changed
that retired answer to Failed. The new maintained history reproduces that exact interleaving
(`/tmp/bittery-runtime-store-released-installation-first-red.log`); the existing callback now invalidates
routing and preserves Idle when the final release grace has completed. Registry15/15 and affected
client/Worker/service122/122,603 assertions pass, including original reacquire/queue histories
(`/tmp/bittery-runtime-store-released-installation-first-green.log`,
`/tmp/bittery-runtime-store-terminal-release-regressions-green.log`). Parent source review passes;
package-root types and scoped formatting also pass.

Further launch diagnosis supersedes the earlier no-child inference: the fourth Chromium process did
start, its DevTools pipe disconnected during launch, and Bun emitted child exit without the close event
that Playwright awaited. A reduced script with no Runtime and a trivial page reproduces process/page
teardown failure; six launches without opening pages pass. One maintained browser process with six
fresh isolated contexts passes the same reduced history. The maintained file now shares only that
browser process, retains each prior Worker/IndexedDB/context isolation boundary, closes per-case
contexts and closes Chromium after the file. All four joined histories pass together unchanged
(`/tmp/bittery-runtime-store-combined-context-first-green.log`,4/4,50 assertions).
The full file now reaches all seven histories without a launch hang, but its original large protected
image recovery case times out waiting for current authority (`/tmp/bittery-runtime-store-full-file-context-first-green.log`,
6 pass/1 fail). This remains unresolved acceptance evidence; fresh current-source WASM and safe route/status
diagnostics are required before attributing that separate failure or completing the phase.

2026-09-09 native pre-journal waiter cancellation is GREEN1/1, covering exact channel loss and
consumer Runtime close (`/tmp/bittery-native-prejournal-cancellation-first.log`,17.32s). With the
original metadata acknowledgement and both Export snapshots held, the native Apply waiter exits with
an error, its old channel cannot issue an ACK, and lifecycle cleanup remains blocked until the holds
are released. The test then reaps all work. Only the live-Runtime channel-loss case claims preservation
and eventual physical cleanup of the already-observed local duty through the existing locked
dispatcher, with immutable accepted Operations retained. Runtime loss before journal commit makes no
durable-ownership or erasure guarantee. Independent review passed hold calibration, cleanup and
lifetime scope; this is cancellation-lifetime evidence, not a specific error-classification test.
Mixed existing/new restriction admission remains the next native RED.

2026-09-09 the next complete-stage overlap history reproduced its intended notification failure
(`/tmp/bittery-travel-complete-stage-overlap-first-red.log`,1/1 failed,2.05s). It reuses the public
Sync/Refresh/caller-loss history with both the original stage-omitted Vault and the newly selected
present Vault in the verified policy. Both erasures and the exact retained configured selection remain
required. The preceding disjoint eligibility gate does not capture the new restriction before old
cleanup in this case. A narrow fix is prepared externally during the shared Core/WASM source freeze:
for selected IDs known in the exact authority generations, preserve the completed stage's omission
proof and pre-capture its present selected IDs with the full original Server policy before promotion.
It requires at least one such new present scope; it does not classify unknown, Session-only or already
fenced selected scopes from local absence. No production change or GREEN result is recorded for this
variant yet, and connected-native propagation remains separately required.

2026-09-09 the shared public Disable password-proof regression passes2/2
(`/tmp/bittery-travel-password-proof-attempt-counter.log`,22.12s). The valid password uses one fresh
real SRP proof without login finish; the wrong password is rejected by the SRP verifier and surfaces
AccessDenied while retaining the verified enabled policy. Both require one proof start, no Session
or QuickUnlock writes, exact retained Session, unchanged QuickUnlock scope/Secret Key/envelope,
creation/password-entry timestamps and biometric setting, and unchanged accepted Operations. The
fixture separately counts POST attempts and successful verified mutations: each path sends exactly
one Disable POST, while only the valid proof changes policy. Independent source review passed. This verifies the
public Core and serialized HTTP/physical platform seams; actual Server wrong-password and remaining
foreground lifetime variants are not claimed from this fixture.

2026-09-09 the strengthened overlap run proved the next retry boundary
(`/tmp/bittery-travel-stage-overlap-session-second.log`,1/1 failed,0.06s). Both selected scopes now
fence before a held current-Session read and reject fresh selected plaintext, but aborting that caller
before promotion leaves the older complete-stage proof and newer policy proof together. Generic
resume then discarded the older stage before its original Vault's erasure, which the final authority/
Session assertion caught. The existing resume owner now prioritizes only a retained CompleteBootstrap
proof matching the current complete stage, then reloads pending batches before continuing. Promotion
remains prohibited while aggregate verification is pending; that pending-progress case is the next
separate public RED. No recursive resume, second runner or replacement proof is added. GREEN for this
retry correction is pending; stage-abandonment crash, unknown and Session-only selection variants
remain required before71 closure.

2026-09-09 strengthened known-authority overlap and caller-loss retry are GREEN1/1
(`/tmp/bittery-travel-stage-overlap-retry-first-green.log`,0.08s). The public test holds promotion's
first Session read after the fresh policy response, verifies both selected scopes refuse new plaintext,
then aborts the caller before promotion. The existing resume owner now preserves the captured exact
complete-stage absence proof before a newer policy purge; original and newly selected authority/
Session wrappers are both erased, configured selection and accepted Operations remain exact. Both
proofs are captured before host notification or old delivery-token waits, using the existing publication
and native policy owners. This covers known authority overlap, not unknown or Session-only selection.
The next registered RED creates a real durable pending episode with a public settings request after
those captures, aborts its held exchange, and requires a fresh public policy read to resolve pending
without abandoning either proof or replaying the mutation. No pending-progress fix is included yet.

2026-09-09 captured-stage pending progress reproduced RED1/1
(`/tmp/bittery-travel-captured-stage-pending-first-red.log`,0.05s) after a real durable settings marker,
caller loss and fresh policy GET. Parent review approved the bounded retirement-only refinement in
[the existing contract](../desktop-extension/vault-travel.md#retiring-a-captured-complete-stage-while-verification-remains-pending).
The same complete-stage omission selector will serve ordinary promotion and pending retirement:
all authority generations, effective/dormant Session-only keys and retained IDs from that exact proof,
with Session clones released before persistence/cleanup. Existing atomic RetireVaults replaces the
complete stage with every omitted duty's purge/journal while preserving cursor and pending marker;
no staged authority publication or new wire/schema/runner. Failed/lost commit and reopen acceptance
must follow the smallest GREEN. A new policy not durably stored retains its existing explicit
no-durable-acceptance limit; this decision does not assert persistence before its first proof write.
The implementation is being prepared externally during the coordinated Core compile.

2026-09-09 fresh current-source WASM reproduced the original protected-image recovery convergence
failure with six explicit unhandled `GET /api/v1/travel-mode` requests after successful upload, receipt
and Bootstrap (`/tmp/bittery-runtime-current-authority-fixture-diagnostic.log`). The controlled HTTP
fixture now serves the valid disabled policy through that existing route, accepts only its two seeded
Session Bearers, and positively asserts a policy read. No deadline, convergence predicate or Runtime
policy was relaxed. Recovery then passed its original assertions, while later real Import observation
exposed a separate Core gap (`/tmp/bittery-runtime-current-authority-fixture-first-green.log`,115 assertions
before failure): a new Items subscription during known verification was removed as a terminal error.

The first Core tracer incorrectly used bare Refresh of still-valid policy, which need not establish a
pending fence; `/tmp/bittery-travel-initial-observation-first-red.log` is fixture miscalibration, not
behavioral RED. The corrected public Sync invalidation tracer calibrates verified Ready then observes
Unverified during the held authoritative GET. It reproduces refusal of the new subscription
(`/tmp/bittery-travel-initial-observation-invalidation-red.log`) and now passes1/1
(`/tmp/bittery-travel-initial-observation-first-green.log`). The existing subscription owner retains an
ordinary Items handle without constructing or delivering a frame while pending, then existing publication
constructs its first fresh guarded Items frame after verification. Only the exact pending/unlocked Items
case is deferred; missing/locked/teardown and fixed Export error paths remain unchanged. No host retry,
empty plaintext frame, additional queue or binding API was introduced. Parent independent source review
passes. Existing pending tests preserve the no-private-frame guarantee using silent handles. Fresh
joined WASM and the unchanged actual Import/full-file acceptance remain required before closing this gap.

2026-09-09 mixed native restriction ownership is GREEN1/1
(`/tmp/bittery-native-mixed-retirement-first-green.log`,9.51s), following the public two-owner RED
(`/tmp/bittery-native-mixed-retirement-first-red.log`,16.96s). An old local proof remains held before
journal adoption while a single native batch selects that Vault and a second Vault. Only the missing
scope gets a new fence; both existing Export controls retire before waiting, and the borrowed Account
stays unlocked. The exact full scope capture prevents partial ACK: the new subset's journal alone
cannot acknowledge the immutable batch. After the original journal commits and its caller releases
Account execution, the native caller acknowledges both duties before either host Export loan is
released. Independent local policy and immutable accepted Operations remain unchanged. Root and
protected-image independent source reviews pass the bounded same-batch union and callback ordering;
no new registry, scheduler or policy owner was added. Multi-batch failure completion, connected
complete-stage restriction classification, new readmission lifetimes and native pending-reason
propagation remain separate required variants; this result does not close71.

2026-09-09 captured-stage pending progress is GREEN1/1
(`/tmp/bittery-travel-captured-stage-pending-first-green.log`,0.06s), following the meaningful RED
(`/tmp/bittery-travel-captured-stage-pending-first-red.log`). The public abandoned settings exchange
leaves a durable pending marker while both original complete-stage and newer verified-selection
proofs are retained. A fresh public policy read now resolves that episode after the existing owner
atomically replaces every omitted complete-stage duty with its purge/journal, without promoting the
stage cursor. The test checks original and newly selected authority/Session erasure, exact accepted
Operations, unchanged active cursor and no mutation replay. Ordinary promotion and this retry share
one omission selector; it releases effective and dormant Session documents before persistence or
cleanup. Parent and native independent review passed this bounded proof-preserving path. Rejected
commit, lost acknowledgement and fresh-owner reopen remain subsequent required histories; differing
proofs among omitted scopes, unknown/Session-only selection and connected native classification are
not established by this result. No phase or71 completion is claimed.

2026-09-09 fresh joined WASM containing the deferred initial Items subscription closes the actual
Import regression: original Create/Import history passes1/1,177 assertions
(`/tmp/bittery-runtime-deferred-observation-import-first-green.log`). The entire maintained Chromium
file then passes7/7,277 assertions in one Bun process (`/tmp/bittery-runtime-deferred-observation-full-file-green.log`,
53.73 seconds), using `/tmp/bittery-travel-observation-joined-bindings`. This includes original protected
image archive/reopen/exact-upload/current-authority convergence, Import mappings and independent outcomes,
physical IndexedDB retirement, Export Lock and orderly Close, abrupt Export loss, and ordinary Items
store loss. The browser and afterAll cleanup complete normally; no deadline, convergence predicate,
Worker isolation or error assertion was weakened. The browser-context fixture correction and the actual
pending-subscription fix therefore have full-file evidence rather than separate-case-only evidence.
Final package-root Runtime types pass (`/tmp/bittery-runtime-policy-observation-fixtures-check-types.log`),
with the earlier122 client/owner/service regressions and source reviews retained. This remains bounded
acceptance for these completed paths; delayed throwing Export callbacks, final-output delivery/admission,
application Export cutover, other71 variants and fresh full phase checks remain open.

2026-09-09 the parent-run fresh Core regression also passes the complete live Sync subset55/55
(`/tmp/bittery-travel-current-live-sync-regression.log`,3.91 seconds), including the new initial
subscription history and all adapted pending no-private-frame assertions. The related native Travel
subset passes7/7,21.31 seconds. These results supersede the earlier pending narrow-regression note;
they do not close the separately listed unfinished71 variants.

2026-09-09 actual Server source inspection corrected the preceding wrong-password fixture before
native acceptance: `auth/login.rs` maps invalid SRP proof to401, not403. The prior403/AccessDenied
history proves that controlled refusal path only; it does not establish actual invalid-password
classification. Under the sealed foreground contract Core reconciles an authentication-looking reply
with one current-policy GET; still-enabled policy returns RetryRequired for fresh password entry.
Core/native fixtures now follow401 and require one POST/one GET for invalid proof, no proof replay,
unchanged policy/credentials and a separate correct-password gesture. Independent review verified
the correction against the actual Server function. Corrected test runs and native Server acceptance
are pending; no production behavior or persisted format changed for this calibration.

2026-09-09 rejected retirement-only commit acceptance is GREEN1/1
(`/tmp/bittery-travel-retirement-only-rejected-first.log`,0.06s). The existing primitive CommitGate
rejects the exact prepared complete-stage/pending-to-retirement-journal transition before storage
executes it. The public request reports StorageUnavailable; the actual durable complete stage,
original authority, pending marker, active cursor and accepted Operations remain unchanged. A fresh
public Refresh then consumes that original proof, erases both required scopes and clears pending
without replaying the abandoned settings mutation. This is the rejected-write side of the boundary,
not lost-acknowledgement or process-reopen evidence. The lost-acknowledgement test is now registered
separately, with no further production changes before its result.

2026-09-09 the next bounded Web Export output bridge tracer is a meaningful actual-Worker RED
(`/tmp/bittery-export-output-worker-first-red.log`,1 failed,6 assertions,2.64s). The real joined
Runtime delivers its fixed nonempty, zero-Attachment Export snapshot, and the host prepares a private
Blob before sending the sealed Begin command through the existing Runtime channel. The current
Worker parser rejects that missing command as unknown; this is not an undefined-method fixture
failure. The host discards its Blob/snapshot and releases the exact observation through existing
unobserve/close before the browser context closes. The remaining assertions require Lock's terminal
control while an admitted output remains live, refusal of a wrong lease without releasing Lock,
and exact Finish after host disposal. Production forwarding, the WASM same-slot successful-callback
witness, the subsequent Close/output variant and application ZIP/download activation remain pending.
The separate delayed throwing terminal-callback failure gap is unchanged.

2026-09-09 the corrected actual native wrong-password foreground history is GREEN1/1
(`/tmp/bittery-native-foreground-travel-wrong-password-first.log`,2.1 minutes). Real Server401
from the invalid SRP proof is followed by a successful current-policy GET and public RetryRequired
with the exact enabled selection. A separate correct-password request confirms disabled policy and
fresh selected-authority restoration. The proxy proves two proof starts/two POST attempts, exactly
one real401 and one real200, and no login finish or automatic proof replay. The original four-process
accepted-work/image/recovery baseline and mandatory scoped public User deletion with actual HTTP200
also pass. This supersedes the pending native wrong-password note above; the preceding403 Core
fixture remains limited to its controlled refusal classification. Native Core/SQLite/keychain/Server
assembly evidence does not activate Desktop or establish either application’s production acceptance.

2026-09-09 lost retirement-only acknowledgement acceptance is GREEN1/1
(`/tmp/bittery-travel-retirement-only-lost-ack-first.log`,0.08s). The same primitive gate forwards the
exact real transaction before returning StorageUnavailable. Physical storage has replaced the stage
with the original omitted Vault's journal and all-generation purge while the Runtime cache still
contains the pre-acknowledgement stage. Pending, active cursor and accepted Operations remain exact.
The subsequent public Refresh reloads that journal, completes both live captured duties and resolves
pending without another settings POST. No additional production change was required for this case.
Fresh-owner reopen is the next independent RED; this result does not establish survival of a newer
policy proof before its first durable metadata write.

2026-09-09 corrected public Core password-proof tests are GREEN2/2
(`/tmp/bittery-travel-password-proof-real401-corrected.log`,21.22s). The invalid SRP case now
uses the real Server401 classification, requires exactly one reconciliation GET and RetryRequired,
and preserves all Server policy fields, Session and QuickUnlock credentials/timestamps. The current
GET may update only the local verification timestamp; the initial corrected run’s strict whole-policy
equality incorrectly rejected that expected refresh. The valid case uses one proof/POST and no GET;
neither case finishes login, replaces credentials or accepts an Operation.

2026-09-09 output bridge support is registered on the existing WASM observation slot and Worker
facade entry. Each hop records successful callback return before permitting Begin; Core alone still
checks captured authority and owns the finalization lease. Finish delegates to the exact Core handle
and removes only that same slot after success. Output commands use only the already-created Runtime,
with cancellation rechecked after its awaited initialization result. Supporting service/owner/entry/
composition regressions pass110/110,571 assertions
(`/tmp/bittery-export-output-bridge-ts-regression.log`); package-root types pass
(`/tmp/bittery-export-output-bridge-check-types-final.log`). These are transport checks, not actual
output acceptance: the current-source WASM artifact and joined output history are still pending.

2026-09-09 fresh-owner pending complete-stage recovery reproduced RED1/1
(`/tmp/bittery-travel-pending-stage-fresh-owner-first-red.log`,0.06s): public open did not replace the
original durable complete stage after the previous owner lost its transient registry. The bounded
fix reconstructs that exact complete-stage omission duty in the existing resume owner whenever
policy remains pending, using the same authority/Session omission selector and atomic journal path.
If that selector finds no omission, the complete stage remains pending for ordinary verification;
no empty proof, purge or cursor promotion is manufactured. The test requires only the older durable
Vault duty and its dormant Session wrapper to survive, with exact old policy metadata; it makes no
claim that the newer uncommitted policy proof survives process loss. The fix awaits targeted GREEN.

2026-09-09 the public foreground conflicting-current-selection history passes1/1 with both
Save and Enable variants (`/tmp/bittery-travel-conflicting-current-selection-first.log`,0.04s).
After one lost mutation response, one current-policy GET returns a disabled empty selection that
differs from the requested visible Vault. Core returns RetryRequired with that actual policy, stores
it unchanged, clears verification and preserves existing authority/accepted Operations. Exactly one
PUT or POST is observed, with no automatic repost or Session refresh. This is controlled serialized
HTTP/public Runtime evidence; it does not prove a second real Device’s concurrent settings gesture.
No production correction was needed for these variants.

2026-09-09 connected complete-stage classification is GREEN1/1
(`/tmp/bittery-native-complete-stage-selection-first-green.log`,9.41s) after its public two-owner RED
(`/tmp/bittery-native-complete-stage-selection-first-red.log`,9.63s). An exact physical complete source
stage omits A while retaining B. Public Refresh verifies selection[A,B]; the fixture holds the Session
primitive after both source Export controls fire, then sends the actual serialized native snapshot.
The consumer now receives both selective controls, stays unlocked with its existing borrowed Account,
and adopts both physical journals before original host Export disposal. Immutable accepted Operations
remain unchanged. The combined first-fence boundary retains A's CompleteBootstrap proof and B's full
verified policy proof, classifies the captured union under native/publication, then notifies outside
both guards. Cleanup preserves continuity only when every actual retired ID was already classified;
unrelated omissions retain the existing hard fallback. Root, native and vault/source reviewers passed
this bounded path. The obsolete generic wrapper was removed; its five tests call the same existing
hard-transition owner with an empty classified-ID set.

The source review also identified a separate inherited error boundary in
`begin_vault_retirement_under_publication`: it can acquire the registry fence and invalidate delivery,
then fail while parsing a retained Move's scope during projection filtering before returning the
notification handle. Current generic retained Operation validation does not reject every malformed
Move body when no attachment recovery record is present. Thus the grouping review does not claim
complete error-handoff coverage. A physical retained-Move/public-refresh RED is being prepared before
any correction; native pending episodes, multi-batch failure completion, general scope readmission and
full connected transport acceptance remain outstanding.

2026-09-09 actual joined Worker output is GREEN against freshly generated current-source WASM
(`/tmp/bittery-travel-export-output-joined-bindings`, build log
`/tmp/bittery-travel-export-output-joined-build.log`). The Lock/output case passes1/1,21 assertions
(`/tmp/bittery-export-output-worker-first-green.log`): both reentrant Begin probes, before and after
Worker forwarding but before the WASM callback returns, refuse; subsequent facade admission succeeds.
Core terminal control arrives while output is retained, wrong Finish leaves Lock pending, and exact
Finish after Blob/snapshot disposal completes Lock. The subsequent Close/output case first failed
meaningfully at the owner refusing exact Finish during shutdown
(`/tmp/bittery-export-output-close-first-red.log`,14 assertions). Its minimal correction extends the
existing descriptor-only cleanup predicate to the exact Finish fields; service and Core still validate
the original handle/lease. Close/output now passes1/1,21 assertions
(`/tmp/bittery-export-output-close-first-green.log`). All six maintained joined Worker histories pass
in one process,6/6,92 assertions (`/tmp/bittery-export-output-worker-six-green.log`); affected TS
service/owner/entry/composition tests pass112/112,595 assertions
(`/tmp/bittery-export-output-close-ts-green.log`), including cleanup before/during Close and refusal
of extra fields, wrong channels and getters without invoking them. Package-root types pass
(`/tmp/bittery-export-output-close-check-types.log`). Actual application archive/ready-Blob/Download
cutover and delayed callback failure remain outstanding; this is the connection/output bridge bound.

2026-09-09 corrected fresh-owner pending complete-stage recovery is GREEN1/1
(`/tmp/bittery-travel-pending-stage-fresh-owner-second-green.log`). The original RED failed because
public open left the durable stage intact. The first fix applied uncaptured reconstruction too broadly:
its GREEN attempt failed at the preparatory live-Sync metadata gate, before reopen
(`/tmp/bittery-travel-pending-stage-fresh-owner-first-green.log`; exact call-site backtrace in
`/tmp/bittery-travel-pending-stage-fresh-owner-gate-diagnostic.log`). That condition began cleanup of a
held Export during live post-watermark verification. The corrected condition reconstructs uncaptured
complete-stage duties only while public open retains its private cache with ready=false. Already
captured live stage retries keep their existing behavior. Parent and native independent reviews pass
the corrected startup/live ordering; no deadline or fixture assertion was relaxed. Fresh open now
retires the original durable Vault/Session omission while preserving pending, cursor, accepted bytes
and exact prior policy metadata, without inventing persistence for the newer transient policy proof.
The six shared histories are being simplified into closed named cases; an independent empty-omission
public startup test is registered next, with no additional production change.

2026-09-09 targeted regression after startup-only reconstruction passes the complete live Sync
subset59/59 (`/tmp/bittery-travel-private-startup-live-sync-regression.log`,2.37s). The prior current
connected-stage/native subset passes8/8 (`/tmp/bittery-travel-native-stage-current-regression.log`,
20.73s). The subsequently registered malformed retained-Move test is a distinct meaningful RED
(`/tmp/bittery-native-retained-move-fence-first-red.log`,1 failed,4.17s): exact persisted bytes pass
current validation, public verified policy fences new selected output, but the fallible projection
filter loses the original retirement control. The correction must retain the acquired notification
and native classification, preserve accepted evidence and report the original error without claiming
a journal or cleanup acknowledgement. Fixture namespace compilation errors before this run are not
behavioral evidence. Fresh full checks remain required after the ongoing71 work.

2026-09-09 empty-omission pending startup is GREEN1/1
(`/tmp/bittery-travel-pending-stage-empty-open-first.log`,0.07s). A real complete Bootstrap includes
every existing authority and Session scope; an abandoned public Save creates durable pending before
fresh-owner public open. Open preserves the exact complete stage, authority, Session wrappers,
policy, accepted Operations and active cursor, retaining pending with no retirement journal. It does
not fabricate an empty absence proof or promote unverified authority. The six preceding histories now
use a closed CompleteStageHistory enum instead of positional booleans, making contradictory reject
and lost-acknowledgement modes unrepresentable while preserving each primitive/public assertion.
The next registered RED covers a complete stage's additional omission when another omitted Vault
already owns a different VerifiedTravelPolicy proof; no production change for that case is included.

2026-09-09 the inherited post-fence retained-Move error is GREEN1/1
(`/tmp/bittery-native-retained-move-fence-first-green.log`,4.79s), following its physical/public RED
(`/tmp/bittery-native-retained-move-fence-first-red.log`,4.17s). The fixture positively loads retained
Move bytes through current SQLite validation, then public Refresh verifies a selected restriction.
The acquired fence now refuses output, emits its Export control and becomes classified native source
restriction even when projection filtering returns the exact original Move error. Accepted bytes are
unchanged; no durable journal or adoption ACK is fabricated. The existing first-fence return carries
its acquired handle/token plus filter error. Callers notify outside publication/native guards and
preserve old delivery-token drain before returning the error; the native consumer uses its existing
async caller for that drain. Root and protected-image independent reviews pass. Held-callback error
drain and broader multi-batch failure completion remain source-reviewed requirements awaiting their
own variants; this malformed-Move test alone does not prove them. Native pending-episode propagation
is the next bounded connected scope, and71 remains incomplete.

2026-09-09 full current-Core regression checking exposed an older native test before its intended
retirement scenario. An exact absolute-binary rerun reproduced1failed,8.30s
(`/tmp/bittery-native-later-retirement-current-red.log`):
`later_native_retirement_progresses_while_another_account_is_still_draining` fails initial native
import preparation, before either held Account execution or the cross-Account progress assertion.
The fixture resolves installation verification only for its first Account, then installs another
Account against offline HTTP without completing that Account's mandatory pending policy duty. The
proposed fixture correction uses a real public initial Refresh before restoring offline transport;
it does not relax native admission, timing or hard-retirement assertions. Until that corrected exact
scenario passes, earlier targeted native results do not constitute a green full-Core regression run.

2026-09-09 differing-proof complete-stage history reproduced RED1/1
(`/tmp/bittery-travel-different-stage-policy-proof-first-red.log`,2.15s): a verified response had
retired selected Vault A's Export before its held metadata read, while the actual final Bootstrap
stage omitted both A and B. After caller loss, retry journaled A alone and waited for its disposal
without notifying B, discarding the older stage's additional omission. The corrected public test uses
HTTP, Export controls and physical storage only; private registry/proof introspection was removed.
Parent approved joint stage adoption: the exact durable omission proof authorizes one atomic purge
and journal for all omitted scopes. Existing distinct selected proof handles/lifetimes remain intact;
only missing scopes get the complete-stage proof, and each retained handle upgrades after the joint
journal is observed. No transient policy metadata rewrite is necessary or permitted merely to adopt
that already durable absence duty. Stage-present selected scopes keep their original proof and normal
resume path. The registered fix awaits GREEN and preserves first-hide ordering by requiring an
existing omitted duty for early live adoption; uncaptured startup reconstruction remains private.

The two exact preexisting SQLite retirement regressions independently reproduced before any physical
assertion because their controlled HTTP feed omitted GET /api/v1/travel-mode
(`/tmp/bittery-71-existing-sqlite-retirement-diagnostic.log` and
`/tmp/bittery-71-existing-retirement-driver-diagnostic.log`). Their narrow fixture now serves a valid
disabled response and positively observes that read before each held promotion. The offline-after-
complete assertion, actual SQLite failure boundaries and original authority/Session-only/readmission
invariants remain unchanged; the complete physical test module must pass before claiming repair.

2026-09-09 the actual Web archive hook now has a meaningful fixed-lifetime RED and first GREEN.
The RED (`/tmp/bittery-web-archive-ready-output-third-red.log`,1 failure,17 assertions) mounts the
production hook and Runtime provider against one actual joined Worker/WASM owner, builds and downloads
an intact ZIP, then verifies selective hide through public Refresh and Items. The old hook still kept
its ready Blob and produced another output after that retirement. Earlier failures were setup only:
the cfg-only seed omitted its stored Account display identity, then the fixture expected the wrong
seeded Item title. Neither was a policy or output-lifetime regression.

The same client mints one fixed Export observation outside its reusable store registry. One archive
attempt holds its captured frame, ZIP work and private ready Blob, clears those references before
acknowledging disposal, and routes final output through the original handle's Begin/Finish. React
receives readiness and progress, never the Blob. The existing Download gesture remains repeatable;
after Finish, another click captures and builds afresh. The actual browser history is GREEN1/1 with
19 assertions (`/tmp/bittery-web-archive-ready-output-repeat-green.log`): two real Download gestures,
two exact Export captures, matching decoded ZIP Items, then a third ready archive disposed by verified
hide with zero subsequent output. A single-animation-frame UI sampling race was corrected to await
the real rendered readiness predicate; no Runtime predicate or deadline was relaxed. Existing format
and cancellation tests pass13/13 with65 assertions (`/tmp/bittery-web-archive-attempt-unit-green.log`),
including all five categories, favorites and original fields, empty archives,140KB authenticated
Attachment bytes in JSON and ZIP, and cancellation during download/ZIP generation. Those unit tests
use a controlled transport and browser-output primitive; actual Worker acceptance currently covers
the nonempty zero-Attachment hook path. Independent review, fresh generated repository ABI/types,
full checks, and the separately retained delayed-throw cleanup history remain outstanding.

2026-09-09 the separate delayed callback failure question is now covered by an actual joined Worker
history (`/tmp/bittery-export-delayed-throw-first.log`,1/1,18 assertions). The real WASM retirement
callback reaches a test-only throw before the service forwards its terminal control. The host still
holds its nonempty zero-Attachment snapshot; public Lock remains pending, and another Begin reaches
Core and is refused. Only explicit host disposal followed by the same observation's unobserve allows
Lock to finish. No production callback retry or automatic cleanup acknowledgement was added. This
proves the bounded failure contract, not eventual cleanup without a functioning consumer or recall of
bytes already released to the browser.

2026-09-09 Export handoff at the user's requested stopping boundary: all owned source is stable and
no test/build process remains active. The existing client/registry/Session/Worker/service/composition
subset passes163/163 with713 assertions
(`/tmp/bittery-web-archive-client-bridge-regression.log`). Scoped Biome and git diff --check pass.
The final package-root `pnpm exec turbo -F web check-types` run has10 successful tasks and one failure
(`/tmp/bittery-web-archive-attempt-third-types.log`): the repository's generated
packages/crypto/wasm/generated/wasm-bindgen declaration still lacks the newly generated
begin_vault_export_output/finish_vault_export_output methods. The retained real acceptance artifact
`/tmp/bittery-travel-export-app-joined-bindings` contains them and passed the actual app/output tests;
regenerate the repository ABI through its normal build, never hand-edit those declarations or weaken
the required bridge interface to conceal the mismatch.

Stable Export entry points are client-runtime/src/client/vault-export.ts (fixed handle),
client/index.ts and transport.ts; the existing WASM web.rs and Worker facade/service/owner forwarding;
apps/web/src/lib/runtime-vault-export.ts (private archive attempt), hooks/use-vault-export.ts and the
existing export dialog. The old format test now observes actual browser-output primitives through
Begin/Finish instead of requiring a publicly returned Blob. The actual app harness uses one joined
composition through an exact test-only module resolver. Its rendered readiness wait replaces only
single-RAF sampling, and its repeat gesture counts real fixed observation requests without supplying
semantic answers. No Desktop or Extension Export caller activation is included.

Remaining work before acceptance: finish the independent archive/hook cleanup review; regenerate the
normal repository ABI and rerun package-root types; run the full11-history
client-runtime/tests/web-create-vault.chromium.test.ts against current joined bindings; then complete
phase-wide pnpm check:ci and pnpm check:ci:rust after all71 work stabilizes. The full browser file's
existing original fixture invokes the real Server signing helper with `--features acceptance-adapter
--bin presign-exact-upload-acceptance`; it does not reset or mutate the Server database, but its Cargo
lane must be serialized with other builds. The file has not been run as a whole since adding app and
delayed-throw histories. The current bounded results are not a completed71 or whole-Web acceptance
claim. Broader pending native/Server overlap and other owners' outstanding variants remain tracked
separately above.

2026-09-09 user-requested checkpoint: [the handoff](../handoff-2026-09-09-desktop-extension.md)
records approved decisions, renamed Desktop `runtime_host`, current source and exact remaining work.
Current Core and Desktop no-run builds pass after a lexical guard-scope repair in joint-stage adoption.
Differing-proof omission GREEN1/1 (`/tmp/bittery-handoff-different-proof.log`), physical retirement5/5
(`/tmp/bittery-handoff-physical-retirement.log`), Device Setup4/4 and QuickUnlock cancellation1/1 pass.
Both corrected native fixture tests also pass. Renamed Desktop host tests89 pass,5 opt-in ignored.

The repaired native pending tracer now produces meaningful RED1/1 after disposing loans and closing
owners: source pending authority applies and old borrowed access remains, but the consumer's new Items
subscription exposes fresh plaintext (`/tmp/bittery-handoff-pending-episode.log`,9.41s). The complete
correctly filtered native Travel module has9 passed/1 failed in20.01s; no pending production fix exists.
The first wrong module filter matched zero and is not acceptance. Two foreground catalog tests now
finish without hanging but fail on an extra publication during pending. QuickUnlock's write ordering
passes and its later exact Replica assertion fails because Bootstrap moved Cold/revision4 to
Ready/revision8. Both require narrow diagnosis; do not weaken policy/credential assertions. Corpus drift
remains. These results supersede fixture-repair expectations, not actual full CI. Full phase checks,
remaining71 variants and both production cutovers are still outstanding; no phase is closed.

2026-09-14 continuation: reviewed the handoff and all dependency statuses;71 remains the earliest
unblocked ready delivery ticket. The current work is still unaccepted. The catalog regressions were
fixture expectations: pending publication contains exactly the unchanged unrelated Account Vaults,
while the prepared stale full Rename frame is refused. Corrected tests retain exact frame-count,
all-Vault and same-revision retry assertions;2/2 pass after independent review
(`/tmp/bittery-resume-catalog-final-green.log`). QuickUnlock's synthetic enabled policy disagreed with
its disabled Server fixture, legitimately abandoning the initial Bootstrap. Aligning that one test's
initial policy restores its intended Ready baseline, exact before/after Replica equality and original
three credential writes;1/1 passes (`/tmp/bittery-resume-quick-policy-aligned.log`). The accepted-write
failure test passes unchanged in isolation,69.55s; the300-second eight-thread baseline reached1036/1037
results before its cutoff and is not full-suite acceptance. Corpus drift was structurally checked:
all111 changed rows add only `policyVerificationPending:false`; normal regeneration remains pending.

The connected pending-policy tracer now passes after shared Core propagates revision-bound source
verification separately from established key availability. Fresh reimport calibration, existing
selective/overlap/cancellation histories and native channel-loss duty cleanup have targeted GREEN
results; remaining reason overlap, independent revalidation, captured removal, bounds and full checks
remain open. Independent native replay evidence passes lost ACK after physical cleanup and a failed
first Account journal with successful later Account adoption, without skipping the contiguous ACK hole
(`/tmp/bittery-native-ack-replay-first.log`, `/tmp/bittery-native-failed-first-adoption-first.log`).

The actual Web archive matrix found and corrected a lifetime bug: retirement must remain active
through awaited exact Finish and observation close, including after synchronous output has consumed
its Blob. Current joined WASM bindings built through the normal test-harness path. The full maintained
Chromium file passes38/38 with574 assertions, including28 actual archive cases with237 assertions:
zero/nonzero Attachments,140KB ZIP/JSON contents, repeat Download, held binary GET and decrypted sink
write, ZIP/ready output, both output-admission orders, Finish, hide/readmit, Close, actual Worker realm
loss, reset and browser-output failure. Format units13/13, package-root Web types11/11, scoped Biome
and diff checks pass. Root independently reviewed the ownership/order and narrow production fix.
Evidence: `/tmp/bittery-export-current-full-browser.log`; bindings:
`/tmp/bittery-resume71-joined-bindings`. This is Export capability evidence, not completed71/full CI.

The actual framed source adapter lacked restriction ACK forwarding and refused encoding Core's
nonsecret Applied response. A real two-owner/socket test first failed with EOF, then exposed the
encoding refusal; the closed command now forwards through the owning source facet and encodes only
while that facet is live. Wrong-port ACK remains refused. All five maintained source socket tests
pass (`/tmp/bittery-native-framed-source-regression.log`). Populated real Server/native executable
Travel acceptance is being extended; no result is yet claimed for that new history. Independent
simplification/review, remaining71 acceptance variants, regenerated contracts/corpus and literal
`pnpm check:ci` plus `pnpm check:ci:rust` still gate ticket closure and subsequent capabilities.

2026-09-14 continued verification: normal Replica corpus generation completed; the current embedded
Rust Domain/both-adapter oracle passes1/1, and IndexedDB migration/history replay passes2/2 with15,278
assertions (`/tmp/bittery-resume71-corpus-indexeddb.log`). The current native namespace passes52/52,
including independent Server/native/successor pending reasons and durable replay. Completed public
Account removal now records `TargetRemoved` only at aggregate teardown completion, retaining the
original captured lifetime in the existing bounded channel target. Further public histories pass
replacement with the same local AccountId and refusal to infer completed removal from physical
absence after failed host cleanup. Independent review still requires the held false-marker output
boundary and source replacement hard-retirement fixes; no complete pending-policy acceptance is claimed.

The populated actual native executable Travel history passes against two real Server Accounts,
two native Runtime owners and their physical SQLite Replicas. The real broker frames carry hide,
durable adoption ACK and exact duplicate ACK; unrelated Vault/Account reads remain available. Disable
does not clear the borrowed grant exclusion; only explicit fresh generation-bound transfer restores
the hidden Item. The existing consumer-owner replacement, selective Lock, delayed reply refusal,
independent native EOF and Desktop shutdown assertions remain. Scoped public User deletion and local
cleanup passed. Evidence: `/tmp/bittery-native-travel-actual-process-diagnostic.log` (1/1,2.8minutes).
The preceding attempt failed with an undifferentiated protocol response; both exact fixture Users
were verified absent after native public deletion and retained credentials removed before rerun.
The successful run retains improved closed-error-code/request-ID diagnostics. A repeat is in progress
alongside expanded real Server selection validation; no unexplained first failure is relabelled fixed.

The repeat and expanded selection run passes2/2 in5.6minutes
(`/tmp/bittery-native-travel-source-and-selection.log`), including a second consecutive populated native
executable success and the unchanged wrong-password/fresh-proof assertions. The settings history now
also proves all-visible/empty saves, empty enable and101-ID refusal, and enabled-selection refusal.
Separate real Core/Server Save and Enable histories pass with socket loss before execution and after
the actual successful response (`/tmp/bittery-native-travel-selection-ambiguity-first.log`,2/2,
4.5minutes). Each records exactly one Save and one Enable attempt, current successful policy reads
after loss, and zero login start/finish calls during those settings attempts. Before-execution loss
requires a distinct explicit retry; post-commit loss confirms actual state. Both restore fresh target
authority via ordinary Disable, retain unrelated reads, and finish the existing multi-process native
artifact/recovery/User-deletion acceptance. Web dependency types pass11/11 and scoped Biome/diff
checks pass. Independent review of these additions and complete71/full-CI gates remain open.

2026-09-14 read-only settings fixture correction: the first genuine invitation setup completed
registration but remained at the existing unlock screen because `signUpFromInvite` waited for app
readiness before the separate Runtime sign-in. The protected invited-User credential capture worked;
the main fixture credential file was written too late. The corrected fixture captures the main
credentials before setup, separates invitation registration from a fresh public Runtime sign-in,
and requires invited-User public deletion before the main User's deletion in the same live test.
The first failure is recorded in `/tmp/bittery-native-travel-readonly-first.log`.

The attempted separate recovery run incorrectly used the ordinary Playwright launcher, whose
`e2e-launch.mjs` runs `migrate --fresh` before starting the isolated E2E Server. This reset
`bittery_e2e` before either failed-run User's public deletion could be proved; it is not public
deletion acceptance. That attempt was stopped and its temporary spec removed
(`/tmp/bittery-native-readonly-scoped-invitee-cleanup.log`). A subsequent read-only query, restricted
to the exact failed-run main User ID/email and invited User email from the protected record, found
zero remaining Users in `bittery_e2e` (`/tmp/bittery-native-readonly-first-reset-absence.log`). No
development database was touched. The protected failed-run record remains retained; the corrected
read-only acceptance run is still in progress and must prove both public deletions itself.

The corrected actual read-only run now passes1/1 in3.8minutes
(`/tmp/bittery-native-travel-readonly-2.log`). A genuine invited User creates a shared Vault and
grants the native fixture User `read-only` membership through the real API, after public Core
recipient-key verification against that recipient's own fingerprint. The helper's separate SRP
Devices use isolated memory stores; no Core token is mirrored. Native all-visible selection now
requires both a Team Vault and a ReadOnly role. Wrong-password/fresh-proof, accepted-artifact,
process-restart and recovery assertions remain successful. The invited User's public Runtime
deletion with actual correlated HTTP200 completes before the main User's same public deletion;
the successful run's protected directory is removed only after both proofs. Web dependency types
pass11/11 (`/tmp/bittery-native-readonly-travel-web-types-2.log`); scoped Biome and diff checks pass.
This closes the requested real settings role variant, not the remaining ticket71/full-CI gates.


2026-09-14 current accumulated host validation: literal `pnpm check:ci` passes
(`/tmp/bittery-resume71-check-ci-first.log`), including host types/package tests,27 root script
checks and the full serial Chromium gate. The current joined Export file passes38/38 with574
assertions inside that gate. Normal production WASM generation also passes separately
(`/tmp/bittery-resume71-production-wasm.log`). Private native contract generation and its eight
closed-wire/decimal/purpose/expiry checks pass; Desktop native IPC generation passes4/4.

Literal Rust CI's first run stopped at Core Clippy: complex return types, two iterator/branch
simplifications, a helper below a test module and five test lock scopes. These are corrected
without suppressions or relaxed assertions; the second literal run is in progress. No full Rust
success or ticket closure is claimed from the earlier host result.

The expanded actual native process run failed before independent restoration: fresh borrowed
Export after Disable returned a correlated `AuthenticationRequired`
(`/tmp/bittery-native-travel-actual-independent-enabled.log`). Both exact fixture Users were deleted
through public HTTP200, and a scoped read-only check found zero remaining rows. The protected failed
record remains available. The fixture now waits for the source's fresh read authority after Disable
and records nonsecret current generation/policy facts on refusal; this is a diagnosis/refinement,
not a claimed production fix. Independent restoration now follows the supported public disconnect,
standalone unlock and fresh native-port attachment sequence. Its actual successful run and pending
consumer Move witness remain required; compilation alone does not establish either result.

The failed source run's protected credential file was subsequently removed after its public
HTTP200 deletions and exact zero-User check; nonsecret diagnostic evidence remains.


2026-09-14 complete controlled native namespace passes76/76
(`/tmp/bittery-native-final-namespace-green.log`), including actual consumer incarnation replacement,
all replay/teardown/bounds histories, pending overlap and independent revalidation. Independent
review found no additional production blocker in terminal removal matching or the source transport.
Desktop, Extension and Web dependency type checks pass13/13 on the regenerated private contract.

The expanded actual process run now proves the consumer's pending Move retains its immutable
request through hide/ACK/Disable and that the original operation converges after fresh restoration.
Borrowed restoration also completes (`/tmp/bittery-native-travel-pending-independent-first.log`).
The overall run fails at independent reconnect because its compiled fixture still launches the
Cargo executable outside the helper's trusted sibling directory. A direct binary check confirms
that old fixture branch was compiled before the path correction. The source now reuses the
already copied sibling executable; peer validation is unchanged. Both exact Users received public
HTTP200 deletion, a scoped query proved zero remaining rows, and that run's credentials were removed.
Independent reconnect and the final complete actual process result remain outstanding.

The two actual foreground loss histories now pass2/2 in5.7minutes
(`/tmp/bittery-native-travel-caller-owner-loss-final.log`). The proxy consumes the real Server's
successful Enable response before withholding delivery and current-policy reads. One history
drops the waiting caller; the other exits the native process with an exact marker and exit code,
then reopens the same locked Account and uses explicit public password QuickUnlock. Both preserve
the durable unverified gate and prior policy until current Server verification converges, remove
the selected Vault and its seeded Item plaintext, and retain unrelated reads. Exactly one
Save/Enable mutation is allowed over each whole fixture; there is no automatic login exchange
or foreground retry. The process-loss history counts the existing QuickUnlock contract's one
explicit login exchange separately. Both histories finish the existing native artifact/recovery
acceptance and prove their exact User's public Runtime deletion with actual HTTP200 in the same run.

The first loss run passed caller-drop and native process recovery but failed a Web counter
expectation that incorrectly included explicit password QuickUnlock among automatic reconciliation
calls (`/tmp/bittery-native-travel-caller-owner-loss-first.log`,1 passed/1 failed). Both Users were
publicly deleted in that run. The correction separates that explicit gesture's request window;
it does not change production authentication or relax automatic-retry assertions. Web dependency
types pass11/11 (`/tmp/bittery-native-travel-loss-web-types-final.log`), and scoped Biome, Rust format
and diff checks pass. Root independently reviewed the held-response and fresh-owner ordering.

The retained failed read-only setup and first process-loss credential files have now been removed
after their previously recorded exact zero-User check and public HTTP200 deletion proof,
respectively. Only nonsecret phase/cleanup evidence remains in those two fixture directories;
the earlier isolated reset is still not claimed as public deletion acceptance. Remaining source
process acceptance and final literal CI gates continue to gate ticket71 completion.


2026-09-14 final expanded actual native messaging acceptance passes1/1 in4.4minutes
(`/tmp/bittery-native-travel-pending-independent-final.log`). The maintained test requires all three
Travel markers: exact pending consumer Move retention/convergence, borrowed hide/ACK/fresh-transfer
restoration, and independent restoration after actual disconnect, explicit own-Account unlock and
fresh native-process reattachment. Existing two-Account transfers, owner replacement, delayed reply
refusal, selective Desktop Lock, unrelated Account/Vault reads, sibling-port EOF and actual Desktop
shutdown remain required. The successful run proves both scoped public User deletions and local
cleanup before removing its private fixture directory. Two independent source-flow reviews found
no remaining blocker after the trusted sibling executable correction. This completes that actual
capability history; final literal phase checks still gate ticket closure.

The current full Core suite passes1068/1068 inside the second literal Rust CI run; bindings tests
and generator tests also pass before the remaining generated checks. The later host-CI attempt
encountered only a5-second whole-repository AST-audit test timeout (5.64seconds) during concurrent
heavy Rust tests. No assertion or deadline was changed. The quieter literal rerun passes that same
test in4.63seconds and has reached Chromium acceptance. Full command completion remains pending.

2026-09-14 final literal host CI completes successfully with exit0
(`/tmp/bittery-resume71-check-ci-quiet.log`). The unchanged whole-repository audit, host types,
package tests and serial Chromium gate all pass, including the complete38-case joined Export file
with574 assertions. The earlier concurrency-related audit timeout remains recorded above; no
assertion, timeout or required check was relaxed for the successful run.

Final independent closure review compared the observable acceptance table and connected native
contract with the current Core1068/1068, native76/76, physical SQLite/IndexedDB conformance,
actual Web archive, real Server settings/ambiguity/caller-loss/process-loss and final actual native
messaging evidence. It found no additional ticket71 acceptance gap. Simplification reviews cover
shared retirement proof ownership, completed target and waiter ordering, independent pending reasons,
bounded replay/revalidation, Export and Download finalization, and the framed/process source flow.
The implementation retains the existing Core channel, challenge, Session, observation and retirement
owners; no host visibility map, extra cleanup registry or policy retry runner was introduced.

The ticket deliberately remains `ready-for-agent` while the second literal `pnpm check:ci:rust`
run completes its remaining Desktop and generated checks. Root will record that command's outcome
before changing ticket status or the map. Actual Tauri gestures remain66/73, and actual Chrome
combined Worker/native Port, broker reattachment and production autofill/passkey delivery remain
74/76/77 under the sealed native contract. This evidence does not claim either production migration.

2026-09-14 final literal Rust CI completes successfully with exit0
(`/tmp/bittery-resume71-check-ci-rust-second.log`). Server checks, crypto tests, Core1068/1068,
bindings, generated schemas, physical Replica conformance, native and production Web bindings,
Desktop Clippy and60/60 Desktop tests all pass. Generated Desktop outputs remain unchanged by
the check relative to the accepted working tree, verified with a disposable Git index; the real
index was not modified. Together with the final literal host CI and completed independent review,
this closes71 as a shared Runtime capability. Product migrations remain in their later tickets.
