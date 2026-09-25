# Protected Vault-image artifact storage and recovery

Type: task
Status: resolved
Blocked by: 65, 69, 86, 92
Spec: ../desktop-extension/vault-image-artifact-protection.md#selected-mechanism-and-migration-decision

## Contract

Deepen the existing Core Vault-image artifact capability with one random artifact key, existing
AES-GCM/AAD envelopes, and an existing Device-key wrapper. Preserve public image bytes/digests and
immutable accepted requests. Hosts store opaque protected chunks; only Core current authority can
admit image decryption, and cleanup remains identity-only. No hidden application reads, resumed
transcryption, new login secret, Device-key export or separate artifact backend is authorized.

Implement the spec's exact scope/chunk/metadata binding and zeroizing lifetimes. Add versioned image
storage and recovery records with old raw-artifact/archive readers. Add the optional accepted local
protected-publication witness, preserving absent legacy serialization and immutable HTTP bodies.
Recovery checks opaque bytes against that accepted witness. Legacy upgrade publishes ciphertext while
retaining raw bytes, commits the witness under the source revision, then cleans raw bytes; no assumed
cross-store atomicity or accepted dependency loss at failure/restart. Encrypted recovery carries only
the necessary artifact key inside its existing encrypted stream, validates opaque image ciphertext
without hidden image decryption, and rewraps under the destination Device key during guarded repair.
Preserve current checkpoint dependency coverage until terminal cleanup.

## Acceptance

Start test-first with real Core ingress → SQLite protected publication → process reopen → unchanged
image upload. Inspect actual bytes and envelope bounds. Widen to IndexedDB/Worker, Create before a
Vault key exists, Update, every checkpoint, same-ID/wrong-scope metadata and chunk corruption,
reordering/truncation, caller/Account/Vault retirement, password/key replacement and missing Device
secret. Held/failing commits prove legacy raw conversion resumes without losing accepted work and
does not claim completed erasure before cleanup.

Real locked encrypted recovery must preserve the accepted image and its exact request through export,
same-device repair and another Device-key domain, without decrypting hidden image chunks or exporting
the source Device key. Preserve existing raw recovery vectors and new protected portable vectors;
run actual Server/object-storage image acceptance plus native/IndexedDB recovery/conformance. State
the actual raw-row/temp/WAL cleanup limits; compilation or mock images are insufficient.

Run generated ADR0012 contracts, crypto compatibility vectors, affected Core/native/Web tests and
types, then full `pnpm check:ci` and `pnpm check:ci:rust` before phase completion. Independent review
must cover key lifetime, format compatibility and recovery ownership.

## Readiness and comments

2026-09-09: draft delivery prerequisite after root selected92's mechanism. Keep `needs-triage` until
independent mechanism/contract review resolves92. Dependencies65/69/86 are resolved. No production
source change or acceptance is claimed. This gates71 and70's protected-image retirement variant;
70's no-image foundation can proceed independently.

2026-09-09: independent mechanism/readiness review passed after the accepted protected witness and
three-stage legacy migration ordering were added. Research92 resolved;65/69/86 are resolved. This
ticket is ready for its smallest test-first protected-ingress vertical slice. Derive missing legacy
User identity from validated Account/Replica evidence. Portable recovery preserves the existing
Account-ID/repair guards and changes Device-key domain; it does not authorize arbitrary Account
remapping. No implementation or production acceptance is claimed by readiness.

2026-09-09 first protected-representation tracer: a real multi-chunk crypto publication/reopen test
failed against the compiling stub (`/tmp/bittery-protected-image-first-red-3.log`), then passed with
the existing AES-GCM/AAD primitives (`/tmp/bittery-protected-image-first-green.log`). All six focused
tests passed (`/tmp/bittery-protected-image-crypto-matrix.log`,2.60s): exact binary readback, Account/
Operation/Vault/User scope, wrong Device key, accepted witness replacement/reorder/truncate/duplicate/
tamper, authenticated metadata rewrite, independent specified AAD and full2MiB images within16 bounded
envelopes. Independent primitive review passed for scope, metadata authentication, bounds and key/
plaintext zeroization. This is staged shared Core representation only. Real SQLite/IndexedDB protected
publication, facade authority admission, hidden-read refusal, legacy migration and recovery translation
remain required; no production protection or93 completion is claimed.

2026-09-09 physical representation refinement recorded before implementation: the existing image
store must retain raw and protected publications concurrently until the guarded source witness commit.
Use a publication component within the same Account/Operation family and an exact generation-delete
primitive, preserving whole-family `delete_bound` for terminal cleanup. Native/Memory/IndexedDB use
one generated contract; no shadow Operation ID, replacement backend or cross-store atomicity claim.

2026-09-09 first actual SQLite protected publication failed against the raw-only verifier
(`/tmp/bittery-protected-image-sqlite-red.log`) and passed after same-store generation/metadata support
(`/tmp/bittery-protected-image-sqlite-green.log`). The fresh file contains protected envelopes, survives
store close/reopen and returns exact original image bytes through the shared crypto reader. The full
image matrix passed17 cases (`/tmp/bittery-protected-image-storage-matrix-2.log`,2.56s), including
transactional legacy raw migration, concurrent raw/protected publications, family cleanup and existing
storage failure histories. Physical recovery passed16 cases
(`/tmp/bittery-protected-image-raw-recovery-regressions.log`,0.12s), including old-layout read without
migration and unchanged raw archive repair. Recovery explicitly refuses protected publications until
the additive portable representation is implemented. Fresh ciphertext-only file evidence does not
prove removal of prior raw free-page/WAL bytes; conversion cleanup, IndexedDB, current-authority
admission and protected recovery remain acceptance gates. No production ingress protection is active.

2026-09-09 migration cleanup refinement: witness publication alone cannot acknowledge erasure. The
existing accepted image record also retains `rawCleanupPending` (default/omitted false), valid only
with a protected witness. Legacy witness installation sets it true in the same guarded Replica plan;
only exact raw-generation deletion plus successful native cleanup of freed pages/WAL permits a
guarded false acknowledgement. A missing raw row after a lost acknowledgement or failed physical
cleanup does not discharge that obligation. Fresh protected admission starts false. Recovery preserves
the duty, and the existing image lifecycle retries it; no separate runner or retry map is introduced.

2026-09-09 parallel recovery implementation starts at the sealed key-translation seam. Manifest2
adds protected metadata/chunk/key records; manifest1/raw readers and the outer encrypted envelope
remain unchanged. Core alone unwraps an exact artifact-key payload into the encrypted archive and
rewraps it under the destination Device key during guarded repair. Physical executors receive only
opaque wrapped metadata and ciphertext. The accepted optional `protectedWitness` uses the actual
shared protected type and is omitted for all legacy records; immutable HTTP bytes are unchanged.
No portable recovery acceptance is claimed until its real storage/locked/restart cases pass.

2026-09-09 bounded physical storage/control checks: actual native generation cursor and exact raw
deletion preserve the protected sibling; independent generation/control review passed. SQLite corrupt
BLOBs and excessive chunk counts are refused before owned allocation. IndexedDB uses bounded cursor/
row reads, and its13 storage tests pass, including legacy2→3 migration and exact generation cleanup.
Actual Chromium passes4 histories, now including raw/protected store reopen, generation ordering and
raw-only deletion with the protected bytes unchanged
(`/tmp/bittery-protected-image-generation-chromium.log`,4.27s). These host fixtures validate opaque
storage mechanics; real encryption is covered by the separate Core crypto/SQLite vectors. The actual
WASM binding check passed1m40s and all14 dependent type checks passed56.55s. Existing crypto workspace
checks passed162 tests, formatting and all-target Clippy without algorithm or legacy serde changes.

The actual raw database/WAL erasure tests reproduced both failures before the fix: deletion left the
known old plaintext marker, and a competing reader did not prevent acknowledgement
(`/tmp/bittery-protected-image-raw-erasure-red-2.log`). Both pass after one shared native deletion
finalizer (`/tmp/bittery-protected-image-raw-erasure-green.log`,5.24s): secure deletion before writes,
VACUUM and checked WAL truncation. A held reader causes visible failure after the selected raw row is
gone; retry after reader release still finalizes physical cleanup and leaves protected chunks intact.
Exact generation, family, Account, Wipe and orphan cleanup share this primitive. This tests current
SQLite database/WAL bytes, excluding snapshots and physical storage recovery. IndexedDB evidence
covers committed deletion and owned-buffer disposal, not browser backing-file forensic erasure.
The accepted witness/cleanup-duty transition and protected Runtime ingress/authority integration
remain incomplete; these results do not establish93 completion or production hidden-read protection.

The first fresh protected ingress tracer reproduced raw publication through the existing facade
(`/tmp/bittery-protected-image-facade-red.log`), then passed through the shared protected writer
(`/tmp/bittery-protected-image-facade-green.log`,0.12s). It uses the existing source claim/close and
exact-generation cleanup lifecycle, writes no raw generation or known plaintext file marker, and
reopens the actual SQLite store to recover exact image bytes. Independent ingress review passed
bounded source assembly, zeroization, metadata/Device-key binding and error cleanup. The combined
image matrix passes24 cases (`/tmp/bittery-protected-image-erasure-storage-regressions-2.log`,5.72s),
including prior raw compatibility/failure histories and portable key primitive. Runtime admission
remains inactive pending complete protected recovery, legacy upgrade and foreground authority gates.

2026-09-09 protected recovery implementation checkpoint: physical capture now emits explicit
protected metadata/chunk records carrying publication identity. The old raw envelope is unchanged;
known native schema1 reads without migration, and schema2 paginates every raw/protected sibling.
SQLite's17 recovery regressions and IndexedDB's14 capture/immutable-restore regressions passed
(`/tmp/bittery-protected-image-recovery-sqlite-matrix.log`,
`/tmp/bittery-protected-image-recovery-idb-green.log`). Recovery controls were generated from Rust;
changed TypeScript passed Biome and package Turbo types. Independent physical-port review passed
Account/generation scope, bounds, raw compatibility and refusal of conflicting records. No artifact
key or Device key was added to the physical control contract.

The portable primitive and actual encrypted archive export each reproduced their prior missing
behavior before implementation. Export unwraps only the accepted artifact key under the existing
Device capability and sends it directly into the unchanged authenticated recovery envelope. Raw-only
exports remain manifest1; protected exports use manifest2. Missing/wrong Device keys produce Partial
with a bounded unavailable-image-key finding and preserve the opaque evidence. Repair's authenticated
first pass requires scoped portable keys and verifies ciphertext against the original accepted
witness, then retains only destination-wrapped metadata. Its second pass checks the original archive
fingerprint/record hashes and never sends a portable key to physical storage. Existing exact wrappers
are reused after key validation; lost-commit retries compare destination metadata and ciphertext.
Independent archive/ownership review passed. The in-memory archive matrix and actual SQLite archive
composition are still being completed; no locked/hidden Runtime or production acceptance is claimed.

The protected encrypted-archive matrix now passes5 tests in70.21s
(`/tmp/bittery-protected-image-archive-matrix-2.log`): accepted-witness coverage, encrypted artifact-key
export, missing/wrong Device-key Partial reports, same/different Device-key repair with exact ciphertext
and accepted rows, and a lost commit acknowledgement whose retry retains revision6. Six authenticated
negative archives (missing key with corrected report count, foreign publication/User, legacy manifest,
invalid key length, changed ciphertext) fail before physical writes. An intermediate repair failure was
an in-memory adapter incorrectly comparing metadata JSON property order; physical SQLite/IndexedDB
compare stored fields. That fixture was corrected without relaxing field/byte equality or changing
production repair. An independent agent is verifying the full archive path through actual SQLite.
The broader recovery suite and real protected Runtime ingress acceptance remain open.

2026-09-09 actual SQLite archive/repair tracer: `sqlite_protected_archive_repair_preserves_accepted_work_across_device_change_and_lost_commit`
passed on its first execution (21645, 23.49s; `/tmp/bittery-protected-image-sqlite-archive-tracer.log`).
The test seeds the shared protected-image fixture into real SQLite Replica and image stores, then
uses production `SqliteRecoveryStorage::read_entry`, `add_artifact`, and `execute_repair` through the
closed recovery executor. Only encrypted archive Sink/Source transport and the Device capability
use existing test fixtures. It exports the authenticated archive, closes physical handles, corrupts
a derived row and removes image artifacts, then reopens storage under a different Device key.
An injected response loss happens only after the actual SQLite commit returns `Repaired`.
Recapture proves complete repair; retry keeps revision 6. The original accepted Operation bytes and
opaque image ciphertext remain identical, the destination key decrypts the restored image, and the
source Device key is refused. No image decryption occurs in recovery itself.

Parent independent review found no blocker or worthwhile extra abstraction. The new test file's
format check and `git diff --check` passed. This is actual storage/Core/archive capability evidence,
not production protected ingress, browser/OS acceptance, or a replacement for required full CI.

2026-09-09 guarded Runtime upgrade now passes its real SQLite tracer and failure matrix. Fresh
Runtime admission uses the protected facade, accepted witness and the existing Account/Vault
foreground registry. Legacy conversion commits its witness and raw-cleanup duty under the original
Account incarnation/User/epoch/revision; failed publication acknowledgement retains raw bytes, and
retry discovers the same protected publication. The shared opaque reader checks ciphertext and the
small authenticated key wrapper when discovering a conversion, without opening image envelopes.
Raw cleanup verifies the accepted opaque sibling before deleting any raw generation; a missing
protected dependency reproduced unsafe cleanup before this guard. The seven cleanup tests pass
(`/tmp/bittery-protected-image-cleanup-dependency-green.log`,5.04s), including a real held SQLite WAL
reader, failed source commit, exact sibling retention and missing Device-key refusal without replacing
its key domain. Original accepted request bytes and fingerprints remain unchanged.

The existing Device-key helper is shared by normal/native installation and startup under catalog
serialization. Image admission only loads the existing key under Account execution, avoiding inverted
lock ordering. Startup missing-key failure still permits the existing recovery-only request gate.
The existing staging owner now admits visible/unlocked image reads and carries its actual foreground
cancellation token through HTTP upload; confirmed/frozen protected paths do not open image chunks.
Current-key admission review, actual held-HTTP lock/hidden tests, host buffer disposal, joined Worker
acceptance and the required full checks remain in progress. This checkpoint is not93 completion.

2026-09-09 recovery integration checks: the broader recovery suite passed73 cases in158.51s
(`/tmp/bittery-protected-image-recovery-broad.log`), including existing raw archive compatibility,
maintenance admission, protected portable repair and actual SQLite histories. Production transport
review then found a missing protected-chunk case in both outer recovery executors. The reproducing
Web and native tests failed before the fix (`/tmp/bittery-protected-image-web-recovery-executor-red.log`,
`/tmp/bittery-protected-image-native-recovery-executor-red.log`). Core's existing `has_binary` predicate
now supplies native pairing instead of a copied variant list. Web derives pairing from the required
`chunkIndex` field after closed generated validation. All8 native and5 Web executor tests passed
(`/tmp/bittery-protected-image-native-recovery-executor-green.log`,
`/tmp/bittery-protected-image-web-recovery-executor-green.log`), including actual SQLite and IndexedDB
writes, missing-byte rejection and Account isolation. Independent review passed both pairing seams;
no key or new physical control variant was exposed. Actual Chromium locked export/Worker-loss/repair
and production protected ingress acceptance are still running, and full phase checks remain required.

2026-09-09 bounded HTTP upload disposal audit reproduced two owned-copy gaps before correction:
native request preparation retained a separate upload Vec, and Web kept its mutable Request handoff
bytes after Fetch took its copy (`/tmp/bittery-http-upload-native-red.log`,
`/tmp/bittery-http-upload-web-red.log`). The existing transport now owns dispatch bodies and serialized
Rust requests through zeroizing types; completed typed HTTP requests erase their body on Drop.
Native decoding avoids a generic JSON Value body copy and transfers its one body allocation into
reqwest's existing Bytes owner backed by a zeroizing Vec. Its final owner drop erases that allocation.
Web erases parsed arrays, Request handoff arrays and signed-hash buffers, including cancellation while
hashing is held. The shared HTTP policy, body bytes, headers, URLs and generated wire remain unchanged;
the serialized executor signature adaptations only express ownership and reuse the platform-storage
pattern. No additional uploader or retry owner was introduced.

Final checks passed: Core HTTP16/16 (`/tmp/bittery-http-zeroize-core-green.log`), native HTTP10/10
(`/tmp/bittery-http-upload-native-green-2.log`), Web finite/stream25/25 including held-hash cancellation
(`/tmp/bittery-http-upload-web-green-2.log`), and actual Chromium production-generated SigV4 upload1/1
(`/tmp/bittery-http-upload-chromium.log`). The browser test proves wiping the handoff preserves the
actual signed upload. Package Turbo types, Biome, scoped Rust formatting, unchanged HTTP contract
generation (`/tmp/bittery-http-zeroize-contract.log`), actual wasm32 bindings compilation
(`/tmp/bittery-http-zeroize-wasm.log`) and `git diff --check` pass. Independent review found no further
ownership/policy issue or worthwhile abstraction. These are owned mutable-buffer guarantees:
immutable JavaScript strings, Fetch-managed bodies, and HTTP/TLS/socket-library copies remain outside
the erasure guarantee. This does not claim forensic browser or OS-memory erasure or replace full CI.

2026-09-09 actual Chromium joined Runtime recovery passed174 assertions, including the new protected
history and the existing Vault/Import histories (`/tmp/bittery-protected-image-chromium-recovery-8.log`,
50.94s). The history accepts a Create image through Core, verifies no raw publication, confirms the
public Lock response, exports a Complete encrypted archive, terminates the actual Worker and deletes
the image's physical IndexedDB rows. A new Worker runs ordinary Core startup before public Repair.
The original accepted Operation, image ciphertext, witness and all non-wrapper metadata remain exact.
Repair may create a fresh Device-key wrapper because physical metadata was removed; its retry keeps
the wrapper, ciphertext and Replica revision unchanged. After fixture authentication is restored,
Core uploads the original bytes to the exact-byte signed HTTP fixture, retains an Applied receipt,
and publishes the created Vault from fresh Bootstrap authority before cleanup. Independent review
required those actual receipt/projection assertions rather than treating a fetched page as promotion;
the final run includes them. This is actual Worker/IndexedDB/OPFS and shared-Core capability evidence
with seeded authentication and an HTTP fixture, not real Server/object-store or Extension acceptance.
The native real-Server image case and final full phase checks remain outstanding.

The first broad host run passed471/472 tests; the failure was an existing migration fixture assuming
that every schema upgrade adds exactly one version. The image store now upgrades legacy1 to3 with an
empty publication component. Its test now explicitly verifies current version3 and every old value
plus that migration-owned component, and still rejects older reopen. All3 maintenance migration
cases pass (`/tmp/bittery-protected-image-maintenance-migration-green.log`). No production storage
behavior was changed to satisfy the fixture. Package Turbo types and changed TypeScript formatting
pass; literal full `pnpm check:ci` and `pnpm check:ci:rust` are running.

2026-09-09 activated-image fixture alignment: the Create-Vault tests now use the existing stateful
MemoryPlatform storage capability and a persisted test Device key; four restart owners share that
same storage. Three serialized fixture constructors explicitly open before unlocking. The old
write-discard/null-read SuccessfulDeletePlatform fixture was removed. Protected PNG retention checks
authenticate the original bytes before retirement, then preserve exact protected witness, metadata
and ciphertext across Lock, Sign out, Close and refused recovery. Failed-acceptance cleanup checks
actual publication-family absence rather than a missing legacy raw lookup. Replica/storage fault
injection is unchanged; no production unavailable-key bypass was added.

The first aligned matrix passed 46/49; the remaining three were missing explicit open calls. A later
broad run passed 103/104 and exposed the independently added current-Vault-key read regression, whose
owner corrected the production guard. The final current-source creation matrix passes 106/106 in
`/tmp/bittery-protected-image-fixture-adaptation-green.log` (5.31 seconds). Independent parent review
passed the bounded fixture changes. Native real-Server protected image restart/recovery acceptance
is being added to the existing four-process foundation fixture and remains a separate pending gate.

2026-09-09 full-check checkpoint: literal `pnpm check:ci` failed in wall-clock-sensitive host tests
while full Rust checks and a production WASM rebuild ran concurrently
(`/tmp/bittery-desktop-extension-progress-check-ci-6.log`). It reached host tests after earlier gates;
ownership-graph, IndexedDB conformance and recovery-write-fault histories timed out. A subsequent
unhandled write assertion followed test timeout, so the complete histories must be rerun under
isolated load before attributing that result solely to resource contention. Timeouts/assertions were
not weakened. Literal `pnpm check:ci:rust` was interrupted during crypto tests to remove competing
load and address the newly reproduced staging/retirement issue; it is not a passing full run
(`/tmp/bittery-desktop-extension-progress-check-ci-rust-3.log`). Final serialized full checks remain
required. Guarded Session refusal also lacks an HTTP deadline, so staging's Account execution lock
must not remain held across network work; that correction and its stale-reply/renewal regressions
are being completed before another phase-check run. No phase or application acceptance is claimed.

2026-09-09 actual native protected-Create image acceptance now passes through the existing
four-process foundation runner:
`BITTERY_NATIVE_FOUNDATION=1 pnpm --filter web exec playwright test runtime-native-foundation.spec.ts --project=cloud --workers=1 --grep 'native Runtime signs'`
passed one case (1.9 minutes; 2.3 minutes including stack startup) in
`/tmp/bittery-protected-image-native-four-process-2.log`. The first actual run reached protected
SQLite publication but the new fixture incorrectly expected camelCase `artifactReady`; the persisted
closed enum is snake_case `artifact_ready`. Correcting only that expectation preserved the exact
witness check (`/tmp/bittery-protected-image-native-four-process-1.log`). This was a fixture failure,
not a production protection defect. The existing inline scoped cleanup completed on that failure.

The actual native Core accepts an unbound selected PNG for CreateVault while offline, before its
Vault exists. It persists one protected publication with no raw sibling, bounded encrypted envelopes,
and an exact accepted witness and precomputed request fingerprint. Releasing the source caller does
not discard the accepted dependency. The original image bytes never appear in those inspected
physical chunks. Locked complete encrypted export includes the image alongside the existing accepted
Move and Vault-deletion race. Under the existing exclusive maintenance gate, the fixture removes that
exact image publication and its chunks. A fresh native process repairs the original accepted intent,
metadata and opaque ciphertext, allowing only the expected artifact-key wrapper rewrap. The next
process requires the repaired wrapper and all ciphertext bytes to survive unchanged before reconnect.

After QuickUnlock, the real Core uploads the original PNG through actual Server staging/object
storage. Acceptance waits for the original Applied receipt with the same fingerprint and current
Vault projection, then fetches the published URL and compares every image byte. Terminal cleanup
removes the complete Operation image family from both SQLite tables, and the fourth process verifies
the original receipt and physical absence again. The combined run also retains the existing real
online Update/image removal, lost Delete reply with all five accepted Item category rejections, and
unrelated Attachment Move/recovery checks. No new runner, key-inspection primitive, scheduler or
production ownership path was introduced. Independent parent review passed the helper and phase
integration. Restricted acceptance credentials now survive failed runs for scoped cleanup; successful
runs clean up and release the exclusive Server window.

This establishes fresh native protected Create ingress, same-Device locked archive repair, real
process restart, actual upload/current authority and terminal physical-row cleanup. Offline Update
with retirement before upload, another Device-key domain, legacy raw-image migration/free-page/WAL
cleanup, and supported-OS/dialog/application acceptance remain their separate gates. Logical absence
and inspected fresh chunks do not establish forensic erasure of historical raw bytes or temporary
selected source files. Full phase checks remain under the phase owner.

2026-09-09 independent integration review traced the actual ingress, staging, installation,
retirement, recovery and physical cleanup callers. Create and Update share the protected facade;
Update additionally requires current visible management authority and a usable current Vault key.
Protected confirmed/frozen stages do not open image chunks. Legacy conversion verifies the opaque
accepted sibling before exact raw deletion, retains `rawCleanupPending` through failed physical
cleanup/acknowledgement, and preserves original HTTP requests. Terminal family cleanup needs only
identity. The opaque verifier, small key-wrapper verifier and current-authority image reader enforce
different admitted actions; merging them would obscure those boundaries. No second key store,
image backend, uploader or retry owner was found.

The review found legacy conversion was also reachable through the old bare-Account-ID fixture
restore helper. That path lacks validated AccountMetadata and could republish pre-conversion cached
records after raw deletion. Protection now runs explicitly in validated production startup and the
existing staging owner; generic orphan sweeping performs no conversion. Both bare-ID restoration
helpers are test-only. A focused regression reproduced the former missing-Device-key failure
(`/tmp/bittery-protected-image-fixture-restore-red.log`), then passed
(`/tmp/bittery-protected-image-fixture-restore-green.log`): fixture restoration preserves exact accepted
raw work and raw bytes without creating a Device key/protected publication and restores SignedOut.
The non-test Core build check, existing restore regression, scoped formatting and diff check pass.

The existing real Web/Server `runtime-recovery.spec.ts` still has plaintext-PNG assertions and a
legacy three-component chunk-deletion key. Those are stale after protected ingress and must be
adapted and rerun; the joined Chromium capability test does not cover that production test file.
The parent owns that correction and the separate offline protected Update acceptance. Explicit valid
password/Vault-key replacement compatibility evidence and the serialized full phase checks remain
to be accounted for before closure. This review does not claim those pending acceptance histories.

2026-09-09 protected staging retirement review reproduced a held HTTP status/upload/Session refresh
preventing Account retirement while staging retained Account execution. Staging now releases that
existing guard after source validation and bounded legacy conversion, and reacquires it for guarded
checkpoint, retry and failure publication. Every awaited staging reply revalidates the original
Account incarnation, User, lock epoch, Operation identity and source revision; stale replies park
without moving accepted work or scheduling a replacement Account. The existing foreground image
loan spans only authenticated image read and HTTP upload and participates in Account/Vault drain.
Explicit Account retirement and exact native-generation retirement cancel their existing registry
before waiting for Account execution; stale generations cannot cancel current work. Refused Session
retirement keeps its existing proof-first ordering and can now reach that drain during held staging.
No network timeout is assumed.

Session renewal reuses the existing refresh request and exact Session publication helpers, splitting
transport from publication so staging can reacquire execution before the latter. Both successful and
failed late refreshes compare the current effective Session with the original document; a replaced
Session cannot inherit a stale refresh or authentication refusal. The additional failed-refresh
replacement reproducer was red in
`/tmp/bittery-protected-image-staging-renewal-refused-red.log`. All 15 production-transport/SQLite
lifecycle tests pass in `/tmp/bittery-protected-image-staging-renewal-refused-green.log`, including held
status, held upload, held refresh, Lock, Vault retirement, exact/stale native generation, exact/stale
Session refusal and Account/Session replacement. Before-read locked/hidden checks use deliberately
unreadable ciphertext and park without opening it; Update also requires a usable current Vault key.
These bounded tests inspect actual Core protected storage and the production HTTP cancellation seam;
their deterministic HTTP executor is not real Server acceptance.

The staging release passed 113 creation regressions before the additional failed-refresh case
(`/tmp/bittery-protected-image-staging-create-regressions.log`), and the final renewal seam passes all
27 dispatcher and 18 Account-refresh regressions
(`/tmp/bittery-protected-image-staging-dispatch-final-green.log`,
`/tmp/bittery-protected-image-staging-session-final-green.log`). Three dispatcher fixtures now persist
the existing test Device key, unlock current authority before image staging after restart/repair,
and inspect protected generation ciphertext instead of the superseded raw-image chunk. Their
production HTTP fixture still verifies the original upload bytes and unchanged final request.
Formatting and `git diff --check` pass. Real native/Web histories and literal phase checks remain
owned by the acceptance/phase runs recorded separately; these focused greens do not close ticket 93.

2026-09-09 the same four-process native fixture now also accepts a protected image Update to a
separate, already authoritative Vault while offline. Both original Create and Update Operations,
request fingerprints, image witnesses, ciphertext chunks and artifact-ready checkpoints survive the
locked archive damage/repair and subsequent real SQLite process reopen. Repair permits only the
Device wrapper replacement required by physical publication loss; reopen compares that repaired
wrapper too. Actual Server reconciliation retains each original receipt identity, current Vault
metadata and exact fetched PNG bytes; terminal cleanup leaves neither image metadata nor chunks.
The existing deletion race, five Item categories, unrelated Move and fourth reopen still execute.
The accepted Update does not optimistically alter the Vault name or image.

`/tmp/bittery-protected-image-native-update-four-process-2.log` passes the one actual acceptance case
(1.7 minutes; 2.1 minutes total), with successful scoped cleanup. Web dependent type checks pass
11/11 in `/tmp/bittery-protected-image-native-update-types.log`; native compilation, formatting and
`git diff --check` pass. The preceding run reached exact image repair/reopen but timed out at the
existing 30-second authoritative Item precondition, before image convergence assertions
(`/tmp/bittery-protected-image-native-update-four-process-1.log`). Safe scheduling/authority
failure diagnostics were added, and the second run passed with unchanged assertions and deadlines;
no production cause for the first timeout is established or claimed fixed. Hidden-policy acceptance
is the next bounded variant, not evidence supplied by this successful visible-Update history.

2026-09-09 the independent parent review passed the final Session renewal seam: the HTTP Result is
retained until original Account scope and effective Session are checked under Account execution,
then the existing publication helper handles replacement. This covers both successful and refused
late refreshes without a second Session or retry owner.

The missing Device-key startup question is now demonstrated through the public Runtime request
path with actual SQLite Replica and protected image storage. Normal `open()` returns the precise
unavailable-key error and creates no replacement key. The same failed-open Runtime can inspect
recovery and export an encrypted Partial archive through its existing maintenance owner. Reading
that archive through the authenticated reader and EOF verification proves exact original accepted
row and protected ciphertext preservation, an explicit `UnavailableVaultImageKey` report finding,
and no portable artifact key. Physical records remain unchanged. The focused test passes in
`/tmp/bittery-protected-image-missing-key-public-recovery.log`; independent parent review passed.
The secret-storage port and archive sink in this bounded test are fixtures; SQLite and Core public
recovery are real. No production fallback or ready-state exception was needed.

The existing protected Update fixture now covers a fresh valid master unlock key with the current
Vault key rewrapped under it, and a fresh valid current Vault key under the existing master unlock
key. Both use real compatible key envelopes, the existing live key owner and current Ready Vault
authority. The production HTTP transport sees the original image bytes, after which Lock cancels
and drains that held upload. The complete accepted Operation, public request/fingerprint, protected
witness, metadata/ciphertext and Device key stay unchanged. The original corrupt-wrapper rejection
case remains in the same parameterized helper. All 17 protected lifecycle tests pass in
`/tmp/bittery-protected-image-lifecycle-final17.log`, with the three focused Update cases in
`/tmp/bittery-protected-image-key-replacement-compatibility.log`. This establishes compatibility after
valid key replacement; it does not claim the actual password-change or Server key-rotation ceremony.
Independent parent review passed the parameterized replacement histories. The existing actual
SQLite changed-Device/lost-commit archive tracer also passes after sharing its unchanged setup with
the failed-open test (`/tmp/bittery-protected-image-sqlite-archive-regression.log`).

2026-09-09 real Web recovery regression acceptance passes against freshly rebuilt production WASM:
`pnpm --filter web exec playwright test runtime-recovery.spec.ts --project=cloud --workers=1 --grep 'locked recovery excludes|explicit re-Bootstrap|held prior-version'`
passed all three cases in 2.4 minutes
(`/tmp/bittery-protected-image-web-recovery-e2e-green-1.log`). The first attempted run failed before
artifact checks because the fixture omitted ticket86's captured picker scope
(`/tmp/bittery-protected-image-web-recovery-e2e-red.log`). The fixture now uses the actual selection
lifecycle, validates generated protected metadata against the accepted witness and opaque chunk
hashes, removes the exact publication's chunk, and preserves full metadata/ciphertext equality through
repair and Worker loss. Legacy layout acceptance explicitly verifies image schema1 to3 with unchanged
old row values plus the empty publication component. No production fallback or timeout was added.

Both image histories use actual signup, locked recovery UI, password unlock, Server staging and
current Vault projection. After the original Applied receipt, each fetches the published image and
compares every PNG byte, then waits for the selected Account/Operation family to disappear from both
physical image tables. Locked recovery also exercises a competing tab, actual Worker termination,
wrong-password/truncated archive rejection and lost repair replies; explicit re-Bootstrap preserves
accepted evidence before fresh authenticated hydration. Independent review passed both the fixture
adaptation and final upload/cleanup observations. Web dependent types (11 tasks), Biome and diff
checks pass. These are production Web regressions, not Desktop renderer or Chrome Extension acceptance.

The host histories that timed out during the earlier concurrent full-check attempt passed in separate
runs without competing builds: all five IndexedDB conformance/recovery-write-fault histories
(17,898 assertions,9.26 seconds; `/tmp/bittery-protected-image-host-timeout-rerun.log`) and all ten
ownership-graph histories (47 assertions,26.52 seconds;
`/tmp/bittery-protected-image-ownership-timeout-rerun.log`). Those targeted results do not replace a
successful literal full-check run. The phase owner is rerunning the complete checks with heavy builds
serialized; hidden-policy native acceptance remains separately outstanding.

2026-09-09 selective scheduling follow-up: a completed selective Vault fence exposed the dispatcher's
whole-pass return on the first parked Operation. The corrected reproducer failed with that return
(`/tmp/bittery-protected-image-dispatch-isolation-red-3.log`): a second Vault's independently accepted
protected image could not progress. Earlier attempts first had a test import error and then left
retirement unfinished; that correctly routed Account cleanup and was not starvation evidence. The
corrected fixture acknowledges the selective retirement and explicitly proves no cleanup remains.

The existing dispatcher now continues its finite captured scan after parked Operations and cleanup
receipts. One shared fresh Account eligibility check before each candidate preserves incarnation,
User, lock epoch, Account failure, teardown/access retirement, pending Vault cleanup and Session
refusal. It does not require Unlocked or Ready for already-frozen ciphertext or identity cleanup.
Account-local scan deadlines join the existing aggregate only while that Account remains eligible;
reauthentication cannot turn an earlier sibling deadline into a spurious wake. No durable queue,
retry map, scheduler or new access policy was introduced. Manual external wakes may still query
accepted staging status; selective parking never uploads the image or reports artificial progress.

All 32 dispatcher tests pass in `/tmp/bittery-protected-image-dispatch-isolation-green-3.log`, including
same-Account selective progress, another Account's exact completion after refusal/failure, retained
cleanup duty and durable sibling backoff without a stale timer. All 17 protected lifecycle regressions
pass after the fix in `/tmp/bittery-protected-image-dispatch-lifecycle-regressions-2.log`. Independent
review passed the production scan and tests. The native hidden history now also requires the existing
unrelated Move and exact Attachment bytes to converge before policy disable, and observes the hidden
image through its actual durable retry deadline. That real run remains pending. The previous literal
host check7 stopped at formatting in the newly edited object-storage fixture, which is now formatted;
no full-check pass is claimed (`/tmp/bittery-desktop-extension-progress-check-ci-7.log`).

2026-09-09 actual native hidden-policy run1 stopped at the second-device fixture's policy enable,
before native hidden-authority assertions (`/tmp/bittery-protected-image-native-hidden-four-process-1.log`).
The third native owner had reopened both repaired protected images exactly and reached Ready/Unlocked;
scoped local native Account removal and catalog cleanup then completed; this helper does not delete
the Server User. The fixture incorrectly reused
the legacy browser Account resolver after signup had deliberately retired that session during the
Rust sign-in handover. This is a fixture boundary failure, not evidence of a production hidden-policy
failure or success. Its replacement performs an existing public SRP login with a fresh fixture ClientId
and isolated in-memory AccountStore, keeps the fixture Session/key ownership in a browser handle, and
uses the configured Server origin directly. It revokes only its own Session after proof-backed disable,
then clears its own keys. No Core Session or Device-key inspection/bridge is introduced. A failed revoke
remains a failure unless the isolated native proxy has already observed successful actual User deletion.
The corrected real hidden history remains pending.

2026-09-09 native hidden run2 passed the separately owned SRP Device setup and actual Server policy
enable, then failed the unchanged60-second combined predicate for selected Vault projection absence,
unrelated Vault presence, all-generation authority absence and completed retirement journal
(`/tmp/bittery-protected-image-native-hidden-four-process-2.log`,2.2 minutes). Runtime remained
Ready/Unlocked without Account failure or waiting reason. The current diagnostic does not distinguish
which part of that predicate remained false; it is insufficient to assign a production cause.
Read-only examination of the retained isolated Server database confirms enabled policy and a
`travel_mode_updated` User event. The native failure path completed local Account/catalog removal;
the separate Device closed its own Session successfully. The Server User remains in the isolated
database for diagnosis and needs scoped real deletion before a subsequent launcher resets that database.
No hidden-image acceptance or phase completion is claimed. Static types now cover the fixture's
dynamically loaded existing auth/storage/API modules, and all11 Web type tasks pass
(`/tmp/bittery-protected-image-hidden-fixture-device-types-final.log`).

The literal host check8 passed types, host tests and27 root tests, then exposed a joined Chromium
retirement fixture's unexpected pre-retirement `GET /sync/changes`. An unchanged rerun reproduced it;
phase diagnostics placed it before retirement. The fixture now reuses its existing explicit Sync
helper during seed, positively observes that catch-up, and still rejects every Sync after owner kill.
The focused actual Chromium history passes28 assertions in `/tmp/bittery-ci8-retirement-green.log`.
Independent review passed; the complete host check is being rerun separately.

Literal `pnpm check:ci` attempt9 passed in `/tmp/bittery-desktop-extension-progress-check-ci-9.log`.
Native hidden diagnostics subsequently gained separate projection, per-store physical, journal,
active-cursor and stored-policy booleans plus bounded public Sync route/status/event/cursor summaries;
independent review passed and the original60-second failure assertion is unchanged. Those diagnostic
changes pass11 type tasks and native test-target compilation. The prior run2 User was then deleted
through existing public Web Runtime sign-in and `deleteServerAccount`, with actual HTTP200 observed
(`/tmp/bittery-hidden-run2-scoped-cleanup.log`). Existing isolated Server/Vite configuration was started
directly without launcher reset or migration; the retained public Server event/request evidence was
saved first in `/tmp/bittery-hidden-run2-server-evidence.log`. Full Rust phase checks and successful
real hidden-policy acceptance are still outstanding.

2026-09-09 acceptance boundary correction after independent source audit: Server Bootstrap returns
membership authority regardless of Travel configuration; live Core Sync currently does not refresh/apply
verified Travel policy. Incoming policy ordering and retirement are explicitly71's contract, and71 is
blocked on93. Requiring that unimplemented integration to finish93 would introduce a dependency cycle.
This does not waive protected-image refusal under current Core authority or any71 production acceptance.
The unchanged real hidden history now has its own named maintained Playwright71 case through the same
four-process helper. The separately named70/93 baseline retains every original image/recovery/Delete/
Move assertion. No production filter, authority fabrication, new skip or expected-failure annotation
was added. Run3 failed compilation of a concurrently edited68 test before native execution
(`/tmp/bittery-protected-image-native-hidden-four-process-3.log`); it adds no hidden-policy result.
Scoped cleanup of its fresh User then passed via public Runtime deletion plus actual HTTP200
(`/tmp/bittery-hidden-run3-scoped-cleanup.log`). The shared fixture now captures its own public Web
Account/server/email immediately after signup and requires exact public deletion outcome plus the
matching actual DELETE200 during final cleanup, preserving evidence on any failure.

The separated70/93 baseline rerun did not pass
(`/tmp/bittery-native-foundation-baseline-separated-travel.log`). It reproduced the earlier restore
stall before image convergence: the original Item remained Pending at Replica revision60 through the
existing30-second authoritative precondition. Runtime was Ready/Unlocked without Account failure or
waiting reason. The lost Delete had Applied and two of five deleted-Vault Creates had Rejected;
three remained pending with protected Create/Update still ArtifactReady and an expired pending Move
retry. The safe Server timeline shows two successful operation exchanges and prompt Bootstrap/Sync
responses, followed by no ordinary HTTP for the remainder of the wait
(`/tmp/bittery-native-baseline-restore-http-timeline.log`). No protected-image staging attempt occurred
in that restored owner. This is a local dispatch/eligibility diagnosis target, not evidence that71's
hidden integration belongs in93. No deadline or assertion was changed and no production cause is yet
claimed. The new scoped cleanup did pass: exact captured public Web Account deletion returned Deleted
and its matching actual HTTP200 was observed; native local Account/catalog cleanup also completed.
Full Rust validation is running separately while the driver is inspected read-only.

2026-09-09 a bounded reproducer now establishes a production dispatcher progress bug independently
of the native process's unavailable interleaving. The existing retirement driver retains a finite
scan's captured active Account exclusions while preserving in-flight HTTP. If another legitimate
caller has already completed a retained retirement attempt, that attempt can finish without another
authority wake. The inner driver consumed its completion but discarded the resulting eligibility
change; the preserved scan could then park with accepted work still excluded.

The new history in `runtime/vault_retirement_dispatch_tests.rs` explicitly polls the actual driver at
existing Account execution locks and the existing held HTTP boundary. Account A's separate Vault is
retired by the existing fenced resume owner, while its exact encrypted accepted Item remains intact.
Account B's accepted protected image has an acknowledged selective fence. Account C's original held
request completes once, forcing a fresh outer scan after the earlier cleanup wake. A's stale no-op
retirement then completes while B keeps that scan pending; releasing B must allow A's original
Operation to reach its receipt without another Notify or Device timer. Earlier attempts exposed only
test setup errors: reusing an existing Bootstrap generation and checking the Item response variant
for Vault creation. Neither is bug evidence. The corrected history fails at its final starvation
assertion in `/tmp/bittery-stale-retirement-driver-red-3.log`; ten direct reruns reproduce that exact
assertion with every preceding phase proof passing
(`/tmp/bittery-stale-retirement-driver-red-repeat.log`).

The bounded production fix retains retirement completion in a boolean owned by that existing scan,
then scans fresh after the preserved scan finishes. It neither cancels in-flight HTTP nor changes
Session, authority, queue, retry or retirement ownership. Existing retirement failure backoff remains
inside the same retirement future. Independent review passed this change and the test's exact
original idempotency key/encrypted request comparison, single C completion, unchanged B image
Operation and absence of a timer. Focused green verification and an unchanged actual native baseline
rerun remain required; this controlled race does not by itself prove the failed native process took
that exact interleaving.

2026-09-09 the unchanged actual70/93 native baseline now passes against the retirement-driver fix:
`BITTERY_NATIVE_FOUNDATION=1 pnpm --filter web exec playwright test runtime-native-foundation.spec.ts --project=cloud --workers=1 --grep 'native Runtime signs'`
passed one case in2.1 minutes (2.5 minutes including stack startup), exit0, in
`/tmp/bittery-native-foundation-stale-retirement-fix.log`. All original deadlines and assertions remain.
The four-process history again proves lost DeleteVault reply reconciliation, all five exact accepted
Item categories rejected by deleted-Vault authority, unrelated Move/Attachment convergence, protected
Create and offline Update image recovery/restart, exact original public PNG bytes and terminal
artifact-family cleanup. Scoped final cleanup separately proves the captured public Runtime Account
deleted outcome and its matching actual Server DELETE200. Native/Server processes exited and the
isolated ports were released. The sole fixture correction was the safe diagnostic event field spelling
from `eventType` to Server `type`; it changes neither routing nor acceptance.

The controlled driver regression identifies a real race and the fresh actual history removes the
previous baseline progress failure; the failed process's exact unavailable interleaving remains an
inference. Incoming Travel's separate maintained71 case remains integration-red until its verified
policy contract is implemented. This result establishes native capability acceptance, not Desktop
renderer cutover, supported-OS acceptance, production legacy migration or final full-check completion.

2026-09-09 current-driver targeted verification passed: four retirement-dispatch histories
(`/tmp/bittery-stale-retirement-driver-green.log`),32 ordinary dispatcher histories
(`/tmp/bittery-stale-retirement-dispatch-regressions.log`) and17 protected lifecycle histories
(`/tmp/bittery-stale-retirement-protected-lifecycle-regressions.log`),53 tests total. These include
the deterministic stale-completion regression and preservation of held HTTP and unrelated Account
progress. Full Rust attempt4 passed the Server and crypto checks but stopped on Runtime formatting
(`/tmp/bittery-desktop-extension-progress-check-ci-rust-4.log`); the five affected Rust files were
formatted, and both Runtime and Desktop formatting checks now pass. Full suites are being rerun
against the current driver; the earlier host CI9 result predates this correction.

2026-09-09 full Rust attempt5 passed Server/crypto checks and stopped at four Clippy findings:
two redundant metadata borrows in protected-image reads and two test-expression simplifications
in protected-image repair (`/tmp/bittery-desktop-extension-progress-check-ci-rust-5.log`). These
were corrected without changing behavior; workspace/all-target Clippy now passes
(`/tmp/bittery-runtime-clippy-corrections.log`). Literal full Rust attempt6 is running against
that correction. Both full Rust invocations use a disposable `GIT_INDEX_FILE` containing the
intended generated Desktop bindings, so the final generation comparison detects drift from those
intended changes without staging or changing the actual user index. No full Rust success is claimed
until that command completes.

2026-09-09 full Rust attempt6 passed Server checks,151 crypto tests and11 format vectors,
Runtime formatting and workspace/all-target Clippy, then failed Core with969 passes and three
failures (`/tmp/bittery-desktop-extension-progress-check-ci-rust-6.log`). Source review traced
all three to outdated fixture assumptions: a native-only installation now creates its own local
Device key; first open checks durable protected-image evidence before initializing a missing key;
and the synthetic Vault-update fixture bypassed normal validated open/install without supplying
that key. No production policy was weakened to satisfy these failures.

The native test now proves its initially empty destination creates a distinct local Device key
that survives restart, while borrowed Session/QuickUnlock material and live access do not persist.
The startup test captures the first open's actual durable-read count and proves the second open
performs no further reads, retaining its single publication and SignedOut assertions. The image
fixture supplies a local Device key, verifies protected metadata/ciphertext and rereads the exact
accepted Operation through the persistence seam before the original exact-byte staging history.
An initial targeted compile exposed an incorrect fixture receiver for that reread; it was corrected
to `runtime.replica.load_uncached`, and is not behavior-red evidence
(`/tmp/bittery-full-core-fixture-corrections.log`). Corrected targeted tests and full Rust remain
pending; capability and production acceptance are not claimed from these edits.

2026-09-09 all three corrected Core histories pass individually
(`/tmp/bittery-full-core-fixture-corrections-2.log`), and Desktop all-target Clippy passes
(`/tmp/bittery-native-clippy-preflight.log`). Literal full Rust attempt7 is now running with
the same disposable generated-binding index and unchanged real user index. Full acceptance remains
open until that run completes; the fixture corrections alone are not a phase result.

2026-09-09 capability phase gate completed. Literal `pnpm check:ci:rust` attempt7 exited0
(`/tmp/bittery-desktop-extension-progress-check-ci-rust-7.log`): Server checks,151 crypto tests,
11 unchanged format vectors, Runtime formatting/workspace-all-target Clippy,972 Core tests,
binding/contract/conformance suites, all generated/native/Web binding comparisons, Desktop
formatting/all-target Clippy,192 Desktop library tests and60 native-host tests passed. Five existing
Desktop environment/child-process entry tests remain opt-in in that default suite; their separate
actual keychain/Server/native-binary evidence belongs to63/68/69 and the histories above, not this
default invocation. The disposable index comparison passed; the real user index remained unchanged.

Literal host `pnpm check:ci` also passed on the current production changes
(`/tmp/bittery-desktop-extension-progress-check-ci-10.log`), including freshly rebuilt production
bindings and all nine Chromium files. Subsequent Rust changes were the three fixture corrections
and the behavior-preserving Clippy expressions, now covered by the complete Rust run. Together
with the unchanged actual four-process native image/recovery/cleanup acceptance and independent
review recorded above, these checks close93 as a capability.68/70/94 also close their recorded
capability gates. This does not activate Desktop or Extension, establish supported-OS production
acceptance, or pass71's separate real incoming-Travel history.71 may now begin under its ready spec.
