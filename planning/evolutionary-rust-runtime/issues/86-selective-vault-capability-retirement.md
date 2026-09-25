# Selective Vault capability retirement

Type: task
Status: resolved
Blocked by: 63, 65, 67, 69
Spec: ../desktop-extension/selective-vault-capabilities.md

## Contract

Extend the existing Core foreground/Move lifecycle and native/Web file/image capability owners with
selective retirement of exact Core-supplied targets. Preserve unrelated Vault and Account work.
Hosts execute Item/Attachment/Vault identity fences and cleanup; Core owns visibility, admission,
durable purge progress, keys and indispensable accepted encrypted work. Generate the closed host
control under ADR 0012 and remove the touched handwritten download control mirrors.

## Acceptance

Actual native unused/claimed upload/download and image capabilities drain only selected targets;
late dialog replies and old handles fail; unrelated targets survive. Held plaintext IO/loans and
already-admitted finalization keep cleanup ownership through cancellation. Image Update prebinding
and unbound new Create selection are distinguished. Core foreground/Move source/destination races,
Web parity and generated-contract checks pass before purge consumes this capability. Full application
Travel/deletion and supported-OS acceptance remain in the consuming tickets.

## Comments

2026-09-09: independent Vault deletion inventory exposed Account-only capability retirement.
Selective generation/target support is a prerequisite for the remaining 70/71 purge paths; whole
Account retirement would cancel unrelated Vault work and would not preserve existing behavior.
Actual owner/caller inventory and proposed interfaces are in the focused spec. Dependencies are
resolved capabilities, but the target re-admission boundary still needs the orchestrator's mechanism
verdict before this ticket becomes ready-for-agent. No implementation or acceptance is claimed.

2026-09-09 mechanism verdict: keep target generations retired until Core explicitly re-admits from
fresh verified authority; reactivation never revives old handles/acceptance. Capture targets before
erasure and clear narrower state on Account removal. Independent review then identified moved
Item/Attachment IDs appearing in both old and current Vault generations. The spec now requires actual
Vault-bound grants/claims and proposes direct Account+Vault primitive retirement so stale unused
handles are not omitted by an authority-ID list. Final interface confirmation is pending; no code
has started.

2026-09-09 final capability mechanism: grants and exact Core claims carry actual Vault binding in
addition to Item/Attachment identity. The host retirement primitive selects Account + Vault, so old
unused handles are included even when their Item is absent from current authority, while the same
resource ID newly bound to another Vault survives. This implements the orchestrator's moved-resource
constraint without host lookup or ID-exclusion heuristics. Core-owned fresh-authority re-admission,
Update image prebinding/unbound Create semantics and acceptance draining remain as specified.
All four prerequisites are resolved; ticket is ready. Start with the native file primitive and real
filesystem behavioral tests, then finish shared claims, Web/image/Move controls and Core seams before
purge consumes it. No implementation acceptance is claimed by readiness.

2026-09-09 bounded native evidence: actual filesystem selective retirement, wrong-Vault claim,
re-admission and dropped queued cleanup tests reproduced behavioral failures before fixes; all ten
native file tests pass (`/tmp/bittery-selective-native-claim-green-2.log`). The generated transfer
contract test reproduced an unbound source claim passing the old schema; three selected generated
contract cases now pass, including Rust-defined download controls. A Core foreground loan test
reproduced missing selective cancellation and passes after targeted scopes/fences were added
(`/tmp/bittery-selective-foreground-{red-2,green}.log`). Native image selective retirement also
reproduced early acknowledgement; nine image tests pass, including existing File→Core ingress→real
SQLite reopen and the new unrelated acceptance/unbound Create preservation case. Broader attachment,
image acceptance and Web tests remain in progress; no ticket closure or application acceptance is
claimed. A parallel Replica compilation window was diagnosed separately and is not counted as a
behavioral red.

The Share management refinement in the spec is accepted: actual caller supplies its existing parent
Item identity; Core verifies current Vault plus authenticated Link membership before Link-scoped
management. Account-wide Sync retains Account lifetime. This closes a discovered target-binding gap
without inventing host visibility or a Share mapping cache.

2026-09-09 widened capability evidence: native image tests now pass 10/10, including prebound Update
selection, unbound Create, real File/SQLite ingress and acceptance drain. Core attachment/Move
regressions pass 143/143; the broadened run caught an unintended change to existing Account/Device
Move behavior, corrected so those boundaries still drain the accepted writer while selective Vault
retirement cancels either endpoint. The new source/destination Move test verifies accepted durable
state remains unchanged. Foreground tests pass 2/2 and Share tests pass 11/11, including wrong-parent
membership refusal and selective cancellation of held HTTP without affecting another Vault.
These are Core lifetime tests, not a claim of supported-OS UI behavior.

Web image tests pass 22/22 (`/tmp/bittery-selective-web-image-final.log`). Behavioral reproductions
covered a Runtime replacement skipping an existing acceptance drain and full-capacity Vault
retirement requiring an additional identity. Replacement now waits the existing acceptance owner;
the shared host generation helper reserves the known Vault slot before selection. Per-acceptance
drain promises replace the previous reusable Account counter/promise, preventing a second acceptance
cycle from inheriting an already-completed drain. The actual Create dialog captures its image scope
before opening the file picker; a JSDOM regression verifies a host rerender retains that callback.
An actual Web File/grant-helper test verifies Lock followed by Account re-admission still rejects the
old picker result, permits a fresh selection, and preserves idempotent host discard.

Generated transfer/image/public protocol checks pass 20/20, including the closed Rust-defined
source/sink controls and required Share parent Item. Native Kotlin/Swift bindings were regenerated.
Desktop all-target Clippy passes. Share hook tests pass 5/5 with the required DOM preload. Dependent
TypeScript checks reached 13/14; the remaining Web Export sink caller was handed to the source/sink
owner for actual scope/finally migration. Real Chromium image and source/sink acceptance, independent
review and final rechecks remain pending. No closure or application Travel/deletion acceptance is
claimed by these intermediate results.

2026-09-09 root Web source/sink lane: one shared opaque picker-scope helper owns platform epochs;
source/sink/image owners retain their existing IO/cleanup policy. Account and Vault identity slots
are reserved atomically before selection, so a full admitted registry can still retire known work.
Mandatory exact Vault claim/begin uses generated Rust controls; the handwritten sink union/parser
was removed. Caller release uses the existing cleanup owner, including Core refusal before claim.
Actual Attachment UI captures before opening the file picker and retains that callback through name
confirmation/rerender. Export captures its Vault scopes before asynchronous work and releases sinks.

Behavioral reds reproduced selective source/sink refusal, late plaintext after retirement, late
plaintext after caller release, and full-capacity retirement failure. Fixes passed20 source and33
sink tests (2,222 sink assertions),7 actual hook lifecycle cases,4 shared Attachment UI cases and13
archive cases. Independent review by Volta found the caller-release and capacity cases; both now
have regressions and passed re-review. Root reviewed native file/image exact epoch cleanup and Share
parent/current-Vault proof. The pending claim/drain-order refinement remains under review below.

Actual Chromium: all4 download-sink cases passed with production Worker/composition/registry,
including selective Vault retirement and Core recovery reconstruction. Repeated full runs initially
hung in Playwright browser launch before any Core work; diagnostic launch logs identified that
boundary. Reusing one browser with a fresh isolated context for each case preserves independent
storage/Workers and passed the full file (4.41s), without increasing timeouts or weakening recovery.
The joined upload case passed (3.34s) through generated Worker bindings, real Core, browser storage,
HTTP fixture and binary executor, including early refusal cleanup. This is capability evidence,
not Desktop/Extension production UI acceptance. Logs: `/tmp/bittery-web-vault-sink-isolated-contexts.log`,
`/tmp/bittery-web-vault-upload-chromium.log`, `/tmp/bittery-web-source-review-green.log`.
All14 Runtime-dependent type tasks passed (`/tmp/bittery-selective-web-final-types.log`); changed
TypeScript Biome passed. Full root CI and real application erasure remain required later gates.

2026-09-09 reviewed image acceptance: the real Chromium joined CreateVault suite passes two tests
with 158 assertions (`/tmp/bittery-selective-create-vault-chromium-green-2.log`, 114.6 seconds). Its new
capability-only probe forwards generated image controls through the actual Worker host channel and
reads an actual File: selective retirement wipes the late plaintext bytes, preserves a different
Account and an unrelated begun acceptance, rejects hidden/new and stale picker scopes, and permits
fresh explicit re-admission. The existing real Core/IndexedDB Vault lifecycle and Import scenarios
also pass. The capability probe supplies target decisions explicitly; it does not claim Core Travel
or deletion policy is integrated.

Independent native/Core review found no blocking scope/key/cleanup duplication. The held-claim
ordering concern is now an explicit spec requirement: start host retirement alongside Core drain.
Its controlled Core test passes and verifies the late claimed source closes before the loan drains
(`/tmp/bittery-selective-claim-drain.log`). Independent Web image review found an activation waiting
on acceptance could overtake close/retirement; both cases reproduced red and were fixed with an
exact transition identity. All 25 image/public registry tests pass after that fix, including the
reverse old-retirement/new-owner race (`/tmp/bittery-image-reviewed-final.log`). Final orchestrator
review, source/sink evidence and remaining shared check results still determine ticket closure.

The final image transition audit also reproduced Core Runtime retirement reopening host closing
admission (`beginClose` followed by `retireRuntime`). Retirement now preserves closing/closed phase;
26 image/public tests pass (`/tmp/bittery-image-reviewed-final-2.log`). This extends the same reviewed
transition fence rather than adding another cleanup owner.


2026-09-09 capability acceptance: resolved after the native/filesystem, Core lifecycle, generated
contract, actual Chromium Worker/Core/File/storage and caller evidence above, independent review and
its reproduced fixes, all 14 dependent type tasks, changed TypeScript Biome and clean diff checks.
Final Runtime workspace all-target Clippy with warnings denied passes
(`/tmp/bittery-selective-core-clippy-green.log`, 1m40 including a shared build queue); Desktop
all-target Clippy also passes. The held-claim drain order and persistent target generation contract
are part of the accepted interface. Image transition fixes were independently re-reviewed without
another finding. Full root `pnpm check:ci` / `pnpm check:ci:rust` remain phase acceptance gates.

This resolves the reusable capability prerequisite, not Desktop or Extension production acceptance.
Tickets 70/71 still own actual authority-driven retirement, all-generation and Session-key erasure,
projection/Export plaintext cancellation and fresh-authority readmission. Native renderer/dialog,
supported macOS/Windows biometry, native messaging and Extension placement/autofill acceptance retain
their downstream gates; none is inferred from this capability's compilation or controlled tests.

2026-09-09 broader regression follow-up: the first root `pnpm check:ci` reached all type checks
and exposed an obsolete public-composition assertion expecting only `grant`. The capability surface
intentionally also exposes opaque pre-selection `captureScope` and unused-resource `release`;
the assertion now covers that exact surface while retaining refusal of host lifecycle controls.
Its focused test passes (12 assertions); a full rerun is in progress. Real Web Attachment UI and
shared-Vault rotation fixtures now click the actual Attach-file button and complete its file chooser,
so they exercise scope capture before selection. The first UI run failed upload against a production
WASM bundle older than the new transfer contract. Production bundle rebuild and fresh UI acceptance
are required; isolated joined-harness success does not establish that production path.

Fresh production-bundle regression passes: `pnpm build:crypto-wasm`, then
`pnpm --filter web exec playwright test runtime-attachment-ui.spec.ts --project=cloud --workers=1`
completed the actual Web picker/upload/exact-byte download/rename/delete path (1 passed, 34.3 seconds;
`/tmp/bittery-selective-attachment-ui-acceptance-fresh.log`). The preceding stale-bundle failure remains
recorded above. The full CI rerun passed all 14 package type and test tasks and the root script tests,
then its real Chromium build encountered an intermediate ticket68 projection import error. That
source error was corrected by its owner; this run is not a full-CI pass.

Independent simplification review accepted a bounded CI-test correction: the orchestration unit test
now invokes the unchanged production runner against controlled build/Xvfb executables, asserting one
private build, harness flag, the same output path across all nine serial invocations, and final cleanup.
It no longer recompiles the real WASM merely to substitute every browser invocation afterward.
All four orchestration tests pass in about one second; the actual full-CI Chromium gate still builds
and runs the real joined Core. No production runner bypass or acceptance waiver was introduced.

The affected real shared-Vault rotation case was also attempted:
`pnpm --filter web exec playwright test teams.spec.ts --grep 'removing a Vault member rotates' --project=cloud --workers=1`.
It failed waiting for the Make-Shared success at `createSharedVault`, before selecting or uploading
an Attachment (`/tmp/bittery-selective-shared-vault-attachment-acceptance.log`). This supplies no
shared-Vault Attachment acceptance. The conversion caller still uses transitional `useConvertVaultType`
and `VaultService`/AccountResolver, unlike the Runtime Attachment caller. This identifies a remaining
integration boundary to investigate; the failed assertion alone does not establish its cause or
authorize replacing it with a mocked conversion. Personal-Vault production acceptance above remains
the completed UI evidence; Desktop has no conversion editor in the actual caller inventory.

Read-only diagnosis now records a high-confidence pre-existing Web ownership gap in the
[Runtime inventory](../desktop-extension/runtime-inventory.md#web-conversion-follow-up-2026-09-09):
Runtime Sign-in deliberately supplies no legacy AccountStore bearer, but conversion still requires
one through AccountResolver. Those conversion/authentication adapter files are unchanged from HEAD;
the historical mirror removal is commit `d9e82992`. The saved failure does not capture the predicted
exception or establish that no conversion HTTP request occurred, so those remain narrower real-run
observations to obtain. The post-success legacy key refresh is also unmigrated. Do not repair this
by mirroring credentials, mock the conversion, or count this failed run as shared-Vault acceptance.
Desktop incoming conversion remains ticket70 work despite having no local conversion editor.
