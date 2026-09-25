# Runtime Vault update and deletion

Type: task
Status: resolved
Blocked by: 63, 69, 86, 87, 89
Spec: ../desktop-extension/vault-travel.md#closed-runtime-commands

## Contract

Extend Core and Server retained outcomes for existing Desktop Vault name/icon/image changes and deletion. Reuse Vault-image ingress and guarded Replica authority rather than retaining TypeScript VaultService writes. Inventory Web/Mobile callers before shared cleanup; no Desktop conversion editor is added solely for migration.

## Acceptance

Durable acceptance, lost response/retry, delete racing accepted Item work, image cleanup, empty Vaults and incoming shared/personal conversion converge through authority. Preserve key/role/Account boundaries. Specify immutable request, outcome, rejection and purge contracts before marking ready.

## Comments

2026-09-08: dependency-ordered delivery scope recorded. No implementation or acceptance is claimed.

2026-09-08: actual Server/shared/Desktop caller research resolves the Vault frontier. The linked
contract defines retained update/delete outcomes, exact metadata patch semantics, shared staged
image preparation, current-authority reconciliation and accepted-work preservation after deletion.
Legacy Web/Mobile endpoints share one effect implementation until their callers migrate. Ready
after native foundation and image/file capability prerequisites complete; no acceptance
is inferred from the specification.

2026-09-09: prerequisites 63/69 are resolved. Implementation starts at the existing Core
request/projection/Replica and Server HTTP/transaction seams: no-image rename is accepted offline,
retains exact request bytes, leaves unconfirmed metadata unchanged, then reconciles the retained
Server outcome and current authority. Bounded Server work runs in parallel with Core implementation;
both retained and legacy routes must share one transaction effect. Variants widen after this path.

2026-09-09 cleanup frontier: read-only inspection found the existing Vault-image cleanup runner
can represent only real staging objects, while published legacy images lack the mandatory staging
metadata. Resolve superseded-object durability with a genuine small outbox drained by that existing
owner, atomically enqueued by the shared legacy/retained effect. The specification records exact
object-key fencing, current-reference/staging rechecks and legacy adoption proof to avoid deleting a
newly referenced image. This is a routine implementation of the accepted cleanup contract; no new
host policy, fake staging records or competing job is introduced. Independent review will exercise
failed deletion, reattachment and outcome replay.

2026-09-09 first vertical evidence: actual native Core/SQLite/keychain and Server acceptance passed
one four-process scenario (3.6 minutes), including offline durable rename, unchanged authority until
reconnect, then the current renamed Vault projection. The same run exercised Attachment and encrypted
recovery/restart paths from ticket 69. This is native capability evidence, not Desktop UI acceptance;
image/delete variants and the remaining ticket gates are still in progress.

2026-09-09 Server capability evidence: retained metadata/deletion routes now share
[catalog mutation effects](../../../apps/server/src/domains/vaults/catalog/mutations.rs) with legacy
PATCH/DELETE. Current User/Team/Vault/member authority is locked and re-read; omitted fields come
from that locked row. Both new kinds have generated closed outcomes, immutable raw-byte fingerprints,
User-scoped replay and database shape constraints. Applied deletion lookup survives removal of its
Vault/membership rows. A no-field patch emits no meaningless catalog mutation; an explicitly submitted
unchanged name retains the existing commit-order behavior. Creation and replacement share the same
verified staging publication helper and persisted image binding format.

[Published-image cleanup](../../../apps/server/src/domains/vaults/vault_image_cleanup.rs) now records
real durable duties in a separate outbox, drained by the existing Vault-image runner. Exact sorted
object locks fence adoption and deletion; current catalog/staging references protect live objects,
new references require existing objects, and a resolved image Operation cannot recreate staging.
Storage failure and database failure after physical deletion retain the duty. Independent review
found starvation behind a failed 100-object batch; an actual 101-object regression reproduced it,
then passed after attempt ordering was persisted outside the failed deletion transaction. No new
runner, host retry policy or synthetic staging record was added.

Test-first evidence includes rename 404 then real PostgreSQL success; delete 404 then retained replay
after row removal; empty patch four instead of three catalog events then correct no-op behavior;
image replacement refusal before metadata accepted staged image fields, then verified publication/removal;
failed superseded deletion lost by the old worker then durable retry; and failed-batch starvation
then fair progress. Fifteen new database tests cover these boundaries, concurrent exact replay,
semantically equal but different raw JSON refusal, current-role demotion while waiting, Account/User
isolation, closed payload constraints, prior Item outcomes after deletion, later Item denial,
physical deletion versus legacy reattachment, staged-object ownership transfer and database finish
failure after successful object deletion. Object storage is an explicit recording capability fixture
in these tests; they do not claim actual S3 networking or OS dialog acceptance.

Final targeted evidence: `DATABASE_URL=... cargo test --manifest-path apps/server/Cargo.toml --lib
domains::vaults` passed 184 tests; OpenAPI tests passed nine; all-target Server Clippy passed with
`-D warnings`; `pnpm exec turbo -F '...@bittery/api-contract' check-types` passed all 14 packages;
OpenAPI/TypeScript contracts and global/local route counts were updated; `pnpm check:server`,
`write-openapi --check` and generated TypeScript verification passed. One preceding broad run passed 183 tests and failed the existing create-Vault
lock-wait observer; two isolated checks and the final full Vault rerun passed without changes to that
observer or production authority. Its intermittent cause is unconfirmed, not recorded as fixed.
Independent effect/constraint and final cleanup/race/simplification reviews found no remaining Server
blocker. Full root CI, Core image/delete convergence and later real Desktop UI gates remain required;
this evidence does not resolve the whole ticket.


2026-09-09 retained-Item/current-absence frontier: inspection found applied Create retries forever
on authoritative Item404, while applied ordinary mutations (except permanent deletion) fail the
Account. This contradicts the real Server case already tested here: an earlier retained Item result
survives later Vault deletion. The specification now separates exact terminal action evidence from
current Item absence. Reuse the guarded Item completion mutation for all seven applied Item kinds,
retaining the original receipt and removing only its own Item authority/overlay/Operation; do not
infer Vault deletion, synthesize rejection or purge keys. Existing Attachment Move artifact sweep
ownership remains after atomic completion, with all required bytes preserved if completion fails.
Core implementation begins with reproducing Runtime and domain tests; no acceptance is yet claimed.

2026-09-09 Core progression: source-image replacement now shares create-Vault source preparation,
guarded acceptance, staging checkpoints, immutable-request freezing and receipt cleanup. Existing
serialized create records remain unchanged; replacement adds an optional boxed intent using the same
artifact/image representation and object-key spelling. The first replacement test failed on missing
capability, then passed actual ingress/durable checkpoint/retry/final request/receipt checks. A fault
in source acceptance release reproduced a missing update-dispatch handshake; extracting the existing
create release gate fixed it. Five mutation tests and 59 existing create-Vault regressions passed at
this point. Subsequent Delete/RSA-member changes still need their accumulated checks.

The quiet-SSE retained-outcome case reproduced RefreshRequired starvation without a new Server hint.
The existing Sync loop now consumes that local wake while preserving the same pending stream read;
22 live Sync tests and targeted Clippy passed. Root independent review found no new Sync owner,
unrelated metadata fetch or stream-reissue path.

Real native image progression: a selected native PNG passed shared ingress, actual Server staging,
public exact-byte retrieval after source-caller release, and image/icon removal twice. The combined
four-process acceptance run is not yet green: its old Move preparation count could satisfy the
"failed final dispatch" condition without a final Move POST. An exact proxy-observed Operation-ID
marker replaces that inference. Its first rerun exposed a fixture path mismatch between the native
Runtime temporary directory and the proxy directory; the marker is now supplied as an explicit
fixture capability. Full combined acceptance must rerun before closure; these partial results are
not production Desktop UI acceptance.

Offline DeleteVault acceptance first failed at the missing Runtime path and now retains exact
empty-JSON POST intent while preserving current readable authority. Shared pending-deletion
admission, confirmed all-generation/key/capability purge, durable purge progress and real deletion
convergence remain in progress. The command is not wired into production Desktop yet.

2026-09-09 combined native acceptance now passed after fixing the explicit proxy marker path:
`BITTERY_NATIVE_FOUNDATION=1 pnpm --filter web exec playwright test runtime-native-foundation.spec.ts --project=cloud --workers=1`
passed one scenario in 3.3 minutes (`/tmp/bittery-native-vault-image-acceptance-final.log`). This joined
real native Core/SQLite/Linux keychain, offline rename, native file/S3 image replacement and exact
public-byte verification after caller release, image/icon removal, Attachments, an actually blocked
final Move POST identified by its Operation ID, encrypted recovery and four-process convergence.
The proxy's evidence and native Runtime use different temporary directories, so the observer path
is an explicit fixture capability. Dependent Web type checks passed 11 tasks; changed TypeScript
Biome and `git diff --check` passed. This closes the previous combined-fixture failure; no OS image
picker or Desktop renderer acceptance is inferred.

Independent image review found no blocker in staging/immutable fingerprints, reconstruction,
receipt cleanup, final dispatch or source release. Its suggested reduction was applied: the shared
Vault acceptance helper derives image ownership from the closed Operation record rather than a
redundant caller Boolean. Pending-deletion admission's first public CreateItem test reproduced an
unwanted accepted write; the shared Replica predicate now guards Item source/Move target, Import
including empty batches, CreateShare, metadata updates and initial Attachment mutations. Seven
Vault mutation tests passed after that change. Confirmed deletion purge and broader guard variants
remain open, so ticket 70 remains unresolved.

2026-09-09 retained-Item/current-absence implementation evidence: the initial Runtime tests
reproduced Create remaining pending and ordinary applied Update failing the Account after a real
fixture action was retained and its Item disappeared. The promoted Attachment Move domain test
separately reproduced refusal to complete with absent authority. All seven applied Item kinds now
reuse the guarded Item completion mutation for authenticated Item404, preserving the original
receipt while removing only that Item's current authority and this Operation/overlay. Present
ciphertext and permanent-deletion contradiction validation remain intact. Failed completion preserves
Move artifact ownership; successful completion makes it eligible for the existing physical sweep.

Review also found two historical Create lookup shortcuts: dispatch and Sync trusted a hint without
proving its immutable request fingerprint. Two reproducing tests showed different request bytes
could complete when the Item was absent. Both paths now use the existing exact replay/auth/backoff
mechanism; Sync cannot advance past a hint before that replay is due. Updated older tests explicitly
assert the replay request and one semantic Item effect. The final outcome suite passed 58 tests,
the focused Move artifact ownership regression passed, and all-target Core Clippy passed with
`-D warnings`. These are Core transport/persistence fixture and domain tests, not real application
acceptance. The earlier Server PostgreSQL regression independently proves a retained Item result
survives Vault deletion. Combined native deletion/accepted-work acceptance and full CI remain open.

The final dispatch regression suite passed 27 tests. Its restart/backoff fixture previously reloaded
without live keys, then spun through valid locked retries using an immediately advancing test timer;
it now unlocks the restarted test owner before checking scheduling. The separate locked-result tests
continue to require retained work until unlock. Independent review of identity proof, absence scope,
present authority validation, cursor/backoff and artifact lifetime found no remaining blocker or
further useful simplification in this bounded change. `git diff --check` passed.

2026-09-09 dependency refinement: remaining selective capability retirement now depends on
[ticket 86](86-selective-vault-capability-retirement.md). Earlier ready implementation and evidence
above were authorized against the then-complete 63/69 foundations and remain valid. This additional
prerequisite gates the newly specified purge integration; it does not retroactively claim either
capability retirement or the whole ticket complete. Do not substitute Account-wide cancellation.

2026-09-09 binding evidence: Rust-defined Update/Delete requests and accepted responses now map through
native UniFFI types, including closed icon/image patches and redacted image-source Debug output.
`cargo check -p bittery-client-bindings` passed; public Runtime schema/TypeScript/validators were
regenerated. The focused generated-validator test passed all patch combinations and rejected mixed
variants, path/URL/token authority and numeric byte lengths. Native generated Kotlin/Swift freshness,
full checks and the remaining deletion/erasure integration remain required.

Remaining purge integration also depends on [87](87-durable-vault-authority-retirement.md), whose
resolved frontier preserves accepted category evidence after overlay erasure and journals all-store
cleanup. This refines the dependency graph while preserving the earlier authorized ready slices.

2026-09-09 pending-write guards: all nine Vault mutation tests passed
(`/tmp/bittery-vault-mutation-pending-guards.log`). The added public-request cases cover Update,
Favorite, Trash, Restore, permanent deletion, Move and Share after source Vault deletion acceptance,
and Move into a destination whose deletion is pending. Refused work makes no HTTP request or
accepted Operation; another visible Vault remains writable and source writes survive a different
Vault's pending deletion. Selective Attachment capability and confirmed-purge acceptance remain open.

2026-09-09: research88 resolved the retained-result/current-authority frontier through one existing
receipt-and-refresh transition. [Implementation89](89-retained-results-current-authority.md) now gates
remaining convergence; a proved old action must neither overwrite newer authority nor use hidden keys.

2026-09-09 remaining image failure audit: staging still converts a physical checkpoint Commit error
through generic Fatal/InvariantViolation, and an invariant returned after a held staging grant can
reach a fresh-snapshot Account failure. Ticket89 corrected terminal completion, not these preparation
paths. Before production70 acceptance, reproduce both physical checkpoint failure and stale grant/
artifact failure at their captured staging snapshot. Resolve genuine contradiction under that exact
scope and use the existing bounded retry owner for physical failure; an outer dispatch snapshot may
predate legitimate staging checkpoints and cannot substitute for the actual error origin.

2026-09-09 protected-image retirement dependency: research92 resolved the actual raw-image retention
gap with a reviewed per-artifact key/Device-key wrapper and opaque encrypted recovery mechanism.
[Delivery93](93-protected-vault-image-artifact-storage.md) gates this ticket's protected-image retirement
variant, including accepted image evidence during erasure. It does not block or alter the ready
no-image foundation; therefore it is not added as a blanket ticket70 dependency. Existing successful
image upload/replacement checks do not establish protected local retention or legacy migration.

2026-09-09 scoped image cleanup: the new helper selects only affected terminal receipt local duties
after the existing foreground/execution fence, reuses ordinary exact image deletion/receipt
acknowledgement, and preserves accepted images plus unrelated active ingress. Actual SQLite tracer
failed before implementation (`/tmp/bittery-scoped-image-cleanup-red.log`). Four focused cases now pass
(`/tmp/bittery-scoped-image-cleanup-matrix-2.log`): same-Vault accepted image/other-Vault unpublished
ingress/other Account preservation, unopened Runtime with missing capability, failed acknowledgement
and idempotent retry, and closed-owner refusal. Four existing ordinary cleanup cases also pass across
`/tmp/bittery-scoped-image-existing-cleanup-regressions.log`,
`/tmp/bittery-scoped-image-delete-retry-regression.log` and
`/tmp/bittery-scoped-image-rejected-cleanup-regression.log`. Independent scoped review passed.
This replaces live Account-wide orphan classification; exclusive startup sweep remains. These are
Core/storage capability checks, not Desktop/Extension UI or protected-image acceptance.

2026-09-09 integration begins after89 capability closure. An actual SQLite engine, using the closed
physical Commit executor and a complete controlled Bootstrap response, reproduced hidden plaintext
remaining readable while the retirement commit was held before application
(`/tmp/bittery-vault-retirement-promotion-red-2.log`). The initial attempt only found an unavailable
test dependency; the second log is the behavioral reproduction. This first test uses SQLite memory
storage and does not claim disk restart or real Server acceptance.

The existing Bootstrap prepared-commit/reconstruction test also reproduced a Session-only Vault ID
missing from the atomic cleanup journal (`/tmp/bittery-vault-retirement-session-only-red.log`). The
closed logical promotion plan now accepts sorted, unique additional absent key identities; its
validation refuses a visible, empty, duplicate or unsorted identity set. Actual integration, retry,
startup and final native/projection checks are being implemented; no completed70 acceptance claimed.

2026-09-09 selective artifact frontier: actual code inspection found Account-wide startup sweeps are
unsafe during Vault-only cleanup and that `Pending` Move progress can already own recoverable
provisional ciphertext. The linked specification now seals an Operation-scoped extension of the
existing artifact store, preserving exact accepted encrypted owners plus pending recovery scopes;
unknown orphan Vault identities remain with exclusive startup cleanup. This adds no persisted format,
key owner or cleanup runner. Implement the real-store tracer before widening adapters. Visibility
integration currently passes five focused tests and four registry tests, including the reproduced
same-revision notification loss; this is capability evidence, not completed70 application acceptance.

2026-09-09 retirement driver: the actual SQLite failure-before-commit test reproduced complete
staging parked when no Session or Operation existed (`/tmp/bittery-vault-retirement-driver-red-2.log`).
The existing driver now resumes local retirement before authentication/Operation eligibility, reloads
physical evidence to distinguish lost acknowledgement, and retains its bounded retry deadline in the
existing foreground retirement batch. The focused matrix passed 18 tests
(`/tmp/bittery-vault-retirement-driver-green.log`), including failure before promotion and after its
physical effect with HTTP forbidden, the old Session removed, and reauthentication required. Both
paths drain the journal; the original projection and Session-only journal tests also pass. Actual
new-connection SQLite startup, storage-failure retries, readmission and full application acceptance
remain under implementation. This is not a completed ticket or production cutover.

- Independent review found the first local-retirement dispatch hook waited on one Account's execution
  fence/drain before discovering later Accounts. The sealed integration requirement now retains
  per-Account attempts inside the existing dispatch loop, skips only their fenced Accounts in the
  ordinary scan and preserves existing retry deadlines. No separate scheduler or host cleanup owner.
  A held A → later B retirement/work regression is required before this progress gate passes.
  Review also found a stale snapshot between multiple retirement batches; the integration reloads
  the current guarded snapshot for each batch after prior acknowledgement commits.

2026-09-09 startup actual disk path: a new Runtime opening a new SQLite connection reproduced
publication of incomplete retirement (`/tmp/bittery-vault-retirement-startup-red.log`). Startup now
installs only a private cache while `ready=false`, holds the existing Account execution fence, resumes
local retirement and then publishes the updated snapshots. The new-connection test passed both
failure-before-promotion and applied-with-lost-ack cases (`/tmp/bittery-vault-retirement-startup-green.log`),
including erasure of hidden Session-only Vault keys, preservation of the other visible Vault, and
HTTP forbidden. Platform document storage is controlled in this test; it does not establish OS
keychain/biometric or full Desktop restart acceptance. Host readmission retry is now explicitly sealed
in the linked specification using the existing Retired fence and current authoritative generation.

2026-09-09 selective capability evidence: registry4 and visibility5 focused tests pass. The missed
same-revision filtered notification reproduced before the token-aware queue fix
(`/tmp/bittery-vault-retirement-delivery-red-2.log`); visibility checks cover late decryption, hidden-source
Move overlays, current visible authority preservation, seven new-work variants and multi-Account
catalog delivery leases. Core's native callback matrix40 also passed in the independent native lane.

Scoped artifact cleanup reproduced no deletion of the selected unowned rows before implementation
(`/tmp/bittery-vault-retirement-scoped-artifact-red.log`) and now shares the existing physical sweep
engine with exact Operation selection. The real SQLite artifact suite31 passed, followed by a selected
matrix11 including additional physical-failure/reopen coverage and both recoverable pending-publication
boundaries. A dedicated Runtime test proves exact Pending scope selection, missing-capability refusal
and stale revision rejection (`/tmp/bittery-scoped-artifact-runtime-selection.log`). Generated IndexedDB
ownership enumeration reproduced its missing control handler, then its executor suite24 and package
types passed. The actual WASM adapter compiles (`/tmp/bittery-scoped-artifact-wasm-check-3.log`);
IndexedDB execution here uses fake-indexeddb, not a Chromium selective-retirement acceptance run.
Both new cleanup helpers await lifecycle composition and independent review; current Clippy/full CI
and real composed application paths remain required before acceptance.

- Dispatch progress implementation: the existing dispatch loop retains bounded-by-Account cleanup
  futures and continues polling them while preserving the exact ordinary HTTP scan future across
  wakes. Each Account is re-read at ordinary admission after earlier awaits, so newly published
  retirement journals cannot be missed by an old scan snapshot. Failed local attempts retain the
  existing backoff inside their same future, including failures before a registry proof exists.
  No new scheduler or retry-state map. The held A → later B retirement case failed before this
  change (`/tmp/bittery-vault-retirement-account-progress-red.log`) and the final3-case matrix passed:
  A retirement → B retirement, A retirement → B ordinary write, and held ordinary A HTTP → B
  retirement without cancelling or resending A's original request
  (`/tmp/bittery-vault-retirement-account-progress-matrix-final-3.log`). Parent independent review
  additionally requested the fresh per-Account scan lookup; it is included. Broader targeted
  dispatch/retirement and Clippy runs are pending and full phase/application gates remain open.

- Supporting dispatcher checks completed after the isolation change: Core `--lib dispatch` passed50
  tests (`/tmp/bittery-vault-retirement-dispatch-regression.log`), `--lib vault_retirement` passed24
  (`/tmp/bittery-vault-retirement-all-regression.log`), and Core all-target Clippy passed
  (`/tmp/bittery-vault-retirement-dispatch-clippy.log`). These include the existing SQLite lost-ack,
  restart/readmission and ordinary accepted-work outcome cases; they do not close remaining70
  mutation, staging-failure, actual application or full-phase acceptance gates.

2026-09-09 readmission and composed cleanup: fresh complete Bootstrap reproduced a permanently
fenced restored Vault (`/tmp/bittery-vault-retirement-readmission-red-3.log`). The earlier readmission
fixture wrongly dropped its loan before expecting cancellation; that was corrected before the
behavioral reproduction. Fresh authority now waits for selected host acknowledgements, checks the
captured Retired proof under publication and creates fresh foreground scope. Old publications remain
cancelled. The readmission retry matrix passed (`/tmp/bittery-vault-retirement-readmission-retry.log`),
including host acknowledgement failure after promotion, no Session/Operations, and bounded retry.
Actual SQLite selective image cleanup and scoped Move artifact cleanup replace the live Account-wide
sweep. Startup keeps its exclusive orphan sweep. Independent reviews passed the scoped helpers;
real combined-Worker/IndexedDB retirement with nonempty Move artifacts is still being added.

2026-09-09 image staging: two actual production-dispatch/HTTP-adapter tests reproduced physical
checkpoint failure becoming permanent Account failure, and a stale contradictory upload grant
failing a newer Replica (`/tmp/bittery-vault-image-staging-scope-red.log`). Both pass after staging
handles invariant failures at its captured execution snapshot and checkpoint failures reload physical
same-Account evidence before exact retry (`/tmp/bittery-vault-image-staging-scope-green.log`). The
existing executor's equivalent failure logic now calls the same shared helper. No new cipher or host
policy was added. Repeated checkpoint/backoff failure, stale lease release, applied-lost-ack checkpoint,
and broad staging regressions remain under test before acceptance.

2026-09-09 additional actual failures: repeated checkpoint and retry-write failure returned immediate
progress (`/tmp/bittery-vault-image-staging-bounded-retry-red.log`), and dropping an expired lease
released its successor (`/tmp/bittery-dispatch-lease-successor-red.log`). The reviewed refinement uses
the existing dispatch lease with an opaque registration identity and deadline; targeted verification
is running. The staged image attempt's lifetime also needs explicit review across its separately
acquired execution phases: an outer transport/Session must never be reused for a replacement
Account incarnation that restores the original accepted Operation IDs. Do not close70 based only
on same-incarnation revision races or the current scoped error tests.

2026-09-09 staging failure matrix passed5 (`/tmp/bittery-vault-image-staging-full-boundaries.log`).
The actual production HTTP adapter now retains the original Account incarnation, User, lock epoch
and accepted request identity across credential resolution and separately acquired execution phases.
Replacing the Account while restoring the same Operation IDs reproduced old-Session dispatch
(`/tmp/bittery-vault-image-staging-incarnation-red-2.log`); the guarded attempt now parks before HTTP.
Applied checkpoint/lost acknowledgement reloads the committed checkpoint before retry, preserving
its immutable bytes. Three consecutive checkpoint/backoff write failures retain the existing lease
deadline, permit another Account's retirement, and repeat with bounded delay rather than spinning.
Expired handles cannot remove or defer successor registrations, including saturated clock values.
Independent lease review passed. Broader Create-Vault64 and dispatch54 tests passed, including all
three lease cases (`/tmp/bittery-vault-image-staging-broad-regressions.log`,
`/tmp/bittery-staging-dispatch-regression-final.log`). Core all-target Clippy passed after deleting
the unused fresh-Account failure wrapper (`/tmp/bittery-staging-clippy-final-2.log`). Full Core
regression, native deletion with real Server outcomes, protected-image93 and final phase checks
remain open; these adapter tests are not Desktop or Extension application acceptance.

The full Core library regression passed925 tests in417.54s
(`/tmp/bittery-vault-retirement-staging-core-regression.log`). This run includes the completed
retirement/staging fixes and staged protected representation; it predates portable protected-image
recovery and does not replace either final root CI command or production application acceptance.

2026-09-09 actual combined-Worker/IndexedDB selective Move retirement now passes
(`/tmp/bittery-vault-retirement-chromium-green.log`:1 Chromium case,26 assertions). The fresh combined
WASM was built with the existing binding-test-harness feature (`/tmp/bittery-vault-retirement-browser-build-3.log`,
release1m33 followed by wasm-opt). A cfg-only writer persists accepted Move history through the real
Core closed Replica plans and real provisional/published artifact ports. It reuses the existing
cryptographic fixture recipe, including ciphertext larger than256KiB, then leaves a complete staged
Bootstrap excluding the source Vault while holding the existing Account execution fence.

The browser terminates that Worker and closes its tab. A new tab in the same browser context has no
SessionSecret; ordinary `Runtime.open()` restores the exact catalog/Replica and reports SignedOut
(no fabricated QuickUnlock). Startup deletes the selected stale artifact, preserves an Encrypted
Move checkpoint and a published-but-Pending recovery scope, preserves every surviving physical
metadata/chunk hash/length, and leaves another Operation's incomplete writer and another Account's
artifact unchanged. The accepted preparation remains byte-for-byte, source authority disappears
across generations, and the retirement journal is acknowledged. A third Worker opens the resulting
Replica/artifacts unchanged. The original seeded Session's quiet SSE closes with its Worker; no
restart HTTP route is accepted.

This actual path exposed prepared-host cleanup rejection (`/tmp/bittery-vault-retirement-chromium-open-diagnostic.log`:
Core Cancelled during ordinary startup). The source/sink control tests reproduce both rejection and
commit-time fence erasure (`/tmp/bittery-vault-retirement-web-startup-red.log` and
`/tmp/bittery-vault-retirement-web-startup-commit-red.log`,2 failures each). Exact prepared-incarnation
Vault cleanup now waits for prepare completion; successful prepare resets old scopes, while commit
preserves startup fences. Foreground and foreign/retired callbacks remain refused. Source/sink57
regressions pass (`/tmp/bittery-vault-retirement-web-startup-regressions.log`), including explicit
readmission, unrelated Account/Vault independence and pending Account-control refusal. Initial
browser fixture failures were missing DeviceCatalog and an incorrect expected Locked state; neither
was a production defect. Runtime observer registration is synchronized with its first actual
projection before physical inspection.

This is real browser storage/Worker retirement evidence with seeded authenticated history, not public
Move creation, real Server authentication, Desktop UI/dialog, or concurrent active-Worker acceptance.
The pending publication's bytes are witnessed; browser Begin/ResumeRecovered is not claimed. Native
startup, physical failure/retry and live-loan concurrency retain their separate tests. Full phase
`pnpm check:ci`/`pnpm check:ci:rust` and ticket70's remaining delivery gates are still required.

2026-09-09 next native acceptance refinement (implementation in progress): extend the existing
four-process real-Server fixture with a separate Vault created online through Core before the
original Attachment Move starts. Once the original Move has durable ciphertext and is offline,
accept five Item Creates (all categories) plus DeleteVault and capture their exact persisted
request/fingerprint identities. A closed proxy mode blocks Item mutations and all Sync/Bootstrap
reads, forwards only the selected retained deletion plus required authentication/read traffic, and
discards the first exact real applied deletion reply. It then goes offline and records the real
Server outcome. No semantic outcome is synthesized. Existing locked export/physical damage/repair
and process restart must preserve all six accepted requests, then reconcile DeleteVault Applied and
five actual missing-Vault rejections while the unrelated original Move still converges. Verify
terminal receipts and all-generation authority erasure again in the fourth process. Direct Session
key-pruning remains the separate Core test boundary; no native raw-key inspection API is added.
This is native capability acceptance, not Desktop UI, and cannot run while the source acceptance
lane holds the real Server E2E window.

2026-09-09 follow-up browser validation: WorkerRuntime47 and composition/worker-entry/public-boundary9
regressions pass (`/tmp/bittery-vault-retirement-worker-owner-regressions.log`,
`/tmp/bittery-vault-retirement-composition-regressions.log`); Runtime package types and changed-file
Biome/diff checks pass. Independent parent review passed the physical Chromium witness and exact
prepared-source/sink control changes. The new native deletion fixture compiles, its Web dependency
types pass11/11 (`/tmp/bittery-native-vault-network-types-2.log`), and independent parent review passed;
its actual four-process run is pending the separate native-source acceptance Server window.

2026-09-09 first native deletion acceptance invocation stopped before execution: the concurrent
protected-image recovery transfer constructor expected `PlatformStorage` while Runtime supplied
`Arc<PlatformStorage>` (`/tmp/bittery-native-vault-four-process-first.log`). This is compilation
failure, not a behavioral red or native acceptance result. The recovery owner is correcting that
interface before the actual four-process fixture is rerun.

2026-09-09 real native deletion run reached the selected real Server Applied reply loss and verified
all six requests still pending before process loss, then failed the existing locked recovery export
completeness assertion (`/tmp/bittery-native-vault-four-process-second.log`). Safe diagnostics in a
second real run reported `Partial`, supported schema, corrupt accepted-work proof, unknown counts,
and no repair permission (`/tmp/bittery-native-vault-four-process-diagnostic.log`). Investigation found
`verify_item_request` incorrectly routed accepted UpdateVault/DeleteVault through Item-target
validation. An actual public-admission→RecoveryCoverage test reproduced `Item Operation target is
invalid` (`/tmp/bittery-vault-mutation-recovery-red.log`). The correction delegates these kinds to the
existing strict domain validators, as CreateVault/Import already do; method, path, headers, body,
fingerprint and target tampering remain refused. Focused green and actual restart rerun are pending;
no export/repair/process acceptance is claimed from the reached first-process boundary.

2026-09-09 the public-admission recovery regression is green1/1 for both Vault kinds and twelve
immutable-request tampering cases (`/tmp/bittery-vault-mutation-recovery-green-2.log`). The first green
attempt was blocked by a concurrent protected-image test's double-Arc fixture compile error, then
rerun after its owner corrected it. The actual four-process path is now rerunning with the strict
classification fix; recovery regressions and final native evidence remain pending.

2026-09-09 recovery coverage regressions pass13/13
(`/tmp/bittery-vault-mutation-recovery-regressions.log`). Independent sibling review passed the
narrow Vault-kind classification correction and strict domain validation/tamper coverage. The real
native restart path remains the separate pending acceptance gate.

2026-09-09 the next actual native run passed complete encrypted export, damage/repair restoring every
Replica row and published ciphertext byte, fresh locked reopen/password QuickUnlock, and the original
Move's real Server convergence with exact Attachment plaintext. The new deleted-Vault terminal/purge
wait then timed out with the Account still Unlocked and healthy
(`/tmp/bittery-native-vault-four-process-after-recovery-fix.log`). This is not final acceptance: bounded
per-request resolution and exact physical-verification diagnostics are added for the next run, without
relaxing any expected receipt or erasure assertion.

2026-09-09 the terminal diagnostic rerun again passed encrypted export and exact repair, but stopped
before the new terminal diagnostics: the existing phase-three Move Attachment helper returned
`RetryableTransport` while the Account remained healthy/Unlocked
(`/tmp/bittery-native-vault-four-process-terminal-diagnostic.log`). This does not diagnose whether the
new Vault receipt/purge wait is a product defect or a fixture mismatch. The Server window is released
to the native-source lane; the next fixture sequence will retain both checks and identify their
individual outcomes explicitly. No retry or success assertion was substituted for the failed request.

2026-09-09 terminal Delete diagnosis: the public Delete admission/dispatch regression reproduced a
missing terminal receipt (`/tmp/bittery-retained-delete-completion-red-both.log`). Runtime already
selected the shared Vault mutation transition, but its domain admission and receipt validation had
only registered UpdateVault. Both now admit DeleteVault with the existing exact fingerprint, target
and closed-result validation. Image cleanup remains restricted to Create/Update. All 11 Vault mutation
tests pass (`/tmp/bittery-retained-delete-completion-green-both.log`), including applied and rejected
Delete receipts preserving original identity, unrelated accepted Item work, current authority and
Bootstrap generation. The old retained result only requests fresh authority; it never purges the
Vault. Actual four-process acceptance remains pending the exclusive Server window.

Independent parent review passed the bounded Delete registration and preservation test. The related
outcome suite passes 72/72 (`/tmp/bittery-retained-delete-outcome-regressions.log`), dependent Web types
pass 11/11 (`/tmp/bittery-native-vault-final-types.log`), and changed-file Biome, Rust formatting and
`git diff --check` pass. The outer native acceptance now also requires the exact safe deletion
completion witness from its child processes. This assertion does not replace the physical receipt,
authority and fourth-process checks.

The related SQLite retirement integration suite passes 5/5
(`/tmp/bittery-retained-delete-retirement-regressions.log`): publication fencing before physical
promotion, journal/restart and Session-only key erasure, fresh-authority readmission, and bounded
failed-host readmission. These establish the independent fresh-authority purge boundary; final real
Server/native evidence is recorded separately after its result.

2026-09-09 actual four-process native deletion/recovery acceptance is green after the exact Delete
receipt registration fix:
`BITTERY_NATIVE_FOUNDATION=1 pnpm --filter web exec playwright test runtime-native-foundation.spec.ts --project=cloud --workers=1 --grep 'native Runtime signs'`
passes one case (2.4 minutes; 2.9 minutes including stack startup) in
`/tmp/bittery-native-vault-four-process-delete-receipt-fix.log`.

The existing actual native Core/SQLite/Linux keychain fixture creates a separate Vault, accepts all
five Item categories and DeleteVault offline, and witnesses the real Server's exact Applied deletion
reply before the proxy discards it once. All six immutable requests/fingerprints survive process loss,
complete locked encrypted export, deliberate physical damage, exact repair, and locked reopen/password
QuickUnlock. DeleteVault retains its original Applied receipt; the five original Creates retain real
`vault_access_denied` rejections. Only the following fresh authoritative Bootstrap removes the Vault
across physical authority generations and acknowledges retirement. The unrelated accepted Attachment
Move still converges with its exact downloaded plaintext. Re-Bootstrap and a fourth process verify
all six terminal receipts and continued absence again. Outer Playwright checks require the real child
completion witness, one lost reply, and repeated exact deletion request IDs/target/body.

This closes the earlier terminal/purge timeout and the combined native capability acceptance gate;
it does not establish Desktop renderer/file-dialog cutover, supported-OS acceptance, Travel settings,
protected-image legacy migration, or the whole ticket's remaining delivery gates. Direct Session-key
erasure remains the separate actual SQLite/Core integration boundary already tested above. The
exclusive Server window was released after successful cleanup; no additional Server effect or retry
policy was introduced. Full phase `pnpm check:ci`/`pnpm check:ci:rust` remain under the phase owner.

2026-09-09 follow-up review ruled out the suspected pre-proof staging reuse in successful Vault
mutation completion. Its transition requires Ready/RefreshRequired, and domain validation forbids
a staging generation in either state; an intervening Bootstrap begin is fenced by the captured
commit revision. Existing Bootstrapping work cannot enter this transition. No additional domain
change or speculative reset was made.

2026-09-09 the existing native four-process baseline passed again with protected Create and offline
Update images included, after the independently reproduced retirement-driver progress fix:
`/tmp/bittery-native-foundation-stale-retirement-fix.log`, one case2.1 minutes/whole2.5 minutes. The
original lost-Delete receipt, all five rejected Item categories, unrelated Move/Attachment convergence
and unchanged recovery/restart checks pass without deadline changes. Both original image uploads
match their exact PNG and terminal cleanup; final scoped User deletion is proved by public Runtime
outcome plus matching actual DELETE200. Full incoming Travel policy remains its distinct71 case;
this does not widen Desktop production or OS acceptance. See93 for the driver red/green evidence.

2026-09-09 independent closure review found the named incoming-conversion variant lacked a maintained
Core history: initial RSA-member installation and the separate actual Server conversion effects did
not by themselves prove refresh of an already installed Vault. The new
`incoming_personal_team_conversion_refreshes_owner_authority_without_rewriting_accepted_work` in
`runtime/shared_vault_tests.rs` now passes against unchanged production code
(`/tmp/bittery-vault-conversion-authority-second.log`,1/1,23.06 seconds). The initial compile attempt
had only a test key-to-byte-slice type mismatch; it is not a behavioral red or a production fix.

The test uses the existing real-SRP/Core authority fixture and ordinary incoming `vault_updated`
changes followed by complete Bootstrap. It follows the actual Server conversion contract: the same
Owner moves personal→team with the same wrapper, then team→personal with a fresh valid personal
wrapper for the same Vault key. Conversion does not fabricate a role transition: the Server requires
Owner and permits the return to personal only for the sole Owner. Each refresh replaces the active
authority generation/cursor, publishes the current type/Owner role and exact current wrapper, keeps
the existing credential readable, preserves every original accepted Operation/request/fingerprint
and receipt plus Account incarnation/epoch, and admits new encrypted Item work under current
authority. No test writes Replica authority or key rows directly, and no semantic mutation HTTP
request is dispatched.

The existing shared/RSA module passes2/2 in `/tmp/bittery-vault-conversion-rsa-matrix.log`
(55.07 seconds), including real RSA member key opening, five-category acceptance and Lock/reopen/
QuickUnlock preservation. Coordinating source review passed the bounded conversion history;
formatting and `git diff --check` pass. Its HTTP authority and platform/persistence ports are
controlled fixtures, complementary to the earlier actual PostgreSQL conversion effects and native
capability histories. This is not a real Desktop conversion gesture, new conversion editor or new
Server policy. The named Core conversion coverage gap is closed; the parent still owns the literal
full Rust phase gate before ticket closure.

2026-09-09 capability phase completed: literal `pnpm check:ci` passed in
`/tmp/bittery-desktop-extension-progress-check-ci-10.log`, and literal `pnpm check:ci:rust`
attempt7 passed in `/tmp/bittery-desktop-extension-progress-check-ci-rust-7.log`.
[The phase record](93-protected-vault-image-artifact-storage.md) details full-suite counts,
opt-in test limits and generated-binding verification without modifying the real Git index.
Together with this ticket's recorded actual Server/native histories and independent review,
these checks resolve its capability scope. Production Desktop/Chrome/supported-OS acceptance
remains in the application tickets; this closure does not claim a production caller cutover.
