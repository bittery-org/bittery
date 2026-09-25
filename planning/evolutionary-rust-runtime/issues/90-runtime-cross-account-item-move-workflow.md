# Shared Runtime cross-Account Item Move workflow

Type: task
Status: resolved
Blocked by: 68, 69, 70, 83, 85, 89, 104
Spec: ../desktop-extension/cross-account-move.md

## Outcome

Preserve Desktop's existing same/different-Server destination choices through one durable shared Core
workflow. Hosts submit Move/explicit Resume intent and render projections. Core owns target creation,
bounded Attachment transcryption, source trash/delete, retry, retained outcomes and both Accounts'
authorization. Preserve original target Item, semantic Operation and immutable child step identities.

The accepted83 policy permits explicit destination reauthorization after removal only for the exact
original canonical Server/User and verified current evidence. Re-add/unlock alone does not resume.
Edited target content/Attachments, stale confirmation or unproven results remain blocked with evidence
preserved. No compensating deletion of a created target and no legacy attachment-delete/rebuild retry.

## Reviewed implementation boundary

The focused spec now seals and independently reviews:

- The closed persisted workflow/immutable child request representation and atomic source admission,
  preserving ordinary Operation persisted bytes and separating semantic lineage from HTTP attempts.
- Source-owned encrypted artifacts with distinct source/destination authorization and existing
  artifact/recovery cleanup, including target teardown without losing accepted ciphertext.
- Durable destination-binding retirement/recovery across target removal and source-store failure,
  plus the exact Core-issued revision guard for explicit Resume.
- Exact generated intent/projection shape and compatibility with existing same-Account Move.

No additional product choice is currently required. The ticket is ready, but an agent must complete
the listed prerequisite capabilities before starting implementation. Profile admission82 and
Desktop cutover consume this capability; they are not prerequisites that create a dependency cycle.

## Acceptance

Follow the spec's test-first no-file vertical slice, then Attachment and permission variants. Prove
original IDs/bytes across real durable reopen and lost responses, both Account/Vault fences, all Item
categories, shared/private Vaults, same/different Servers and explicit same-identity Resume. Verify
that old retained outcomes cannot recreate current missing data or turn rejected source deletion into
completion. Run actual nonempty Attachment transfer through existing crypto and real Server routes.

Actual Desktop dialog/drag/drop acceptance remains73, populated legacy work admission remains91,
and relevant Extension product acceptance remains77. Remove the old executor only when its remaining
application callers migrate. Run the required targeted/generated checks and both full CI commands;
record evidence and any blockers without substituting compilation/mocks for application acceptance.

## Comments

2026-09-14 resolved after final independent acceptance review and both complete literal CI gates.
`pnpm check:ci` passes on the final source (`/tmp/bittery90-check-ci-fourth.log`), including all14
test tasks,484 Runtime tests,540 Web tests,27 repository tests and all11 actual Chromium suites.
`pnpm check:ci:rust` also exits successfully (`/tmp/bittery90-check-ci-rust-third.log`): Server checks,
152 crypto tests and11 format vectors, workspace/all-target Clippy, all1,148 Core tests,52 generator
tests, every generated contract/corpus/binding comparison,11 normal Web smoke checks, Desktop lint,
194 Desktop tests and60 native-host tests pass. Six explicitly gated Desktop acceptance tests and
one feature-only Web harness are intentionally skipped in these normal commands; the actual native
cross-Account transfer and required browser histories were exercised separately as recorded below.
The production WASM retains its normal-build identity and `git diff --check` passes. The generated
Desktop comparison used a disposable index; the real index was not staged.

The completed capability includes no-file and file-bearing execution, exact retries and retained
outcomes, both participant fences, explicit same-identity Resume, shared/private and different-Server
variants, durable artifact recovery, cleanup and actual native-process/Server nonempty transfer.
The final no-file retirement regression is reproduced and fixed without weakening file-bearing
cleanup. Independent closure review finds no remaining capability acceptance gap. Desktop dialog/
drag-and-drop73, populated-profile admission91 and relevant Extension77 remain their own application
work; the loopback object fixture does not claim AWS signature verification. Ticket91 is now unblocked.

2026-09-14 the complete literal host gate passes with the retirement correction and final native
fixture lint cleanup (`/tmp/bittery90-check-ci-fourth.log`). All14 test tasks,484 Runtime tests,
540 Web tests,27 repository tests and all11 Chromium suites pass. Browser recovery passes8/8 with112
assertions; shutdown passes;38 joined Create Vault/archive histories and the actual Import hook pass.
Independent review finds no sibling no-file artifact-capability mistake in admission, dispatch,
Resume, startup or recovery. The normally generated production WASM remains unchanged by browser
test generation. The third literal Rust gate is running; ticket90 remains open until it succeeds.

2026-09-14 both unchanged native source/target Vault-restriction histories pass after the narrow
artifact-selection correction (2/2,52.08seconds,
`/tmp/bittery90-native-participant-retirement-fix-green.log`). The existing selected-file sweep test
still carries the exact pending recovery scope and refuses a missing artifact port (1/1,
`/tmp/bittery90-nofile-retirement-strict-artifact-port-green.log`). The no-file regression is fixed
without broadening cleanup permission or weakening file-bearing duties. Normal production Web
bindings and11 smoke checks pass. Desktop all-target Clippy also passes after removing one needless
borrow in the native acceptance fixture (`/tmp/bittery90-attachment-desktop-clippy-green.log`). Both
complete-ticket gates are being repeated; ticket90 remains open.

2026-09-14 the second full Rust gate passes crypto152/vectors11, workspace Clippy and many Core
histories, then exposes a no-file source-Vault retirement regression. The unchanged exact native
restriction test reproduces1failure in68.68seconds
(`/tmp/bittery90-native-source-retirement-ci-repro.log`): Native policy adoption and selected Session
key removal succeed, but cleanup cannot complete. The new cross-workflow artifact selection counted
an empty Attachment set and required a storage capability that the valid no-file fixture does not
need. Independent source review confirms the durable checkpoint set exactly covers the source
manifest. Selection now requires a nonempty Attachment set, including Completed file-bearing
workflows whose orphan cleanup still needs storage. No policy, timeout or missing-port check is
relaxed. The already-failed full run was interrupted after reproducing the cause; its remaining tests
are unclaimed (`/tmp/bittery90-check-ci-rust-second.log`). The existing regression, strict file-duty
checks, production bindings and both literal gates must pass again before resolution.

2026-09-14 the literal full host gate passes again on the corrected final implementation
(`/tmp/bittery90-check-ci-third.log`): all14 test tasks,484 Runtime tests,540 Web tests,27 repository
tests and all11 serial Chromium suites. The recovery eight pass with112 assertions; the actual
shutdown lease regression passes; all38 joined Create Vault/archive histories and the actual Web
Import hook pass. The normally generated production WASM is unchanged by the temporary test build.
The required second literal Rust gate is now running; ticket90 remains open until it succeeds.

2026-09-14 the corrected implementation passes workspace/all-target Clippy, the unchanged generated
Replica corpus and all8 serialized cross-Account Move conformance tests, including Attachment Resume
and recovery ownership. Normal production Web bindings regenerate successfully and pass11 smoke
checks with the intentional feature-only skip. Evidence is in
`/tmp/bittery90-clippy-layout-green-attempt.log`, `/tmp/bittery90-boxed-evidence-corpus-green.log`,
`/tmp/bittery90-boxed-evidence-conformance-green.log` and
`/tmp/bittery90-boxed-evidence-production-web-smoke.log`. Both full gates still precede resolution.

2026-09-14 the first complete-ticket Rust gate passes Server checks and all152 crypto tests plus11
vectors, then stops on two Core Clippy findings
(`/tmp/bittery90-check-ci-rust-first.log`). Registration `VerifiedPresent` evidence now boxes its
large metadata record; the HTTP refusal test uses `matches!` with the same four exact assertions.
Independent review confirms unchanged Serde representation and metadata matching. Existing corpus
and behavior checks, normal production bindings and both literal full gates will be rerun before
resolution; the earlier full host success does not close the ticket after this correction.

2026-09-14 the literal complete-ticket `pnpm check:ci` gate passes
(`/tmp/bittery90-check-ci-second.log`), including all14 test tasks,484 Runtime tests,540 Web tests,
27 repository script tests, all11 serial Chromium suites, the eight artifact-recovery histories,
shutdown ordering,38 joined Create Vault/archive cases and the actual Web Import hook. The required
literal Rust gate is running sequentially against the same stable implementation with a disposable
Git index for generated-file comparisons. Production Web bindings retain their normal-build hash;
ticket90 remains open until that final gate succeeds.

2026-09-14 normal production Web bindings regenerate and pass11 smoke checks with the intentional
feature-harness-only skip. The first literal full host gate passes all14 test tasks, including484
Runtime and540 Web tests, then catches the CI runner test's old suite list
(`/tmp/bittery90-check-ci-first.log`). Its expected serial list now includes the two newly registered
artifact-recovery and shutdown files. The existing four runner tests pass, preserving one feature
build, exact Xvfb ordering and cleanup; independent review confirms no gate bypass. The complete
`pnpm check:ci` is being rerun, followed by the still-required literal Rust gate. No ticket acceptance
is claimed from the targeted successes or this runner correction.

2026-09-14 both final streaming histories pass2/2 in188.41seconds
(`/tmp/bittery90-attachment-streaming-first.log`). A fully read bad-tag source leaves only unsealed
provisional chunks, with no publication or grant. Interrupted second-pass input, actual owner/store
reopen, partial PUT, another reopen and a completed PUT whose reply is lost converge on the same
sealed generation/hash/bytes and original registration/Item proofs. One source401 uses the real
Session-renewal response and subsequent unchanged source requests carry that token. Both complete
destination plaintext and fixed User/Vault context are verified. No production correction was needed
for these remaining adapter cases. All targeted Attachment acceptance and independent reviews now
pass; normal production bindings and both literal complete-ticket CI gates remain required.

2026-09-14 the two-file/different-Server/shared-Member history passes1/1 in128.26seconds
(`/tmp/bittery90-two-file-shared-cross-server-first.log`). Independent SRP Users and real RSA Member
Vault-key wrapping participate. Actual owner loss occurs with file1 acknowledged/Encrypted and
file2 physically Finalized while its separate checkpoint is still Pending. The real reopened full
sweep preserves both exact generations and complete ciphertext; normal recovery then finishes
without another source pass. Both actual registration requests and the three retained Item outcomes
match the original five-child workflow. Both destination plaintexts decrypt under the destination
User/Vault context, and the source disappears only after those proofs. Independent storage/lifecycle/
recovery review also finds no remaining integration defect or useful additional owner abstraction.
The final interrupted-stream history and complete-ticket gates still precede resolution.

2026-09-14 the unchanged actual Web shutdown reproduction now passes1/1 with12 assertions in5.96seconds
(`/tmp/bittery90-sweep-close-chromium-green.log`). Core drains before Attachment resources close,
preserving the Account lease until the already-invoked deletion settles. The existing feature bridge
passes its reentrant lifecycle/lease/transfer history1/1; actual configured Upload, Download retirement/
open-failure cleanup and held-response binary cancellation also pass6/6 with29 assertions
(`/tmp/bittery90-web-close-reentrant-compatibility.log` and
`/tmp/bittery90-web-close-chromium-compatibility.log`). The regression is registered in the normal
Chromium gate. Independent review found no further production change needed at this boundary.

All three current-file authority histories pass in182.21seconds
(`/tmp/bittery90-attachment-authority-edits-first.log`). A removed source file and missing/edited
already-acknowledged target files each preserve every accepted request/proof and physical artifact,
block before source Trash, and remain unscheduled without reupload or compensating deletion. All14
dependent TypeScript tasks pass. Final bounded spec/production review finds no Attachment driver,
guard, proof, Resume or transition defect and no useful further abstraction. The interrupted-stream
pair and two-file/different-Server/shared-Member restart history are being executed; complete-ticket
CI remains required after those results.

2026-09-14 all eight actual IndexedDB/WASM recovery histories pass with112 assertions in184.34seconds
(`/tmp/bittery90-artifact-recovery-chromium-eight-green.log`). They cover immutable healthy recovery,
corrupt published bytes, absent/incomplete scopes, full-sweep Pending preservation and eventual
cleanup, valid older publication during incomplete redo, duplicate/missing current mappings,
incomplete publication mapping and extra physical chunks. Native bindings regenerate successfully,
and all52 generator tests pass. Production crypto WASM remains unchanged.

A separate two-page Chromium test reproduces early Account lease release during Web close while an
already-invoked orphan deletion remains pending (1failure,3.91seconds,
`/tmp/bittery90-sweep-close-chromium-red.log`). Both deletion and shutdown drain before the assertion;
this establishes lease ordering and makes no accepted-data-loss claim. The focused spec records the
independently reviewed ordering-only correction. Its fresh hosted verification remains pending.

2026-09-14 actual native-process/real-Server Attachment acceptance passes1/1 in2.7minutes
(`/tmp/bittery90-native-cross-account-first.log`). Two real Users and private Vaults participate.
The first process exits after the real durable grant commits and its reply is lost. A fresh process
opens both Accounts locked, preserves the original sealed generation/hash/ciphertext through public
QuickUnlock and a witnessed full sweep, renews the original claim, and completes the fixed target
registration and three retained Item outcomes. Public authenticated Download verifies complete
plaintext and metadata. The loopback object store witnesses the exact received ciphertext and all
four required upload headers; this does not claim AWS signature validation. Both fixture Users are
publicly deleted before native Account removal, and the protected local fixture is removed only
after that cleanup is proved.

Public Attachment Prepare/Resume passes1/1 in68.45seconds
(`/tmp/bittery90-attachment-explicit-resume-first.log`): target Remove/re-add preserves the source
artifact, Prepare sends only current reads, and explicit confirmation enriches the original
registration with VerifiedPresent in one guarded source revision, without retranscryption or a new
grant, PUT or registration effect. Both source/target Lock-after-PUT histories pass2/2 in135.67seconds
(`/tmp/bittery90-attachment-lock-after-put-first.log`); the already-finished physical PUT is retained
while its local reply is abandoned, and QuickUnlock completes the original fixed requests. The new
generated shared Attachment history also passes IndexedDB conformance2/2 with22,118 assertions
(`/tmp/bittery90-attachment-indexeddb-conformance-first.log`). Remaining interrupted stream/file-set/
multifile composition histories, hosted recovery, independent closure review and full CI still gate
ticket completion.

2026-09-14 the valid-ciphertext/inconsistent-declared-size reproduction now passes1/1 in59.92seconds
(`/tmp/bittery90-attachment-size-consistency-green.log`): the canonical envelope size and complete
artifact digest are checked before any destination grant. This checks envelope-size consistency;
it does not claim to prove the precise decoded plaintext length from base64 size alone. Both idle
completion cleanup histories pass2/2 in116.21seconds
(`/tmp/bittery90-attachment-completed-cleanup-green.log`), including a physically committed terminal
checkpoint whose reply is lost while the cache retains the earlier stage. The existing lifecycle
reclaims from an uncached durable inventory after its sweep marker is invalidated under the existing
lease and Account locks. The original nonempty path still passes1/1 in54.95seconds.

Renewable source/grant/registration refusal and capped-deadline recovery pass1/1 in68.49seconds
(`/tmp/bittery90-attachment-refusal-matrix-first.log`). Permanent grant/registration conflicts and
both actual committed-registration reply-loss histories pass4/4 in226.46seconds
(`/tmp/bittery90-attachment-conflict-evidence-first.log`), preserving the original intent and sealed
bytes and never interpreting an unavailable current read as absence. The actual SQLite recovery
inventory history also passes, retaining Pending, Encrypted, Retired and Rejected source-owned
Attachment requirements until Completed. Public file-bearing Resume and post-PUT Lock variants are
being verified separately.

Actual Chromium reproduced additional absent/incomplete recovery, contradictory current mapping,
extra physical chunk and completed-sweep cleanup defects. Their reviewed corrections preserve the
existing primitive owners; all25 IndexedDB artifact compatibility tests pass with156 assertions.
The artifact-control, public Runtime and shared Replica conformance generators pass. Fresh feature
WASM and all eight hosted histories remain in progress. The concrete native-process/real-Server
acceptance harness passes Web type checking and Desktop compilation but has not yet executed.
These results do not complete the Attachment phase or ticket.

2026-09-14 both lease-boundary regressions and both actual Runtime owner-loss/reopen histories pass
4/4 in73.09seconds (`/tmp/bittery90-attachment-lease-and-restart-ninth.log`). Lease loss during the
last read prevents Commit admission; an issued Commit drains without late cache/projection adoption.
A committed encrypted checkpoint and a physically published file whose separate checkpoint was lost
both survive the real full Account sweep with identical generation, hash and ciphertext, then finish
the original Move without retranscryption. The common inventory includes ordinary preparation and
embedded recovery, plus every non-Completed source-owned cross-Account Attachment scope; selective
cleanup keeps source Account/Vault identity explicit. Independent review covers the inventory and
commit boundary. The post-commit check recognizes the exact returned source revision while retaining
the original incarnation, lock epoch and destination scope.

Existing artifact35, bounded recovery13, scheduler19, lifecycle15, preparation10 and cross-Account
serialized conformance7 tests pass (99total; `/tmp/bittery90-shared-artifact-inventory-regressions.log`,
`/tmp/bittery90-shared-inventory-lifecycle-compatibility.log`, and
`/tmp/bittery90-shared-inventory-preparation-conformance.log`). Web/Runtime type checking passes all11
tasks (`/tmp/bittery90-native-cross-account-web-types-first.log`). Actual Chromium variants, durable
refusal/evidence cases, idle completion cleanup, native-process/Server execution and full-ticket
checks remain open. No complete-ticket acceptance is claimed.

2026-09-14 the first complete public nonempty Core Move passes1/1 in58.38seconds
(`/tmp/bittery90-nonempty-execution-first.log`). Both actual SRP Users participate;524,317 source
bytes pass through shared scan/transcryption, a reopened SQLite artifact matches the exact upload,
fixed registration evidence precedes source Trash/Delete, and destination metadata and plaintext
decrypt under the new file key and destination User context. The old User context is rejected. This
uses the Core Server fixture; actual native-process/Server acceptance is still unexecuted.

Read-only SQLite recovery now passes all3 published-corruption, absence/incomplete, and contradictory
current-mapping histories in1.69seconds (`/tmp/bittery90-recover-mapping-green.log`). Actual
IndexedDB/WASM independently reproduces published ciphertext corruption being accepted
(`/tmp/bittery90-artifact-recovery-chromium-red.log`); its correction awaits a fresh feature build.
Real Runtime owner loss after the first committed grant reply is lost reproduces startup sweep
deleting the accepted encrypted artifact (1failure,69.40seconds,
`/tmp/bittery90-attachment-restart-inventory-red.log`). A separate actual published Pending history
is being verified before the common live/pending inventory change. Lease loss during the final
Replica read also reproduces a wrongly admitted commit; issued-commit draining/cache checks and
their implementation remain underway. These results do not close the Attachment phase or ticket.

2026-09-14 the first public nonempty admission is GREEN1/1 in51.68seconds
(`/tmp/bittery90-nonempty-admission-green.log`), retaining source Pending and fixed target metadata
without opening any grant or binary capability. Tagged workflow validation passes all7 current
serialized SQLite cases, including forbidden Attachment transitions and exact Resume enrichment
(`/tmp/bittery90-tagged-move-conformance-regression.log`); the shared Upload comparator passes its3
actual streaming/ambiguous/definite-failure regressions. The published-corruption SQLite regression
now passes. Absence/incomplete recovery separately reproduces both scopes returning invariant errors
instead of the new closed unavailable result; that correction and actual WASM recovery remain pending.
Independent review found the new driver must extend its lease-loss watch through the final Replica
commit. A held-commit regression is being prepared before correcting that race. Actual nonempty
transfer/restart and the remaining ticket gates are still open.

2026-09-14 the first nonempty Attachment test reaches its intended public admission refusal after
both real SRP Sign-ins and successful source file metadata decryption (1 failing test, 51.68 seconds,
`/tmp/bittery90-nonempty-admission-red.log`). A separate actual SQLite history proves a fully committed
state2 publication survives healthy read-only recovery unchanged, then reproduces Recover accepting
one changed ciphertext byte while its stored seal remains intact (1 failing test, 1.30 seconds,
`/tmp/bittery90-recover-integrity-red.log`). These are the recorded behavioral REDs for the first path.
The shared scanner/transcryptor extraction preserves ordinary behavior: preparation10, scheduler19
and lifecycle15 tests all pass (`/tmp/bittery90-transcryption-*-compatibility.log`). Fixed admission
metadata, tagged registration evidence, guarded transitions, read-only integrity correction and
actual IndexedDB/WASM regression are now being implemented and require their coordinated GREEN runs.

2026-09-14 the no-file phase is complete after independent review/simplification, all targeted
histories, and both literal full CI commands. Rust CI passes
(`/tmp/bittery90-nofile-check-ci-rust-first.log`): Server checks, 152 crypto tests and 11 vectors,
1,119 Core tests in 840.72 seconds, 56 binding tests, artifact/conformance/Server-contract integration
checks, generator and native/Web binding comparisons, production Web smoke checks, and 60 Desktop
tests. Host CI passed sequentially as recorded below. The real Git index was not used for generated
comparison staging.

The first Attachment path now starts test-first: public nonempty-file admission/transfer and actual
committed-Finalize/separate-checkpoint-loss recovery. The focused spec records independent refinements
for fixed checkpoint metadata, shared live/pending inventory, read-only artifact validation and
explicit Resume evidence, using existing primitive ports and owners. This is a phase transition,
not ticket acceptance; nonempty orchestration, wider failure histories and actual Server acceptance
remain required.

2026-09-14 the literal no-file `pnpm check:ci` gate passes
(`/tmp/bittery90-nofile-check-ci-first.log`), including 484 Runtime host tests, the repository script
checks, all 38 joined Chromium cases with 574 assertions, and the actual Web Import hook's 70
assertions. The literal Rust gate is running sequentially against the same stable source with a
disposable Git index for its generated-file comparison. Attachment implementation remains gated on
that result; this does not close the ticket.

2026-09-14 same-Server, distinct-User Move passes 1/1 in 54.50 seconds
(`/tmp/bittery90-same-server-distinct-users-first.log`). Two real SRP Sessions share one canonical
Server while owning distinct private Vaults and keys. Target ciphertext uses the destination User's
AAD, and every durable Create/Trash/Delete child matches its actual wire request, original identity,
fingerprint and retained Applied result. Independent review corrected a test-only route filter and
strengthened those proof assertions; no production change was needed. All remaining no-file targeted
histories now pass. The source is stable for both literal full CI commands; the no-file phase and
Attachment implementation remain gated on their results.

2026-09-14 both Native participant Vault-retirement histories pass 2/2 in 102.44 seconds
(`/tmp/bittery90-native-participant-vaults-final.log`). Source retirement erases the selected durable
authority, overlay, public Items and Session keys while preserving the exact accepted workflow;
target retirement preserves the visible source work. Both histories keep both Accounts unlocked,
preserve the unaffected participant's complete durable snapshot including its head, and permit no
late-response replay or compensating deletion. Independent review found no production defect.

2026-09-14 wrong-User Resume passes 1/1 in 180.77 seconds
(`/tmp/bittery90-resume-wrong-user-first.log`): a real independently signed-in User with current
shared-Vault membership on the original canonical Server is refused before HTTP, preserving both
durable Accounts and the original workflow. Lost retirement-marker acknowledgement passes 1/1 in
74.87 seconds (`/tmp/bittery90-marker-lost-ack-first.log`): the actual persisted marker survives owner
loss, and reopening retires both original source bindings before Ready without duplicate writes.

Native target-Vault retirement passes 1/1 in 52.83 seconds
(`/tmp/bittery90-native-target-vault-third.log`). Both participating Sessions contain real Vault keys
before the hide. An independently signed-in Desktop publishes verified policy to the Extension's
independent Sessions; the incoming hide drains the held Move, removes selected Vault authority and
keys, and preserves the source workflow while both Accounts remain unlocked. The source-Vault
counterpart and same-Server distinct-User success case were saved for their coordinated test runs;
the Native pair's result is recorded above. The remaining no-file checks still precede Attachment
implementation.

2026-09-14 startup inventory failure passes1/1 in74.08seconds
(`/tmp/bittery90-startup-unreadable-source-first.log`): after the first source retirement commits,
the second source's uncached inventory read fails; public startup exposes neither observations nor
Account commands. Retry preserves the first revision and retires the second binding exactly once.
Wrong-Server Resume passes1/1 in73.63seconds (`/tmp/bittery90-resume-wrong-server-first.log`): an unlocked,
writable candidate with the same User ID on a different canonical Server is refused before HTTP and
both source workflows stay unchanged. The refined real shared-Member source-trash refusal also
passes1/1 in78.11seconds (`/tmp/bittery90-source-trash-member-refusal-first.log`).

Fresh production Web bindings pass11 smoke checks with the intentional harness-only skip
(`/tmp/bittery90-nofile-web-smoke.log`), and all14 dependent TypeScript tasks pass
(`/tmp/bittery90-nofile-dependent-types.log`). These checks do not replace the remaining no-file full
CI gate. Native Vault-retirement acceptance initially needed an explicitly configured test Server
that accepts both Desktop and Extension client headers; its first failure occurred before Move
admission in the Desktop-only test fixture. The subsequent successful history is recorded above.

2026-09-14 the four-case source-retirement matrix passes4/4 in156.19seconds
(`/tmp/bittery90-fanout-commit-matrix-first.log`): failure before source1/source2 and lost acknowledgement
after each actual SQLite commit preserve exactly0/1/1/2 retired bindings, respectively. Actual owner
loss and public reopen finish only the outstanding retirements; public Remove then consumes the
marker without rewriting either source again. Target Lock during active create recovery also passes
1/1 in51.17seconds (`/tmp/bittery90-target-lock-inflight-first.log`), preserving source rows and replaying
the original create after public QuickUnlock. Source refusal and edit histories pass2/2 in86.81seconds
(`/tmp/bittery90-source-refusal-edit-first.log`); the refusal fixture is now being tightened to a real
RSA Member whose Server role changes after admission. The public protocol was regenerated, its14
generator checks and affected Runtime TypeScript check pass, and native bindings include the derived
availability reason. Remaining no-file histories/full checks and the Attachment path are still open.

2026-09-14 the actual lost target-create refusal exposed a durable validation defect: the common
rejection helper omitted Create Item's closed rejection set, so exact retries stayed Pending instead
of retaining the Server's refusal. The unchanged diagnostic reproduces11 exact retries with no stored
child result (`/tmp/bittery90-target-rejection-diagnostic.log`). The helper now owns the same four-code
set previously embedded in ordinary receipt validation. Public lost-response recovery passes1/1 in
86.89seconds (`/tmp/bittery90-target-rejection-green.log`); direct serialized SQLite rejects three
other-operation codes without changing its head or rows, then preserves the valid rejection across
recovery/reopen (1/1, `/tmp/bittery90-target-rejection-sqlite-green.log`).

Source Lock during an actual committed, held trash response passes1/1 in50.57seconds
(`/tmp/bittery90-source-lock-inflight-first.log`): prompt cancellation/drain, no late proof or permanent
delete, then exact original trash replay and both destructive proofs after public QuickUnlock. The
first two-source fanout history passes1/1 in69.17seconds
(`/tmp/bittery90-fanout-second-source-first.log`): a second source write failure preserves the first
retirement and catalog marker; actual owner/SQLite loss followed by public open retires the remaining
binding before Ready without repeating the first write. Public Remove retry finishes the marked
lifecycle. Refused old Operations delivery also passes1/1 in43.35seconds
(`/tmp/bittery90-subscriber-refused-first.log`), retaining the newer availability's deduplication state.
Independent reviews find no new no-file driver/Resume or delivery-ordering defect. Remaining explicit
identity, Vault-fence and failure histories still precede the no-file full-check gate.

2026-09-14 no-file availability and startup recovery now pass their concrete reproductions. The
existing source Operations subscriber receives destination Lock/Unlock and incoming ReadOnly/Member
changes without changing source rows or its public Replica revision. Delivery ordering uses the
existing Device revision alongside the projection revision; a delayed older capture cannot replace
newer availability (1/1,35.81seconds, `/tmp/bittery90-subscriber-delayed-first.log`). Current scope
refusal derives `AccessUnavailable`; explicit Resume still passes without changing accepted bytes.

Startup now scans surviving source Replicas for absent or replaced destination incarnations and
durably retires those original bindings before Ready, including restored catalogs with no surviving
retirement marker. Actual SQLite reopen proves absence recovery and second-open idempotence
(1/1,47.20seconds, `/tmp/bittery90-startup-absent-green.log`), and an earlier source image paired with a
valid replacement destination retires without retargeting (1/1,63.35seconds,
`/tmp/bittery90-startup-replacement-first.log`). Startup15/15, teardown20/20, Vault visibility5/5 and
Export6/6 compatibility checks pass. Failed retirement-marker persistence preserves both Replicas
and reports unavailable through fresh and retained source observations; public Remove retry then
retires the original binding (1/1,39.63seconds, `/tmp/bittery90-marker-failure-projection-first.log`).
Partial fanout, in-flight lifecycle histories, remaining no-file review/checks and the full Attachment
path remain open. These results do not close the phase or ticket.

2026-09-14 prerequisite104 is resolved after actual nonempty binary acceptance, independent review
and both literal full CI gates. Continue this ticket's remaining no-file permission, Operations
subscription/availability and markerless startup-retirement histories before Attachment execution.
The focused spec now records the reviewed startup/bound-scope helpers and fresh Attachment refusal
mapping, including retryable409 and current-plan size refusal. No orchestration acceptance is
claimed by closing104.

2026-09-14 permission-fixture review confirms that Item creation has no plan/quota rejection in the
Server's closed retained-result contract. No-file permission cases must use actual `vault_read_only`
or `vault_access_denied` results; plan/quota changes belong to the Attachment grant/registration path
under104. Do not manufacture a retained Item result to represent a fresh Attachment route refusal.

The same read-only audit identifies an unfinished required startup history: without a surviving
pending-retirement marker, an Active destination binding whose catalog Account is absent or has a
different incarnation is currently parked by dispatch but not durably retired. Explicit Resume then
cannot reauthorize it. Complete the accepted startup inventory/retirement requirement through the
existing catalog and source Replica owners before claiming the no-file phase. Availability must
also reuse execution's exact destination-binding scope, not merely a writable current Account.

2026-09-14 implementation begins after all68/69/70/83/85/89 prerequisites and the preceding
Travel71 capability are resolved. The reviewed frontier remains settled; no product choice is
outstanding. The first test uses the agreed public Runtime intent/projection and serialized
HTTP/SQLite persistence seams: a different-Server no-Attachment Move must preserve its target
identity and exact accepted child bytes across a lost committed response and durable reopen,
and complete only after proven source trash and permanent deletion. Wider Attachment and
retirement/Resume variants follow that end-to-end path; this start records no acceptance.

2026-09-09: drafted after accepted research83. Existing Rust Move is same-Account; completed Web does
not implement this Desktop variant. The accepted explicit resume policy is recorded, but the four
engineering review seams above are not yet sealed. No implementation or production acceptance claimed.

Independent review selected a source-owned closed workflow with one scheduling/claim owner and
immutable Source/Destination child requests, plus revision-guarded durable destination bindings.
Existing artifact publication already supports source durable ownership with destination crypto
scope; no second backend/schema is required for that distinction. The remaining concrete frontier
is durable exact-incarnation target retirement before cross-source binding writes, covering crash
while the old target catalog entry still exists and replacement/Full sign-in as well as removal.
The focused spec records the proposed lifecycle-owner extension and crash matrix. Parent review and
exact durable mutation shape are still required; status remains needs-triage.

Parent architectural review accepted the existing DeviceCatalogAccount optional exact-incarnation
pending retirement marker with explicit Remove/Replace purpose, omitted when absent. It precedes
cross-source fanout and replacement staging; contradictory pending install is rejected, source-store
failures remain visible/incomplete, and startup drains it before normal dispatch/installation/reuse.
The spec records validation/ordering. The public confirmation shape and concrete workflow schema still
need final review; implementation remains blocked by the listed incomplete capabilities.

Parent review accepted optional destination Account on existing Move, stateless PrepareResume guard
and explicit Resume. The source Replica revision fences child advances without a second workflow
counter; binding revision and both current Account incarnations/lock epochs fence reauthorization.
The spec now fixes the closed workflow row, stages, child request transitions and plan mutations.
Final independent read remains before readiness; no source implementation has begun.

Final retirement-order refinement accepted by parent: Remove marker remains through cleanup until
catalog removal consumes it; Replace is atomically consumed into pending_install by staging after
fanout. Clearing the marker separately after fanout would lose intent on crash and is forbidden.
The final independent review includes this boundary; no new state owner or product question.

Final independent review accepted the concrete workflow/artifact/retirement contract and found one
confirmation gap across actual owner loss with unchanged durable epochs. The stateless guard now
includes the existing random Core owner incarnation, never an address or process-local counter.
Parent approved the correction and abrupt-loss regression. Contract review is complete; ready-for-agent
with incomplete prerequisites still blocking implementation. This status does not claim capability
or product acceptance, and no production workflow source has been changed.

2026-09-14 first no-Attachment vertical path passes through the public Runtime, two independently
routed Server fixtures with distinct Vault keys, and actual SQLite close/reopen. The initial RED
was the missing `targetAccountId` intent after both public Sign-ins and readable source authority
(`/tmp/bittery-cross-account-move-first-red.log`). The first GREEN passes1/1 in55.28seconds
(`/tmp/bittery-cross90-first-green-attempt.log`): offline atomic source/workflow admission, fixed
target ID/ciphertext, lost committed create response, exact fingerprint-proving replay with one
target effect, and held trash/permanent-delete results that prevent premature completion. The
destination ciphertext decrypts under its distinct target Vault key with preserved Login data.
These controlled Server fixtures do not substitute for the required real Server acceptance.

Independent first-path review found and corrected loss of an already-proven source-delete result
when a subsequent current-authority read failed. The result now has its own durable checkpoint before
that read. The corrected baseline passes 1/1 in 59.11 seconds
(`/tmp/bittery-cross90-delete-proof-baseline.log`); temporarily removing only that checkpoint reproduces
the intended missing-durable-proof failure in 43.42 seconds
(`/tmp/bittery-cross90-delete-proof-mutant-red.log`). The checkpoint is restored and the joined build
is being verified. The source Item remains Pending until completion. A public target Lock regression
also reproduces the misleading Ready projection; its derived AccountLocked fix is awaiting that build.

The source-owned closed row is separate from ordinary Operations. SQLite uses new store ID10 without
rewriting0–9; IndexedDB uses an additive version9 migration preserving version8 data and rollback.
Migration11/11, adapter26/26 and package types pass. A serialized SQLite child-immutability/refusal
history passes. Its 21-step shared history passes IndexedDB conformance 2/2 with 18,530 assertions; all 11
earlier histories remain byte-for-byte unchanged. Destination retirement/Resume, broader
failures and permissions, Attachments, actual Server acceptance, generated contracts, independent
closure review and both literal full CI commands remain outstanding; this ticket is not accepted.

2026-09-14 the restored joined binary passes the original lost-create/reopen history and the
source-delete proof regression (1/1 each, 61.12 and 61.93 seconds). The public target Lock regression
passes 1/1 in 52.67 seconds: Waiting while locked, then normal availability after QuickUnlock, with
the exact accepted workflow unchanged. An old retained target-create outcome plus a now-missing
target also passes 1/1 in 42.83 seconds: TargetChanged, no target recreation, no source deletion.

Destination Remove passes 1/1 in 50.88 seconds with exact source-row preservation apart from retired
binding/disposition. Same-identity re-addition stays parked. A failed source retirement commit first
reproduced fresh SQLite open exposing an Active binding; the startup fix passes 1/1 in 42.27 seconds:
retire before ready, preserve the catalog marker, refuse target QuickUnlock, and consume the marker
only when public Remove finishes. Existing startup 15/15, teardown 20/20, and catalog validation 2/2
pass. Full Sign-in replacement and wider crash/fanout cases remain outstanding.

Public Prepare/Resume initially failed on the absent request variant after successful Remove and
same-identity Sign-in. The first implementation passes 1/1 in 52.34 seconds
(`/tmp/bittery-cross90-explicit-resume-green.log`): preparation leaves exact SQLite rows unchanged,
explicit confirmation rebinds only the original destination binding/disposition, and the existing
dispatcher finishes the same Move. The guard includes both scopes, source Replica revision, binding
revision and the existing random Core owner incarnation. Lock/unlock and actual-owner-loss guard
regressions are being verified; this first path does not accept the remaining Resume variants.

Attachment investigation found an additional Server prerequisite: the ordinary grant allocates a
fresh file ID and expiring storage key on every request, so it cannot renew a sealed cross-Account
artifact's accepted identity after expiry/cleanup. [Research 103](103-durable-attachment-upload-renewal.md)
records the bounded existing-reservation extension, now accepted after parent and independent
review. [Delivery 104](104-durable-attachment-upload-renewal.md) is the newly discovered prerequisite
for the Attachment path; the already-started no-file implementation continues its verification.
No Server capability or Attachment acceptance is claimed until implementation and actual nonempty
transfer pass.

2026-09-14 no-file verification now passes all five Item categories and private-to-RSA shared Member
destination authority (1/1,106.75seconds). Public source-delete rejection retains every proved child
and the original source overlay. Fresh public Sync now releases that rejected overlay for a new
Restore only after current source authority covers every proved source version (1/1,41.65seconds,
`/tmp/bittery-cross90-sync-reconciliation-final-green.log`). Strict serialized SQLite tests refuse
active-overlay removal, older/missing authority and rewritten child proofs; the matching Attachment
authority path also persists its overlay deletion atomically instead of changing only cached state.

Explicit Resume passes stale target lock/unlock, source revision change, actual Runtime owner loss,
edited target and lost-create proof histories. Preparation sends no mutation; confirmation alone may
replay an already-decided original child to prove it. Full Sign-in replacement retires the original
binding, and actual owner loss after pending installation restores the Replace marker before old
QuickUnlock can reopen authority (1/1,58.28seconds). Remove after failed replacement, failed-lifecycle
publication and writable destination filtering have concrete reproductions and are being verified.
Remaining no-file permission/fanout variants, the104 prerequisite, Attachments, actual Move Server
acceptance and complete-ticket checks still prevent90 resolution.

2026-09-14 the mirrored RSA Member-to-private path also passes; the joined shared/private namespace
passes 2/2 in 124.93 seconds (`/tmp/bittery-cross90-private-shared-both-directions.log`). Both directions
verify the full decrypted payload, current physical Vault roles, fixed target identity, all three
Applied child proofs and actual source destruction.

Remove now supersedes a failed Replace only for the same pending incarnation; its public regression
passes 1/1 in 51.11 seconds (`/tmp/bittery-cross90-remove-supersedes-green.log`). Failed replacement
publishes retired source Operations and excludes the gated destination from writable choices; the
rollback/reopen/verified-retry history passes 1/1 in 58.22 seconds
(`/tmp/bittery-cross90-failed-replacement-projections-green.log`). Existing teardown passes 20/20.

Independent review identified a separate availability issue: an existing Operations subscriber can
deduplicate a destination-only change because the source Replica revision is unchanged. It also found
that fresh projection must use the execution scope check for current Vault and pending lifecycle
availability. The focused spec records the independently reviewed bounded access projection; the
subscriber ordering refinement and public reproductions are next. No-file permission/fanout cases,
Attachments and complete-ticket acceptance remain open.

The accumulated Runtime dispatcher crossed the default test stack limit for public
`QuickUnlockAccounts` during104's full Rust gate. The unchanged isolated test reproduces the abort
(`/tmp/bittery104-multi-unlock-stack-repro.log`); the dispatcher polling frame was about584KiB and
batch orchestration nested it twice. Batch routing now occurs in the existing outer request owner,
while each selected Account still uses the same scoped QuickUnlock command. The public regression
passes1/1 in18.93seconds (`/tmp/bittery104-multi-unlock-stack-green.log`), captured-scope replacement
refusal passes1/1, and acceptance/cancellation passes1/1 in27.28seconds. No new task, authentication
owner, larger test stack or runner exemption was added. Fresh full checks remain required.
