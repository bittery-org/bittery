# Desktop and Extension Runtime migration handoff — 2026-09-09

This handoff was requested because the user's usage allowance is nearing its end. Continue the
existing migration, preserving the decisions below; do not restart planning or ask them again.

## Read first

- [AGENTS.md](../../AGENTS.md), [CONTEXT.md](../../CONTEXT.md),
  [ADR index](../../docs/adr/README.md), [map](map.md), and
  [issue-tracker process](../../docs/agents/issue-tracker.md).
- [71 — current Travel implementation and chronological evidence](issues/71-runtime-travel-management-and-erasure.md).
- The ready ticket and full linked spec for the next slice. Wayfinder requires resolved frontiers,
  dependency-ordered specs, and `ready-for-agent` delivery tickets with completed dependencies.

## Latest checkpoint — start here

The rename builds and its Desktop host tests pass: **89 passed, five ignored**. Current Core build
passes. The joint differing-proof retirement fix and physical fixture corrections now pass targeted
checks. **The next implementation RED is connected native pending-policy admission**: the consumer
receives fresh plaintext while its source is pending. Two catalog tests and one QuickUnlock snapshot
assertion also still fail. Exact commands/results appear in the final section; do not rerun the old
inconclusive pending tracer or treat the earlier full suite as green.

## Actual status

**The migration is not complete. Neither Desktop nor Extension has production acceptance.**
Desktop still runs its legacy production composition. The new native host assembly and renderer plugin
remain inactive until all reachable callers can switch together. Extension production has not migrated.
Historical Web ticket completion and native assembly tests are not proof of either application cutover.
Ticket71 remains in progress. Its latest full CI baseline predates its current changes.

The shared working tree contains hundreds of modified/untracked files from this ongoing effort.
At handoff preparation HEAD is `13d4490f0b1e70b3b4988b3782ae9d995559dd11`; no commit or push was
performed for this continuation. Preserve all existing work. The real Git index was not staged for
validation. Test logs named below are local `/tmp` artifacts and may disappear; their outcomes and
limitations are recorded here and in the tracker.

The user explicitly requested parallel agents for bounded implementation, independent review and
simplification. Prefer test-first vertical slices. Make routine implementation decisions autonomously.

## Decisions already accepted by the user

1. Desktop uses one Runtime in the Tauri Rust process, owning live keys, SQLite, Sync and native
   messaging projections. Renderer access is a thin generated bridge. No duplicated Runtime policy.
   ADR0010 was amended; native platform adapters do not replace shared Core behavior.
2. Chrome116+ is the Extension acceptance scope. One combined Worker in an offscreen document,
   IndexedDB, and a service-worker broker follow ticket41. Firefox/Safari remain roadmap hosts.
   Broker restart reattachment must be distinguished from actual Runtime-owner loss.
3. Connected Extension Operations stay in the Extension. Both Runtimes use one shared Core,
   generation-bound key transfer; transport only carries it. Desktop Lock/disconnect retires access.
4. Hidden Vaults lose keys, cached authority, projections and unnecessary files. Retain only inaccessible
   encrypted accepted-work evidence and indispensable encrypted artifacts until outcomes can be proven.
5. Connected Extension reads come from its own Runtime Replica, including its pending Operations.
   Desktop supplies Account/lock state and authorization; Desktop edits arrive through Server convergence.
6. Travel settings remain foreground commands. Reconcile lost Disable replies against current Server
   policy and require fresh password entry for retry. Never replay the one-use proof or substitute login.
7. Cross-Account Move may explicitly resume after destination removal/re-addition only after Core
   reauthorizes the same canonical Server/User and rechecks both Accounts. Preserve original Operation
   and Item IDs; stop on destination edits or unprovable prior outcome. Decision83, implementation90.
8. Passkeys require a durable Device-local counter reservation before assertion disclosure. Failed local
   commit fails the ceremony. Preserve read-only Vault authentication; sync writable Item usage separately.
   Do not claim global counter ordering across offline Devices. Recorded in75 and its spec; not implemented.
9. The Desktop adapter directory is now named `runtime_host`, as explicitly requested. It assembles the
   shared `bittery-client-core::Runtime`; it is not a second Runtime implementation.

Preserve cryptographic algorithms and persisted formats. Biometric unlock remains local under ADR0015;
never replace it with password sign-in or persist another login secret. Remove obsolete hosts only after
callers migrate; remove shared transitional code only after the repository proves no remaining consumer.

## Rename made at this handoff

`apps/desktop/src-tauri/src/client_runtime/` was moved to
[apps/desktop/src-tauri/src/runtime_host/](../../apps/desktop/src-tauri/src/runtime_host/mod.rs).
Updated the Rust module declaration/imports/visibility, exact child-process test names, the maintained
Web native acceptance launcher, and planning links/test commands. The module comment explains the
shared Core versus Desktop host boundary. No compatibility alias or second module was added.

The new test prefix is `runtime_host::`. Historical logs can still contain `client_runtime::`.
The shared `packages/client-runtime` package and its public names remain unchanged.

## Current71 work and evidence

### Foreground native acceptance

Maintained public-API acceptance lives in
[runtime_host/native_travel_settings_acceptance.rs](../../apps/desktop/src-tauri/src/runtime_host/native_travel_settings_acceptance.rs),
[runtime-native-foundation.spec.ts](../../apps/web/tests/e2e/runtime-native-foundation.spec.ts),
and the existing native network fixture. Real Server sign-in, SQLite, keychain, fresh processes,
accepted work, images and recovery are exercised. Each real run must finish scoped public User deletion
with HTTP200 before another fixture reset. There is no known outstanding cleanup from the latest run.

- Incoming Travel case passed: `/tmp/bittery-native-incoming-travel-runtime-sixth.log`.
- Lost Disable response before/after Server execution: 2/2,
  `/tmp/bittery-native-foreground-travel-before-and-after-first.log`.
- Unavailable policy reconciliation: 1/1,
  `/tmp/bittery-native-foreground-travel-uncertain-first.log`.
- Actual wrong password: 1/1,
  `/tmp/bittery-native-foreground-travel-wrong-password-first.log`. Real401 followed by fresh current
  policy read and a separate correct-password attempt; no login finish/proof replay; cleanup200.
- Corrected Core wrong-password proof tests: 2/2,
  `/tmp/bittery-travel-password-proof-real401-corrected.log`.
- Conflicting current selection after lost Save/Enable: one test/two variants passed,
  `/tmp/bittery-travel-conflicting-current-selection-first.log`.

These establish bounded native assembly behavior, not actual Tauri UI or Chrome acceptance.

### Shared retirement and connected native work

Core files primarily include `runtime/travel_policy.rs`, `vault_retirement.rs`, `vault_visibility.rs`,
`native_travel.rs`, their existing fixtures/tests, and the already shared native authority machinery.

Verified histories before the last joint-stage edit:

- Captured complete-stage overlap and caller loss:
  `/tmp/bittery-travel-captured-stage-pending-first-green.log`,
  `/tmp/bittery-travel-stage-overlap-retry-first-green.log`.
- Rejected and lost-ack physical retirement commits:
  `/tmp/bittery-travel-retirement-only-rejected-first.log`,
  `/tmp/bittery-travel-retirement-only-lost-ack-first.log`.
- Fresh-owner reconstruction and empty omission startup:
  `/tmp/bittery-travel-pending-stage-fresh-owner-second-green.log`,
  `/tmp/bittery-travel-pending-stage-empty-open-first.log`.
- Native grouped complete-stage retirement:
  `/tmp/bittery-native-complete-stage-selection-first-green.log`.
- Native retained malformed Move: RED then GREEN1/1,
  `/tmp/bittery-native-retained-move-fence-first-green.log`. Acquired retirement fences must retain
  notification/native classification even if later projection filtering fails; accepted bytes unchanged.
- Native Travel subset8/8: `/tmp/bittery-travel-native-stage-current-regression.log`.

Latest joint-stage bug: a complete Bootstrap stage omits A+B, while selected A already has a different
VerifiedTravelPolicy proof. A-only retirement previously abandoned the stage before notifying B.
Meaningful public/physical RED:
`complete_stage_omissions_survive_a_selected_vaults_different_policy_proof`,
`/tmp/bittery-travel-different-stage-policy-proof-first-red.log`.

Registered fix uses the exact complete stage to authorize one atomic full-omission RetireVaults
transaction. Keep existing proof handles/lifetimes, acquire only missing scopes, then upgrade existing
handles after observing the joint journal. No temporary metadata rewrite. Live early adoption requires
an already existing omitted duty; uncaptured reconstruction remains private startup (`!ready`). Native
handoffs preserve acquired groups and drain notifications outside publication guards on errors. Native
agent independently reviewed this boundary. Current test outcomes are appended at the end of this file.

Native pending episode remains an implementation frontier inside the sealed99 contract. Its repaired
first tracer is `native_pending_policy_episode_preserves_grant_but_pauses_fresh_consumer_admission`.
The first attempt hung because `prepare_import` replaces an existing generation and therefore waited
on the intentionally retained Export loan. Those destructive re-import probes were removed from the
first tracer; all held paths are now bounded and cleaned up before assertions. That hang is not a valid
behavioral RED. The corrected tracer now reproduces a meaningful fresh-plaintext admission RED (see
final results). A separate calibrated transfer/re-import history must follow the first slice. No native
pending production fix is registered.

Still open: pending reason propagation; multi-batch failure completion; readmission; remaining native
framed/application variants and all required acceptance matrix rows. Do not infer coverage from nearby tests.

### Export bridge and actual Web application

The existing fixed Export observation owns output lifetime. Begin/Finish validate its same connection
and handle in Core. WASM marks delivery only after its real callback succeeds. The Worker admits exact
cleanup messages while closing, so Finish can drain a pending Lock/Close without starting another owner.

The new [fixed client handle](../../packages/client-runtime/src/client/vault-export.ts),
[archive attempt](../../apps/web/src/lib/runtime-vault-export.ts),
[hook](../../apps/web/src/hooks/use-vault-export.ts), and existing dialog keep snapshots/ZIP work/Blob
inside one attempt. React gets progress and readiness only. Retirement synchronously aborts/clears
readiness, then waits for private references to drain before unobserve acknowledgement. Do not pass
builder cancellation into transport observation: early automatic unobserve would falsely acknowledge
cleanup. Repeated Download is preserved through a fresh capture/build after the previous Finish.

- Actual joined Worker output/Lock/Close six histories:6/6,92 assertions,
  `/tmp/bittery-export-output-worker-six-green.log`.
- Actual production Web hook, intact ZIP, repeated Download and selective hide:1/1,19 assertions,
  `/tmp/bittery-web-archive-ready-output-repeat-green.log`. Zero Attachments, nonempty Item archive.
- Actual delayed WASM terminal callback throw:1/1,18 assertions,
  `/tmp/bittery-export-delayed-throw-first.log`. Core refuses new Begin and Lock waits until explicit
  private disposal/unobserve; no fabricated cleanup acknowledgement or production callback retry.
- Formats/cancellation:13/13,65 assertions,
  `/tmp/bittery-web-archive-attempt-unit-green.log`. Includes all categories and140KB Attachment bytes;
  this controlled unit transport does not replace actual Worker Attachment acceptance.
- Client/registry/Session/Worker/service/composition:163/163,713 assertions,
  `/tmp/bittery-web-archive-client-bridge-regression.log`.

Remaining: independent archive/hook cleanup review; complete zero/nonzero-Attachment and output race
matrix; full11-history `packages/client-runtime/tests/web-create-vault.chromium.test.ts`; current generated
repository bindings/types; phase CI. The browser fixture shares one browser with isolated contexts because
repeated browser process launches caused a separately reproduced Bun/pipe hang. Its original signing helper
uses the Server manifest, `--features acceptance-adapter --bin presign-exact-upload-acceptance`; it does not
reset the development DB. Serialize conflicting Cargo build lanes.

The temporary real test artifact `/tmp/bittery-travel-export-app-joined-bindings` has Begin/Finish and
passed the actual browser cases. **Repository production WASM declarations are stale**: the latest web
root type check had10/11 successful tasks; missing generated Begin/Finish methods cause the failure
(`/tmp/bittery-web-archive-attempt-third-types.log`). Regenerate normally using
`packages/client-runtime/scripts/build-web-bindings.sh`, without the test harness environment flag.
Never hand-edit generated declarations or weaken the required Runtime interface.

## Broad Core regression diagnosis at handoff

The preceding full Core binary run had13 reported failures and two hung catalog tests; it was terminated
with143 after1028/1030 results. Log: `/tmp/bittery-travel-retirement-output-current-core-regression.log`.
It was not successful and was not literal full CI. Fixes below were registered before the new handoff
build; append exact rerun results instead of assuming they pass.

- Device Setup3tests: fixture was Unlocked/Bootstrapping with Travel verification still pending.
  `biometric_tests.rs` now uses a dedicated public valid disabled-policy Refresh helper only for
  Device Setup. Offline biometric fixture behavior is unchanged. Temporary DEBUG instrumentation removed.
- QuickUnlock2tests in `authenticated_installation_tests.rs`: valid policy verification adds a final
  Metadata write after the original Metadata/QuickUnlock/CurrentSession sequence. Expected order updated;
  original credential/identity/Replica assertions retained. Diagnose any further assertion independently.
- Catalog2tests in `attachment_tests.rs`: entering pending publishes a new DeviceRevision, so expected
  revision is captured after pending. Held request is released/joined before assertions; a Drop guard
  prevents fixture thread leaks on future panics. Same-revision resumed catalog assertion remains.
- Physical retirement5tests in `vault_retirement_integration_tests.rs`: existing fixture lacked the
  now-required GET travel-mode route and failed before physical assertions. Added valid disabled policy
  and positive route observation; original SQLite faults, offline and Session-only assertions preserved.
- Native2tests: later-account fixture now performs public initial Refresh on both owners before switching
  HTTP offline; older disabled-policy fixture now has `enabledAt=None`. Hard-retirement and import denial
  assertions remain. Names: `later_native_retirement_progresses_while_another_account_is_still_draining`
  and `offline_native_import_cannot_ignore_source_verified_travel_authority`.
- Checked-in Replica conformance corpus drift remains to diagnose. Do not weaken exact corpus comparison.
  Generator: `pnpm --filter @bittery/client-runtime generate:replica-conformance`; inspect the generated
  diff and rerun the Rust/IndexedDB conformance checks.

## Next execution order

1. Use the bounded current Core results below. Diagnose the remaining catalog and QuickUnlock failures
   from their current binary; old binaries do not include new fixes. Use absolute paths if changing cwd.
2. Implement native pending admission from its now meaningful RED and obtain GREEN; preserve the current
   differing-proof GREEN and finish independent review/missing71 variants, including app output lifetime.
3. Regenerate normal repository WASM bindings; rerun package-root types and actual full browser file.
4. Run required targeted checks and **literal `pnpm check:ci` and `pnpm check:ci:rust`** before closing71.
5. Follow ready dependency order for remaining capabilities and Desktop activation. No new product choice
   is currently waiting for user input. Resume frontier work only if an actual new architectural gap appears.

After71, remaining delivery includes90 cross-Account Move (ready, not implemented),95 private credentials/
public Item commands,97 legacy Extension native compatibility,91 populated-profile exclusive handoff,
then66 activation and72 exhaustive caller migration/removal. Review the actual dependency headers rather
than treating this list as a substitute for them.90's full spec exists; `/tmp/runtime90-first-slice.md`
is only a local preparation note and not implemented code.

Desktop73 acceptance requires the actual Linux Tauri behavior matrix and packaged macOS/Windows critical
paths, with real platform biometric/credential/native messaging evidence. Missing hardware is not waived.
Use existing Extension97 for Desktop acceptance to avoid requiring the later migrated Extension first.
Then74 implements Chrome offscreen composition,75 passkeys,76 all page/background/popup callers,77 actual
release-package acceptance.78 removes shared transitional code only after the last consumer migrates.

## Validation discipline

Earlier complete baseline, before current71 edits:
`/tmp/bittery-desktop-extension-progress-check-ci-10.log` and
`/tmp/bittery-desktop-extension-progress-check-ci-rust-7.log` both passed. These do not validate current71.

Use package-root `pnpm exec turbo -F <pkg> check-types` (Web package name is `web`); add dependents as
needed. Run Extension Bun files separately. Format changed TypeScript with scoped Biome. Prefer scoped
rustfmt with `--config skip_children=true` while multiple owners edit; avoid global formatting churn.
Real Server E2E resets fixtures and must perform scoped public User cleanup before another reset.

The Rust full-check script compares generated tracked output. Earlier validation used a disposable Git
index so the real user's index was untouched:

```sh
set -e
bittery_validation_index_dir="$(mktemp -d /tmp/bittery-rust-check-index.XXXXXX)"
export GIT_INDEX_FILE="$bittery_validation_index_dir/index"
trap 'unlink "$GIT_INDEX_FILE"; rmdir "$bittery_validation_index_dir"' EXIT
git read-tree HEAD
git add -- apps/desktop/src/generated
pnpm check:ci:rust
```

Do not declare production acceptance from compilation, mocks, native assembly or historical ticket status.
Record exact observed checks and blockers in71/the relevant ticket. Final handoff verification follows.

## Final verification and exact resume points

The first coordinated build failed because the new joint-retirement helper's publication MutexGuard
was considered live across an await. The owner corrected lexical scope, returning only captured
handoffs/error from the lock block. Notification, token drain and journal awaits remain outside;
no behavioral change was made merely to satisfy Send.

| Current check | Actual result | Local log |
| --- | --- | --- |
| Shared Core `cargo test ... --lib --no-run` | PASS,58.63s;1032-test binary | `/tmp/bittery-handoff-current-core-build-2.log` |
| Desktop `cargo test ... --lib --no-run` after rename | PASS,56.21s | `/tmp/bittery-runtime-host-rename-build-2.log` |
| Desktop binary `runtime_host::` | PASS89, ignored5;1.92s, including process lease tests | `/tmp/bittery-runtime-host-rename-tests.log` |
| Core `device_setup_` | PASS4 | `/tmp/bittery-handoff-device-setup.log` |
| Core `runtime::vault_retirement_integration_tests::` | PASS5 | `/tmp/bittery-handoff-physical-retirement.log` |
| Differing-proof complete-stage retirement | PASS1 | `/tmp/bittery-handoff-different-proof.log` |
| QuickUnlock cancellation boundary | PASS1 | `/tmp/bittery-handoff-quick-cancel.log` |
| Later native retirement with another Account draining | PASS1 | `/tmp/bittery-handoff-later_native_retirement_progresses_while_another_account_is_still_draining.log` |
| Offline native import/source policy mismatch | PASS1 | `/tmp/bittery-handoff-offline_native_import_cannot_ignore_source_verified_travel_authority.log` |
| Native Travel module | FAIL:9 passed,1 failed (new pending tracer) | `/tmp/bittery-handoff-native-travel-corrected-filter.log` |
| Native pending tracer separately | RED1,9.41s; all loans disposed/owners closed before assertion | `/tmp/bittery-handoff-pending-episode.log` |
| Foreground catalog during pending | FAIL1, no hang | `/tmp/bittery-handoff-catalog-pending.log` |
| Foreground catalog resume | FAIL1, no hang | `/tmp/bittery-handoff-catalog-resume.log` |
| QuickUnlock Session/Replica preservation | FAIL1 after write-order assertion passed | `/tmp/bittery-handoff-quick-session.log` |

Correct current Core binary:
`packages/client-runtime/target/debug/deps/bittery_client_core-7db65d48ea7aed7d`.
Correct Desktop binary:
`apps/desktop/src-tauri/target/debug/deps/bittery_lib-da083c5b72bdacd7`.
These names are build artifacts, not stable API. Use Cargo to rebuild after changing source.

The first attempted native module filter, `runtime::native_authority_travel_tests::`, matched **zero**
tests and supplies no evidence. The corrected filter is:
`runtime::authenticated_installation_tests::native_authority::travel::` (10tests).

Remaining exact failures:

- Native pending test fails at `native_authority_travel_tests.rs:2427`: source pending Apply succeeds
  and keeps consumer Unlocked/old loan intact, but new Items subscription receives fresh plaintext.
  The assertion requires retained silent subscription. Later assertions for durable pending/new work/
  output are not established by this failure. Implement the sealed pending reason propagation without
  treating normal generation replacement as a harmless query. Remove temporary nonsecret tracer
  diagnostics after the completed RED/GREEN history; no production fix has been started.
- Both catalog tests reach `attachment_tests.rs:6501`: expected one preexisting publication but
  observe two while pending. The earlier revision assertion/thread hang is fixed. Determine the extra
  frame's category and contents through a narrow nonsecret diagnostic before calling it a harmless
  control or weakening the no-private-publication assertion. Do not assume fixture error.
- QuickUnlock reaches `authenticated_installation_tests.rs:1788`: exact Replica comparison differs
  from Cold/revision4/no active generation to Ready/revision8/an active Bootstrap generation;
  lock epoch remains1 and policy pending isfalse. The expected platform write ordering now passes.
  Determine the intended Bootstrap fixture/invariant and preserve Account identity, Operations and
  credential checks; do not blindly drop the comparison.
- Replica corpus drift has not been rerun or repaired in this checkpoint.

Scoped Biome for the renamed TypeScript launcher passes. `git diff --check` passes; handoff/map local
Markdown targets were checked, along with current renamed planning links. Whole-repository references
were searched: old Desktop module references remain only in this handoff's rename explanation.

No build/test process or sub-agent work remains active at this handoff. No actual Server acceptance
fixture was run or reset during the rename/checkpoint. Full `pnpm check:ci` and `pnpm check:ci:rust`
were **not rerun** here: current known Core failures and incomplete71 remain explicit blockers to phase
closure. Normal repository WASM generation and its types remain pending as documented above.
