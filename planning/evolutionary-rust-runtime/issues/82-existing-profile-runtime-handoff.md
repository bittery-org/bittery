# Existing Desktop and Extension profile handoff

Type: research
Status: resolved
Blocked by: 60, 61, 62
Spec: ../desktop-extension/profile-handoff.md

## Question

How do existing production profiles enter the shared Runtime without losing retained Account access,
security preferences, encrypted local work or its original request identity, and without keeping a
second behavioral owner active?

## Investigation

Inventory actual Desktop `store.json`/OS key references and Extension storage/record adapters, including
catalog identity, Device key, encrypted MUK, QuickUnlock, CurrentSession, Server/KDF identity, local
biometric/re-entry/inactivity settings, encrypted Item/Vault records and pending outbound work.
Compare the completed Web migration's behavior against these exact persisted formats. Distinguish
existing accepted Server-bound work from reconstructible cache; historical completion is not evidence
of a profile upgrade path.

Specify one shared Core compatibility/admission path with primitive platform readers, guarded durable
commit and explicit failure behavior. Keep original ciphertext/cryptography and accepted request IDs;
never manufacture a new login secret or replay an accepted UI command. Native/browser hosts must not
parse policy into a replacement AccountStore. Default preferences only when the existing value is
absent, and preserve local biometric release under ADR 0015.

Resolve any unrepresentable pending-work outcome or product choice explicitly before implementation.
Interrupted handoff must retain original evidence and avoid simultaneously running the old and new
owners. Actual populated-profile upgrade acceptance belongs to Desktop 73 and Extension 77.

## Comments

2026-09-09: local-access review identified the old per-Account inactivity/global re-entry preferences
have not yet entered Core. Broader actual startup inspection confirms the new native stores do not
currently admit the existing legacy profile. This is a pre-cutover frontier, not permission to reset
a profile or require Full sign-in as a substitute for retained local unlock. Independent inventory
assigned while native capability acceptance continues. Ticket 66 must await a sealed and implemented
handoff contract; no upgrade acceptance is claimed.

## Inventory verdict

2026-09-09: actual source schemas, request identities and the shared admission boundary are recorded
in [profile-handoff.md](../desktop-extension/profile-handoff.md). Desktop's pending queue and Sync
cursor are in **`sync-store.json`**, separately from AccountStore/ItemCache in `store.json`; secrets
are entries in the existing OS credential map. Extension has both Chrome local/session areas and
`bittery_records` IndexedDB. New Core namespaces do not admit these values automatically. The Web
Worker and Core startup contain no populated AccountStore/queue import, so historical Web completion
does not supply an upgrade path.

The technical decision is one shared Core compatibility/admission owner with bounded trusted source
readers. Preserve existing Account identity, Device key and wrapped-MUK bytes, Secret Key, retained
Session, KDF/Server identity, original password-entry timestamps, security preferences and encrypted
work. Only absent preferences default. Start the new owner locked; retire old prompt grace under the
already accepted owner-loss contract. No new login secret, SRP substitute, plaintext secret archive
or parallel host policy is introduced.

The exact queue incompatibility is now explicit: legacy semantic `operationId` can survive a changed
HTTP `attemptId` and `baseVersion`; Core freezes one request/fingerprint per Server Operation ID.
Create uses the semantic ID while other ordinary Item kinds send the attempt ID. The Server hashes
raw JSON bytes, which the legacy queue does not itself retain. Admission must reproduce the supported
legacy dispatch serialization, verify original retained outcomes and retain semantic lineage/status
separately. Regenerating IDs, serializing unordered bodies or replaying UI commands would be incorrect.
Cross-Account queue entries require ticket90's shared workflow. Accepted83 permits explicit same-identity destination reauthorization; re-add/unlock alone never resumes work.

Interrupted admission uses recorded private staging and ordered recoverable catalog promotion across
OS credentials and Replica stores; it is not falsely described as one physical transaction. Before
commit, preserve the legacy source for abort. After Core accepts work, restoring an old file snapshot
cannot be an automatic rollback because the old dispatcher cannot understand the new work. Retain
evidence and use the new owner's recovery path. No global keychain wipe is authorized.

Accepted83 resolves the product frontier. Research readiness still requires a
proven exclusive-startup mechanism that stops the old owner before source capture and new publication.
The current Desktop builder has no single-instance plugin; its Unix IPC listener removes the existing
socket path before binding, so that socket does not prove exclusivity. This is a platform feasibility
task, not another product question. A new lease/marker alone cannot constrain old binaries that ignore
it. The specification gives test-first credential, cache, ordinary queue and cross-Account slices;
none is authorized to silently omit unsupported populated-profile evidence at production cutover.

No implementation or upgrade acceptance is claimed. Documentation links and `git diff --check` are
the checks for this inventory; actual populated Desktop/Chrome upgrade, interruption and restart
evidence remains in tickets 73/77, with full phase CI required there.

2026-09-09: accepted83 research resolves explicit same-identity destination reauthorization. Whole-profile
admission depends on implementation90, not research resolution alone. Delivery91 carries that
dependency; research82 remains independently investigable. Concrete
exclusive legacy-owner startup investigation can continue independently while that capability blocks
admission implementation. No forced relogin or omitted legacy queue variant is authorized.

Actual legacy writer inspection confirms tauri-plugin-store persists with ordinary fs::write and no
shared OS lease. Existing Core NativeDeviceLease therefore cannot fence that writer. The supported
upgrade/startup flow must prove legacy owner-process exit before capture and never mount the old
owners in the new process. Arbitrary later old-binary launch is unsupported downgrade, not a property
this cooperative lease can enforce. Exact platform process/quiescence and supported launch admission
still require a bounded feasibility proof; no automatic updater integration was found in the current
Desktop entrypoint/builder. Delivery91 remains draft pending that verdict and journal review.

A bounded throwaway serialization probe answered the ordinary-request reconstruction question using
actual ItemSyncEngine.enqueue/drain and createApiClient Request output, not a manually copied serializer.
Eight synthetic vectors are retained with exact source hashes and limitations in the focused spec.
Unicode/control escaping, field ordering, omitted Favorite and numeric strong preconditions are
observed; no network, valid ciphertext, real profile, retry or upgrade acceptance is claimed. The
probe code was removed after its recorded verdict; delivery91 owns maintained conformance and real
retained-outcome verification. Existing-owner exclusion remains the research frontier.

## Supported Desktop startup feasibility

2026-09-09: bounded source and Linux process research establishes a feasible **process-exit primitive**
and the required **supported launch boundary**. It does not establish populated-profile admission or
whole-profile exclusivity from a process scan alone. No additional product choice is needed: preserve
the source and refuse admission when the platform cannot establish the accepted single-owner contract.
Ordinary stale launchers are part of supported upgrade work, not arbitrary user downgrades.

### Actual release and writer behavior

The [release workflow](../../../.github/workflows/release.yml) builds macOS ARM64, Windows x64 and Linux
x64; it publishes DMG, NSIS EXE, AppImage and DEB aliases. The
[Windows override](../../../apps/desktop/src-tauri/bundle.windows.conf.json) selects NSIS, despite the
Desktop README's MSI wording. Current configuration and the Desktop builder contain no updater or
single-instance plugin. Therefore neither an automatic updater's stop/restart protocol nor a new
cooperative single-instance lock is evidence that a legacy writer has exited.

The pinned tauri-plugin-store 2.4.4 implementation uses `fs::write`; pending autosave, Store drop and
the plugin's application Exit handler can still save after a close request. Existing window-close
broadcasts, IPC EOF, socket-path replacement and a quiet modification time are not exit or durable-save
witnesses. Observe actual process exit before reading `store.json` and `sync-store.json`; then validate
their retained evidence through Core's admission journal. Exit alone does not prove the final save
succeeded. [Pinned plugin Exit handler](https://docs.rs/tauri-plugin-store/2.4.4/src/tauri_plugin_store/lib.rs.html)

Installation in place and installation at a new path have different launcher consequences. NSIS
replaces files in its installation directory and checks for a running named application; its pinned
helper may terminate that process and uses a delay. That existing installer behavior is not a retained
process-exit or source-flush witness for Runtime admission.
[Pinned NSIS installer](https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi),
[process-check helper](https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/windows/nsis/utils.nsh)

Replacing the same macOS Applications bundle or installing a DEB over the same package paths ordinarily
preserves references to those paths; a still-running old process must nevertheless be observed through
exit. A copied second bundle or downloaded AppImage can leave ordinary references aimed at the old
installation. The pinned Linux packager generates `bittery.desktop` from the current product name and
places DEB executables under `/usr/bin`; the native helper's `gtk-launch com.bittery.desktop` fallback
does not match that default desktop-entry name. Its preceding PATH lookup may work for DEB, but cannot
establish AppImage launch identity.
[Pinned desktop-entry generator](https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/linux/freedesktop/mod.rs),
[DEB layout](https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/linux/debian.rs)

The [native installer](../../../apps/desktop/src-tauri/src/native_messaging_installer.rs) writes an
absolute bundled-helper path. Its production `is_installed` check accepts the existence of any one
supported browser registration without checking its target or the other registrations. The
[native helper](../../../apps/desktop/src-tauri/src/native_host.rs) launches Desktop through bundle-name,
PATH or desktop-entry lookup, rather than an exact admitted executable. Both references belong in
preflight. Rewriting a manifest does not retire an already-running old helper with a pending launch.

### Concrete primitive boundary for delivery91

Before mounting any legacy writer or publishing the new Runtime, the new Desktop entrypoint must:

1. Hold the existing exclusive NativeDeviceLease to serialize cooperating new admission entrants.
   That lease does not constrain old binaries. Inventory the same OS user's potential legacy writer
   instances, including other sessions, and the product's supported installed launch references.
   Executable basenames are candidate hints only; validate executable/bundle and user identity.
   The existing IPC peer lookup primitives are useful, but their current-install-directory allowlist
   would miss a running older bundle at another path. Unreadable or ambiguous relevant identity blocks
   admission rather than being skipped.
2. Converge supported owned launch references on the new gated executable. For installation in place,
   verify their actual targets; for a new path, update only positively identified product-owned native
   registrations and launcher entries, preserving unrelated values and refusing changed or unsupported
   forms. The new helper must cold-launch the exact admitted installation. Drain already-running old
   helpers or establish that all of their remaining launch routes reach that installation. A normal
   stale shortcut must be repaired or detected and block capture; it cannot be dismissed as a downgrade.
3. Retain OS process-instance identities while waiting for all relevant old writers to exit; do not
   substitute a PID/name recheck, window-close event or successful signal request. Recheck inventory
   after route convergence and exit. A snapshot alone cannot exclude another old launch. Only then
   capture the source and enter the shared Core validation/staging/journal path while retaining the
   new-owner lease. Any unavailable proof leaves the original evidence intact and admission unstarted.

The native layer supplies process identity/exit, exact registration operations and source-reader
capabilities. Core continues to own Account interpretation, queue compatibility and admission outcome;
no legacy AccountStore or second admission policy belongs in the host. This research authorizes no
forced termination, removal of old binaries, broad shortcut rewriting, elevated installer mutation or
real profile changes. Deliberately executing an arbitrary retained old binary after supported routes
have converged remains the previously excluded rollback case.

### Platform evidence and limits

- Linux: a retained `pidfd_open` descriptor is pollable through process exit and remains an instance
  identity across executable replacement. The primitive requires Linux 5.3 or newer; this research
  does not silently raise the supported minimum kernel. Older kernels, restricted process visibility
  and inaccessible same-user sessions need a tested equivalent or an explicit unavailable preflight
  result. [Linux pidfd manual](https://man7.org/linux/man-pages/man2/pidfd_open.2.html)
- macOS: `NSRunningApplication` exposes bundle/executable identity, PID, launch date and termination
  state; retain the application identity and allow its run-loop-dependent observations to progress.
  Bundle-name lookup or a successful termination request alone is insufficient. No macOS process,
  LaunchServices cache, replacement-bundle or packaging acceptance was executed here.
  [Apple process API](https://developer.apple.com/documentation/appkit/nsrunningapplication?language=objc)
- Windows: enumerate candidates, obtain full executable identity and retain a process handle with
  synchronization rights; only the successful process-handle wait result witnesses exit. PID reuse,
  denied access, timeout or an installer kill request must not count as exit. No NSIS, registry,
  shortcut-cache or multi-session acceptance was executed here.
  [Process enumeration](https://learn.microsoft.com/en-us/windows/win32/toolhelp/tool-help-functions),
  [executable identity](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew),
  [process-handle wait](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject)
- AppImage: the runtime provides `APPIMAGE` for the durable image-file path and `APPDIR` for its mounted
  contents. Current native installation does not distinguish them or provide a proven stable helper
  registration after unmount. Delivery needs a durable product-owned helper/launch registration that
  targets the exact admitted AppImage, plus cold-launch, move/replacement and old-helper acceptance.
  This is platform integration work under the same boundary, not permission to drop AppImage support.
  [AppImage runtime path contract](https://docs.appimage.org/packaging-guide/environment-variables.html)

Two throwaway Linux probes were executed on Linux 6.12 using only temporary fixtures and owned `sleep`
children. The process probe replaced the executable path while retaining the old pidfd, observed the
old `/proc/PID/exe` deleted suffix while it remained live, launched a second instance at the same path,
then observed the old handle exit while the second instance stayed live. This proves why all relevant
instances and launch routes matter. The registration probe redirected an exact known native manifest
path and desktop-entry Exec path, preserved their other values and an unrelated file, and refused a
changed source. It proves only narrow fixture transformation; its read/check/write is not atomic
against an external registration writer and does not prove browser or desktop-shell cache behavior.
Logs: `/tmp/bittery-profile-process-quiescence-linux-probe.log` and
`/tmp/bittery-profile-registration-linux-probe.log`. All temporary children/files were removed; no actual
user process, launcher, browser registration or profile was mutated. Probe code was discarded.

The technical boundary is now concrete, with Linux instance-exit feasibility observed. Whole supported
startup exclusion still requires maintained platform/packaging acceptance, especially retained AppImage
launches and cached old helpers. Delivery91 also requires its stated source-snapshot/journal review and
completed dependencies. This evidence changes neither ticket91 readiness nor ticket73/77 acceptance;
ticket82 status at that evidence checkpoint remained claimed pending coordinating review.

2026-09-09 coordinating verdict: accepted and research resolved. The supported startup contract is
concrete: converge exact owned launch references on the gated installation, drain old helpers and
observe every relevant legacy writer through actual process exit before capture, then retain the
new-owner lease through shared Core admission. Refuse unavailable or ambiguous proof while preserving
the source. In-place installation and retained AppImage/new-bundle paths both remain supported scope;
ordinary stale launchers are not classified as arbitrary rollback. Linux synthetic process and exact
registration feasibility passed; macOS/Windows packaging, cached helpers and AppImage cold-launch
acceptance still belong to delivery and production cutover, not this research result.

The accepted journal ownership is now elaborated in the
[concrete admission contract](../desktop-extension/profile-handoff.md#concrete-admission-lifecycle-contract).
Its exact shapes await independent review under91, which remains needs-triage and dependency-blocked.
This research resolution claims neither implementation nor populated-profile acceptance. Local links
and documentation diff checks are the checks for the recorded verdict.
