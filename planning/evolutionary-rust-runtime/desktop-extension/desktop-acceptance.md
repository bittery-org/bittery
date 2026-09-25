# Desktop production acceptance

Concrete matrix for [73](../issues/73-desktop-production-acceptance.md), following the accepted
[66/72 caller closure](desktop-cutover.md) and [production inventory](desktop-inventory.md).
This records the reviewed acceptance allocation, not a completed run.72 must complete before73
executes the migrated application matrix.73 is ready after independent source/spec review;
its incomplete72 dependency still blocks execution.

## Application and OS allocation

Run the complete behavior/variant matrix in the actual Linux Tauri application. On packaged Apple
Silicon macOS and Windows x64, run critical all-category read/write, Account, restart and teardown
histories plus every platform-specific path below. An observed OS-dependent discrepancy widens the
affected row. Missing required hardware/host evidence blocks73; a passing Linux run or compilation
cannot waive Touch ID, Windows Hello, Keychain/Credential Manager, native installation or OS cleanup.

This follows the existing [release targets](../../../.github/workflows/release.yml):
`aarch64-apple-darwin`, `x86_64-pc-windows-msvc` and `x86_64-unknown-linux-gnu`. Record actual tested
OS/WebView versions without inventing another support promise. Final packaged paths use the real
bundled renderer and native binary. Debug/Vite application evidence is supporting and labeled.
A generic Playwright renderer, mocked Tauri invoke or headless native Runtime is not that app.

73's browser consumer is the actual existing Extension with
[97 compatibility](native-legacy-compatibility.md). Do not require the migrated76 consumer here:
74 is blocked by73, and that would create a cycle. Exercise Chrome116+ or maintained supported
Chromium with actual registration/origin and the packaged native host. Firefox/Safari remain outside
this accepted scope.76 later removes97 after its caller cutover.

## Required matrix

All rows include actual Linux Tauri gestures where the path exists. The final column fixes the
additional macOS/Windows evidence; shared Core vectors remain supporting evidence throughout.

| Row | Required history and observable result | Additional packaged macOS/Windows evidence |
| --- | --- | --- |
| 1. Single owner and startup | Ordinary entry/imports, mounted controllers and native handlers reach one Runtime. Reload/detach/reattach renderer and exercise multiple permitted caller connections: old caller cannot publish, native owner and accepted work survive. New app process reopens Locked. Failed startup never activates a legacy fallback. | Real launch, renderer reconnect, process restart and native PID/owner distinction on each OS. |
| 2. Accounts and convergence | UI Sign-in/add Account, per-Account Server and insecure-transport confirmation. Offline read/create/edit, lost accepted UI reply, renderer/app restart and reconnect preserve exact Account/Operation identity and one Server effect. Equal-email Accounts on distinct Servers stay isolated; selection clears old detail/dialog/QR/TOTP. | Critical fresh/multi-Account and offline write/restart/convergence histories on each OS, using its actual credential store. |
| 3. Populated upgrade | Produce an isolated profile through the supported old production composition, locked with retained Session/security settings. Start candidate over those exact source records/references.91 preserves identity, wrappers/preferences and offline data; password-only QuickUnlock and local biometric release use retained prerequisites. A fresh Sign-in cannot replace this test. | Actual legacy-to-candidate upgrade in each OS's credential store and profile; supported real local biometric release on macOS/Windows. |
| 4. Admission interruptions | Preserve every supported pending/staged/failed/conflicted kind and exact request/receipt/artifact IDs. Lose a real Server reply before legacy ACK, then prove one outcome after admission. Follow90/83 for cross-Account work. Maintain91's complete physical crash matrix and actual app restarts at each externally distinct catalog/credential/Replica/cleanup phase. Test competing old process, changed/malformed/partial source, collisions, unreadable credentials and interrupted reset; no false empty Sign-in. | Platform exclusion, credential-write interruption, same-profile restart and cleanup evidence on each OS. Fine-grained shared commit variants remain in91's maintained physical tests. |
| 5. Local security | Lock/unlock-all, partial password outcomes, preferences/re-entry, inactivity and native Lock. Supported biometric path prompts once, preserves partial outcomes and adds no finish-login/new Session. Cancel/Lock/renderer loss/native disconnect/Account replacement while prompt is held; callback drains, late release fails and prompts do not overlap. | Actual Touch ID and Windows Hello success/cancel/dismissal plus unavailable/not-enrolled/lockout outcomes as applicable; real OS store and re-entry boundaries. A simulated callback is not OS dismissal proof. |
| 6. Full Item surface | All five categories and inventory fields/optionality; search/tags/counts/favorites, history/restore, trash/restore/permanent delete. Ordinary Login edit and Duplicate preserve private passkeys; exact removal preserves siblings. Current TOTP display/copy/rollover rejects stale/expired replies across hide/Lock/Item replacement. | Critical create/read/edit for all five categories, TOTP display/copy and clipboard/selection cleanup on each OS.95/crypto vectors support private preservation and algorithms. |
| 7. Vault and Travel | Reachable Vault edit/delete/image replace/remove, held source/upload/reply and exact outcome after reopen. Real writable/read-only changes and incoming/local Travel policy retire readers and purge hidden generations; unrelated Vault/Account stays usable. Password-confirmed disable and retained protected-image convergence use actual Server semantics. | Native image/file and retirement integration on each OS. Trigger remote conversion/admin changes through actual Web/Server where needed; do not invent an absent Desktop management page. |
| 8. Move and Attachments | Existing dialog and DnD same/cross-Account Move; upload/download/rename/delete with exact bytes. Hold file/network work across cancellation, Lock, removal and app restart. Preserve accepted artifacts and reject stale reads; explicit83 Resume retains original identity/both-Account proofs and supported legacy hold semantics. | Actual file source/sink/dialog, cancellation, reopen and scoped filesystem cleanup on each OS.69/90/93 supply exhaustive deterministic phase variants. |
| 9. Share and handoffs | Actual history/log/revoke UI with held response across departure. Existing Desktop/Web and native create/view handoffs use current active Account; URL is prefill, and locked pending navigation stays in its original renderer scope. | Real opener/browser/native handoffs on each OS. No new Desktop CreateShare, Import, Item Export or credential-change route is implied. |
| 10. Recovery and teardown | Same failed-open owner exposes maintenance Inspect/encrypted Export/Repair/Rebootstrap/Wipe. Missing/corrupt physical data/Device key yields accurate complete/partial/unavailable results; recover original accepted work/receipts without fabricating bytes. Cancel/restart file recovery. Remove preserves unrelated Accounts; successful Wipe clears exact Core/legacy scope and cannot reimport an old source. Failure remains visibly incomplete and recoverable. | Actual file/store cleanup and failed-open access on each OS; macOS reset menu and ordinary reset path use the same Core lifecycle.91 reset/tombstone and86/87/93 archive tests support exact phase histories. |
| 11. Existing Extension/native path | Actual old consumer+97, packaged native host and ordinary migrated Desktop exercise13 protocol1 requests/events, active-Account private snapshot/offline reads and distinct AuthToken Session gate. Browser EOF during prompt cancels Core before late callback. Buffered reply/nested consumer writes across Lock/port replacement cannot republish or erase a successor; cleanup drains before new acquisition. Ordinary request completion is not global DesktopClose. | Real installation/allowed origin/peer checks and browser/native connection on each OS, including source loss and supported OS prompt.68 framing fixtures alone do not establish this joined product path. |
| 12. Accumulated review and checks | Independent standards/spec review and simplification of the complete Desktop change; map every inventory caller to current implementation and evidence. Run appropriate targeted suites plus literal `pnpm check:ci` and `pnpm check:ci:rust` at the tested revision. | Include platform build results and every required host row. No completion while a required row is unavailable. |

The inventory's absent Desktop paths remain absent; a shared component or Core capability does not
prove a mounted route. Recovery maintenance under91 is required even where normal product Import,
account-recovery or Server-deletion pages are absent. Exact accepted-work/ciphertext witnesses and
real Server outcomes may be inspected behind UI gestures without replacing those gestures with
internal Runtime requests. Fault control delays/drops actual replies; it never invents semantic
Server success or weakens a timeout to turn failure into evidence.

## Existing harnesses and commands

Extend the [Linux Tauri smoke](../../../apps/desktop/tests/e2e/README.md) and its existing application;
do not add a test-only Tauri app, fake bridge or mixed-owner feature mode. The current smoke proves
only legacy Login rendering and native/renderer lifecycle. It is not in ordinary `pnpm check:ci`.
Its documented development entry points, from repository root, are:

```sh
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --bin Bittery
pnpm --filter desktop dev:vite
node apps/desktop/tests/e2e/smoke.mjs --application /absolute/path/to/Bittery --driver /absolute/path/to/tauri-driver --webkit-driver /absolute/path/to/WebKitWebDriver
```

Vite runs separately while that development smoke executes. Final artifacts use the existing
`pnpm --filter desktop build:app --target <target>` build wrapper and normal bundle configuration;
record the actual command/artifact used. Windows currently bundles NSIS, despite older README MSI
wording. Packaging does not itself establish real application acceptance.

The maintained [native foundation/source tests](../../../apps/web/tests/e2e/runtime-native-foundation.spec.ts)
reuse real Server provisioning and native executors as supporting checks:

```sh
BITTERY_NATIVE_FOUNDATION=1 pnpm --filter web test:e2e --project=cloud runtime-native-foundation.spec.ts
BITTERY_NATIVE_SOURCE_ACCEPTANCE=1 pnpm --filter web test:e2e --project=cloud runtime-native-foundation.spec.ts
pnpm check:ci
pnpm check:ci:rust
```

Use that fixture's scoped credentials/provisioning rather than invoking an ignored Rust acceptance
test without its required setup. Its four-process Runtime and actual native binary histories do not
exercise the full Tauri renderer or real biometric prompt. Current
[CI](../../../.github/workflows/ci.yml) has Linux Desktop Rust suites and Windows compile checking;
neither those jobs nor release artifact builds replace the matrix above.

## Environment, evidence and completion

Linux needs the existing harness's Node24+, Python3, keyutils, bwrap/user namespaces, Xvfb, D-Bus,
tauri-driver and matching WebKitWebDriver prerequisites. Check tool availability when executing;
the inventory's historical missing-PATH observations are not a present failure report. macOS needs
an Apple Silicon test session with Touch ID and Keychain; Windows x64 needs enrolled Hello and
Credential Manager. Record actual hardware/unavailable cases separately. Missing hardware is an
execution blocker, not a reason to add a simulated OS success or change support policy.

Isolate the actual credential backend and native/browser registration as well as app files. Reuse
Linux's existing namespace/home/XDG/session-keyring harness. macOS/Windows use a dedicated test OS
user or equivalently proven isolated account scope. Keep the same source references for upgrade;
do not touch the developer's existing profile. Real Server/database/object-storage prerequisites
and scoped user cleanup follow the existing fixtures. Failed cleanup retains isolated evidence.

Each row's ledger records revision/worktree and generated-artifact identity, exact command or manual
steps, test name, app/OS/architecture/WebView/browser versions, source-profile provenance, binary and
native registration origin, observed result and limitations. Retain relevant UI traces/native PIDs,
exact accepted-work/outcome witnesses and restricted evidence paths. Keep credentials out of ordinary
logs/screenshots. Distinguish application, primitive, mocked and unexecuted evidence explicitly.

Independent final review checks the full accumulated caller graph and this ledger. Only complete
required host rows and checks permit73 closure;74 remains blocked until then. Routine environment
provisioning and manual hardware runs need no new product or ownership decision.
