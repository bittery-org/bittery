# 91 — Shared Runtime admission and Desktop profile source

Type: task
Status: ready-for-agent
Blocked by: 67, 68, 69, 70, 71, 82, 89, 90
Spec: ../desktop-extension/profile-handoff.md

## Outcome

Existing Desktop production Accounts, protected local unlock material, security preferences, encrypted
Replica and accepted pending work enter one shared Core admission owner before normal Runtime
commands, dispatch, Sync or native export start. Preserve Account IDs, crypto/persisted source bytes,
original request/step identities and offline evidence. Start locked; do not substitute Full sign-in,
new login secrets, empty profiles or omitted unsupported queue variants. This ticket implements the
shared admission capability and Desktop source family. Extension-specific source primitives and
startup wiring move to [106](106-extension-profile-admission.md) after Desktop acceptance73; real
Chrome upgrade, browser restart, broker reattachment and owner loss remain production acceptance under77.

Desktop primitives capture its real store.json, sync-store.json and protected credential references.
Shared Core owns compatibility decoding, exact legacy request serialization, validation, recoverable
staging/catalog commit and scoped cleanup. Ticket106 adapts Extension's actual Chrome local/session
areas and IndexedDB source to this same owner after73, before composition under74. One application
profile never runs old and new policy owners together. Delete shared transitional implementations
only after their final application caller.

## Readiness

Research82 resolves the supported startup boundary: converge owned launch routes, retain actual
legacy process identities through exit, and hold new-owner exclusion before source capture. Linux
synthetic feasibility is observed; maintained OS/packaging acceptance remains required before enabling
each production path. The legacy writer does not honor a new Core lock. Coordinating and independent review accepted the
[concrete admission lifecycle](../desktop-extension/profile-handoff.md#concrete-admission-lifecycle-contract),
including its closed source-snapshot/generated primitive envelope and restartable reset scope.
The ticket is decision-complete and all capability dependencies are resolved. Implementation starts
with the populated locked-Account slice and its admission refusal regression.
Fresh-profile native Sign-in does not establish populated-profile acceptance.

90 supplies the actual cross-Account workflow under accepted83, including destination reauthorization;
89 supplies exact retained-result/current-authority handling. Preserve every supported legacy queue
kind and terminal/staged status. Reproduce actual TypeScript serializer bytes, including Unicode,
numeric values, optional fields and property order. Unknown accepted in-flight evidence fails closed
and stays recoverable; it is never guessed or dispatched with a new identity.

## Acceptance

Follow profile-handoff.md's dependency-ordered test-first slices for shared Core admission and the
Desktop source family: populated locked Account and exact protected credentials/preferences;
encrypted cache and Sync baseline; each ordinary pending command; and cross-Account workflows.
Crash each capture/protected write/Replica/catalog/cleanup boundary and retry with original identities.
Prove offline populated reads, existing password unlock and supported-OS retained-Session biometric
release, with no SRP substitute. Extension's source families and browser-owner startup are moved to
106 without removing any accepted-work shape or recovery requirement.

Test a real Server outcome lost before legacy acknowledgement and convergence to its original
retained result after admission. Test old-owner exclusion and changed-source capture with actual
processes/platform stores, scoped fixture cleanup and explicit incomplete recovery on failure.
Actual Desktop upgrade belongs73 and actual Chrome upgrade/owner loss belongs77. Run required targeted
checks and both full CI commands; compilation and mocks alone do not establish profile acceptance.
Ticket91 must pass its complete shared/Core and Desktop-source acceptance before it closes; it does
not wait for Extension implementation or claim Extension production acceptance.

## Remaining delivery inventory

The 2026-09-23 source audit separates these remaining families from the completed bounded slices:

- The reviewed **source-absent staged/applying** slice is integrated after the joined95/105
  freeze. Genuine [legacy producer](../../../packages/core/src/services/cross-account-item-command-acknowledgement-crash.test.ts)
  captures and behavioral admission RED now precede the narrow implementation; Domain and public
  locked-reopen checks pass in isolation as recorded below. A departed claim does not prove that a
  remote child ran. Normal no-Attachment scheduling and original-child proof recovery after remote
  progress already have focused coverage; do not reimplement those families.
- Map legacy **cross-Account Attachment and progress evidence**. The producer currently uses an
  empty Attachment list; both the [Desktop mapper](../../../packages/client-runtime/crates/bittery-client-core/src/runtime/profile_admission/desktop/commands.rs)
  and [durable mapper](../../../packages/client-runtime/crates/bittery-client-core/src/replica/legacy_cross_account_admission.rs)
  refuse nonempty cross-Account Attachment evidence. Ordinary Update/Move Attachment retention and
  modern Runtime Move tests do not establish this legacy admission path.
- Resolve the remaining named cache/source shapes, including producer reachability and typed
  disposition for unique or changed unpromoted stages and unique-baseline evidence. The reviewed
  duplicate-only frontier is now implemented and integrated; its bounded equality and physical-key
  ownership rules do not admit unique evidence. Failed-Create `optimisticFailure`
  and Travel without pending work already have focused coverage. Unknown fields remain refused and
  recoverable. Travel with pending work and other unrepresented combinations remain refused until
  their supported mapping is resolved; this is not permission for a generic cache fallback.
- Complete the real Desktop-source crash, old-owner exclusion, cleanup and whole-profile Wipe
  matrix. [Linux source tests](../../../apps/desktop/src-tauri/src/runtime_host/profile_source_tests.rs)
  and [native process tests](../../../apps/desktop/src-tauri/src/runtime_host/native_source_process_tests.rs)
  provide opt-in entrypoints. Earlier records include 15/15 actual OS-source cases, scoped native
  cleanup/direct Reset, populated-cache/password and retained-outcome evidence. The maintained
  whole-Runtime native Wipe case now also passes as recorded below. Twelve actual Linux crash
  cuts pass: the earlier six platform writes, Replica Install, Account checkpoint and whole-profile
  commit, plus exact source cleanup after DesktopStore removal, protected Account SecretKey removal,
  and the final Committed/all-Absent receipt before Complete. The locked SQLite fixture has a real
  revision-zero head and zero rows; these cuts assert logical head/row continuity, not populated
  profile recovery or database/WAL byte identity. Ten actual Linux Wipe cuts also pass: the initial
  Reset/Wiping journal, DesktopStore deletion/receipt, SyncStore deletion/receipt, Credentials
  deletion/receipt, DevicePlain and DeviceSecret Runtime prefix deletion, and the final Wiped catalog
  write. The latest three platform cuts prove the same original scope and wipe ID at Wiping revision
  three, complete by explicit same-Wipe retry to Wiped revision four, and recover the terminal Wiped
  write through normal open with zero profile-source requests. A named abandoned NativeFiles file is
  proven absent before any reopened host owner could recreate its directory. Actual legacy-writer
  exit/exclusion remains a separate gap; these tests do not establish that complete matrix.
- Implement the supported-startup capability before exposing a production source constructor.
  [NativeProfileSource](../../../apps/desktop/src-tauri/src/runtime_host/profile_source.rs)
  currently has only isolated test constructors. Its new-owner lease does not constrain the
  existing Tauri store writer. Research82 still requires exact owned launch-route convergence,
  retained legacy process-instance exit evidence, a fresh inventory and the retained new-owner
  lease before capture. An actual legacy writer test must exercise that boundary; a new Core
  child or login-only smoke is insufficient. Production Runtime composition remains66.
- Obtain actual supported-OS retained-Session biometric evidence and pass both full CI commands.
  Only Linux is currently available. Extension sources remain106; packaged Desktop upgrade remains73.

The staged/applying admission, fifteen physical crash tests, and duplicate-only cache batches are
integrated. The cache ownership finding has a reproducer and reviewed correction; all 138 combined
public admission tests pass. This inventory does not mark any open family fully accepted.

## Comments

2026-09-24 one additional ignored Linux process case now seeds a real encrypted Item and Vault
through the maintained active-generation Desktop source, admits them with `NativeProfileSource`
and Core, and verifies the populated `SqliteReplica` head and rows before starting the Wipe child.
The child awaits the actual `WipeDevice` transaction response, fsyncs a marker and withholds Core's
acknowledgement; the parent observes empty logical heads and rows, kills and reaps that exact child,
then reopens the same database with fresh owners. Retrying the original scope and Wipe ID reaches
`Reset/Wiped` revision four. Normal open makes zero legacy source requests and leaves that tombstone
and the empty Replica unchanged. The existing real `NativeFiles` cleanup, unrelated and near-miss
values, and exact source deletion guards remain in the path. The maintained source fixture's
generation token was corrected to the producer's colon-free form so strict active-stage ownership
admits it; no product admission policy changed.

The new case, existing populated offline admission and adjacent empty-owner physical Wipe cut
each pass as one selected ignored test; strict Desktop all-target Clippy passes. This establishes
Linux process-loss recovery and logical SQLite head/row deletion only. It does not establish
power-loss behavior, SQLite/WAL byte equality, populated Attachment/Vault-image artifact cleanup,
legacy-writer exit/exclusion, production startup/cutover or macOS/Windows acceptance. The pending
unmatched-cache retention decision and legacy cross-Account Attachment mapping remain unchanged;
ticket91 and both full-CI gates remain open. Exact commands, first-run diagnostics and final
source/binary provenance are in
`/var/tmp/bittery91-populated-wipe-v60-evidence-iru4o8ce/final-manifest.md`.

2026-09-23 two further actual Linux crash cuts are reviewed and integrated: the successful
Account-checkpoint catalog write leaves Preparing/Verified with its exact inactive reservation;
the committed catalog write leaves Committed/Verified with the active incarnation and no pending
Install. Each write completes in real platform storage before a fsynced marker and withheld reply
let the parent kill and reap the exact child. Both preserve the already committed, locked
revision-zero, zero-row SQLite Replica across reopen, refuse a second Install on Resume, and
complete scoped cleanup while preserving unrelated source data. The matcher observes only the
necessary catalog fields; Core retains complete catalog validation.

All nine exact ignored cases pass serially with the already integrated duplicate-only cache changes
and a confirmed fresh Core compile. Strict Desktop all-target Clippy also passes. Independent Sol
Spec and Luna Standards reviews report zero findings. The integrated test leaf has SHA-256
`f8d51d59d1888f1ae33085988dcd6cdcd414c204bfd179dd5a1feba9d7d0f2c8`; the cumulative patch has SHA-256
`5867d9ceb18f2dcf2760a263bc53a4df8dbcada8552b2cf6140aa20d23638753`. Evidence is pinned in
`/var/tmp/bittery91-replica-cut-3z8dJk/captures/catalog-cuts/final-verification-manifest.md`,
SHA-256 `4b41e0754ef8631a073af79c63b824603c9f9bb9a05d1dc022eab428a1dc83bf`.
The final strict lint log has SHA-256
`c7fde175e35e5d0e05de88ec02a9050db9de0d55010fbc6636d4662b73423c40`. An earlier timestamp-preserving
source copy reused the prior binary; its logs remain diagnostic only. The final evidence explicitly
requires fresh Core compilation. These are metadata/credential fixtures, not populated Replica,
SQLite/WAL byte equality, legacy-writer exclusion, production startup or supported-OS biometric
acceptance. Later physical cuts, the remaining admission families and both full CI gates remain.

2026-09-23 the seventh actual Linux crash cut is reviewed and integrated. It delegates Install
to the real SQLite Replica, observes the applied commit, fsyncs a marker and withholds the reply
until the parent kills and reaps that exact process. The held catalog remains Preparing/Unwritten
with the original inactive reservation. The committed Replica contains one locked revision-zero
head and no rows. Reopen preserves its exact logical head/row contents; Resume completes with a
test-only guard refusing any second Install for that Account. Existing scoped source/credential
cleanup and unrelated-entry preservation checks also pass. This does not assert SQLite/WAL file
byte equality or populated Replica rows.

All seven exact ignored Linux cases pass serially on final source SHA-256
`06b5722fe6644146be300a978b2ef93a7c44fec1b87e3ce74067aa57e9a54e4f`, including the earlier six
protected/plain writes. Independent Sol Spec and Luna Standards reviews pass that source, which
matches the integrated file exactly. Patch SHA-256 is
`cc0515303d83f2b3cbaa86debefe78218eed5984aa1bb70b9b7de5d2e1a15bd8`;
`/var/tmp/bittery91-replica-cut-3z8dJk/captures/replica-install/manifest.md` records the seven
separate test logs and has SHA-256
`9617053961ea1dc0afc908d639139e067aabc4ab323327db1502516a83f5ddca`.
Strict Desktop all-target Clippy exits zero in 9m58s; its adjacent
`strict-desktop-clippy.log` has SHA-256
`6fc10e0ed6b8b8fef336d62fb97c83efa7ea11f23311eeea63b8ac6408a09913`.
Leaf-file rustfmt and patch application checks pass. Catalog checkpoint/commit, later cleanup,
populated source variants, actual legacy-writer exclusion and supported-OS biometric evidence
remain separate requirements; this bounded test-only integration does not complete ticket91.

2026-09-23 the duplicate-only cache implementation and ownership correction are integrated at
tree `84546113189477369e1c09c216d6542121583a0b`. All 12 source/fixture hashes match the final
isolated manifest; only the formatter exception list is merged with the earlier staged captures.
Final cumulative patch SHA-256 is
`fc68d66d4eb201ea2dc2b4bcf2a7354d95d652703b0f9a8f5263788825fef0d1`, and manifest
`/tmp/bittery91-cache-producer-CO9M2J/evidence/duplicate-only/implementation-followup.manifest.json`
is `ec78931b634cf0e5b152c68fb683946cc6b812790e55e2ca85c47e387b3dde14`.
Initial independent Sol Spec review accepted the bounded implementation; Luna Standards review
found that consumed active keys could hide an alternative stage owner when no leftover stage row
remained. Domain and public tests reproduce that failure. The correction validates every captured
stage-prefixed physical key, including consumed keys, and retains only the reviewed null-generation
plain-prefix exception. Different Luna Standards review and the original reviewer's Spec follow-up
both pass the pinned correction. The isolated suite passes 135/135 and strict all-target Clippy passes
at `/tmp/bittery91-cache-producer-CO9M2J/evidence/duplicate-only/no-leftover-strict-clippy-unambiguous.log`.
The earlier collided Clippy log is diagnostic only.

Integrated validation passes Domain 9/9, producer 1/1 with 55 assertions, nine Core type tasks, Biome,
and the complete public SQLite admission suite 138/138 in 180.15s, including the other integrated
staged/applying cases. Logs are `/tmp/bittery91-integrated-cache-domain.log`,
`/tmp/bittery91-integrated-cache-producer.log`, `/tmp/bittery91-integrated-cache-types.log`, and
`/tmp/bittery91-integrated-cache-admission-family.log`. An earlier empty test-filter run is retained
separately and supplies no test evidence. Source-free reopen remains locked with the genuine
metadata-only capture's `RefreshRequired`/`Cold` disposition; no Ready checkpoint is manufactured.
The real Git index remains unchanged. This accepts the duplicate-only slice, not unique or changed
unpublished data, physical application capture or completion of ticket91.

2026-09-23 the isolated Travel producer experiment captures two genuine queue-interface cuts:
a visible-Vault Create while another Vault becomes hidden, and a Create queued before its own
Vault becomes hidden. Real ItemCommands, ItemSyncEngine, TravelModeEnforcer.enable, repository
and WASM crypto run over in-memory stores and a mock API. At the held client-acquisition cut,
before any Item HTTP, both serialized pending queues remain byte-identical with retryCount0;
the hidden key and cached Vault metadata are removed, and the hidden Create projection vanishes.
The fixtures have no independent Sync checkpoint. After release, both retained ciphertexts reach
the mock API; its hypothetical applied reply consumes the queue and can recreate a hidden
encrypted cache row without restoring its key or readable projection. Server source inspection
finds role/size checks but no Travel-specific predicate in the Create route/effect/access chain;
no actual Server acceptance is claimed. Lack of HTTP does not exempt locally accepted work
from65/71: acceptance belongs to the Client Runtime, not a later Server outcome. This experiment
proves serialized legacy behavior, not physical durability, Core65/71 acceptance or an actual
application-profile upgrade. Its seeded unsynced cache and direct drain are explicit limits.
The two cases pass with29 assertions and Biome. Corrected verdict at
`/tmp/bittery91-staged-applying-ENftx9/packages/core/src/services/experiments/ticket91_travel/evidence/verdict.md`
has SHA-256 `5e23fa34ba1a4e1744dc868ed700dfa39ef81714cff0cde4a570739d94148b64`;
manifest SHA-256 is `1067c1e4598a53dae869bd7550871c6e211a73156708ca08c03cfca3c518459f`.
Earlier wording is archived and all test/capture bytes remain unchanged. Enabled Travel with
pending work still refuses admission until its typed mapping receives its own contract review
and behavioral tests; no Update, Move or admission mapping is inferred from these Create cuts.

2026-09-23 after95/105 resolve with both literal full CI gates, the reviewed staged/applying
implementation, exact fixture formatter exception and six-cut physical harness are integrated
from their pinned patches below. Completed prior-phase tree is
`13cc4a110f08a257679d1374b8e99d03209bc21d`; the real Git index is unchanged. Main Biome passes
for the producer, fixture files and config. Integrated checks pass: producer2/2 with125 assertions,
nine Core type tasks, Domain3/3 and public SQLite3/3 including locked reopen and malformed refusal.
Logs are `/tmp/bittery91-integrated-preprojection.log`,
`/tmp/bittery91-integrated-preprojection-public.log`,
`/tmp/bittery91-integrated-preprojection-producer.log` and
`/tmp/bittery91-integrated-core-types.log`. The physical test source retains the reviewed six-cut
hash. This partial91 integration is not a new completed phase. The duplicate-only patch stays isolated:
independent review found that consumed active keys could bypass ambiguity validation if no
unconsumed stage key remained. A reproducer and correction are required before its integration.

2026-09-23 the isolated physical harness now passes six exact Linux crash cuts at source SHA-256
`7b679d009bc85fb5ffb60f8b6463cac4f2cbc2a05dad531f4e6bf40f121a2c36`. The three added cuts
hold acknowledgment after actual SQLite writes of global local security, Account metadata and
Account local security. All six cases pass serially at the same source; rustfmt and strict
Desktop all-target Clippy pass. Independent Sol Spec, separate Luna Standards and coordinating
review accept the bounded extension. Before killing the exact child, and again after reopening,
the parent verifies committed DevicePlain/DeviceSecret values, exact Core namespace key sets,
pending-only Preparing/Unwritten state, no Replica, and unchanged source bytes and identity.
Legacy credentials and unrelated values are checked separately; this is not a whole-keychain
inventory assertion. Recovery completes locked with scoped cleanup. Cumulative patch
`/tmp/bittery91-staged-applying-ENftx9/captures/physical-crash-device-plain.patch` has SHA-256
`f78f1305a68294f6af3255dc58654832e5a86c7dbf3a235cba6ab1c4d155a92e`; delta from the accepted
three-cut source is `9c108b61b0c4b04596cb105a19eee1961eae05a3a2e866b1f0f528f553005278`.
Main integration, later admission/cleanup cuts, actual legacy-writer exclusion and supported-OS
biometrics remain outstanding.

2026-09-23 the isolated Attachment experiment runs the real legacy Move, queue, executor,
API client, cache refresh and WASM crypto through one lost-registration-reply cut. Its serialized
retry keeps the original semantic Operation, remints the attempt and retains no source-to-target
Attachment binding or per-Attachment checkpoint. Refreshed source/target rows also lack that
binding; the transient request header is not retained Server proof. Independent review corrected
two evidence limits: the mock upload key fails actual Server signed-key validation, so its commit
is hypothetical, and the in-memory storage adapters establish serialized client state rather
than process durability. The captured Sync store contains only the queue, not an independent
checkpoint; legacy cache metadata does not establish Core readiness. Server source separately
shows ordinary registration retains the target row and consumed reservation without an Operation
receipt. Expiry cleanup excludes consumed ordinary reservations; owner deletion can remove them.
Final verdict SHA-256 is `d34bfb6145cf25e1f24e3427ca326ce6dbcd30e646dd2eacbebd1e6ab11561ef`;
manifest at `/tmp/bittery91-staged-applying-ENftx9/packages/core/src/services/experiments/ticket91_attachment/evidence/manifest.json`
is `6d2f77ba3d99232071bb4ee5c08d1507e26c86322faebfd7aa967c6ed80c7ced`. Producer source remains
`8dc4101711420895391e3c19a04bc489ebb1c46e98937ae3e6f22ac637b4d0d1` with one passing case and
25 assertions, nine type tasks and Biome. Earlier revisions are preserved. This experiment does
not establish real Server reachability, a durable Attachment admission mapping or physical
Desktop acceptance; nonempty cross-Account Attachment evidence remains refused.

2026-09-23 the isolated Linux physical harness now covers three protected-write crash cuts:
DeviceKey, QuickUnlock and metadata-only retained Session evidence. All three exact opt-in
cases pass at test-source SHA-256
`362dd23a17539e15df3d8a4ed0534ca3dcd7aad65a1187355a79e4f78be35ccf`; rustfmt and strict
Desktop all-target Clippy pass. Independent Sol Spec and separate Luna Standards review find
no blocking issue. The shared harness verifies exact Account/incarnation key selection, real
write completion before the held acknowledgment, original source evidence, pending-only
publication state, exact child exit, recovery and scoped cleanup. The Session case explicitly
has no token, Vault keys or encrypted private key; it does not prove biometric Session release.
Cumulative patch `/tmp/bittery91-staged-applying-ENftx9/captures/physical-crash-expanded.patch`
has SHA-256 `8e19d7539893f5c878cee94e3a6924c99a58ecd856f0b82cd7796092f7dc6193`; its delta
from the first accepted cut is `b46436e823c02f47ffba8d4ec95e1a2cbc88d4602ae7aa889b1bccc14fa74a07`.
The earlier test-selector failure is preserved separately and is not a production regression.
Main integration and the rest of the physical matrix remain outstanding.

2026-09-23 integration audit found the two new staged/applying immutable JSON fixtures needed
the existing exact-file formatter exception. The isolated follow-up adds only their paths to
that formatter-only list, leaves lint enabled and preserves both fixture hashes. Biome now
passes on the config, both captures and producer source; independent Standards and coordinating
review accept the narrow correction. The separate patch is
`/tmp/bittery91-staged-applying-ENftx9/captures/staged-applying-biome-fix.patch`, SHA-256
`0938a06fafed2b89ec0c532a5c85467f08386eed6bab1ed85e7fb28a83c7aeb0`.
Apply it with the frozen staged/applying implementation after the main CI freeze ends.

2026-09-23 isolated staged/applying admission now has genuine behavioral RED followed by GREEN:
the unchanged Domain validator and both public SQLite cases reject the actual source-free
captures at the unsupported-history invariant. Two narrow production match arms admit only
the observed original-attempt, zero-retry Staged/Applying shapes; Staged requires its exact
claim pair, Applying forbids one, and both forbid deadlines, diagnostics and conflict-copy
provenance. Existing scope, immutable request, Ready-source absence, ownership and dispatch
fences remain unchanged. New Domain cases pass 3/3, the missing-source Domain family 35/35,
new public cases 3/3 and the broader public missing-source family 18/18, including locked
source-free reopen/unlock and malformed controls. Independent Sol Spec and Luna Standards
review find no blocking issue. Combined patch SHA-256
`d20e01997d6b096b3745f1efd859da53f88b8925bec5d2f62081118878f335ac` lives at
`/tmp/bittery91-staged-applying-ENftx9/captures/staged-applying-green.patch`; behavioral logs are
beside it. Strict Core all-target Clippy, rustfmt, nine dependent type checks, Biome and the two
maintained producer cases also pass. The patch applies cleanly to main but remains isolated
pending the main95/105 freeze. This neither establishes physical Tauri projection timing nor
closes ticket91.

2026-09-23 coordinating and independent Sol review resolve the
[duplicate-only unpublished cache frontier](../desktop-extension/profile-handoff.md#duplicate-only-unpublished-cache-frontier).
One nonactive generation may be elided only when every recognized raw row exactly duplicates
validated active evidence with an explicit matching Account scope. Enumerate all syntactically
valid stage-key partitions, including unknown Accounts, and refuse ambiguity or known active
prefix overlap; Account and row IDs remain opaque. The explicit row scope also rules out an
unknown legacy active-collection alias. Unique/stale rows, missing scope, unsupported kinds and
multiple generations remain refused with the source retained. This adds no durable owner,
authority, cursor or cleanup rule. Producer-derived Domain/public behavioral RED must precede
the bounded implementation in the isolated cache workspace; main source remains frozen for
joined95/105 CI. This records a decision, not implemented admission or physical acceptance.

2026-09-23 the first isolated physical crash cut passes on Linux: the child delegates a real
native DeviceSecret write, fsyncs a content-free marker and withholds only its acknowledgment.
The parent confirms the actual protected write, original source bytes/inodes and credentials,
Preparing journal and pending-install reservation with no active incarnation or Replica head,
then kills and reaps that exact child. Reopening preserves the journal and source; Core resumes
to Complete and Locked, cleans only the admitted legacy scope and preserves unrelated values
and the Runtime key. Parent-owned UUID credential cleanup is verified after the case, including
error paths. Independent Sol Spec and Luna Standards review found no blocking issue. Evidence:
`/tmp/bittery91-staged-applying-ENftx9/captures/physical-crash.patch`, SHA-256
`9c2b57d563e00194f56a98d5ca8eb9289e4faa69048b457117d401aceb79326c`;
`physical-crash-test-reservation.log` records the exact opt-in test passing 1/1. The test remains
isolated while joined95/105 CI freezes main source. This proves one actual Linux fault cut;
the remaining crash matrix, actual legacy-writer exclusion and supported-OS biometric evidence
remain required.

2026-09-23 a second isolated cache producer experiment pauses before the first Item page after
the unchanged Vault page and both baseline copies. All three unpublished physical collections
contain only raw `(id, serialized value)` pairs identical to their pointer-selected active
counterparts. The unpublished Items collection is absent; active pointer, rows and metadata
remain unchanged. The real error path disposes of the stage in `finally`. The case passes 1/1
with 25 assertions and Biome; independent Sol source review accepts this bounded producer
evidence. Capture SHA-256 `a12e576611978055dd46790c1fb5d216c1b2b4d76c4dc8e8681ee9024d37c8d6`;
provenance `/tmp/bittery91-cache-producer-CO9M2J/evidence/duplicate-only/provenance.json`, SHA-256
`cbfaa5c894ea8bea993aa1f912eccdb2518d43df8aa2c6c3e15f370f977d7d22`.
This supplies a smaller duplicate-only frontier to specify and test before admission changes.
It does not establish a retention owner for unique stage or baseline rows, physical capture,
or actual application scheduling.

2026-09-23 isolated cache producer evidence now demonstrates a partial Bootstrap stage with
an identical control row, an older unique baseline for an independently updated Item, a
baseline for an independently deleted Item, and an unpublished stage-only Item. The active
pointer remains unchanged; its metadata cursor is not evidence of the separate Sync
checkpoint. The test drives maintained Bootstrap and Delta delegates at the real second-page
await, captures before cleanup, then releases the error path and verifies stage disposal.
It passes 1/1 with 33 assertions, Core TypeScript and Biome; independent source review accepts
that direct-producer scope. Foreground refresh and Sync mutation call paths have no shared
hydration fence, but actual application scheduling and physical Desktop capture are untested.
Evidence: `/tmp/bittery91-cache-producer-CO9M2J/evidence/provenance.json`, SHA-256
`1549c8c1a2d814d9fb2a7521f28fdaef2632571c855fe55a62bd0925c007c2e7`.
Core has no current typed bounded representation for retaining those unique rows after
source cleanup. A duplicate-only partial-stage capture is the next smaller experiment;
unique evidence remains refused with its source retained. No cache admission rule changes.

2026-09-23 the revised isolated staged/applying producer experiment passes 28/28 cases
(1,544 assertions), including the prior 26 histories, and nine dependent type checks.
Independent Spec and Standards review accept the modeled storage-acknowledgment cut and
resolve the earlier raw-record/cleanup findings. Both captures preserve exact queue bytes
through independent deletion and complete source/destination refresh, contain no source-keyed
record, and precede restore or acknowledgment release. The real applying projection then
runs once without restoring the source; no semantic executor or remote child ran. Evidence:
`/tmp/bittery91-staged-applying-ENftx9/captures/manifest.json`, SHA-256
`e9d5186ed98f13e0889b0757ecbcb52fcd7f15c11efd6f67a64daf9cecfc2ca6`;
staged capture `3581a7df1226a5b49fe795f9054ff6837cf654cd794862ada9f3cb56b40fe659`;
applying capture `e8ad94646b9a39386ea36b1a3167a455348e39612364aa80251f2c905d21ac4e`.
The isolated test-only admission patch is being prepared; Domain/public SQLite behavioral
RED, production admission, locked reopen and physical Tauri crash acceptance remain unrun.
Main source and tests remain frozen for the joined95/105 full CI checks.

2026-09-23 Linux physical-fault audit distinguishes the existing green paths from the remaining
crash matrix. The 15 isolated OS-source tests and the whole-Runtime Wipe test use actual file,
keyring and SQLite primitives, but do not inject process death after each protected/catalog/
Replica write. The next bounded test should let a parent own the private directory and unique
OS credential identity, let a child delegate a protected write to the real primitive, and kill
the child after that write commits but before Core receives its acknowledgment. Reopen the
same stores to verify the journal, absence of partial publication, original source evidence
and successful resume. Parent-owned cleanup is required because the existing child-only
credential cleanup cannot run after SIGKILL. This is a test-harness proposal, not completed
fault evidence. The empty-catalog native-process test and login-only Desktop smoke still do
not prove exit/exclusion of an actual legacy writer.

2026-09-23 producer review tightened the applying experiment before admission work. The real
projection records pending work synchronously, which would retain the source during deletion;
an inserted pause before that callback alone does not establish production reachability. The
reviewed cut is after the queue bytes commit but before the asynchronous storage update
acknowledges. Independent Sync uses separate `set` writes and full refresh uses ItemCache,
while the real projection remains unmodified and runs after release. The
[bounded contract](../desktop-extension/profile-handoff.md#source-absent-staged-and-applying-projection-cuts)
now states that exact boundary and requires release/cleanup assertions. Revised isolated
producer evidence is pending; this neither admits a new history nor claims physical Tauri
fault acceptance.

2026-09-23 actual Linux whole-Runtime native Wipe passes 1/1 in its exact isolated child
(`runtime_host::profile_source::tests::actual_runtime_wipe_resets_native_legacy_sources`;
`/tmp/bittery-runtime-91-actual-wipe-linux.log`). The test uses a fresh UUID-named actual OS
credential and private profile fixture. Runtime Wipe removes malformed legacy store/sync files
and six protected legacy values, preserves foreign/near-miss values, records an empty Wiped
catalog, reopens without the legacy source, releases the source capability and verifies fixture
credential deletion. No source/test change was needed. This extends the earlier 15-case actual
OS-source evidence; physical fault/restart cuts, legacy-writer exclusion and supported-OS
biometrics remain open. Ticket91 is not complete.

2026-09-23 read-only cache/Travel frontier audit: the maintained bootstrap snapshots active
rows into per-generation baselines, writes unpublished pages and promotes only after all pages.
Hard termination can leave partial stages; concurrent active updates/deletes can make baseline
rows unique but stale. Core currently refuses those leftover stores. Capture real paused
bootstrap plus active update/delete histories before defining their disposition; never promote
unpublished pages merely because their bytes are unique. Separately, Travel enable purges hidden
keys/cache/projections without mutating the persisted command queue. Real producer captures must
cover both visible-Vault pending Create and a Create queued before its Vault becomes hidden.
The current enabled-Travel/nonempty-queue refusal remains until those typed mappings are reviewed
and tested. Neither audit is completed producer evidence or new admission authorization.

2026-09-23 read-only Attachment frontier audit: the maintained `ItemCommands.move` queue row
stores a whole Move attempt, not per-Attachment checkpoints. Its executor lists source
Attachments later, obtains random target upload IDs, registers each target and only then
trashes/deletes the source. Server registration rows do not retain the source Attachment ID or
Move operation ID; target presence alone cannot establish that correspondence. The modern
Core checkpoint owner requires precisely that source/target binding and exact registration
evidence. The next useful experiment is an actual producer Move with one source Attachment,
losing the registration reply after commit and capturing the persisted queue plus refreshed
source/target and reservation state before another drain clears target Attachments. No such
capture is claimed yet. Do not fabricate a manifest from names, order, counts or retry state;
this audit does not broaden admission or resolve the partial-progress frontier.

2026-09-23 independent Luna frontier review accepts the bounded staged/applying contract below.
The maintained worker and Core enqueue paths support the distinct raw queue cuts, and restore
behavior requires capture before restore. The current missing-source representation already owns
the parked projection and reserved child identities; only exact producer-proven status shapes may
extend admission. The combined independent-delete/full-refresh histories remain an experiment to
run, followed by genuine Domain and public SQLite refusal tests. This review establishes the next
bounded implementation contract, not completed producer evidence or ticket acceptance.

2026-09-23 bounded next-frontier draft: [source-absent staged/applying projection cuts](../desktop-extension/profile-handoff.md#source-absent-staged-and-applying-projection-cuts).
Source inspection, not a completed producer capture, shows two distinct reachable queue cuts:
Extension worker-origin `stage(command, claim)` persists staged with original semantic/attempt ID,
zero retries and exact claim ID/expiry; Core/Desktop `enqueue` persists applying before optimistic
projection, with original ID, zero retries and no claim. Neither has a retry deadline or diagnostic.
The maintained producer must still prove independent source deletion plus full Ready refresh while
each real queue row remains stopped, then freeze raw storage before restore; restore skips staged
but normalizes applying. Domain and public SQLite RED must precede two narrow admission branches;
locked reopen must preserve `Blocked(MissingSourceEvidence)` with no live deadline, and no original
remote child/proof may be inferred. This shared/Core history work does not implement Extension source
wiring under 106/74 or satisfy ticket91's remaining Attachment, cache, Desktop platform, biometric
and full-CI acceptance. No new status is marked accepted by this draft.

2026-09-23 only the Linux workspace is available, as confirmed by the maintainer. Supported-OS
retained-Session biometric evidence also remains unavailable where it requires macOS or Windows
hardware. Continue the unblocked shared/Core and Linux source work; do not replace that evidence
with mocks or new sign-in, or mark the complete ticket accepted from Linux-only results. The same
access limitation is recorded on [73](73-desktop-production-acceptance.md) for packaged application
acceptance.

2026-09-23 independent Spec and Standards reviews of the frozen retained-deadline slice
(`41c83b29657a9805e6731177b56938953427bd93` to
`ed0416588ab77003182c74f82acdef076c58bb59`, scoped worktree snapshot trees) found no blocking
issue. Both reviews used separate Sol workers; the available agent-thread limit prevented starting
the planned Luna reviewer. The nonblocking fixture-selection nesting observation is addressed by
a named history selector and one fixture read. All 26 producer cases and 1,450 assertions still pass,
and Biome passes with the captured fixture bytes unchanged. This accepts only the bounded slice;
remaining ticket 91 families, Desktop-source acceptance and full CI still gate ticket completion.

2026-09-23 retained-deadline HTTP400 held admission passes its focused implementation checkpoint.
The actual executor and queue produce Failed1–4 after either acquisition retries with reminted
attempts or reconciliation-read retries with the original attempt. A typed target-lookup HTTP400 at
the exact persisted retry deadline leaves that deadline and attempt unchanged, with no target Create,
acknowledgement or source mutation. Fresh queue/repository restore, independent permanent-deletion
Delta Sync and maintained full refresh yield Ready source-free captures. The two frozen producer
representatives are acquisition4 (SHA-256
`f12eb84f47b12a164a5ee2f26914ce8de318758ac93cd6dce98fa5fa7c2e213b`) and
reconciliation-read1 (SHA-256
`d86d1e47e8f8b8752103b449ad4b6fc1700c5b539bacb194356c73d5e83de223`).
All 26 producer cases pass 1,450 assertions; Biome and nine dependent Core type tasks pass.

Domain behavioral RED refused the new positive history at the original-history gate while its
malformed control passed. Both genuine public SQLite artifacts failed at that same gate. The bounded
production predicate now accepts Failed1–4 with a retained source deadline and either nonempty
attempt relation, while preserving the prior reminted/no-deadline terminal branch and the Failed0/5
deadline limits. The two focused Domain tests and two public source-free locked-reopen/QuickUnlock
cases pass. Public cases preserve exact original DTO/request/scheduling, held projection with no live
deadline, and nonmutating Prepare/Resume refusal. Rustfmt and scoped diff checks pass. Concurrent
ticket105 team-page integration caused temporary public test-binary compile errors; after its owner
restored build coherence, both ticket91 public cases passed. Broader new-slice regressions,
independent review, whole-phase CI and remaining ticket91 source/platform families are still open.
Ticket91 is incomplete.

2026-09-22 reconciliation-read original-attempt held slice passes independent Spec and Standards
review. The only Standards observation was a test-only type name that conflated acquisition and
reconciliation failure counts; its narrow type refinement is applied. The full focused
`missing_source` Rust Domain regression set passes 30/30, and configured public admission cases
pass 15/15 after the concurrent ticket95 projection migration reached a coherent build. The real
producer, fixtures, dependent types, Biome and Rust formatting gates passed as recorded below.
This closes that bounded slice only; other ticket91 admission families and whole-phase checks remain
open.

2026-09-22 reconciliation-read original-attempt holds pass the focused implementation checkpoint.
The maintained producer drives one through four actual source-version failures followed by failed
reconciliation GETs, then a real conflict and genuine-WASM independent copy; a separate five-failure
branch reaches Failed without target Create. Fresh repository/queue restore, independent source
deletion through Sync and maintained full refresh yield Ready source-free captures. The frozen
Conflicted1 and Failed5 artifacts retain original attempt/semantic IDs and exact queue/request rows
(SHA-256 `4d5331614dd44e20994a3490417c7bb6fb7f0749adacb6cee65a30e0facb40b8` and
`fe736882cc25c1b4452a54de26b304bb396099dd3db33259b79c901f1b4c3940`, respectively).
All 18 producer cases pass 956 assertions; Biome and nine Core/dependency type tasks pass.

Domain behavioral RED refused the supported same-attempt history at the original-history gate while
its malformed-history control passed. Both genuine public fixtures failed at that same gate before
the production predicate changed. The bounded change admits Conflicted1–4 and Failed5 with an
explicit nonempty original attempt, retaining prior reminted-attempt branches, exact identity,
deadline, disposition, immutable request, ownership and no-execution guards. The two focused Domain
tests and two public SQLite admission cases now pass. Public cases reopen configured source-free and
locked, unlock with the existing password, retain held projections and original Prepare/Resume
refusal, and leave the genuine independent copy readable and normally dispatchable. Focused Rustfmt
checks pass. A broader Rust lib regression
attempt was interrupted by concurrent ticket95 projection type migration in unrelated tests, not
by a ticket91 runtime failure. Independent review, whole-phase CI, other accepted-work/source-cache
and Attachment variants, and actual Desktop/Extension platform acceptance remain open. Ticket91 is
incomplete.

2026-09-21 post-acquisition terminal holds pass implementation and review as one count-range batch.
The real producer drives one through four acquisition failures, reads each persisted retry deadline,
and verifies a distinct reminted attempt before the actual semantic-rejection or conflict transition.
The final terminal transition preserves that last attempt/count and clears its deadline. The Failed
branch uses the maintained typed target-Create rejection fixture and real rejection callback with no
acknowledgement or remote source mutation. The Conflicted branch uses actual executor version
conflict, queue reconciliation and genuine-WASM conflict-copy creation; the copy has its own ordinary
retry, payload and deadline. Fresh legacy restore, independent permanent-deletion Sync and maintained
full refresh preserve exact queue rows and establish valid Ready source-absent capture. No raw cache,
checkpoint or queue repair is used, and no running Server is claimed by the HTTP fixtures.

The two frozen representatives are Failed1:
`packages/core/src/services/fixtures/legacy-cross-account-missing-source-failed-retry-semantic-rejection.json`
(SHA-256 `8ab55ba8a8b8af1532c7ddb8eee02df26bb6b89760d9649c334339cedc7cfa3e`), and Conflicted4:
`packages/core/src/services/fixtures/legacy-cross-account-missing-source-conflicted-retry-independent-copy.json`
(SHA-256 `cb47c0ac823a180bd85818f69a7effec4d4755f924542ff76868cc65d5fffbbf`).
All thirteen live producer cases pass 665 assertions, Biome and nine dependency type tasks. The five
prior artifacts are unchanged and one-time capture hooks are removed. The copy's actual first retry
is due at 16001 after original acquisition deadlines 1001/3001/7001/15001; its retry count remains one.

The only production delta accepts reminted-attempt Failed1–4 alongside existing Failed0/5 and
reminted-attempt Conflicted1–4 alongside Conflicted0. Exact disposition, diagnostics, no deadline,
copy provenance, semantic/three-child identities and all shared structural gates remain unchanged.
Conflicted5 and same-attempt positive-count histories remain refused. Both new histories retain
inactive ownership and no own overlay, with no original execution, proof, Attachment or Resume path.
There is no new schema, binding surface or diagnostic classifier.

Domain behavioral RED refuses the new positive matrix at the original-history gate; the malformed
history/identity control passes. Both genuine public representatives fail at that same intended gate
before production support. Green passes all 28 missing-source Domain and thirteen public tests.
The matrix covers both statuses/counts with empty/nonempty diagnostics, exact rows, retirement,
inactive ownership, own-overlay refusal and Recovery in both orders; malformed identity/scheduling/
copy/count controls include explicit Conflicted5 refusal. Public acceptance preserves exact source
DTOs/requests/queue indices, configured locked source-free SQLite reopen and genuine unlock. Failed
remains held; Conflicted retains its real readable independent copy, whose exact outcome GET and
immutable Create PUT dispatch while the original row remains unchanged. That PUT stays pending;
only the independent target Account refresh also reaches HTTP, and no completed Server effect is claimed.

The other 187 Replica and 116 admission tests and strict Core all-target Clippy pass. Final Standards
and Spec reviews report no findings on code tree `bc3f4959ebf7a65f4904cbcf3cbbc9b0834cbbdc` relative to
the preceding Failed0 checkpoint. Reconciliation-read retries can retain the original attempt and
remain a distinct next frontier; retained-deadline failures, other accepted-work/source-cache/
Attachment variants, Extension/platform acceptance and both full CI commands remain open.
Ticket 91 is incomplete.

2026-09-21 first-attempt semantic-rejection missing-source holds pass implementation and review.
The maintained producer receives an exact typed target-Create rejection (`vault_read_only`) through
its actual executor and queue, awaits the real rejected reconciler callback, and persists Failed0
without acknowledgement, a new attempt, conflict copy or source Trash/Delete. This is an HTTP protocol
fixture, not a claim of a running Server or actual permission mutation. Fresh repository/queue restore,
actual independent-deletion Sync and maintained full refresh retain the exact command and establish
consistent Ready baselines with absent source authority. No queue/cache/checkpoint repair is used.
The frozen artifact is
`packages/core/src/services/fixtures/legacy-cross-account-missing-source-failed-semantic-rejection.json`
(SHA-256 `5005e29fda8c668d24561bd2622a89678ce887d094d644de57f3527a7c14662e`).
All five producer cases pass 232 assertions, Biome and nine dependency type tasks. The four earlier
artifacts are unchanged. Its original target ciphertext remains opaque held evidence; this path does
not claim historical payload decryption or change the genuine-crypto independent-copy fixture.

The only production change adds Failed0 with explicit equal semantic/raw/attempt IDs alongside the
existing Failed5 distinct-attempt branch. Present diagnostics, including empty text, no deadline,
no copy provenance and exact LegacyFailed disposition remain mandatory. No diagnostic classifier,
rejection receipt or proof is invented. Existing inactive ownership, identity fences, Recovery,
projection and no-execution policy apply unchanged; no public schema or binding changes are needed.

Behavioral RED fails at the intended original-history gate in both the positive Domain case and the
actual public oracle. The two new Domain refusal/fence controls pass before implementation. Green
passes 26 missing-source Domain and eleven public tests, including prior histories. The new public
case shares the existing Failed acceptance journey while retaining exact count-specific attempt
assertions. It proves immutable request/lineage, one inactive held owner, no overlay/authority/receipt,
zero-count LegacyFailed/LegacyHeld projection, locked source-free SQLite reopen, genuine password
unlock and nonmutating Prepare/Resume refusal. The strict parked driver observes only independent
Account refreshes and no original Move HTTP.

The remaining 187 Replica and 116 admission tests and strict Core all-target Clippy pass. Final
independent Standards and Spec review report no findings for code tree
`9ac287e0a4f903b9506b0e9cbd056b09ade3645f` relative to the prior Conflicted checkpoint. Post-retry terminal
histories and other accepted-work/source-cache/Attachment variants, Extension/platform acceptance,
and both whole-phase CI commands remain open; ticket91 is incomplete.

2026-09-21 first-attempt missing-source conflict preservation passes implementation and review.
The maintained producer uses genuine WASM crypto, an actual executor version conflict and repository
conflict preservation to retain the original Conflicted0 Move and its independently enqueued Create.
A real transport failure leaves the copy retrying; fresh repository/queue restoration, independent
permanent-deletion Sync and maintained full refresh produce matching Ready baselines with neither
original nor copy authority present. The immutable two-Account artifact is
`packages/core/src/services/fixtures/legacy-cross-account-missing-source-conflicted-independent-copy.json`
(SHA-256 `ad4019496121f0a30035937fb3d4e41e1528cd8f34e53b1509989ba04c2c9867`).
The four producer cases pass 182 assertions, Biome and nine dependency type tasks. Earlier artifacts
remain unchanged. Core has a test-only workspace dependency on the maintained WASM package.

The closed version-one entry preserves the explicit Conflicted0 history, exact original semantic and
attempt identities, diagnostic including empty text, no deadline and nonempty historical copy ID.
Copy provenance adds no foreign key or ownership reservation. The original remains an inactive
LegacyConflicted/LegacyHeld owner with no overlay, execution or invented source/Attachment evidence;
all original identity fences remain. The real independent copy keeps its exact normal Create,
retry history, own overlay and readable producer ciphertext under the unchanged key and AAD.

Two Domain cases and the corrected actual public fixture fail at the intended history gate before
production changes. The initial public attempt instead exposed a fixture bug: concurrent Account
seeding lost one Account. Sequential maintained seeding and a genuine recapture corrected that
artifact; no raw Account-page repair was used. That initial failure is not behavioral RED.
Green passes all 23 missing-source Domain cases and all ten public cases across the initial nine
passing controls and the corrected focused conflict run. The dispatch tracer initially expected a
source Account refresh while the pending copy PUT held that Account's execution lock. Its corrected
expectation passes: exact copy outcome GET and immutable PUT, plus one independent target refresh;
source refresh waits and no original Move request occurs. The PUT stays pending, with no claim of
Server completion. Locked source-free SQLite reopen, genuine password unlock, actual copy decryption,
exact two owners and queue indices, immutable request/history, no inferred receipt, and original
Prepare/Resume refusal are verified.

The other 187 Replica and 116 admission tests pass. Strict Core all-target Clippy passes. Independent
Standards and Spec reviews report no findings on final code tree
`7d02dbe88c2adcf0c1ffbba73e24edfb5f2d6487` relative to the prior Failed checkpoint, including the final
tracer correction. No public schema or native binding changes. Further accepted-work histories,
Attachment/source-cache variants, Extension/platform acceptance and both whole-phase CI commands
remain open; ticket91 is incomplete.

2026-09-21 exhausted-retry missing-source holds pass implementation and review.
The maintained producer exhausts five actual source-client acquisition failures without executing or
acknowledging the Move. A fresh repository/queue restores the exact Failed row without its projection;
actual Delta Sync then applies independent permanent deletion. Investigation found that this leaves
the legacy cache full-refresh baseline behind the advanced Sync checkpoint, which correctly remains
Cold. The fixture therefore performs a real maintained staged full refresh against the absent source
and current cursor before freezing Ready pages. No raw cache/checkpoint repair or Cold-policy expansion
is used. The Failed queue stays exact across both steps. The immutable artifact is
`packages/core/src/services/fixtures/legacy-cross-account-missing-source-failed-independent-deletion.json`
(SHA-256 `20aba5c01e74bc7e1ace59ea029a4a90aaa8041ece1fa541883a434e059d8a2d`).
All three producer cases pass 144 assertions; the two earlier artifacts remain unchanged.

The closed version-one entry additionally accepts Failed5 with explicit equal queue/semantic IDs,
a nonempty distinct attempt, no deadline, present diagnostic including an empty string, and exact
LegacyFailed disposition. It preserves one inactive held owner, original request and all semantic/three
child-ID fences. Independent same-Item owners and overlays may coexist under existing held policy;
any overlay claiming the unavailable workflow itself remains categorically forbidden, including for
another Item. Normal Pending/retrying source reservation remains unchanged. Both visible ReadOnly
scopes are accepted for held preservation, and LegacyHeld takes precedence over destination retirement.
No source witness, Attachment manifest, remote outcome or execution/reauthorization path is added.

Public behavioral RED preserves all six existing controls and refuses all three real Failed variants
at the original history gate (`/tmp/bittery91-missing-source-failed-public-red.log`). The first Domain
RED contains one real ownership/history refusal and one unrelated duplicate bootstrap-generation
setup failure; expanded RED has a second such setup failure. Those setup failures are not counted as
feature RED. The fixture correction seeds the intended initial authority once, without changing
production bootstrap behavior. Green passes nineteen Domain and nine public tests
(`/tmp/bittery91-missing-source-failed-second-green.log`), including exact history/request persistence,
all identity fences, own-overlay refusal and independent ordinary/captured-workflow coexistence in
both Recovery row orders. Public tests use locked source-free SQLite reopen, genuine password unlock,
actual current-authority Sync, independent Favorite acceptance and readable projection after reopen,
and actual destination removal/re-add plus source Account removal. The held row remains exact except
its original binding retirement. Prepare/Resume issue no HTTP; the public driver identifies only its
independent Account-refresh requests and issues no Move HTTP.

The remaining 187 Replica tests and 116 profile-admission tests pass separately without repeating the
focused cases (`/tmp/bittery91-missing-source-failed-replica-regressions.log` and
`/tmp/bittery91-missing-source-failed-profile-regressions.log`). Strict Core all-target Clippy, producer
Biome and nine Core/dependency type tasks pass. Final Standards and Spec review of the frozen delta
report no findings. No public schema or native binding surface changes. Conflicted/copy histories,
other accepted-work variants, Extension/platform acceptance, and both whole-phase CI commands remain
open; ticket91 is incomplete.


2026-09-21 normal retry acknowledgement-crash admission passes implementation and review.
The next maintained producer case causes one actual source-client acquisition failure, reads the
persisted retry deadline, advances its fixture clock, then executes and acknowledges the real Move
before pausing queue removal. Its separate immutable artifact retains retryCount one, a reminted
attempt ID, deadline and diagnostic under the same original id/operationId. The first Pending artifact
is unchanged. Both producer cases pass 77 assertions; ordinary tests never rewrite their captures.

The same version-one unavailable entry now accepts the closed retrying history: counts one through
four, explicit equal queue/semantic IDs, a nonempty distinct attempt ID, present deadline and present
error including an empty string. Existing safe-integer, exact scheduling/request, source-absence,
identity, owner and overlay guards remain unchanged. The attempt remains lineage; the semantic owner
and three fixed Item child IDs remain original, with no new execution path or scheduled deadline.

Domain RED has two passing controls and one expected history refusal
(`/tmp/bittery91-missing-source-retrying-domain-red.log`). Public RED preserves all five Pending
controls and refuses the real retry capture at that same validation gate
(`/tmp/bittery91-missing-source-retrying-public-red.log`). Green passes fourteen Domain and six public
tests (`/tmp/bittery91-missing-source-retrying-first-green.log`): all supported retry counts, empty
errors, twenty malformed-history controls, exact one-row persistence and Recovery, unchanged Pending
wire, and the genuine retry artifact through locked source-free SQLite reopen and both-Account
QuickUnlock. Prepare/Resume perform no HTTP; the public dispatch driver issues only its independently
recorded Account-refresh GETs, with no Move HTTP or Replica changes. Lineage, request bytes and source
reservation stay exact. The prior frozen Pending implementation separately passed all 134 existing
cross-Account Runtime regressions; that run is not presented as a rerun of this retry extension.

Strict Core all-target Clippy passes (`/tmp/bittery91-missing-source-retrying-clippy.log`), as do producer
Biome and Core/dependency type checks across nine tasks. Final Standards and Spec reviews of the
frozen eight-file delta report no findings. This adds no public schema or native binding surface.
Failed/Conflicted missing-source capture, other producer histories, remaining accepted-work and
Extension/platform acceptance, and both whole-phase CI commands remain open; ticket91 is incomplete.

2026-09-21 parked missing-source admission passes focused implementation and behavioral acceptance.
The maintained TypeScript producer now freezes the genuine acknowledgement gap after the real
repository removes its source cache and before the queue removes its original Pending command.
Actual AccountStore metadata, cache rows and SyncManager cursor/baseline writes form the immutable
oracle; the stateful HTTP test port enforces the original Create/Trash/Delete identities and CAS
sequence. The producer test passes without rewriting its captured JSON. No original source authority,
Attachment manifest or remote outcome is supplied to Core admission.

The existing workflow owner now has a closed entry union. Captured records retain their old wire;
legacySourceUnavailable retains the exact result-free target Create and typed lineage, reserves the
normal source Item plus its semantic/three child IDs, and forbids overlays and execution. The new
public MissingSourceEvidence reason projects the preserved attempt count without a scheduled deadline
or fabricated source. Destination retirement retains ownership; re-add never rebinds; source Account
removal cleans up the owner. Source Vault retirement retains accepted work under existing policy.
Strict map decoding, required-null result evidence and exact request/scheduling validation reject
unsupported or injected representations before changes.

Eleven Domain tests pass, including guarded one-row persistence, Recovery in both row orders,
original/future-ID and independent-owner fences, strict wire and forbidden-mutation controls, optional
history preservation, source Vault retirement/reopen and later-authority ownership refusal. Five new
public tests pass: actual producer-page admission; independently changed current target preservation;
source-free locked SQLite reopen followed by genuine test credential/SRP QuickUnlock; actual destination
RemoveAccount, same-identity SignIn/re-add and source Account cleanup; and actual Runtime live Sync of
new current source authority, readable projection and same-Item Favorite refusal before/after reopen.
Current test credentials and newly served Sync content are explicit current fixture facts, never
claims about missing historical source evidence. Prepare/Resume make zero HTTP requests. A deterministic
public background-driver poll makes only its two independently recorded pending Account-refresh GETs,
with no Move HTTP or Replica changes. Source cleanup leaves no rows and preserves destination state.

The 197-test Replica and 118-test profile-admission regression runs pass before the final additional
controls; the later controls pass separately. All 134 existing cross-Account Runtime regressions pass on the frozen Pending implementation
(`/tmp/bittery91-missing-source-runtime-cross-account-regressions.log`), including captured-source
execution, held proof/reauthorization/completion, Attachment restart and Account/Vault lifecycle.
The final five public Pending controls also pass during the next retry-history RED run.
Dependent TypeScript checks pass across fourteen tasks. Protocol/native generation and drift checks,
the generated validator regression, formatting and strict Core/bindings all-target Clippy pass.
Final Spec review reports no findings. Final Standards review reports no hard breaches or actionable smells.
Both whole-phase CI commands and the remaining ticket91 variants/platform acceptance remain open.

2026-09-21 full remote completion from earlier Item prefixes passes focused implementation and review.
Six behavioral RED tests compiled and failed as expected: five domain cases rejected the new internal
three-proof payload, while public Prepare refused after all three genuine original effects and actual
retirement/re-add at the initial result-free Create checkpoint
(`/tmp/bittery91-fullprefix-red.log`). The shared domain candidate builder now derives the fixed three
original requests, compares every immutable retained child and preserves its outcome. Runtime selects
those candidates only from initial source absence. Durable target/Trash outcomes still skip lookup
and replay; Delete remains freshly checked. The guarded domain independently validates all three
named outcomes and the final Completed record before source cleanup, preserving the public Resume
request and persisted final workflow shape.

Twenty-eight reauthorization domain tests and two Runtime tests pass
(`/tmp/bittery91-fullprefix-first-green.log`). Domain controls cover both holds and reachable earlier
prefixes, closed map-only payload decoding including duplicates, exact state preservation on wrong
proofs/corrupt prefixes/owners, and ordinary-Advance refusal. The initial Failed Create-prefix tracer
checks all three original lookups/replays, final current reads, one final revision with no Pending
publication and exact configured locked/source-free SQLite reopen. The second Runtime test reaches
both actual SourceTrash checkpoints (Failed with absent Trash; Conflicted with result-free Trash),
preserves the durable Create proof without another Create GET/replay, refuses a wrong fresh Trash
version before mutation, and completes with the exact remaining original requests.

A third Runtime test passes across two genuine Missing/Rejected histories
(`/tmp/bittery91-fullprefix-proof-controls.log`). Original Create and Trash exist, but an unrelated
Delete removes the source while original Delete is genuinely absent or rejected. Fresh Prepare and
a valid earlier live-source guard both check all original outcome IDs and refuse without any replay,
commit, projection change or durable-scope mutation. The original ledger remains unchanged.

Thirty-two existing Recovery, ordinary/Attachment Resume, source-continuation, completion-cache,
unmaterialized-Delete and lost-final-reply regressions pass
(`/tmp/bittery91-fullprefix-regressions.log`). Strict Core all-target Clippy passes
(`/tmp/bittery91-fullprefix-clippy.log`). Independent final Standards and Spec reviews of the frozen
ten-file code delta report no findings. Both full-CI commands and the rest of ticket91 remain open.

The next [parked admission after source-cache removal](../desktop-extension/profile-handoff.md#parked-admission-after-source-cache-removal-before-queue-acknowledgement)
is sealed after producer, evidence-model and ownership review. Its first genuine normal Pending
capture retains the command after source-cache acknowledgement but before queue removal, without
inventing source/target authority or Attachment history. A closed entry in the same workflow owner
preserves full-source wire compatibility and normal source reservation, but performs no remote work.
Implementation remains pending.

2026-09-21 completion before fixed Delete materialization passes focused implementation and review.
The nine-test behavioral RED has seven passing refusal controls and two expected failures: the domain
rejects the two-child predecessor, and public Prepare refuses after genuine original remote effects,
actual held recovery to two proved children, retirement/re-add and locked source-free reopen
(`/tmp/bittery91-held-unmaterialized-delete-red.log`). Runtime now derives one ephemeral original Delete
only from initial Server absence, using the same candidate in lookup, replay and both authority passes.
Domain independently derives that child on its cloned record, adds only the exact Applied proof and
validates the complete final row before cleanup. Existing mutation, binding/cache/ownership policy,
three-child completion and ordinary Advance remain unchanged.

Thirty-two domain tests and the first Runtime tracer pass
(`/tmp/bittery91-held-unmaterialized-delete-first-green.log`). The matrix covers both holds, missing/
result-free/Applied Delete shapes and all valid completion-cache states; corruption, proof, owner and
ordinary-Advance controls preserve exact state. The first tracer uses original remote Create/Trash/
Delete effects before Core proof recovery, then completes the actual two-child checkpoint in one
revision with original Delete request bytes and no Pending publication, followed by exact SQLite
reopen. Its Failed history retains the producer's five-attempt exhaustion count.

Three additional Runtime tests pass across four genuine fixtures
(`/tmp/bittery91-held-unmaterialized-delete-variants-green.log`): conflicted source-present Prepare has
no speculative Delete lookup, then genuine original Delete permits the same guard to complete only
with the correct proof; delivered wrong-version proof leaves the original ledger intact; unrelated
absence with original Missing or genuine Rejected refuses both calls; and absence first observed on
confirmation's final reread refuses without lookup/replay/materialization until a new explicit attempt.
The last test wraps only test HTTP, checks the maintained handler's real current CAS precondition and
response shape, and preserves both durable scopes. Configured reopen delegates to an injected-HTTP
helper with all original locked/source-free/zero-HTTP and durable-row assertions intact.

Twenty-eight existing Recovery, ordinary/Attachment Resume, source continuation and completion-cache
regressions pass (`/tmp/bittery91-held-unmaterialized-delete-regressions.log`), and strict Core all-target
Clippy passes (`/tmp/bittery91-held-unmaterialized-delete-clippy.log`). Independent cross-review reports
no Domain or Runtime Spec gaps; Standards review reports no documented breach or actionable smell.
Coordinating review accepts this focused checkpoint. Ticket91 and both final full-CI commands remain
outstanding.

2026-09-21 SourceDelete continuation from exact trashed cache passes focused implementation and review.
The six-test behavioral RED rejects the new serialized internal mutation in five domain cases and
refuses public confirmation after actual Trash Sync
(`/tmp/bittery91-held-trashed-continuation-red.log`). A dedicated private verification/mutation mode
carries the complete current source DTO. Both Runtime authority passes require exact cached/current
equality; Domain independently requires valid Ready Bootstrap and precise original Trash progression.
The unchanged comparison is shared with ordinary dispatch. Existing live-cache continuation and
combined completion retain their separate gates, and only the live-cache mode installs an overlay.
The new mode writes one authorized workflow row, preserving source authority and all original evidence.
No public protocol, persisted workflow representation or Recovery production change is added.

Thirty domain tests and the first genuine Runtime tracer pass
(`/tmp/bittery91-held-trashed-continuation-first-green.log`). Both holds and both child shapes retain
exact source/target/history/scheduling, source reservation and absent overlays. Domain controls reject
audit-only witness disagreement, changed progression, invalid cache/generation/key, retained Delete
results, active/inactive independent owners and ordinary mutation bypass. The Runtime tracer preserves
the exact trashed Authoritative Item while the workflow becomes Pending, checks actual prepared writes
and no Missing Delete send, reopens locked/source-free SQLite while still pending, then completes the
original Delete. Two additional Runtime cases and three completion-cache regressions pass
(`/tmp/bittery91-held-trashed-continuation-variants-green.log`): conflicted/unmaterialized continuation
survives a second actual retirement/re-add/Resume with binding revisions two/three/four, and actual
Trash Sync invalidates the old guard before HTTP. Public Favorite requests while active, retired and
rebound refuse specifically at the existing active-owner fence with unchanged durable state.

Twenty-two existing Recovery, ordinary/Attachment Resume, completion and SourceDelete tests pass
(`/tmp/bittery91-held-trashed-continuation-regressions.log`), and strict Core all-target Clippy passes
(`/tmp/bittery91-held-trashed-continuation-clippy.log`). Independent cross-review of Domain and Runtime
reports no Spec gaps; Standards review reports no documented breaches or smell findings. Coordinating
review accepts the focused checkpoint. Ticket91 and both final full-CI commands remain outstanding.

The next [completion before fixed Delete materialization](../desktop-extension/profile-handoff.md#stopped-completion-before-the-fixed-delete-child-is-materialized)
is sealed after independent producer/proof review. It extends the existing combined completion only
for a durable two-child target/Trash prefix and initial current Server source absence, derives the
already-reserved original Delete ephemerally for proof, and appends it Applied in the single final
completion. Source-present continuation gains no speculative lookup, ordinary Advance remains
unchanged, and valid Ready completion-cache semantics remain intact. Implementation is pending.

2026-09-21 combined completion after active-cache progress passes focused implementation and review.
The seven-test behavioral RED run reports four passes and three expected failures
(`/tmp/bittery91-held-progressed-cache-red.log`): valid progressed cache refuses completion, invalid
Bootstrap can be partly changed before cleanup fails, and real Trash Sync plus locked SQLite reopen
reaches the old confirmation gate. Complete now requires Ready and valid Bootstrap before cleanup;
Continue retains its original exact-live-cache gate. Full original capture, proof/current-authority
checks and owner fences remain unchanged. No Runtime production or representation change is needed.

The green run passes 24 domain tests and three new Runtime cases
(`/tmp/bittery91-held-progressed-cache-first-green.log`). Actual Trash Sync preserves original evidence
then completion removes current authority; actual permanent-Delete Sync permits completion with no
fabricated source write; Sync between Prepare and confirmation invalidates the old guard before any
HTTP, while fresh confirmation succeeds. Tests observe no Pending publication or overlay write and
reopen exact completed SQLite state locked without a source provider. The domain matrix covers both
holds/result forms and valid original/trashed/newer/absent authority, preserves inactive generations
and unrelated work, and refuses malformed authority before cleanup. Newer-cache evidence is domain
coverage, not a claimed Server producer history. A separate both-holds continuation control refuses
trashed/newer/absent cache with exact state preservation
(`/tmp/bittery91-held-progressed-cache-continue-control.log`).

Existing completion, SourceDelete and ordinary Resume regressions pass 14 tests
(`/tmp/bittery91-held-progressed-cache-regressions.log`), and strict Core all-target Clippy passes
(`/tmp/bittery91-held-progressed-cache-clippy.log`). Independent Spec review reports no gaps; Standards
review reports no documented breaches or smell findings. Coordinating review accepts this focused
checkpoint. Both final full-CI commands and the whole ticket remain outstanding.

The next [SourceDelete continuation from trashed cache](../desktop-extension/profile-handoff.md#stopped-sourcedelete-continuation-from-a-trashed-active-cache)
is sealed after independent projection/ownership/Recovery/interface review. It keeps exact current
trashed authority without a source overlay, while the authorized Pending workflow reserves its
source. A dedicated internal witness-bearing mode must require complete cache/current equality and
precise original Trash progression; existing continuation and completion keep separate gates.
Implementation and its acceptance remain pending.

2026-09-21 absent-target destination reauthorization passes focused implementation and acceptance.
The public both-holds tracer first fails on the old held Missing rule
(`/tmp/bittery91-held-absent-target-red.log`). The only production change permits Missing for the
fixed result-free TargetCreate child during explicit reauthorization. Existing current-authority
checks distinguish genuine absence from proof; confirmation sends no undecided request, and normal
dispatch later sends the original Create exactly once. No domain or public representation changes.

The positive test passes both original holds with exact immutable rows, source overlay and original
three-step completion (`/tmp/bittery91-held-absent-target-first-green.log`). Five additional Runtime
variants pass alongside four existing controls (`/tmp/bittery91-held-absent-target-variants-green.log`):
unrelated target appearance after Prepare, genuine original rejection, source Trash progress,
original Applied Create whose target is subsequently trashed/deleted under independent IDs, and
genuine original target appearance using the existing proof-confirmation path. The old manually
retired/Missing refusal is superseded; its both-holds Active-binding refusal remains, along with
exact-present-target/Missing and wrong-proof controls. A narrow test-only item-ID parameterization
preserves the existing fixture handler default; independent target effects use that handler with
explicit version assertions. This is maintained-handler/crypto/SQLite evidence, not external Server
or general routing/CAS conformance. Strict Core all-target Clippy passes
(`/tmp/bittery91-held-absent-target-clippy.log`). Independent Spec review reports no material findings;
Standards review reports no documented breaches or smell findings. Coordinating review accepts the
focused checkpoint.

The next [completion after active-cache progress](../desktop-extension/profile-handoff.md#stopped-completion-after-active-cache-progress)
is sealed after coordinating and independent review. Only combined completion may replace exact
original live-cache equality with Ready/valid-active-generation authority, preserving the original
capture and full proofs. Fresh current absence uses the existing guarded Sync cleanup; continuation
keeps exact-live cache requirements. Actual trashed/absent Item-event Sync and revision races are
specified before implementation; newer-cache coverage must be labelled domain evidence. Ticket91
and both final full-CI commands remain outstanding.

2026-09-21 stopped remote-completion reconciliation completes focused implementation and review.
The actual six-test RED run rejects the new serialized internal mutation in five domain cases and
refuses current source absence through public Prepare (`/tmp/bittery91-held-completion-red.log`).
One private Runtime result selects continuation or verified completion. Completion freshly checks
original Delete even with a durable result, replays only a missing local result with its exact hint,
and rereads target/source after proof work in both branches. One combined domain mutation shares
binding/lineage derivation and ordinary source cleanup, checks exact original source cache and
independent ownership, and completes without installing an overlay. Both persistence classifications
derive writes from the final snapshot; no store, schema, public protocol or workflow variant is added.

All 23 domain tests plus the first public tracer pass (`/tmp/bittery91-held-completion-first-green.log`).
The domain matrix covers both holds/result forms, exact final prepared writes, wrong/replacement
proof, stage/binding/cache/active and inactive owner refusals, and whole-plan rollback. Three more
Runtime cases pass alongside all eight remaining SourceTrash/SourceDelete cases
(`/tmp/bittery91-held-completion-variants-green.log`): Conflicted with durable Delete proof and no
replay, valid continuation Prepare followed by original remote Delete, and actually committed SQLite
completion with its reply lost. Recorded real writes and public observation sinks prove one final
revision, source removal and no optimistic overlay write or Pending publication. Locked source-free
reopen recovers exact completion and refuses the old guard without HTTP. The prior SourceDelete-only
genuine-completion refusal is intentionally replaced by the specified completed result; unrelated
Delete/Missing-original proof still refuses.

Eleven existing normal/Attachment Resume, first-authorization proof/refusal and held Missing-dispatch
tests, seven streaming Recovery tests and strict Core all-target Clippy pass
(`/tmp/bittery91-held-completion-regressions.log`, `/tmp/bittery91-held-completion-recovery-green.log`,
`/tmp/bittery91-held-completion-clippy.log`). Independent production, Standards and Spec review reports
no findings. These are focused checks within unfinished91; both full-CI commands and all remaining
source/Attachment/Extension/platform acceptance remain required.

The next [absent-target authorization path](../desktop-extension/profile-handoff.md#stopped-absent-target-destination-reauthorization)
is sealed after coordinating and independent review. Missing original Create plus actual target
absence may authorize future original dispatch through the existing mutation; confirmation sends
nothing undecided. Evidence is recomputed: genuine original Applied plus exact target can use the
prior proof path, while target appearance with unrelated/Missing proof refuses. Implementation is pending.

2026-09-21 [stopped remote-completion reconciliation](../desktop-extension/profile-handoff.md#stopped-remote-completion-reconciliation)
is sealed before implementation after coordinating and independent review. With exact original live
cache/capture, all three materialized children and proved target/Trash, a fresh original Delete
Applied result plus exact target/current source absence permits one atomic authorization/completion.
Both result-free and durable-equal Delete forms are specified. A combined internal mutation shares
binding and cleanup policy and never installs an overlay. Confirmation rereads target and absence
after the lookup in both branches, even with no replay. This deliberately extends SourceDelete's
temporary completed-absence refusal while retaining Missing/unrelated/rejected proof refusal.
The focused implementation and passing acceptance are recorded above.

2026-09-21 stopped SourceDelete destination reauthorization passes its new focused acceptance.
The combined domain/public Runtime RED run has one refusal control pass and two expected failures
at the unsupported shape (`/tmp/bittery91-held-sourcedelete-red.log`). The shared predicate now admits
the proved target/Trash prefix, with either no future Delete child or its fixed result-free child.
Explicit authorization alone permits Missing for that future Delete. Both current-authority passes
require a present precisely trashed source; the guarded commit separately requires the exact live
Ready cache, restores the existing normal Pending overlay and preserves all original evidence.

All 18 domain tests and the materialized Failed public tracer pass
(`/tmp/bittery91-held-sourcedelete-first-green.log`). Four additional Runtime cases pass alongside all
four SourceTrash cases (`/tmp/bittery91-held-sourcedelete-variants-green.log`): Conflicted with no
materialized Delete, genuine original Delete rejection, original Delete applied after valid Prepare,
and source deletion under another identity while the original outcome remains genuinely Missing.
Confirmation sends no undecided Delete; normal dispatch completes the original request. Refusals
preserve both snapshots/durable rows with no authorization, overlay or additional effects. Strict
Core all-target Clippy passes (`/tmp/bittery91-held-sourcedelete-clippy.log`). Ten existing normal
Resume, first-authorization proof/refusal and held Missing-dispatch regressions pass
(`/tmp/bittery91-held-sourcedelete-regressions.log`). Independent production,
test and Spec review finds no material issue. Public contracts and persisted representations remain
unchanged. This is a focused checkpoint within unfinished91, with full CI and remaining acceptance
still required; remotely completed work is a separate reconciliation frontier.

2026-09-21 stopped SourceTrash destination reauthorization passes focused implementation and
independent Spec/Standards review. Actual guarded-domain and public Runtime RED tests fail on the
previous shape restriction (`/tmp/bittery91-held-sourcetrash-domain-red.log`,
`/tmp/bittery91-held-sourcetrash-runtime-red.log`). Runtime and Domain now share the supported shape
predicate. Explicit authorization alone permits a Missing prospective Trash; confirmation sends no
undecided request, retains the original proved target prefix, and atomically restores normal Pending
ownership. Both authority passes require the exact live current source independently of the exact
Ready cache check. Ordinary held dispatch remains proof-only.

All four new Runtime cases pass: Failed/materialized Trash, Conflicted/unmaterialized Trash, genuine
Trash rejection, and original Trash applied remotely after valid Prepare while the cache remains
live. The refusal cases preserve exact snapshots/durable rows and create no authorization or overlay.
The seven-test SourceTrash selection also passes four existing source/Attachment regressions
(`/tmp/bittery91-held-sourcetrash-green.log`); all 16 workflow-domain tests and the late-proof Runtime
case pass together (`/tmp/bittery91-held-sourcetrash-domain-and-late-proof-green.log`). Strict Core
all-target Clippy passes (`/tmp/bittery91-held-sourcetrash-clippy.log`). Nine existing normal Resume,
first TargetCreate authorization and held Missing-dispatch/Resume regressions pass
(`/tmp/bittery91-held-sourcetrash-regressions.log`). No persistence or cross-language
wire representation changes in this extension. These are focused checks within unfinished ticket91;
both literal full-CI commands and all remaining platform/source/Extension acceptance remain required.

The next [SourceDelete path](../desktop-extension/profile-handoff.md#stopped-sourcedelete-destination-reauthorization)
is sealed after coordinating and independent review. It retains the exact live capture/cache and
normal Pending overlay, requires the durable TargetCreate/Trash prefix and a present precisely
trashed current Server source, and permits only future original Delete after explicit authorization.
Remote absence remains a separate completion-reconciliation mapping. Implementation is pending.

2026-09-21 first explicit stopped-work destination reauthorization completes focused implementation
and review. Behavioral RED rejects the new authorization payload and guarded activation, while a genuine
original target effect plus public destination removal/re-add reaches the temporary Prepare refusal
(`/tmp/bittery91-held-reauth-domain-red.log`, `/tmp/bittery91-held-reauth-runtime-red.log`). The existing
Prepare/Resume action now authorizes the bounded exact-target TargetCreate path under writable,
current scope and shared source-owner checks. Its one guarded commit updates destination binding
and closed DestinationReauthorized metadata, preserves the original prior hold/DTO/requests/results/
scheduling, and installs the exact normal source overlay. Another active owner or any independently
stored overlay, including inactive held evidence, prevents activation. Repeated confirmation keeps
prior-hold evidence and preserves its existing overlay or legitimate Vault-retirement absence.

A first combined run proved the new durable transition but exposed a stale Authoritative Item view
(`/tmp/bittery91-held-reauth-first-green.log`, three passed/one failed). Initial held activation now
refreshes the existing decrypted projection before publication, as normal Move admission does.
All 15 workflow-domain tests, seven streaming Recovery tests and five new Runtime tests pass
(`/tmp/bittery91-held-reauth-expanded-green.log`). The Runtime cases include both holds, original-ID
completion, real SQLite locked/source-free reopen, an actually committed authorization with its
reply lost, stale-guard refusal, second retirement/confirmation, independent Favorite ownership,
and both RSA Member roles becoming ReadOnly through actual Sync. Two additional proof tests reject
wrong-version delivered hints and genuine Missing/Rejected original outcomes through both Prepare
and Resume without writes (`/tmp/bittery91-held-reauth-proof-refusals-green.log`). Seven existing
normal/Attachment Resume tests, all 116 public admission tests and strict Core all-target Clippy pass
(`/tmp/bittery91-held-reauth-normal-resume-regressions.log`,
`/tmp/bittery91-held-reauth-public-admission-green.log`,
`/tmp/bittery91-held-reauth-core-reviewed-clippy.log`).

Independent Spec review accepts this bounded mapping and its explicit limits. Runtime evidence uses
maintained in-process Server handlers and real crypto/SQLite; the ReadOnly tests establish refusal
before Prepare, while per-await writable fences are supported by code review and existing guard
structure. Standards review finds no code-standard or smell violations; coordinating and independent reviews
accept the checkpoint. Both literal full-CI commands remain required before the phase completes.
Original held later stages, absent-target authorization,
source/Attachment/Extension variants and final full-CI/platform acceptance remain required; this is
not ticket91 completion.

2026-09-21 the next [stopped SourceTrash reauthorization path](../desktop-extension/profile-handoff.md#stopped-sourcetrash-destination-reauthorization)
is recorded after coordinating and independent source/ownership review. A proved original target and
exact live source may support explicit authorization of an undecided original Trash. The Missing
exception is confined to that future child during confirmation; background held dispatch and absent-
target refusal retain their proof requirements. Both child shapes, exact current/live cache checks,
original evidence, guarded ownership and later-source boundaries are specified before implementation.

2026-09-21 the first stopped cross-Account proof path completes focused implementation and review.
Actual public/domain regressions rejected failed/conflicted rows before implementation; a genuine
Server Runtime regression then sent target Create despite Missing original proof. The existing
workflow now retains either hold with its exact DTO, original child reservations and no overlay,
allows readable proof scopes, and requires fresh original proof before replay. Missing parks without
sending or polling; transient proof failures retain workflow backoff. Original prefixes reconcile
sequentially, with durable Delete proof plus fresh source absence required for completion. Public
projection preserves LegacyFailed/LegacyConflicted and inner LegacyHeld. Both actual ReadOnly roles,
source SignOut, destination removal/reopen, Sync reconciliation, first-path Resume refusal and a lost
SQLite Delete-result reply pass. Separate active requests/overlays survive terminal reconciliation.
The public runner parks the held proof while a same-source Favorite completes: its later SourceChanged
guard preserves the hold and original requests. The test's initial stale Ready expectation was
corrected without weakening that production guard.

All 116 public admission tests, nine workflow-domain tests, six streaming Recovery tests, the
focused real-crypto Runtime matrix and five existing normal/Resume regressions pass. Evidence includes
`/tmp/bittery91-held-cross-admission-pages-green.log`,
`/tmp/bittery91-held-cross-domain-green.log`, `/tmp/bittery91-held-cross-recovery-green.log`,
`/tmp/bittery91-held-cross-runtime-first-green.log`,
`/tmp/bittery91-held-cross-lifecycle-crash-readable-green.log`,
`/tmp/bittery91-held-cross-coexistence-final-green.log` and
`/tmp/bittery91-held-cross-normal-regressions.log`. Expanded intermediate runs retain their fixture
failures honestly; their successful cases and the subsequent corrected runs establish the matrix.
The actual TypeScript queue rejection oracle preserves the complete cross DTO/history across durable
restore (69 tests/194 assertions), with Biome passing. Generated protocol/native bindings, 53 binding
tests plus five downstream checks, 27 generator tests, 14 dependent type checks and strict Core
all-target Clippy pass. Coordinating review and independent Standards/Spec reviews accept this
focused checkpoint. This does not replace the earlier frozen full-CI checkpoint or complete ticket91.

The next [explicit held destination reauthorization path](../desktop-extension/profile-handoff.md#first-stopped-work-destination-reauthorization)
is recorded after independent source/ownership review. It restores normal ownership only through
accepted83 confirmation with an exact existing target and its original proof, preserves the prior
hold and binding revision, and retains writable scope checks throughout authorization. Implementation
and new acceptance checks are pending; broader source/Attachment/Extension paths remain required.

2026-09-21 the [first stopped cross-Account proof path](../desktop-extension/profile-handoff.md#first-stopped-cross-account-proof-path)
is recorded after coordinating and independent source/model review. It selects inactive no-overlay
holds, record-aware readable proof scopes, fresh original proof before every child replay, explicit
LegacyHeld projection and a temporary first-slice Resume refusal with a durable guard. The existing
accepted explicit83 DestinationReauthorized continuation remains required later. Implementation
starts with public failed/conflicted admission regressions and a normal-overlay control, followed by
the zero-count Missing-proof Runtime tracer. This records a decision, not implementation completion.

2026-09-21 durable legacy baseline scope validation completes focused implementation and review.
Two reproducing domain tests accepted a foreign-Server cache baseline as Cold during admission and
serialized reload, while seven existing/control tests passed
(`/tmp/bittery91-legacy-baseline-scope-first-red.log`). The shared origin validator now requires the
baseline's normalized Server to equal the admitted origin before considering cursor corroboration
or a captured failed-Create refresh reason. Same-scope missing corroboration remains valid Cold
evidence. All nine domain tests, all 109 public admission tests and strict Core all-target Clippy pass
(`/tmp/bittery91-legacy-baseline-scope-green.log`,
`/tmp/bittery91-legacy-baseline-scope-admission-pages-green.log`,
`/tmp/bittery91-legacy-baseline-scope-core-clippy.log`). Coordinating and independent review accept
the guard and regression controls. This focused check does not replace the separately recorded
full-CI checkpoint or complete ticket91.

2026-09-21 original-child recovery after legacy remote progress completes focused implementation
and review. Actual regressions show a remote Trash prefix stuck at TargetCreate and a durable Trash
result bypassing a later restored-source check
(`/tmp/bittery91-remote-progress-public-runtime-first-red.log`,
`/tmp/bittery91-remote-progress-durable-trash-first-red.log`). Only original, normal, no-Attachment
legacy workflows with their initial destination binding now recognize exact post-Trash or absent
current source. Exact current target remains required even beside durable Create proof. Each replay
beyond its own precondition requires the original Applied entity/version before sending, followed by
the existing exact replay comparison. Pure child preparation retains the sequential domain guards;
completion still needs durable original Delete proof and fresh absence. Ordinary, Attachment and
reauthorized workflow behavior remains unchanged. Ten new real-crypto Runtime tests pass, including
both remote prefixes, every missing original proof, rejected/wrong-version/disagreeing proof, changed
or absent target after durable proof, restored source, and actual SQLite lost preparation/result
replies followed by locked reopen and QuickUnlock
(`/tmp/bittery91-remote-progress-matrix-first.log`,
`/tmp/bittery91-remote-progress-proof-refusals-first.log`). These use the maintained in-process Server.
Two ordinary source tests, five ordinary fault tests, the existing changed/trashed-source refusal
test and strict Core all-target Clippy pass; the exact post-Trash/absent-target case now reaches
TargetChanged while retaining all no-effect assertions
(`/tmp/bittery91-remote-progress-existing-source-green.log`,
`/tmp/bittery91-remote-progress-existing-fault-green.log`,
`/tmp/bittery91-remote-progress-existing-legacy-refusal-green.log`,
`/tmp/bittery91-remote-progress-core-clippy.log`). Actual TypeScript executor tests cover lost Trash
and Delete replies with mocked API clients, exact child IDs/ETags and unchanged caller command:
ten tests/32 assertions, Biome and nine type-check tasks pass. They do not claim cache or queue
persistence. Coordinating and independent production/test reviews accept the checkpoint. The full-CI
snapshot remains separately recorded below. Stopped workflows, Attachment and source-cache variants,
Extension primitives and full platform acceptance remain required; ticket91 is incomplete.

2026-09-21 normal cross-Account scheduling history completes focused implementation and review.
Actual public and durable-domain regressions reject the previously unsupported history
(`/tmp/bittery91-cross-history-public-first-red.log`,
`/tmp/bittery91-cross-history-domain-first-red.log`). Admission now accepts all five normal status
shapes, retains the complete source DTO and initializes the existing workflow schedule from its
retry count and optional deadline. Durable reread permits guarded live schedule evolution without
rewriting that evidence. Departed claims confer no ownership; original child IDs, bytes, proof
requirements, exact cached base and writable-scope boundaries remain unchanged. All 109 public
admission tests, seven workflow-domain tests, four workflow-recovery tests and strict Core all-target
Clippy pass (`/tmp/bittery91-cross-history-admission-pages-green.log`,
`/tmp/bittery91-cross-history-domain-green.log`, `/tmp/bittery91-cross-history-recovery-green.log`,
`/tmp/bittery91-cross-history-core-clippy-final.log`). Three new Runtime tests pass, including seven
status/claim cases and a locked SQLite reopen followed by actual QuickUnlock, public scheduling,
no early lease/HTTP, retained-count backoff and all three original child proofs
(`/tmp/bittery91-cross-history-runtime-scheduling-startup-fixed.log`). The four existing workflow
tests pass on their unchanged fixture path. Initial scheduling fixtures incorrectly used an already
ready constructor that skipped catalog startup; the correction uses normal startup with only a
manual clock/timer, plus a durable locked-row assertion before Replica loading. The failed runs
remain `/tmp/bittery91-cross-history-runtime-actual.log` and
`/tmp/bittery91-cross-history-runtime-scheduling-reopen-fixed.log`; no production correction was
needed for those fixture failures. The actual TypeScript queue test proves a retry before any child
executor is contacted, with 69 tests/188 assertions; both byte-oracle tests and nine type-check tasks
pass. Coordinating and both independent reviews accept this checkpoint. The preceding full-CI
snapshot remains separately recorded below. Original-child proof recovery after remote progress is
the next recorded frontier; ticket91 remains incomplete.

2026-09-21 stopped Update with newer confirmed cache completes focused implementation and review.
The public regression fails at the old exact-base comparison
(`/tmp/bittery91-newer-cache-public-first-red.log`). Only failed/conflicted Update now permits
cached version greater than or equal to the original base; normal commands and other held kinds
retain equality. Scope/live-Item checks, original payload/base/If-Match/fingerprint and current
authority stay unchanged. All 106 public admission tests, 23 focused recovery tests, thirteen
real-crypto Runtime tests and strict Core all-target Clippy pass
(`/tmp/bittery91-newer-cache-admission-pages-green.log`,
`/tmp/bittery91-newer-cache-recovery-green.log`, `/tmp/bittery91-newer-cache-runtime-green.log`,
`/tmp/bittery91-newer-cache-core-clippy.log`). Ten focused public tests cover both holds, read-only
scope, exact source-free reopen, independent conflict-copy work and retained refusal boundaries
(`/tmp/bittery91-newer-cache-public-green.log`). Four new Runtime tests contain 28 cases covering
missing proof, both genuine outcomes through dispatch and Sync, fetched versions eight/ten beside
cache nine, below-result authority fencing and newer active overlays. The existing nine tests pass.
Historical Applied proof is established at source version six before later encrypted authority;
Rejected/missing history retains encryption version four. These use the maintained in-process
test Server. Recovery preserves both row orders and physical owners without new storage shapes.
Two fixture corrections were required: independent Create uses its semantic identity, and newer
authority must enter through guarded Sync instead of reusing a Bootstrap generation
(`/tmp/bittery91-newer-cache-public-copy-expectation-failure.log`,
`/tmp/bittery91-newer-cache-runtime-bootstrap-fixture-failure.log`). Neither required a production
change beyond the admission predicate. Coordinating and independent reviews accept the final code.
The preceding full-CI snapshot is recorded below; normal cross-Account scheduling history proceeds
next from separately reviewed test preparation. Ticket91 remains incomplete.

2026-09-21 both literal CI commands now pass on the same frozen ordinary-holds snapshot
`345e7f7a7a75deca8298b3ae6bd5b7ad48cac571`. `pnpm check:ci` passes all package checks and
63 actual Chromium tests across twelve suites (`/tmp/bittery91-held-ordinary-check-ci.log`).
`pnpm check:ci:rust` passes Server checks, crypto, 1,247 Core tests, all 103 public admission
tests, the other integration suites, 64 generator tests, all generated contracts/conformance,
native bindings, Web bindings and Desktop checks
(`/tmp/bittery91-held-ordinary-check-ci-rust.log`). Web bindings pass eleven tests with one
intentional feature-only skip; Desktop passes 205 library and 60 integration tests with its
25 existing opt-in tests ignored. The final generated comparison and complete comparison against
the disposable snapshot index are clean; the real staging area remains untouched. This closes the
ordinary-holds CI checkpoint, not ticket91. Reviewed newer-cache Update acceptance tests were
prepared separately during the run and are now entering the regression/implementation sequence.

2026-09-21 the exact-base ordinary-holds frontier completes its focused implementation and review.
Favorite, Trash, Restore, Permanent-delete and same-Account Move now retain the original request,
complete source history and local hold without an overlay or witness. Normal write and exact-base
gates remain unchanged. All 103 public admission tests and strict Core all-target Clippy pass
(`/tmp/bittery91-held-existing-admission-pages-green.log`, `/tmp/bittery91-held-existing-core-clippy.log`).
The four new public tests cover twelve source shapes across both holds, exact authority and requests,
ReadOnly scopes, representative locked reopen, missing Move keys and the existing whole-queue
Travel refusal. Refusals preserve full protected/source values and the complete SQLite head/rows
(`/tmp/bittery91-held-existing-public-reviewed-green.log`). Twenty domain tests and 22 focused recovery
tests pass, including all ordinary holds in either row order and actual either-Vault Move retirement
(`/tmp/bittery91-held-existing-domain-final-green.log`, `/tmp/bittery91-held-existing-recovery-green.log`);
the unchanged three workflow recovery tests remain included in the upcoming full gate.
Nine real-crypto Runtime tests pass, including forty independent kind/status/outcome/dispatch-or-Sync
combinations, ten newer-owner coexistence cases, live Restore/Permanent-delete rejection, Move
retirement and Attachment/category fences
(`/tmp/bittery91-held-existing-runtime-final-vault-proof-green.log`). These use the maintained
in-process test Server. The initial Move test incorrectly prohibited any authority change after
retirement; corrected expectations allow proven current authority in an unretired visible Vault
while preserving retired Vault absence and its cleanup journal. The failed expectation log remains
`/tmp/bittery91-held-existing-runtime-final.log`; no production correction was required.
Coordinating and independent reviews accept the final code. Normal Web regeneration passes without
generated-source changes (`/tmp/bittery91-held-ordinary-web-regenerate.log`). The subsequent literal
CI results are recorded above. This checkpoint does not complete91.

2026-09-21 the later newer-cache Update frontier now has an actual TypeScript queue-producer oracle
in `packages/sync/src/__tests__/sync-engine.test.ts`. It retains source/semantic/attempt IDs and the
base-six/payload-seven request while emitting mapped authority version nine/encryption version four
to the reconciler, awaits that callback, then records the immutable conflicted command. Exact DTO
persistence and fresh queue restoration pass. A deferred callback proves the awaited ordering; a
controlled removal of only that production `await` fails with premature conflict preservation
(`/tmp/bittery91-newer-cache-producer-await-negative-control.log`), after which source bytes were
restored exactly. All 68 producer-suite tests and 176 assertions pass
(`/tmp/bittery91-newer-cache-producer-barrier-final-green.log`), and both reviews accept the test.
The final post-regeneration type gate passes six package tasks
(`/tmp/bittery91-newer-cache-producer-barrier-types-final-green.log`).
This is the actual queue/reconciler boundary with opaque ciphertext, not a physical ItemCache or
cryptographic acceptance claim. Rust admission still requires an exact cached base at this checkpoint.

2026-09-21 exact-base held Update completes its bounded checkpoint. All 99 public admission tests
and strict Core all-target Clippy pass (`/tmp/bittery91-held-update-admission-pages-green.log`,
`/tmp/bittery91-held-update-core-clippy.log`). Seven public tests cover exact source/request retention,
confirmed cache without an overlay, both local holds, ReadOnly, newer active work in either source
order, source-free locked reopen, interrupted physical install and 26 malformed variants
(`/tmp/bittery91-held-update-public-combined-final-green.log`). Twenty-six variants span both statuses;
they do not represent 26 independent test functions. Nineteen legacy domain tests and 25 recovery
tests pass, including actual Vault retirement and immutable compact lineage
(`/tmp/bittery91-held-update-domain-final-green.log`, `/tmp/bittery91-held-update-recovery-green.log`).
Three real-crypto Runtime tests include sixteen independent status/outcome/dispatch-or-Sync/newer-work
combinations. They retain confirmed plaintext, park without original-attempt proof, reject a semantic-ID
substitute and preserve newer overlays through genuine Applied and Rejected completion
(`/tmp/bittery91-held-update-runtime-status-matrix-green.log`). Coordinating and independent reviews
found no blocker. The same recorded exact-base frontier now widens to the remaining five ordinary
kinds; Favorite public admission and durable lifecycle have actual unsupported-disposition regressions
(`/tmp/bittery91-held-existing-public-first-red.log`, `/tmp/bittery91-held-existing-domain-red.log`).
Newer-cache admission, workflow history and remaining platform acceptance stay incomplete.

2026-09-21 exact-base held Update now has actual regressions at public admission, durable domain,
streaming recovery and real-crypto Runtime seams. Public open refuses the source status; the other
three reject the unsupported durable disposition (`/tmp/bittery91-held-update-public-first-red.log`,
`/tmp/bittery91-held-update-domain-red.log`, `/tmp/bittery91-held-update-recovery-red.log`,
`/tmp/bittery91-held-update-runtime-red.log`). Core implementation is in progress against these
failures. Confirmed-authority projection, original-attempt proof and aggregate review remain pending.

2026-09-21 interim CI corrections now pass their complete affected stages. Normal Web regeneration
and `check:bindings:web` pass with eleven combined-binding tests and one feature-only skip
(`/tmp/bittery91-web-bindings-check-final-green.log`); the generated delta is one closure-index
comment. Its intervening test failure was a stale Platform Get fixture returning `done`, which made
Wipe stop with incomplete platform storage before reaching sink cleanup. A corrected shared fixture
and isolated Node Worker cases prove exactly one attempt and a still-pending Wipe for missing and
throwing timers, with bounded parent timeout and owner termination. Runtime timer behavior did not
change. The original failure and causal probe are retained in
`/tmp/bittery91-web-bindings-check-red.log` and
`/tmp/bittery91-web-bindings-timer-platform-corrected-unopened.log`.
Desktop formatting, strict all-target Clippy, 205 library tests, 60 integration tests and generated
comparison pass (`/tmp/bittery91-interim-desktop-final.log`; 25 opt-in tests ignored by this standard
suite). Clippy's actual unused-import failure was fixed by limiting `std::sync::Mutex` to test builds;
independent review accepted it. Coordinating review accepted the generated/test corrections. All
Rust command stages have now passed across the recorded runs; the literal full Rust command still
requires its next checkpoint rerun. Exact-base held Update now proceeds test-first.

2026-09-21 read-only producer/domain reviews also resolve two later bounded widenings:
[stopped Update with newer confirmed cache](../desktop-extension/profile-handoff.md#stopped-update-with-newer-confirmed-cache)
and [normal cross-Account scheduling history](../desktop-extension/profile-handoff.md#normal-cross-account-scheduling-history).
The former retains the old immutable request beside newer authority without rollback or replay
permission; the latter uses the existing workflow schedule without inferring child progress.
Coordinating and independent reviews found no blocker within their stated refusal boundaries.
Neither widening is implemented yet; exact-base held Update remains the next path after interim CI.
Extension source inspection separately identifies raw Chrome/IndexedDB readers, the session marker
and awaited old-owner drain as remaining work. Its future primitive admission acceptance must not
depend on74's later production assembly, which would introduce a cycle through66 and91.

2026-09-21 the interim literal `pnpm check:ci` gate passes
(`/tmp/bittery91-interim-check-ci-final.log`), including all 63 actual Chromium tests across twelve
suites. Its initial failure exposed the Chromium orchestration test's missing device-timer entry;
the expected serial list now includes the already-active production suite without weakening shared
binding or ordering checks. The focused script suite passes four tests. The Rust gate passed crypto
before identifying six older formatting gaps; scoped rustfmt-only corrections pass workspace and
Desktop formatting checks. The literal Rust rerun passes crypto, 1,235 Core tests, all 92 public
admission cases, 64 generator tests, generated contracts/conformance and native bindings, then fails
the Web binding comparison on one stale wasm-bindgen closure-index comment. Regeneration and the
remaining Desktop stages are running separately; the full Rust command will run again at the next
implementation checkpoint. This avoids repeating unchanged suites before the focused correction is
verified and does not claim a successful full Rust command. The real Git staging area remains
unchanged; generated-file comparisons use a disposable index. This interim gate does not complete91.

2026-09-21 captured failed-Create cache completes its bounded checkpoint. All 92 public admission
tests, 17 legacy domain tests, 25 recovery tests, the persisted refresh-origin test and strict Core
all-target Clippy pass (`/tmp/bittery91-failed-cache-admission-pages-green.log`,
`/tmp/bittery91-failed-cache-legacy-domain-green.log`, `/tmp/bittery91-failed-cache-recovery-final.log`,
`/tmp/bittery91-failed-cache-origin-green.log`, `/tmp/bittery91-failed-cache-core-clippy.log`). Seven
public cases cover strict producer rows, 25 malformed variants, forced refresh with original baseline
evidence, both overlay-precedence orders, read-only holds, locked source-free reopen and ambiguous
install without reinstall (`/tmp/bittery91-failed-create-cache-public-final.log`). The actual
read-only refusal regression precedes the narrow held-only role correction
(`/tmp/bittery91-failed-create-cache-readonly-public-red.log`); normal writes retain their role gate.
Fourteen held-runtime tests plus actual retirement/visibility and both proven outcomes pass, as do
87 ordinary outcome/Sync regressions (`/tmp/bittery91-failed-cache-runtime-green.log`,
`/tmp/bittery91-failed-cache-runtime-retirement.log`, `/tmp/bittery91-failed-cache-outcome-regression.log`).
Coordinating source/domain/public/runtime review and independent producer/recovery review found no
blocker. Both literal full CI gates are running as an interim check with a disposable Git index.
The reviewed [remaining ordinary holds frontier](../desktop-extension/profile-handoff.md#remaining-ordinary-holds-with-an-exact-confirmed-base)
starts with Update after those gates; stale bases and remaining ticket91 acceptance stay incomplete.

2026-09-21 captured failed-Create cache now has its public refusal regression
(`/tmp/bittery91-failed-create-cache-public-red.log`) and strict durable-schema regression
(`/tmp/bittery91-failed-cache-recovery-red.log`). The actual TypeScript producer oracle confirms
complete row contents, semantic/fallback identity, zero/nonzero milliseconds and unchanged baseline
after overwriting confirmed version-one cache; all 52 producer-suite tests and nine Core type tasks
pass (`/tmp/bittery91-failed-cache-typescript-producer-final.log`,
`/tmp/bittery91-failed-cache-producer-types-final.log`). Independent review accepts those checks and
the new recovery scenarios. With the new schema, runtime regressions additionally reproduce Pending
projection and active ownership for the captured held overlay
(`/tmp/bittery91-failed-cache-runtime-projection-red.log`). Mapping, runtime fixes and aggregate
checks remain in progress; this is not completion of the captured-cache path.

2026-09-21 the first cross-Account checkpoint is complete: all 85 public admission tests, 15 legacy
domain tests, 22 recovery tests and strict Core all-target Clippy pass
(`/tmp/bittery91-cross-admission-pages-green.log`, `/tmp/bittery91-cross-legacy-domain-final-green.log`,
`/tmp/bittery91-cross-recovery-green.log`, `/tmp/bittery91-cross-core-clippy-final.log`). The final six
public cases also pass (`/tmp/bittery91-cross-account-public-final.log`), including distinct Users,
matching-target retention, endpoint/local identity scope, locked source-free reopen and ambiguous
source install. Four runtime cases pass (`/tmp/bittery91-cross-runtime-matrix-green.log`), proving
the original three child IDs, target-response loss across SQLite reopen and missing/changed authority
guards; the existing ordinary lost-target regression remains green. Independent review found an
initial destination Account binding gap; its actual regression and fix pass while later guarded
reauthorization still reloads (`/tmp/bittery91-cross-initial-binding-red.log`). Independent source,
domain, recovery and coordinating public/runtime review accepted the final checkpoint. The
[captured failed-Create cache frontier](../desktop-extension/profile-handoff.md#captured-failed-create-cache-frontier)
now proceeds, including forced refresh because the legacy producer can overwrite confirmed cache
without invalidating its baseline. Remaining workflow/history and platform acceptance still gate91.

2026-09-21 first cross-Account admission has its public unsupported-workflow regression
(`/tmp/bittery91-cross-account-public-red.log`). The typed workflow schema and two-pass Account
binding are under implementation. Recovery separately reproduced acceptance of an ordinary
Operation occupying an unmaterialized original trash-child ID
(`/tmp/bittery91-cross-recovery-reservations-red.log`). Its existing bounded identity census now
uses the validated workflow's derived child reservations. All 22 recovery tests pass
(`/tmp/bittery91-cross-recovery-green.log`), including exact raw lineage/source-overlay preservation
in both row orders, malformed evidence refusal and independent-work acceptance. No extra payload
owner, journal or physical Operation count was introduced. Public/runtime convergence and review
remain in progress; this does not complete cross-Account admission.

2026-09-21 the first stopped-Create checkpoint is complete. All 79 shared admission tests and strict
Core all-target Clippy pass (`/tmp/bittery91-held-create-admission-pages-green.log`,
`/tmp/bittery91-held-create-core-clippy.log`). Twelve runtime tests prove fresh-lookup-only replay,
missing-outcome parking across owner restart, original scheduling, retained Applied/Rejected proof,
same-Item/unrelated progress, identity/auth refusal, transient backoff, shutdown/incarnation fencing
and receipt-acknowledgement loss with reopen (`/tmp/bittery91-held-runtime-final-green.log`). Actual
behavioral regressions exposed and fixed initial effect replay, failed-schedule false progress, Sync
backoff omission, inconsistent lookup/replay proof and replay after shutdown. Existing dispatch33
and outcome/Sync72 regressions pass (`/tmp/bittery91-held-normal-dispatch-regression.log`,
`/tmp/bittery91-held-normal-outcome-regression.log`). Independent source/domain/recovery/public review
and coordinating runtime review found no blocker. The reviewed normal cross-Account path now starts;
other held kinds/captured failed rows and the remaining ticket acceptance are still incomplete.

2026-09-21 first stopped-Create admission passes six public SQLite paths, eleven durable domain
tests and all nineteen recovery tests. Failed/conflicted commands retain exact request and source
history without an optimistic row; newer same-Item work and independent conflict-copy work survive
locked admission and source-free reopen. An ambiguous install reply/readback recovers without
reinstalling. The mixed-command test exposed an ordering mismatch between prepared snapshots and
canonical Replica rereads; preparation now sorts physical rows while retaining original queue
indices. Evidence is in `/tmp/bittery91-held-create-public-expanded-final.log`,
`/tmp/bittery91-held-create-domain-green.log` and `/tmp/bittery91-held-create-recovery-green.log`.
All 53 binding library tests also pass (`/tmp/bittery91-held-resolution-bindings-green.log`). Runtime
proof/fencing and aggregate review evidence completing this checkpoint is recorded above.

2026-09-21 normal scheduling/claim preservation completes its bounded checkpoint. All 35 SQLite
status/kind paths pass, covering retained history/error, JavaScript-safe maximum count/deadline and
departed claims with future, expired or missing expiry. A controlled clock proves no early lookup or
send, original-ID lookup for a reminted unsent attempt, exact 503 replay, retained source evidence on
retry and compact original lineage after success (`/tmp/bittery91-scheduling-dispatch-green.log`).
All 73 public admission tests, nine lifecycle tests including 35 status/kind roundtrips, and strict
Core all-target Clippy pass (`/tmp/bittery91-scheduling-admission-pages-green.log`,
`/tmp/bittery91-scheduling-lifecycle-green.log`, `/tmp/bittery91-scheduling-core-clippy.log`).
Coordinating independent review found no blocker. First stopped Create now proceeds with public,
domain, recovery and dispatch/Sync tests split across the existing owners.

2026-09-21 generated Operations projections now distinguish `legacyFailed` and `legacyConflicted`
from pending work and Server results; Runtime mapping suppresses their executable deadline and
rejection code. The generated validator first refused the new states
(`/tmp/bittery91-held-resolution-contract-red.log`); all 17 Runtime contract tests now pass, and all
14 dependent type-check tasks pass (`/tmp/bittery91-held-resolution-contract-green.log`,
`/tmp/bittery91-held-resolution-dependent-types.log`). The native enum/mapper and generated Kotlin/
Swift bindings also include both states; native release generation and all three secret-binding
hardening tests pass (`/tmp/bittery91-held-resolution-native-generation.log`,
`/tmp/bittery91-held-resolution-native-hardening.log`). The projection contract alone does not
establish held-work execution or recovery acceptance; their separate evidence follows above.

2026-09-21 the bounded cross-Account frontier passed coordinating and independent review and is
recorded for implementation after ordinary stopped Create. The actual TypeScript semantic executor
plus generated API serializer passes its new request-byte oracle, including distinct identities,
encoded Unicode/slash/colon paths, all three semantic suffix IDs and exact preconditions. Reuse
ticket90's source workflow/overlay owner; require live exact source authority and no Attachments,
pin later child identities durably and check collisions on each actual Server/User endpoint.
Already-trashed or missing source remains blocked in this first mapping; no previous result is
fabricated. This is compatibility evidence and a reviewed frontier, not implemented admission.

2026-09-21 Move's aggregate checkpoint is complete: 72 public admission tests, 18 recovery tests,
nine lifecycle tests and strict Core all-target Clippy pass
(`/tmp/bittery91-move-core-clippy-final.log`). Coordinating and independent review found no blocker;
normal retry/claim implementation now proceeds. The separately reviewed first stopped-command path
is recorded: failed/conflicted Create without captured Item evidence retains an inactive typed
Operation and no synthesized overlay, with fresh-lookup-only proof in both dispatch and Sync.
Later active same-Item work must survive held-result completion. This is an implementation frontier,
not completion of the stopped-work contract or ticket91.

2026-09-21 actual native lost-Create acceptance passes against the development Server after
independent review and cleanup hardening
(`/tmp/bittery91-native-admitted-create-real-server-final-green.log`, one Playwright case).
The captured production legacy queue remains byte-identical while its applied response is held;
admission and locked reopen issue zero HTTP. After ordinary password QuickUnlock, native Core
observes the original semantic-ID outcome endpoint and replays the exact original Create bytes.
Both observed responses equal the retained original outcome; the sole Item decrypts through public
Items and its compact receipt preserves original lineage. Scoped Account, proxy, profile and OS
credential cleanup passed. This proves isolated native convergence after JavaScript owner loss;
production old-process exclusion and supported-OS upgrade/biometric acceptance remain incomplete.

2026-09-21 the Wasm long-deadline prerequisite is implemented and independently reviewed. Actual
Chromium reproduced immediate completion for delay2147483648 before the fix
(`/tmp/bittery91-device-timer-red.log`). The timer now waits the full duration in signed-32-bit-safe
chunks and clears each physical lease on completion or cancellation. The optimized feature-Wasm
runner passes one browser test with 27 assertions (`/tmp/bittery91-device-timer-green.log`), covering
overflow boundaries, JavaScript's largest safe integer, zero/short waits and cancellation. A manually
advanced first callback checks remainder sequencing without claiming a 24-day wall-clock test.
Package types, direct harness types, Biome and diff checks pass; no production binding hook is added.

2026-09-21 same-Account Move's four valid SQLite paths and nine pre-write refusal variants pass
(`/tmp/bittery91-move-public-final.log`), including same-Vault moves and source-ID attempt fallback.
Nine durable lifecycle tests cover all seven ordinary kinds, typed AttachmentStateConflict
reconciliation and retirement of either Vault (`/tmp/bittery91-move-lifecycle-green.log`). All 18
streaming recovery tests pass (`/tmp/bittery91-move-recovery-green.log`), including exact Move request
retention after either Vault retires, valid overlays in either row order and changed-overlay refusal.
Aggregate admission checks and independent Move review remain the next checkpoint.

2026-09-21 normal Favorite/Trash/Restore/Permanent-delete admission passes the eight valid and 30
malformed/refusal public paths, seven durable lifecycle tests, all 70 shared public admission tests
and strict Core all-target Clippy (`/tmp/bittery91-metadata-lifecycle-green.log`,
`/tmp/bittery91-metadata-admission-pages-green.log`, `/tmp/bittery91-metadata-core-clippy.log`).
Coordinating and independent review found no blocker. Whole-row assertions preserve the exact
legacy metadata/permanent-delete projection and confirmed base; retry, retirement and compact
lineage receipt reload remain valid. Restore/Permanent-delete rejection tests use typed simulated
Server outcomes; the separate native lost-Create harness owns actual Server acceptance.
Same-Account Move is the next recorded path;91 remains incomplete.

2026-09-21 normal retry/claim mapping passed source review and is recorded before implementation.
Initialize live scheduling from the retained cumulative retry count/deadline, preserve original
evidence and retire old projection claims without waiting for expiry. Pending history and deadline-
free retrying attempts are legitimate. Review also found the existing Wasm timer passes oversized
delays directly to signed-32-bit setTimeout; fix that prerequisite with bounded chunks and an actual
Chromium regression before admitting future source deadlines.

2026-09-21 the next same-Account Move frontier passed independent source review and is recorded
before implementation. Its immutable legacy body omits attachments; the target Operation owns the
destination Vault while source lineage/body retain the original Vault. Existing Core projection can
retain source-bound Attachments inside a target Item overlay, and both-Vault retirement/recovery
gates already apply. Preserve that exact request and let genuine Server outcomes reconcile it;
do not synthesize a new preparation or rejection. Same-Vault source commands are also legitimate.
Begin this path after current metadata/lifecycle checks.

2026-09-21 recovery's cross-row regression is fixed and independently reviewed. Both changed Create
ciphertext and changed inherited Update favorite first produced invalid accepted coverage
(`/tmp/bittery91-legacy-recovery-overlay-red-2.log`). Recovery now retains only a bounded tagged
expected hash, obtains Create's hash from the existing typed source/request owner and Update's from
its immutable witness, and checks any present overlay in either row order. No payload owner or
durable record was added; legitimate retired-overlay absence remains supported. All 16 recovery
validation tests pass (`/tmp/bittery91-legacy-recovery-overlay-green.log`), including existing
cross-Account, artifact, image, raw-byte and resource-bound cases. The expanded public admission
suite also passes 68/68 (`/tmp/bittery91-update-admission-pages-green.log`).
Strict Core all-target Clippy passes with warnings denied
(`/tmp/bittery91-update-core-clippy.log`), closing this bounded checkpoint before metadata commands.

2026-09-21 normal pending Update passes three public SQLite admission/reopen/refusal cases and five
durable evidence/lifecycle tests (`/tmp/bittery91-update-public-green-final.log`,
`/tmp/bittery91-update-lifecycle-green-final.log`). Independent review found no remaining blocker
in this path. It preserves cached Server version6/encryptionVersion3, original attempt identity,
exact encoded PATCH and separate version7 overlay; retries retain immutable lineage/witness and
genuine completion compacts to the original lineage receipt. Ordinary Vault retirement now permits
legitimate overlay removal for both Create and Update while still validating accepted requests.
The recovery request verifier's raw-versus-encoded path mismatch has a reproducing test and fix
(`/tmp/bittery91-update-dispatch-path-red.log`; the filename predates identifying its recovery scope).
Separate review identified recovery's missing cross-row legacy overlay comparison; its reproducer
and bounded hash integration are in progress before the aggregate checkpoint.

2026-09-21 eight additional maintained legacy projection cases pass through the public repository,
checking complete projected values and unchanged ItemCache at Server version6/encryptionVersion1
(`/tmp/bittery91-legacy-metadata-projection-oracle.log`, 40 assertions). These pin the next Rust
metadata/lifecycle mapping, including live/trashed Restore and Permanent delete; they are source
compatibility evidence, not Rust admission completion.

2026-09-21 the next normal Favorite/Trash/Restore/Permanent-delete frontier passed coordinating and
independent source review. Legacy metadata projection preserves both version fields; Permanent
delete keeps its prior visible Item until acknowledgement. Restore/Permanent delete can carry a
live base and must preserve the request for a genuine Server rejection. The unreleased Update
witness is named generically `overlaySha256` before widening its kind set. Existing legacy public
projection tests pass 9/9 (`/tmp/bittery91-legacy-projection-oracle.log`). Implement this path after
the current Update checks; terminal states and per-Item command chains remain unfinished.

2026-09-21 coordinating and independent review resolved the Update overlay witness before its
implementation: a versioned, domain-separated digest of the complete typed optimistic row stays in
immutable legacy Operation evidence. It preserves inherited base fields across Bootstrap evolution
without duplicating payload ownership, is immutable on retry, and disappears on receipt compaction.
Existing SignOut regressions also pass 11/11 (`/tmp/bittery91-sign-out-regressions.log`).

2026-09-21 all 65 shared public admission tests pass
(`/tmp/bittery91-profile-admission-shared-current-3.log`), including enabled Travel's every-write
recovery matrix and strict pre-storage checks that hidden ciphertext/keys never reach Replica
staging. Runtime generated controls pass 16/16 with required-nullable Travel receipt validation
(`/tmp/bittery91-travel-runtime-contract-final.log`). Strict Core all-target Clippy also passes
(`/tmp/bittery91-core-clippy-admission-current-3.log`) after fixing old lifetime fixture Reset
matches, removing two Copy clones, and boxing optional legacy Operation evidence without changing
its persisted wire. Full phase CI still waits on the remaining ticket acceptance.

2026-09-21 the actual isolated native cache fixture now proves ordinary public password QuickUnlock
and offline authoritative Item plaintext using the original password/Secret Key/KDF/wrapped Vault
key. Its dynamic test SRP responder observes zero HTTP through admission and locked Core-only
reopen, then handles only the explicitly requested ordinary unlock ceremony. After HTTP is forced
offline, public Items exposes the retained title/password; direct crypto checks remain. Focused
RED/GREEN and the full actual source 15/15 suite are recorded in
`/tmp/bittery91-native-cache-public-unlock-red.log`,
`/tmp/bittery91-native-cache-public-unlock-green-final.log` and
`/tmp/bittery91-native-source-all-actual-travel-unlock-final.log`. Coordinating review found no
blocker. This fixture is not the actual Server lost-outcome test or production upgrade acceptance;
those, remaining queue variants and supported-platform acceptance still keep91 open.

2026-09-21 the next normal pending Update frontier is resolved and recorded before implementation.
Independent source review corrected a projected-cache assumption: the maintained legacy command
projection mutates memory; ItemCache remains the confirmed base. Server revision and encryptionVersion
also remain distinct after favorite/trash/restore. The accepted path retains that base, constructs an
optimistic overlay, uses the original wire attempt identity, and preserves semantic lineage through
retry and acknowledgement. Noninitial scheduling/status variants remain a separate bounded path.

2026-09-21 enabled Travel without pending work passes six public admission tests
(`/tmp/bittery91-enabled-travel-red-2.log`, `/tmp/bittery91-enabled-travel-green.log`), covering
visible cache retention, hidden key removal from complete and partial Sessions, already-erased
source keys, strict malformed-hidden-evidence refusal, and locked SQLite reopen. Independent review
found no remaining hidden destination copy; the expanded crash/staging checks are running.
Queued Create now passes actual public admission/restart and durable retry/completion lineage tests
(`/tmp/bittery91-legacy-create-public.log`, `/tmp/bittery91-legacy-create-lifecycle-green.log`).
Review's reschedule-lineage mutation finding was reproduced and fixed; the Rust serializer matches
all twelve actual TypeScript request vectors. Normal pending Update is the next bounded path.

2026-09-21 Abort's final public matrix passes 10/10
(`/tmp/bittery91-admission-abort-final-green-3.log`). The complete mirrored UniFFI admission requests,
inspection phases/results, Abort response and optional cleanup status now pass all 53 binding tests
and three secret-hardening checks; Kotlin/Swift artifacts were regenerated, including nullable
Travel receipts (`/tmp/bittery91-admission-bindings-suite-green.log`,
`/tmp/bittery91-admission-bindings-hardening-green.log`,
`/tmp/bittery91-admission-native-bindings-generation.log`). Native storage passes 11 tests and fresh
keychain guarded deletion passes its tightened test. Guarded IndexedDB passes 27 executor and four
rollback tests plus Runtime types after strict array-presence checks. Full phase CI remains due.

2026-09-21 the disabled Travel path passes three public SQLite/strict-wire tests and its retained
receipt unit test; independent review found no blocker. Native generated policy controls pass 8/8.
The next enabled-policy/no-pending-work frontier is recorded in the focused spec: validate hidden
source rows and credentials before filtering, erase hidden keys/cache before destination staging,
retain original source metadata/counts, and use existing admission digests instead of another
retirement journal. Pending work remains refused on enabled-policy Accounts until its own path is
ready. The broader check also found missing UniFFI admission responses/status conversion, now
assigned for completion; ticket91 remains open.

2026-09-21 coordinating and independent Travel review resolved the missing legacy receipt:
`TravelModeConfig` has no local verification timestamp. The existing durable/public/native
`verifiedAtMs` becomes required-nullable; fresh Server reads retain actual receipt times and
legacy/native handoff preserves null. The focused spec records the next disabled-policy-only
admission path before code. Enabled policy still needs its separate hidden-authority retirement
path and remains a recoverable refusal until that path is implemented.

2026-09-21 guarded SQLite Abort deletion passes three real-row/rollback/absence cases
(`/tmp/bittery91-abort-replica-guard-green-5.log`); generated Runtime contracts pass fifteen checks.
Native exact-value deletion, identical-byte reuse after a dropped worker, and isolated OS credential
deletion each pass their focused regression. The actual source suite again passes fifteen tests,
now asserting metadata-only Session evidence
(`/tmp/bittery91-native-source-all-actual-final-session-evidence.log`). Final combined reruns await
the in-progress OperationRecord integration; no ticket-completion claim is made.

2026-09-21 the combined protected-storage suite passes 34/34
(`/tmp/bittery91-platform-storage-session-and-guard-green.log`), including strict generated-control
serde, zeroizing expected deletion values, Session evidence lifetime and existing document
validation. All new local documentation link targets exist and diff whitespace checks pass.
These are bounded checks; full phase CI and ticket91's remaining acceptance are still required.

2026-09-21 independent Abort lifetime review identified a detached native-worker ordering gap:
PlatformStorage acquired its mutation lock only inside spawn_blocking, so a dropped queued deletion
could be overtaken by a later absence read and then erase identical global bytes reused by a new
attempt. The accepted refinement orders issued operations inside the existing executor before
worker dispatch and retains ownership through physical completion. The focused spec records the
requirement before a paused-worker cancellation regression/fix. No second lifecycle journal is added.

2026-09-21 explicit SignOut now removes partial credential evidence as well as QuickUnlock and
CurrentSession. Its public regression first reproduced the leftover document, then passed with
Account/catalog retention and fresh source-configured SQLite reopen as SignedOut
(`/tmp/bittery91-session-evidence-signout-red-second.log`,
`/tmp/bittery91-session-evidence-lifecycle-green-second.log`, 2/2 including all fragment masks).
The new evidence document and its staging/census/digest integration received independent review.
Reset's expanded public crash matrix passes 13/13; the uncovered orphan Vault-image chunk Wipe
bug is fixed inside the existing SQLite transaction and its rollback test passes
(`/tmp/bittery91-reset-crash-matrix-final-green-2.log`,
`/tmp/bittery91-vault-image-wipe-rollback-green-2.log`). Isolated native populated cache and public
Wipe also pass; this proves direct crypto decryption and Wipe, not public unlock/item projection.

2026-09-21 maintained TypeScript serialization conformance now passes twelve vectors, including
opaque path-parameter percent encoding and absent semantic/attempt IDs falling back to the original
command ID (`/tmp/bittery91-legacy-request-path-and-id-vectors.log`, 12/12). Independent Rust review
found the path encoding gap and an unsupported nonempty constraint on historical lastError; fixes
and strict omitted-vs-null source evidence validation are underway. The guarded PlatformStorage
wire is generated from Rust and the Web host passes 10/10 tests plus Runtime types
(`/tmp/bittery91-guarded-platform-web-green.log`, `/tmp/bittery91-guarded-platform-types.log`).
Native exact-value deletion and explicit Abort integration are still in progress.

2026-09-21 coordinating and independent Abort review also found the protected-document read/delete
race. The focused lifecycle contract now requires exact-value DeleteIfUnchanged under the existing
PlatformStorage owner, with one raw read, strict typed digest verification and closed deletion
outcomes. Native transactions/owner locks and the Web host's sealed single-owner assumption are
explicit. The Web regression currently fails on the absent generated primitive
(`/tmp/bittery91-guarded-platform-web-red.log`).

Incomplete Session preservation now passes the seven fragment combinations and every destination
write/restart ambiguity with two Accounts (`/tmp/bittery91-incomplete-session-crashes-green.log`).
The original RED refused a valid partial Session. Review also confirms explicit SignOut should
remove this nonauthorizing protected evidence alongside existing sign-in material; postcommit
catalog digests already become historical on ordinary credential updates. The focused spec records
that lifecycle refinement before implementation. Ticket91 remains in progress.

### 2026-09-21: guarded precommit destination retirement

Coordinating review accepted the explicit Inspect/Abort controls and the exact Replica deletion
prerequisite recorded in [the handoff lifecycle contract](../desktop-extension/profile-handoff.md#durable-transitions-and-crash-behavior).
Abort derives its remaining references from the existing fixed progress and preserves original
matching Device documents. `DeleteAccountIfUnchanged` compares the entire expected head and canonical
rows inside one adapter transaction; a same-head changed row must conflict, and only completely empty
physical scope is AlreadyAbsent. Ordinary Remove/Wipe is unchanged. Implement with a public Abort
crash history and an adapter race reproducer before widening the cleanup path.


2026-09-21 coordinating and independent reviews resolve the precommit Abort trigger: generated
Runtime InspectProfileAdmission returns only strict catalog lifecycle identity/phase while startup
is fenced; explicit AbortProfileAdmission requires that exact admission ID. Matching Aborted retries
are idempotent; stale identity, committed/completed imports and Reset refuse. Aborting is durable
before any owned staging deletion, and success requires full Aborted readback. Ordinary observation
gates and source capability privacy remain unchanged. The spec records this bounded cross-host API;
implementation follows the completed Reset path, with no implicit rollback on failed open.

2026-09-21 coordinating and independent reviews resolve the incomplete-Session retention frontier
within the existing PlatformStorage owner. A typed protected per-incarnation
LegacySessionEvidenceDocument preserves original Session metadata and zero-to-two credential
fragments without widening CurrentSession authority. Exact journal expectations, lifetime mapping,
readback, Abort and scoped deletion cover it. Zero fragments stays AbsentAtCapture; partial
credentials become IncompleteRetained; complete credentials remain exclusively CurrentSession.
The focused spec records the closed shape and future Extension metadata-only loss rule. The next
Desktop regression requires locked admission of intact QuickUnlock with partial Session evidence;
no implementation or partial-Session success is claimed by this frontier review.

2026-09-21 the bounded encrypted-cache path passes decoder, Replica transition, actual SQLite and
fresh Runtime restart checks. It preserves encrypted Vault/Item rows and typed source-generation
evidence without fabricated Server page receipts. A matching baseline admits its exact Cursor;
missing proof retains the rows under RefreshRequired/Cold. Independent review added regressions for
ordinary bootstrap staging/abandonment/promotion, valid incremental cursor advancement, and refusal
of forged Ready state on a Cold legacy generation. Checks:
`/tmp/bittery91-legacy-cache-decoder-final.log`, `/tmp/bittery91-legacy-cache-domain-final.log`,
`/tmp/bittery91-legacy-cache-sqlite-final.log`,
`/tmp/bittery91-legacy-cache-public-restart-final.log`. The last case opens a new Runtime without a
source provider and stays locked. Actual native real-crypto offline-cache acceptance is next.

Reset's first eight public Wipe tests also pass, including malformed-catalog independent scope,
lost initial journal/family replies, unavailable providers and changed scope. Review reproduced
same-identity journal substitution during host cleanup and final census; exact whole-document
checks now refuse the next deletion or Wiped overwrite
(`/tmp/bittery91-reset-journal-substitution-green.log`). Native Reset passes actual isolated OS
file/keychain acceptance with exact per-entry namespace identity
(`/tmp/bittery91-native-profile-reset-namespace-green.log`). Broader Reset crash coverage and
whole-Runtime native Wipe acceptance remain in progress; no ticket completion is claimed.

2026-09-21 native cleanup now passes actual isolated OS acceptance and independent review
(`/tmp/bittery91-native-source-cleanup-review-green.log`). The cases cover expected-only cleanup
reopen, newly present references that were absent at capture, changed file contents during a paused
delete, same-byte file replacement, malformed protected maps, lost deletion replies and reader drain.
Native exact-prefix preservation passes its physical SQLite/session regression
(`/tmp/bittery91-preserve-prefix-native-green-second.log`).

The public two-Account destination crash matrix passes all three maintained tests after independent
review (`/tmp/bittery91-staged-crash-matrix-reviewed.log`). It faults each platform document/catalog
write with lost acknowledgement and optional unavailable readback, both actual SQLite Account
installation boundaries, and the final source verification. Restart retains reserved identities,
exact credentials and private snapshots, avoids reinstalling proven Accounts, and never publishes
ambiguous or changed-source preparation. These are conformance tests of the implemented bounded
path; initial test-only expectations were corrected for an empty no-cache row set and ordinary
lock-epoch advancement on closing a successfully published Runtime.

The eight existing request-byte vectors now have a maintained test driving the actual legacy
TypeScript queue and API client (`/tmp/bittery91-legacy-request-bytes-first.log`). It checks exact
request bodies, route, strong precondition and semantic-versus-attempt identity, including omitted
Favorite and Unicode escaping. This is offline serialization conformance, not admitted pending work
or Server outcome acceptance. Reset lifecycle and cache review are underway; ticket91 remains open.

2026-09-21 committed cleanup now has a separate bounded capability and public Runtime crash tests.
Core checks the complete committed catalog before each exact source deletion, persists each receipt
with whole-document readback, and compacts only proven cleanup to Complete. Source failures retain
visible pending status without reimporting or blocking the committed owner; catalog ambiguity still
fences that open. A cleanup-only Close duty remains owned after a lost acknowledgement without
revoking Core readiness; ordinary captured readers still drain before publication. Seven cleanup
regressions pass (`/tmp/bittery91-cleanup-final-green.log`), including replacement of a previously
Absent target, lost deletion/progress/compaction replies and completion after the last Account is gone.
Shared source/control/lifetime tests pass 20/20
(`/tmp/bittery91-cleanup-contract-lifetime-joined.log`), generated source controls 6/6
(`/tmp/bittery91-cleanup-generated-controls-all.log`), and Runtime types pass.
Native cleanup review/actual acceptance remains in progress.

Trusted composition can now declare `LegacyUnavailable { format }`: a missing applicable provider
cannot become an empty profile, while an authoritative completed/committed catalog can still open.
Known admission records fence Wipe even without a provider until Reset is implemented. Catalog
checks pass 7/7 (`/tmp/bittery91-preserve-prefix-unavailable-green.log`). The Reset prerequisite
`DeletePrefix.preserveKey` is additive, exact and omitted on ordinary calls; Rust control regressions
are RED/GREEN and the Web adapter passes 9/9, including aliased storage and partial deletion failure
(`/tmp/bittery91-preserve-prefix-rust-red-second.log`,
`/tmp/bittery91-preserve-prefix-web-green.log`). Reset applicability, physical alias preservation and
file-identity scope have been refined in the focused specification; its complete lifecycle, Abort,
cache/work variants and remaining ticket acceptance are still open.

2026-09-21 the first populated Desktop Preparing/Committed path now passes. Public Runtime tests
use retaining platform storage and actual SQLite to preserve fixed Account/incarnation identities,
stage exact protected documents and signed preferences, and atomically publish the whole catalog
locked. Whole-document readback reconciles lost catalog acknowledgements; a fresh source Reopen
retains the original manifest lineage while issuing new handles. A full destination preflight finds
later-Account conflicts before recreating earlier missing documents; missing proof beneath a Verified
checkpoint refuses without restaging. Catalog/source/import tests pass 25/25
(`/tmp/bittery91-catalog-import-final-green-second.log`). Strict destination-object regression is
RED/GREEN and all 26 platform-storage tests pass
(`/tmp/bittery91-strict-destination-red.log`, `/tmp/bittery91-strict-destination-final.log`,
`/tmp/bittery91-platform-storage-strict-green.log`).

Actual isolated Linux acceptance now composes a unique OS credential entry, native platform SQLite,
Replica, Attachment and Vault-image stores. It imports real wrapped key material, commits locked and
reopens Committed without a source. Native source checks also cover original Reopen lineage,
same-file-object directory replacement and a reproduced provisional-reader Close leak. All 10
actual OS source tests pass (`/tmp/bittery91-native-source-all-actual-final.log`); Desktop library
tests pass 200/0 with 19 explicitly gated cases ignored, and Clippy passes
(`/tmp/bittery91-desktop-lib-native-source-final.log`,
`/tmp/bittery91-desktop-clippy-native-source-final.log`). Scoped fixture entries are deleted and
absence verified. This is not production old-writer exclusion, password-command or supported-OS
biometric acceptance. Source cleanup remains recorded and pending; Complete/Abort/Reset, encrypted
cache/Sync and accepted-work variants, Extension and the complete ticket acceptance remain open.

2026-09-21 bounded manifest controls and Core verification now pass their focused regressions.
Shared Rust owns the versioned SHA-256 framing, streaming evidence/manifest digests, strict
Verify/Reopen steps and generated schema/TypeScript/validator. The shared manifest/control tests
pass 17/17 (`/tmp/bittery91-manifest-controls-green.log`), with the exact digest RED recorded in
`/tmp/bittery91-manifest-digest-red.log`. Core derives full Desktop coverage from the decoded Account
list, retains Missing references, hashes the exact consumed bytes and stable file identities, and
checks each bounded verification acknowledgement before the remaining admission fence. A changed
source regression is RED/GREEN (`/tmp/bittery91-runtime-source-verify-red.log`,
`/tmp/bittery91-runtime-source-verify-green.log`); unavailable/malformed proofs also refuse without
destination writes. Independent review found no blocker in this bounded source proof.

The catalog now strictly reads a compact Complete marker and preserves it through ordinary
installation/replacement, startup reconciliation and removal of the final Account. Completed
admission bypasses source recapture after reconciling any retained in-memory Close duty. A temporary
Legacy Wipe guard prevents destructive work from erasing the marker before the specified whole-profile
Reset exists. External catalog tests pass 5/5; a public Sign-in/replacement/removal/reopen tracer passes
(`/tmp/bittery91-catalog-green-expanded.log`, `/tmp/bittery91-catalog-auth-green-second.log`). Joined
catalog/lifetime/source-reader/control tests pass 30/30
(`/tmp/bittery91-runtime-source-catalog-integrated.log`). These changes do not yet create a successful
admission: preserved decoding plans, Preparing/resume destination reconciliation, staged whole-profile
commit, cleanup/Reset and populated acceptance remain open.

2026-09-21 Core now consumes bounded source pages and strictly validates the initial populated,
locked Desktop Account source before its remaining admission fence. The 13 joined public source/
decoder tests pass (`/tmp/bittery91-core-source-pages-final.log`), including all exact credential
selectors, malformed nested object shapes, conflicting Server/User identity, signed preferences,
expired retained Session and explicit refusal of unsupported cache/Travel/pending work. Independent
review corrected a stale selected-Account pointer: it is presentation evidence and cannot block
intact Accounts. Source contract/lifetime tests pass 10/10
(`/tmp/bittery91-core-source-contract-lifetime-final.log`), startup tests pass 19/19
(`/tmp/bittery91-startup-source-reading-20260921.log`), and all-target Core Clippy passes
(`/tmp/bittery91-source-reading-clippy-final-20260921.log`). Shared invocation bounds replace
duplicated page-control plumbing, with shutdown checks between issued pages.

Actual isolated Linux credential/source tests pass for fixed references, missing/non-string/empty
values, replayable scalar pages and scoped cleanup. Independent review reproduced malformed Unicode
inside an unselected value; recursive zeroizing validation/discard fixes it, including nested values
(`/tmp/bittery91-native-source-unpaired-surrogate-red.log`,
`/tmp/bittery91-native-source-unpaired-surrogate-green.log`). Captured protected bytes now share one
immutable zeroizing owner across pages. A maintained canceled native page case proves actual file
reader drain before Close acknowledgement with retained exclusion and unchanged source evidence
(`/tmp/bittery91-native-source-cancel-final.log`). Desktop library tests pass 200/0 with 13 explicitly
gated cases ignored; the relevant actual OS cases were run separately. Desktop Clippy passes
(`/tmp/bittery91-desktop-clippy-final.log`). These are capability tests, not old-writer exclusion or
populated admission acceptance.

Coordinating and independent review sealed
[bounded manifest verification/reopen](../desktop-extension/profile-handoff.md#bounded-manifest-verification-and-desktop-reopen).
Compact headers and per-selector evidence avoid a whole-profile control quota. Fresh verification
attempt IDs distinguish physical rechecks from lost-response replay; exact credential references
exclude admission's own shared-map writes. Implementation proceeds to this source proof and the
catalog-owned tombstone/Preparing lifecycle. There are still no successful profile admission,
destination credential writes or production activation in this source-reading step. Ticket remains open.

2026-09-21 expanded physical-inventory conformance reproduced positional-array cursor acceptance
in all three native inventory owners
(`/tmp/bittery91-inventory-cursors-red-20260921.log`). Reusing the existing object-only Serde
boundary fixes Replica, Attachment and Vault-image cursors without changing valid cursor bytes.
All 9 targeted physical-inventory tests pass
(`/tmp/bittery91-inventory-cursors-green-20260921.log`). The additional Vault-image case crosses
the 128-key page boundary and both metadata/chunk tables, retaining raw and protected publication
keys, Unicode byte ordering, replay, unchanged database/WAL evidence and rejection after owner loss.
The first version of that fixture incorrectly used domain construction for noncanonical Unicode
Operation IDs; the maintained case injects those orphan physical rows directly, matching the
census contract. Independent cursor review found no blocker; its additional Replica replay and
owner-restart assertion passes with all five Replica inventory tests
(`/tmp/bittery91-replica-cursor-reviewed-20260921.log`). Ticket-wide acceptance/full checks remain open.

2026-09-21 continuation reviewed the accumulated implementation and confirmed all eight ticket
dependencies are resolved. Independent baseline review found no confirmed correctness defect in
the implemented refusal, native inventory or snapshot-close lifetime. The four Runtime admission
refusal tests pass, including the previously pending unpublished Vault-image case
(`/tmp/bittery91-admission-baseline-20260921.log`). All 20 public admission integration tests pass,
including the physical Vault-image inventory
(`/tmp/bittery91-admission-public-baseline-20260921.log`); Runtime TypeScript checking and
`git diff --check` also pass. These checks validate the existing fenced baseline only.
Native credential selectors, Core source-page consumption and strict Desktop source decoding are
the next implementation steps. Complete destination reconciliation, the catalog-owned lifecycle,
source verification/cleanup, populated admission and its acceptance matrix remain open; no ticket
closure or production activation is claimed.

2026-09-14 bounded source-page controls now come from Rust with the normal schema/types/validator
generator and package checks. All17 then-current public admission tests pass, including Attachment
paging across all four physical families (`/tmp/bittery91-source-page-contract-first.log`), and
Runtime types pass. A raw-control regression then reproduces Serde accepting array-shaped source
controls (`/tmp/bittery91-source-control-array-red-first.log`). Object-only typed deserialization
passes all18 public tests (`/tmp/bittery91-source-control-array-green-first.log`); normal regeneration
preserves all four generated files byte-for-byte. Generated validator checks also pass.

The isolated actual native source first refuses ReadSourcePage after successful Begin/Close and
verified file/credential cleanup (`/tmp/bittery91-native-source-page-red-first.log`). Positional
bounded file reads then pass the same test (`/tmp/bittery91-native-source-page-green-first.log`),
including a Unicode scalar split between pages, fresh protected capture without cache changes and
retained exclusion through snapshot Close. Production capability construction remains unavailable;
this newly created fixture does not establish old-writer exit or application upgrade acceptance.
Credential selectors, source verification/deletion and populated catalog admission remain open.
The Vault image Runtime regression also reproduces its missing census after exact source/database
preservation (`/tmp/bittery91-vault-image-admission-red-first.log`); its native inventory and guard
are now under verification.

2026-09-14 the Attachment guard passes all18 startup tests
(`/tmp/bittery91-startup-compatibility-fourth.log`). A public native inventory test independently
finds exact physical keys from all four tables, including orphan/noncurrent chunks and unsealed
work, without decoding payloads or changing database/WAL bytes
(`/tmp/bittery91-artifact-physical-inventory-first.log`). All three isolated actual OS credential
tests also pass: fresh reads, malformed-map refusal, bounded paging and refusal of a cursor after
actual storage-owner restart (`/tmp/bittery91-native-platform-keychain-paging-first.log`). Scoped
entry deletion is verified in each history. Source-page controls and the normal Rust-to-TypeScript
generator are the next work; full destination census and populated admission remain incomplete.

2026-09-14 the real unsealed Attachment artifact Runtime tracer reproduces the missing census
(`/tmp/bittery91-artifact-admission-red-first.log`), after proving unchanged SQLite evidence and
completed source cleanup. Core/SQLite inventory now enumerates all four physical artifact tables
through the existing owner; its Runtime guard is under startup verification. The source transport
now carries a separately owned optional zeroizing binary payload. A new public regression proves
that ignoring binary on Close could clear its reader cleanup duty
(`/tmp/bittery91-source-binary-red-first.log`). Independent control/payload bounds and rejection of
every binary-bearing Begin/Close reply, including an empty payload, make all ten public admission
tests pass (`/tmp/bittery91-admission-primitives-third.log`). Actual OS malformed-map conformance also
passes both isolated credential tests (`/tmp/bittery91-native-platform-keychain-malformed-first.log`).
These remain admission prerequisites; source page reads, all destination families and populated
catalog commit are unfinished.

2026-09-14 actual OS DeviceSecret inventory first fails at missing ListKeys after real setup and
verified scoped cleanup (`/tmp/bittery91-native-platform-keychain-red-first.log`). Fresh strict
enumeration then passes the same isolated child test
(`/tmp/bittery91-native-platform-keychain-green-first.log`): it discovers physical keys absent from
the warmed cache, preserves exact credential bytes/cache and proves the unique fixture entry was
deleted. Ten ordinary native storage tests and six keychain tests also pass. The parser reads into
zeroizing ownership, rejects duplicate/non-string/malformed map data and emits only keys without
creating or refreshing a payload map. Actual malformed-entry variants remain to verify.
The real-crypto offline legacy source producer passes its smoke and Web types
(`/tmp/bittery91-native-profile-source-smoke-reviewed.log`,
`/tmp/bittery91-native-profile-source-types-reviewed.log`); it is fixture provenance, not populated
admission. The reviewed separate-binary Desktop source-page shape is recorded in the focused spec.
The next Runtime refusal test uses an actual unsealed SQLite Attachment artifact.

2026-09-14 Web ListKeys passes three maintained RED/GREEN cycles for literal keys/actual aliases,
bounded paging/cursor ownership and malformed physical keys. Final host tests pass 8/115 assertions
(`/tmp/bittery91-web-listkeys-malformed-green.log`), with Runtime TypeScript checking and scoped
Biome. Native escaped-key pages pass both SQLite and session wire-size limits, with all nine native
storage tests green (`/tmp/bittery91-native-platform-wire-bound-first.log`). The existing keychain
entry/cache now has one instantiable owner for isolated actual-entry test composition; production
still shares its fixed default owner. All six keychain compatibility tests pass
(`/tmp/bittery91-keychain-extraction-compatibility.log`), and independent review found no blocker.
Fresh protected-entry census and populated admission still remain to implement.

2026-09-14 native continuation first refuses the 129th key
(`/tmp/bittery91-native-platform-pages-red-first.log`); owner-bound paging then passes all eight
native storage tests (`/tmp/bittery91-native-platform-pages-green-first.log`). It retains only the
next bounded page and lookahead, measures the entire serialized response including its cursor, and
rejects cursor reuse across areas, prefixes or owner loss. The generated nullable request-cursor
validator also reproduced missing bounds (`/tmp/bittery91-platform-cursor-schema-red.log`) and now
passes after normal regeneration (`/tmp/bittery91-platform-cursor-schema-green.log`). Normal recovery
and platform regeneration pass; fresh protected-entry enumeration and full admission remain open.

2026-09-14 native closed-schema compatibility passes all six storage tests
(`/tmp/bittery91-native-platform-schema-compatibility-first.log`). The next native ListKeys test
first fails at the missing primitive (`/tmp/bittery91-native-platform-list-red-first.log`), then
passes with all seven storage tests (`/tmp/bittery91-native-platform-list-green-second.log`).
SQLite and session enumeration return exact literal-prefix keys in UTF-8 order, singleton backing
areas and no values, while preserving durable bytes. SQLite revalidates its closed schema for each
scan. Continuation and fresh protected-entry enumeration remain unfinished; this first bounded
page still refuses larger inventories. Normal persistence-contract regeneration also passes after
the strict empty-control fix (`/tmp/bittery91-persistence-contract-second.log`).

2026-09-14 the real native platform constructor regression reproduced mutation of an unversioned
foreign database (`/tmp/bittery91-native-platform-schema-red-first.log`). Native now reuses the shared
pure schema validator before any table/version write: version zero still requires an empty schema,
version one requires its exact known layout, and existing stamp behavior is retained. All five native
storage tests pass (`/tmp/bittery91-native-platform-schema-green-first.log`), including the foreign
table/view preservation regression. The new helper is a native-only hidden Rust export, not a new
storage owner or renderer capability. Additional closed-layout compatibility and actual native key
enumeration remain the next work.

2026-09-14 the platform orphan-key regression now passes
(`/tmp/bittery91-platform-key-green-first.log`). The existing PlatformStorage owner has a strict bounded
ListKeys wire and the Runtime verifies the live area partition before accepting empty inventory.
All17 startup tests,24 platform-storage tests, normal platform-contract generation and Runtime
TypeScript checking pass. Native and Web adapters still return unavailable for ListKeys until their
physical variants are implemented. Independent review then reproduced Serde accepting a contradictory
cursor on an internally tagged unit End (`/tmp/bittery91-closed-controls-red-first.log`). The four new
admission/inventory empty controls now use strict empty structs with unchanged JSON; all eight
then-existing public admission tests pass (`/tmp/bittery91-closed-controls-green-first.log`). Native
platform opening's pre-mutation schema regression is the next running check.

2026-09-14 the first orphan-platform-key Runtime regression is RED
(`/tmp/bittery91-platform-key-red-first.log`): after confirming an empty actual Replica, admission
returns its generic incomplete fence without enumerating the publicly seeded Core platform key.
The regression requires the exact key in the bounded primitive response, the specific collision
refusal, cold observations/commands and unchanged destination values. The reviewed ListKeys wire and
Runtime check are being implemented; no complete platform census or admission success is claimed.

2026-09-14 all seven public admission primitive tests pass
(`/tmp/bittery91-admission-primitives-first.log`), including a dropped open future with a real detached
blocking capture, explicit cleanup-entry/release barriers and release before Runtime close completes.
This is Core/source-port conformance, not production native or browser adapter acceptance. Both
previously supported application stamps retain identical serialized orphan evidence through known
unversioned-layout adoption. All16 startup tests and six existing migration/recovery compatibility
tests also pass (`/tmp/bittery91-startup-compatibility-second.log`,
`/tmp/bittery91-schema-migration-compatibility-first.log`). Independent review fixes the next concrete
PlatformStorage inventory shape in the focused spec: bounded keys, explicit area aliases, UTF-8
ordering, strict nested controls and fresh protected-entry census. The next Runtime refusal tracer
uses an orphaned Core platform key with an empty Replica.

2026-09-14 losing Begin's reply after creating a real source reader also reproduced the leak
(`/tmp/bittery91-source-begin-red-first.log`). Core now records `CurrentCapability` cleanup before
issuing Begin and narrows to an exact handle only after complete response validation. Both public
lifetime histories pass (`/tmp/bittery91-source-begin-green-first.log`), with independent review;
actual interrupted blocking work is the next conformance case. A separate public-open regression
proved that a view-only unversioned SQLite file was being mutated before inventory
(`/tmp/bittery91-view-only-schema-red-first.log`). Replica migration now uses the shared strict
empty-or-known-object validation before any table/stamp write, preserving its existing stamp rules.
All three physical-schema regressions pass (`/tmp/bittery91-view-only-schema-green-first.log`).

2026-09-14 the next public Runtime regression reproduced a retained source reader after two failed
Close calls (`/tmp/bittery91-source-close-red-first.log`). The existing startup owner now retains the
exact cleanup obligation, reconciles it before another capture and confirms release under the catalog
lock during shutdown. The same real-reader/SQLite test passes
(`/tmp/bittery91-source-close-green-first.log`), and independent review confirms the known-handle
ordering. Lost Begin replies and interrupted executor work remain the next lifetime variants.
The schema regression and three-owner unversioned refusal both pass
(`/tmp/bittery91-inventory-schema-compatibility-first.log`); persistence and recovery-control generation,
Runtime TypeScript checking and scoped Biome pass. These are tracer checks, not ticket completion.

2026-09-14 the first Runtime refusal now passes
(`/tmp/bittery91-headless-admission-green-second.log`), and all16 existing startup tests pass
(`/tmp/bittery91-startup-compatibility-first.log`). Bounded physical Replica inventory discovers
headless rows without adopting them. The normal persistence-contract generator passes. Independent
review then reproduced a schema-filter omission: a legal `sqliteXforeign` table was reported as
an empty complete inventory (`/tmp/bittery91-inventory-schema-red-first.log`). Replacing SQL LIKE's
wildcard underscore with GLOB's literal underscore in the four schema filters makes the same
public SQLite regression pass without changing database or optional WAL bytes
(`/tmp/bittery91-inventory-schema-green-first.log`). The reviewed
[snapshot cleanup lifetime](../desktop-extension/profile-handoff.md#snapshot-lifetime-across-interrupted-calls)
is the next tracer before the populated Account path. Complete destination census, admission
success, real source primitives and all platform acceptance remain unfinished.

2026-09-14 the first maintained admission regression fails for the intended behavior
(`/tmp/bittery91-headless-admission-red-second.log`,1failure): a configured applicable Desktop
source with absent legacy families and absent Core catalog still publishes empty success over an
actual SQLite headless row. The test observes the public Runtime/store seams and requires the exact
orphan to appear in inventory, cold observations/commands, no destination mutations and unchanged
opaque evidence through serialized Load. It cannot pass from an unrelated missing provider. The
initial compile-only fixture error used a nonexistent direct UUID dependency and was corrected to
Core's existing helper before this behavioral failure. Shared Runtime gating and bounded physical
Replica enumeration are now being implemented; no admission success is claimed yet.

2026-09-14 ticket90 is resolved after its complete capability acceptance, independent review and
both literal full CI commands. All91 dependencies are complete, and coordinating dependency review
confirms this is the next unblocked delivery ticket. Implementation now starts at the reviewed
Runtime/open seam with an actual headless SQLite row: applicable admission must refuse the
unexplained destination and retain its bytes before any empty-profile publication or staging.
Then extend that same path to the populated locked Desktop Account and exact protected material.
The full admission, process-exclusion and platform acceptance matrix remains required for resolution.

2026-09-14 read-only preparation and independent review resolve the concrete
[destination-inventory frontier](../desktop-extension/profile-handoff.md#complete-destination-inventory-before-staging).
Catalog absence, normal Account reads and artifact recovery do not prove physical destination
emptiness. Bounded raw-key enumeration belongs to the existing Replica, platform, Attachment and
Vault-image owners; Core compares complete observed keys and strict value evidence against the
recorded admission before staging or resuming. Platform results declare only addressable-area alias
facts, preserving Web's shared device namespace and native's separate areas. No second registry,
maintenance owner or host credential policy is introduced. The accepted Runtime/open refusal and
adapter conformance seams cover orphaned rows/chunks, unknown schema, aliases, paging and exact
Preparing restart reconciliation. Ticket90 still gates implementation; this review enables no
production startup path and claims no populated-profile acceptance.

2026-09-09: delivery ticket separated from research82. Accepted83 alone is not an implemented Move or
profile upgrade; capability90 and admission91 are explicit cutover dependencies. This draft records
a complete preservation scope, but startup/journal contract review remains open. No source changes
or populated-profile upgrade acceptance claimed.

2026-09-09: coordinating review accepts one optional versioned admission lifecycle in the existing
DeviceCatalog, existing per-Account pending installation, one whole-profile catalog commit, independent
validated QuickUnlock/Session staging in existing tiers, exact legacy-reference capture from fresh
protected reads, durable abort/cleanup/tombstone and full ticket90 mapping before publication. The
focused spec now records concrete fields, closed phases, generated startup-only primitives and crash
ordering. Extension session-area loss has a recorded nonauthorizing disposition without moving a
Session into DeviceSecret. No second journal service, key owner or scheduler is introduced.

Status remains needs-triage for independent review of those concrete shapes and adapter feasibility.
Review must cover partial multi-Account installation, catalog-write outcome uncertainty, missing
password-only Session, browser-session loss versus changed source, cleanup after lost replies,
unchanged shared keychain/browser entries, raw non-string source observations, session-marker
initialization/recreation, tombstone preservation through every catalog transformation, Wipe recovery
with malformed catalog and complete scoped legacy/staging erasure, and source-owned cross-Account
artifacts/children. Delivery remains blocked by its incomplete capability dependencies;
research82 resolution is not permission to implement91 early or claim platform upgrade acceptance.

2026-09-09: source review pins the stopped-command preservation boundary. Legacy `failed` includes
five-attempt exhaustion and local/API failure as well as semantic rejection; the stored error string
is not an authoritative outcome. `conflicted` can coexist with an independently accepted conflict-copy
Create. Both statuses are excluded from legacy dispatch and restore, and the existing UI only reports
that automatic retry stopped: there is no Retry gesture to preserve. Automatically moving either into
09's retry loop would change existing behavior and could revive an old write.

The coordinating review therefore accepts the
[closed admission-only hold contract](../desktop-extension/profile-handoff.md#admission-only-holds-for-stopped-legacy-commands):
optional versioned typed metadata under the existing Operation owner, `LegacyFailed` and
`LegacyConflicted` dispositions and projections, original Server attempt/request/fingerprint and
semantic source lineage, with ciphertext referenced from its existing owner. No new Resume/Retry/
Discard action, opaque executable fallback, scheduling owner or fabricated conflict copy is added.
For representable cross-Account Moves,83's existing explicit destination Resume remains available
only with an actual retired destination binding and every accepted identity/content/Attachment/
outcome proof. Its existing guarded reauthorization plan records the prior hold and new binding
revision atomically; original source evidence stays immutable. This is no general retry action, and
unproven history or a known terminal rejection cannot be made eligible by replacing a binding.
An existing retained-outcome lookup may permit exact frozen-request proof and genuine receipt
completion; a missing outcome keeps the hold and sends no mutation. Held evidence does not replay an
optimistic delete/move or block otherwise eligible work. Recovery and crash handling preserve its
typed disposition and original evidence; ordinary new Runtime Operations retain09's retry policy.

This resolves the preservation choice without broadening the authorized product behavior. The spec
now records the concrete schema, projection, dispatch, receipt, recovery and crash mapping for
independent review. Status remains needs-triage until that review and the remaining admission record/
source/Wipe details are sealed; no implementation or populated-profile acceptance is claimed.

2026-09-09 independent hold review: the typed source mapping, ordinary no-reactivation rule,
GET-present-only frozen-request proof, genuine receipt lineage, recovery ownership and83's narrowly
guarded workflow reauthorization fit the accepted behavior. Added an explicit reference to the
workflow's already-owned accepted payload and clarified that ordinary hold projections do not erase
the existing83 action. No extra ciphertext owner or dispatcher is required.

Coordinated lifecycle refinements now specify session-marker creation before inventory and reuse
through worker recreation, exact legacy-reference hashing excluding destination/marker writes in all
shared containers, and source-value type/presence preservation. Every catalog transformation retains
the lifecycle field. Existing explicit Device Wipe uses the same catalog's minimal Reset arm without
parsing damaged old catalog data; it must prove fixed-family legacy and Runtime/private-staging
erasure before Wiped/success. A suppression marker alone is insufficient. Exact catalog-key
preservation prevents its deletion mid-wipe, while unknown scope or inaccessible cleanup remains
visibly incomplete. These final lifecycle/reset shapes still await coordinating independent review;
status remains needs-triage and no delivery implementation is authorized before dependencies complete.

2026-09-09 final bounded lifecycle review found and corrected three transition details. Wiping now
persists a versioned nonsecret fixed-profile reset descriptor with the replacement catalog and
reacquires/revalidates exact live scope on retry; a deleted namespace after a lost reply is distinct
from a foreign replacement or inaccessible scope. Hosts with no applicable legacy format retain
CoreOnly Wipe, while an applicable format's missing provider cannot stand in for verified absence.
An allowed shared Extension Session loss changes all affected Account dispositions and invalidates
Session-dependent checkpoints in the same journal write before revalidation. Ticket83 authorization
revision equality applies to an Active destination; retirement preserves the old proof as inactive
evidence and a subsequent Resume must explicitly bind the new revision. No extra cleanup, Session or
authorization owner is required. Final coordinating review still controls readiness; no implementation
or populated-profile acceptance is claimed.

2026-09-09 coordinating acceptance of the specification: reviewed the final lifecycle against the
existing catalog constructors, pending installs, failed-open Wipe and platform prefix deletion.
The source, credential, stopped-command, ticket83 Resume and reset contracts now pass independent
and coordinating review. Ticket 91 is ready-for-agent, with incomplete dependencies 68/70/71/90 still
blocking implementation. The review adds no second journal, credential owner or scheduler. All 45
local links/anchors and `git diff --check` pass. Supported-platform process exclusion, populated
admission and production application acceptance remain implementation gates, not documentation results.

2026-09-21 the coordinating cache-frontier review refines the existing Replica mapping for the
bounded Desktop locked/no-work tracer. Core may admit only a strictly decoded promoted ItemCache
generation. It records a typed `legacyAdmission` origin on the existing generation, derives the Core
generation identity from the durable Account incarnation, preserves exact source pointer/state,
metadata/checkpoint, Account/Server and admission-manifest evidence, and creates no fake Server page
receipts. An exactly agreeing ItemCache and Sync baseline admits its exact Cursor; absent or
unreliable baseline admits only `RefreshRequired` with a `Cold` cursor while preserving offline
encrypted rows and gating mutation/incremental Sync. Source active generation remains evidence, not
Core identity. Unknown cache fields, unpromoted unique stages, `optimisticFailure` and Travel evidence
remain fail-closed until their typed owners are implemented. This is a refinement of the already
ready ticket91 mapping, not a claim of complete cache, work, cleanup or production admission.


2026-09-23 Linux physical cleanup crash slice: three exact cuts extend the previously reviewed
nine-cut harness. They stop only after the real scoped `DeleteCapturedSource` primitive has removed
the captured DesktopStore `store.json`, after the exact protected Account SecretKey is removed, and
after the complete, nonempty cleanup target set has Absent receipts in Committed but before
Complete compaction. Source-deletion markers carry the exact admission and manifest target; the
final catalog marker identifies the write cut and its journal assertions bind the fixture scope.
The parent SIGKILLs and reaps the selected child after the marker is fsynced. Each recovery reopens the actual source, catalog
and locked SQLite head, refuses a second Replica Install, and resumes through the existing Core
executors. Earlier cuts retain their distinct Pending/checkpoint assertions; cleanup cuts verify
their corresponding partial or finished source state, durable receipts, retained Core secrets and
unrelated protected entry.

All twelve exact ignored cases pass serially after a fresh joined Core compile, and strict Desktop
all-target Clippy passes with `-D warnings`. The physical fixture holds a real revision-zero SQLite
head with zero Replica rows; evidence is logical head/row continuity, not populated-profile recovery
or SQLite/WAL byte equality. The run manifest at
`/var/tmp/bittery91-replica-cut-3z8dJk/captures/catalog-cuts/cleanup-cuts-final-manifest-v2.md`,
SHA-256 `c650d4a800cbdce6b5abe8a63de3fd56cb73435c66b1a5e5cb9007b5cdbf5019`, pins source and log hashes. Independent Spec review found no in-scope findings; Standards review
found no hard violations and one optional repeated-list smell, deferred without changing the tested
leaf. Whole-profile Wipe cuts, actual legacy-writer exit/exclusion and supported-startup acceptance,
biometric evidence, remaining accepted-work/source variants and both full-CI commands remain open;
this bounded slice does not complete ticket91.


2026-09-23 first physical Wipe boundary: the accepted next cut is immediately after the initial
`Reset/Wiping` DeviceCatalog Set commits in native SQLite, before Core receives its reply/readback
and before any destructive family operation. The isolated Desktop fixture starts with malformed old
catalog bytes and a valid independently acquired fixed reset scope. At the cut, the canonical reset
record must have version 1, a nonempty wipe ID, revision zero, Wiping phase, an empty Account list,
and the exact Store/SyncStore/Credentials scope with every family remaining. Source files, protected
credentials, a Core-owned Runtime-prefix value and an owned NativeFiles host file must still match
their pre-cut state. The exact child delegates the physical Set, fsyncs a marker and withholds its
reply until SIGKILL/reap. A fresh Runtime retries Wipe without `open()`, reacquires the same scope and
wipe ID, reaches Wiped, removes the fixed legacy families, Runtime namespace value and real host
file, and preserves near-miss/unrelated protected values. The existing `AdmissionDeviceWipe` test
helper is a no-op and must not supply this acceptance. Replica and artifact SQLite owners remain
empty, so the cut makes no populated-row claim. This proves durable suppression and malformed-catalog
recovery before erasure; later family receipts, Runtime/Replica/artifact deletion, final Wiped-write,
provider-loss and legacy-writer/startup boundaries remain open.

2026-09-23 the accepted first physical Wipe cut is implemented and verified. The new exact Linux
process case observes the real native catalog Set only after the durable version-1 Reset/Wiping
record replaces malformed catalog bytes. It checks the exact fixed Store/SyncStore/Credentials scope,
all families still pending at revision zero, unchanged legacy source and protected values, retained
Runtime-prefix values and the actual host file; then it kills/reaps the marked child. A fresh source
provider retries Wipe without `open()`, keeps the same scope and wipe ID through Wiped, removes the
legacy/runtime/host data, and preserves near-miss and unrelated values. The twelve earlier import and
cleanup cuts were rerun serially: all thirteen exact process tests pass, and strict Desktop all-target
Clippy passes with warnings denied. The physical test leaf SHA-256 is
`496fe257e47bf0a6319cbbbe78533fb0a267557a48ac711d5a57c9b67dc4b02f`. The evidence manifest is at
`/var/tmp/bittery91-replica-cut-3z8dJk/captures/catalog-cuts/wipe-reset-intent-manifest.md`,
SHA-256 `5d4be871c39e0e63d0ef8a83c4d95cc5ac791f08a3f9c0f9198b2841fd77b76a`. The first compiler
attempt found a test-helper closure borrow/move error; the owned-capture fix is included in the pinned
leaf and the diagnostic is preserved separately. This remains a single pre-erasure Wipe boundary;
later Wipe cuts, old-writer/startup acceptance, populated-profile coverage, remaining ticket91 work
and both full-CI commands remain open.

2026-09-23 the first Wipe cut is integrated after independent Sol Spec review with zero findings
and Luna Standards review with no hard violations. Standards identified optional duplicated reset
record parsing in the test selector and post-crash assertions; that simplification is deferred to
the next Wipe harness variants. The integrated Rust leaf exactly matches the reviewed and tested
SHA-256 above. The thirteen-case transcript is the primary execution evidence; the separate first-run
file is a completion summary. Coordinating verification confirms all six manifest artifact hashes,
local documentation targets and the scoped Git whitespace check. This does not close ticket91.


2026-09-23 the coordinating review accepts two further Linux physical Wipe cuts in the existing
closed source/catalog harness. The first holds after the real `ResetLegacySourceFamily(DesktopStore)`
deletion and exact absence proof, before Core receives that result: the durable journal remains
Wiping revision 0 with all three families remaining, while Store is absent and SyncStore, credentials,
Runtime data and the owned host file are unchanged. After SIGKILL/reap, a fresh provider must
reacquire the original durable scope, including the original Present Store file identity, repeat the
same wipe ID at the now-absent Store family, and finish Wiped. The second holds after the actual
catalog Set receipts that absence, so revision 1 retains the same wipe ID and immutable scope with
only SyncStore and Credentials remaining. Reopen resumes that receipt and finishes at Wiped revision
4; an AlreadyAbsent retry must not create a duplicate receipt. Both variants use the existing exact
physical Wipe child and add only closed observation of successful source reset results. The assertions
must distinguish an absent captured file from a replacement and must not revalidate the deleted Store
through an all-files-present helper. Replica and artifact owners remain real but empty; populated rows,
all-family cuts, provider loss, old-writer exclusion, terminal Wiped-write recovery and supported-OS
acceptance remain open. This records the accepted test frontier before implementation and does not
change production APIs or complete ticket91.

2026-09-23 both accepted DesktopStore Wipe cuts are implemented in the existing Linux physical
process harness. The deletion cut verifies the real source response after native removal while the
journal remains revision 0; the receipt cut verifies the native catalog Set at revision 1 with only
SyncStore and Credentials remaining. Each cut kills and reaps the exact child, reopens the same
journal and immutable pre-cut scope, then completes the same wipe ID without `open()`. Recovery
observes Store `AlreadyAbsent` for both cuts and finishes at Wiped revision 4, proving that the
already-receipted family does not increment revision again. All 15 physical cases pass serially, and
strict Desktop all-target Clippy passes with warnings denied. Targeted `rustfmt --check` passes; the
workspace-wide check still reports preexisting formatting differences in vendored biometry files.
The pre-assertion-fix two-cut manifest remains outside Git at
`/var/tmp/bittery91-replica-cut-3z8dJk/captures/catalog-cuts/wipe-two-cuts-manifest.md`,
SHA-256 `929afe75a9817d7a914c26871af66ce286ac468678dbc1dfda6aae132fd21993`; it records the earlier
evidence before the correction below. Replica and artifact SQLite owners are real but empty, and
populated-row, all-family, terminal-write, provider-loss, old-writer exclusion and supported-startup
acceptance remain open; ticket91 is not complete.

2026-09-23 Wipe assertion correction: the initial `Reset/Wiping` cut now recomputes its physical
directory/file scope at the held Set and after SIGKILL, while every captured file is still present.
Store-deletion and receipt cuts continue comparing the immutable pre-cut scope and retrying through a
fresh provider after Store is absent. Store absence checks use `symlink_metadata` and accept only
`ErrorKind::NotFound`; a small dangling-symlink regression failed with the prior `try_exists()` check
and passes with the correction. The final assertion manifest remains outside Git at
`/var/tmp/bittery91-replica-cut-3z8dJk/captures/catalog-cuts/wipe-two-cuts-assertions-manifest.md`,
SHA-256 `aff96ffe795616fa5a215ce478be994bd07567166f082748fd05087ea81f30b9`; it pins the Rust test leaf and the ticket91 blob as it stood before this docs-only correction. A
separate run-evidence receipt at
`/tmp/bittery-runtime-orchestration.7hGO37/physical91-two-wipe-fixed-verified.json` records and verifies the hashes of these four raw final logs:

- Regression: `/var/tmp/bittery91-replica-cut-3z8dJk/captures/catalog-cuts/wipe-store-absence-regression-final.log`, SHA-256 `0209513d19502e1c87d914901ea0fdd56505d15d45968dbd5572b6835aaabf4b`.
- All 15 serial physical cases: `/var/tmp/bittery91-replica-cut-3z8dJk/captures/catalog-cuts/wipe-two-cuts-assertions-15-serial.log`, SHA-256 `a61356f38d149a35d034b8e2175ce5310ed357f57205117b48194a441cf12b1e`.
- Strict Desktop all-target Clippy: `/var/tmp/bittery91-replica-cut-3z8dJk/captures/catalog-cuts/wipe-two-cuts-assertions-clippy.log`, SHA-256 `ca493a889ecfd679d9f5b5efb65241f1039c931a29c325ca8f80cfc27590e934`.
- Leaf `rustfmt --check`: `/var/tmp/bittery91-replica-cut-3z8dJk/captures/catalog-cuts/wipe-two-cuts-assertions-rustfmt.log`, SHA-256 `105a4e914ab6866ed7e5df0991e6dfb094a5f35d44ad29cfd0c2fccc8448f8fb`.

These private evidence artifacts remain outside Git. This repairs fixture assertions only and does not
complete ticket91.

2026-09-23 the next accepted bounded physical Wipe increment is four Linux process cuts through the
existing closed source/catalog harness. For each cut, observe the exact successful
`ResetLegacySourceFamily` response (DesktopSyncStore or Credentials, with matching nonempty handle,
wipe ID and family) before fsyncing the marker and killing/reaping the owned child. After SyncStore
deletion the journal remains Wiping revision 1 with SyncStore and Credentials pending; after its
receipt it is revision 2 with only Credentials pending. After credential deletion it remains revision
2 with Credentials pending; after its receipt it is revision 3 with no legacy families pending, while
Runtime and host cleanup are still outstanding. Source and catalog scope remain the immutable
pre-cut capture. SyncStore cuts preserve the exact legacy credential entries and Runtime/platform/
host values. Credential cuts prove every recognized legacy selector absent while preserving foreign
and near-miss entries and Runtime/platform/host values. All path-absence assertions require
`symlink_metadata` to return `NotFound`.

Each child is killed and reaped after its fsynced marker. A fresh `NativeProfileSource` reacquires the
original durable scope, retries the same wipe ID without `open()`, proves the already-deleted family
`AlreadyAbsent`, avoids a duplicate receipt, and finishes at Wiped revision 4. The fixture's actual
Replica and artifact owners remain empty; this increment makes no populated-row, WAL-byte, power-loss,
old-writer-exclusion or supported-OS claim. Terminal Wiped-write, Runtime-family, provider-loss and
populated-owner cuts remain separate; ticket91 stays open.

2026-09-23 the four accepted SyncStore/Credentials Wipe cuts pass in the existing Linux physical
process harness. SyncStore deletion holds after both legacy files are absent but before Core's
acknowledgement, with the journal at Wiping revision 1 and SyncStore/Credentials still pending; its
receipt cut holds at revision 2 with only Credentials pending. Credential deletion holds at revision
2 before its receipt, with every owned legacy credential selector absent and the foreign and
near-miss entries intact. Its receipt holds at revision 3 with no legacy families pending; Runtime
and host cleanup are still outstanding. Each source cut validates the exact `ResetLegacySourceFamily`
response handle, wipe ID, family and `Reset` result before fsyncing the marker. Every absence check
uses `symlink_metadata` and accepts only `NotFound`.

All four children are SIGKILLed and reaped. A fresh provider reopens the unchanged durable scope,
replays the selected deleted family as real `AlreadyAbsent`, does not duplicate a receipt, and
finishes the same wipe ID at Wiped revision 4. The final leaf hash is
`764f522bfdbae5643c86d85eb6f650c542c6a0db0af337f5735e0a9a88bfd2c6`; the final serial transcript
contains 19 separate exact physical cases, each 1 passed/0 failed, at
`/var/tmp/bittery91-replica-cut-3z8dJk/captures/catalog-cuts/wipe-family-final-19-serial.log`,
SHA-256 `d7b91d97b026d51036bf42add336c081b7bdd5ec2dd3187403d58e0c3aab0e39`. Strict Desktop
all-target Clippy passes with `-D warnings` (log SHA-256
`566ce4d11e65bfdf76e03e41a3f1c9827318833b6de8fdc326dda54acfb557b5`); leaf rustfmt check and the
dangling-symlink absence regression also pass. The external raw-log manifest is
`/var/tmp/bittery91-replica-cut-3z8dJk/captures/catalog-cuts/wipe-sync-credentials-final-manifest.md`,
SHA-256 `fe94bff92075d7d4a303c2dfdcc7839f13256a7e1e23ada488b989274fa6e07b`.

The actual Replica and artifact SQLite owners remain empty. This checkpoint does not establish
populated-row recovery, SQLite/WAL byte equality, terminal Wiped-write or Runtime-family cuts,
provider-loss behavior, power-loss atomicity, old-writer exclusion or supported-platform acceptance.
Ticket91 remains open; the other admission, Extension and full-CI requirements are unchanged.

2026-09-23 Wipe selector-fixture correction: `seed_wipe_crash_fixture` now seeds the exact
`bittery_account_orphan_secret_key` reference with a test-owned value alongside the existing
`_secret_key_extra` near-miss. The shared keychain assertion requires that exact entry in its fixture
before checking state, so its state loop proves the entry is present before Credentials deletion,
absent at both the Credentials-deletion and Credentials-receipt cuts, and absent after fresh
Wipe retry. Runtime, foreign and near-miss entries retain their existing boundary checks; production
selector behavior is unchanged.

All 19 exact ignored physical cases pass serially as separate Cargo processes against corrected leaf
SHA-256 `3634e97302ce3f220b20f5a9ed69df3d437453837156a197b2a71df510002ee4`. The dangling-symlink
regression passes 1/1, strict Desktop all-target Clippy passes with `-D warnings`, and leaf
`rustfmt --check` passes. The corrected source and raw-log hashes/counts are pinned by
`/var/tmp/bittery91-replica-cut-3z8dJk/captures/catalog-cuts/wipe-secret-key-selector-final-manifest.md`,
SHA-256 `10d37ce53b7fca30c860affe6d8274e89b8d8f40f3c71b6cc52db2253bd061ae`.
This supersedes the earlier leaf hash and verification logs as the current physical Wipe fixture
checkpoint; prior manifests and raw logs remain unchanged. The SQLite owners remain empty, and this
fixture correction does not close ticket91 or change its remaining acceptance requirements.

2026-09-23 next bounded Linux Wipe frontier, resolved against the Runtime platform-cut and remaining
Wipe-family source audits before implementation: extend the closed physical child harness with exactly
three successful actual-provider cuts. Hold after DevicePlain `DeletePrefix` with the exact Runtime
namespace prefix and preserved DeviceCatalog key, after DeviceSecret `DeletePrefix` with that exact
namespace prefix and no preserved key, and after the final DevicePlain catalog `Set` to Wiped. In both
prefix cuts the durable catalog remains the original `Reset/Wiping` revision 3 with the immutable
pre-cut legacy scope and wipe ID, all legacy families receipted, and the existing Runtime cleanup
still outstanding. DevicePlain deletion must leave the owned Runtime plain value absent while the
owned Runtime DeviceSecret remains; DeviceSecret deletion must leave both absent. The terminal Set
must be Wiped revision 4 with the same scope and wipe ID, no remaining families or Accounts, and all
Runtime-owned prefix values absent.

The observer must validate the exact request selector and actual `PlatformStorageResponse::Done`
before syncing the marker. Parent assertions inspect the committed SQLite records and protected-vault
mapping before and after SIGKILL/reap, retain the foreign and near-miss fixtures, and prove the named
abandoned NativeFiles file is already absent before another NativeFiles owner can recreate its
directory. The two Wiping cuts recover by explicitly retrying the original Wipe through a fresh real
source provider and finish the same ID at Wiped revision 4. The terminal cut recovers through NORMAL
OPEN, verifies the same durable Wiped tombstone, and observes no profile capture/import request from
the fresh real source provider; it does not issue a new Wipe. DevicePlain and DeviceSecret are distinct
actual native backing areas even though DeviceSecret shares the OS vault with legacy credentials;
the Core reset path enumerates all areas after host cleanup, and its catalog-preserving DevicePlain
deletion precedes DeviceSecret deletion and the final Wiped Set. Replica and artifact SQLite owners
remain empty. This increment claims Linux process loss only, not populated rows, WAL/power-loss
atomicity, old-writer exclusion, SessionSecret durable deletion, or supported-platform acceptance;
ticket91 remains open.

2026-09-23 three further actual Linux Wipe process-loss cuts are integrated. DevicePlain Runtime
DeletePrefix and DeviceSecret Runtime DeletePrefix each hold the actual successful platform response
after its durable write and before Core acknowledgement; both observe the same immutable original
scope and wipe ID at Wiping revision three. The plain cut proves the owned plain Runtime value absent,
the owned protected Runtime value still present, and the foreign near-miss still present. The secret
cut proves both owned Runtime values absent and retains the foreign protected near-miss. Each retry
uses the original Wipe and reaches Wiped revision four. The terminal Wiped catalog Set cut observes
revision four with the exact original scope and wipe ID before acknowledgement. Recovery uses a fresh
normal Runtime open, issues zero profile-source requests, and preserves the exact Wiped tombstone;
it does not issue a new Wipe. Host cleanup precedes these platform writes and is non-vacuous: a named
fixture-owned abandoned host file is seeded and proven absent before any reopened NativeFiles owner
could recreate its directory. The exact orphan `_secret_key` fixture and previous 19 cuts remain.

All 22 distinct exact ignored physical tests pass serially, each in its own Cargo process and each
executing one test. The dangling-symlink absence regression passes 1/1, strict Desktop all-target
Clippy exits 0, and leaf Rust formatting check exits 0. Source SHA-256 is
`31136990063bdf3e7b2392c97bf661211afa1337a5d12d7a353bf4281dce91b7`. The complete command, count,
exit-status and raw-log hash manifest is
`/var/tmp/bittery91-runtime-terminal-cuts-v10.4RRUw7/final-manifest.md`, SHA-256
`9273ab5e6bc13526be79d79c13a005b7fad0fa87355c46c8483e846657a1d26e`. Actual Replica and artifact
SQLite owners remain empty: no populated-profile, SQLite/WAL byte-equality or power-loss claim is
made. This does not establish provider-loss recovery, actual legacy-writer exit/exclusion,
supported-startup or maintained-platform acceptance, remaining accepted-work or Extension families,
or either full-CI gate; ticket91 remains open. All processes exited and the source is frozen for
independent review.

2026-09-23 prefix-cut evidence correction: both DevicePlain and DeviceSecret prefix retries now
observe the fresh provider's actual `PrepareLegacyProfileReset` result and require the returned
snapshot to match the original scope and wipe ID. Each of the three already-receipted legacy
families must then be requested once through that acquired reset handle and return the provider's
actual `AlreadyAbsent` result with no byte payload. The held journal remains Wiping revision 3 and
recovery reaches Wiped revision 4 without another receipt. For both prefix cuts, the write observer
captures the original wipe ID only after the delegated initial Wiping revision-zero catalog Set
returns `Done`; every subsequent catalog Set and the fsynced cut marker must retain that ID, which is
also compared with the held journal and recovered terminal record. The terminal Wiped-write cut
continues recovering through normal Runtime open with zero source requests and the unchanged
tombstone. Targeted checks and the final 22-process run, dangling-symlink regression, strict Desktop
all-target Clippy, and rustfmt results are recorded in the new external manifest at
`/var/tmp/bittery91-runtime-terminal-fix.Th2l8c/final-manifest.md`. This closes the two evidence gaps
from the prior bounded review only; the remaining ticket91 acceptance work is unchanged.
