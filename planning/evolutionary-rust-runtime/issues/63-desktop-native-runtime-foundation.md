# Desktop native Runtime foundation

Type: task
Status: resolved
Blocked by: 60, 61
Spec: ../desktop-extension/spec.md#native-foundation

## Contract

Link the existing Core into Tauri, reuse its SQLite Replica and closed protocol, and implement
primitive native storage/HTTP capability adapters. Expose a renderer request/observation bridge
whose caller lifetime is separate from the one process-wide Runtime. Add no host auth, retry, Sync,
Account policy, private protocol copies, or primitive crypto surface.

## Delivery

1. Test capability contracts with real temporary persistence and loopback HTTP before implementation;
   reuse existing Core schema/conformance tests. Production Device secrets use the existing keychain.
2. Compose the linked Core and start its scheduling tasks once; reopen persisted catalog locked.
3. Test renderer request/observation cancellation and connection retirement through the transport.
4. Exercise native Sign-in/restart against the real development Server. Record actual Tauri/OS
   evidence separately from library tests; unavailable host evidence keeps acceptance open.
5. Run dependent type, Rust formatting/Clippy/test and generation checks. Delegated simplification
   and independent review precede closure. Full CI is required before the Desktop phase completes.

## Scope limit

This ticket is the first foundation, not production migration acceptance. Existing UI callers are
cut over by the next vertical slice only after its required capabilities are ready. It must not
activate a second production Account owner beside the old composition.

## Comments

2026-09-08: dependencies resolved; implementation may start. Test seams follow the specification
and the existing Runtime/capability protocol decisions; routine seam choices need no further approval.

2026-09-08 foundation evidence, accumulated worktree based on `13d4490f`, Debian 13.6,
Linux 6.12.107, native SQLite and production Linux keyutils credential backend:

- Native storage: four tests include actual SQLite reopening, exact prefix isolation and corrupt
  schema refusal. OS-store failure doubles establish failure propagation, not OS acceptance.
- Native HTTP: nine real loopback TCP tests cover exact requests, bounded responses, streams,
  cancellation and dispatch identity. Core alone retains authentication and retry policy.
- Renderer connection: six tests cover duplicate observations, reentrant retirement and caller
  cancellation during Core teardown. The reproducer failed before waiter cancellation was separated
  from the still-running Core task. Accepted/lifecycle work continues after caller loss.
- Native assembly: real empty SQLite reopening preserves owner/connection separation. Independent
  review found no additional blocking storage/HTTP/assembly issue; simplification removed the raw
  Core accessor and consolidated keychain persist-before-cache updates.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
  runtime_host::native::tests::real_os_keychain_roundtrip_and_scoped_cleanup -- --ignored --exact
  --nocapture`: passed against the actual OS store, including exact disposable-key cleanup.
- `BITTERY_NATIVE_FOUNDATION=1 pnpm --filter web exec playwright test
  runtime-native-foundation.spec.ts --project=cloud --workers=1`: one passed. Web provisioned a real
  Account/Vault/Login through its UI; Desktop-linked Core performed Server Sign-in, authoritative
  Item read, Lock, in-process owner recreation, password Quick Unlock and read. No mocked API or
  credential-store backend participated. This run proves neither process restart nor Tauri UI.
- `pnpm check:ci`: passed (14 package tasks and nine Chromium Runtime files). The opt-in native
  acceptance fixture was added after this run began and separately passed Biome and its real case.
  The first full Rust CI run passed Core (729 tests), crypto, Server checks and generated native/Web
  bindings, then failed on Desktop module formatting. The formatting failure is being corrected;
  this command is not recorded as a pass.

Remaining foundation gate: generated Tauri bridge integration/tests and actual process restart
evidence. Native teardown honestly reports incomplete `AttachmentArtifacts` and `HostCleanup`
capabilities; Core's scoped catalog/platform/Replica cleanup ran in the real test. Ticket 69 supplies
those adapters. No Tauri production Runtime is activated and no Desktop/Extension acceptance is
claimed. Actual biometric and native-messaging paths remain later acceptance work.

2026-09-08 stronger native restart gate: reran the same Playwright command after changing the native
fixture to launch two separate, exactly filtered Rust test processes. First process signs in,
reads, locks, shuts down and exits. Second process opens the same SQLite/real OS keychain, verifies
the retained locked Account identity, performs password Quick Unlock and reads the authoritative
Item. One case passed in 1.2 minutes. Failed phases attempt a separate scoped cleanup process and
report/retain recovery data if that cleanup fails. This is actual process restart evidence, still
not Tauri UI or biometric reuse of a retained Session. Independent review found no new blocker.

2026-09-08 foundation closed after generated renderer bridge delivery and independent review:

- The inactive native plugin derives caller identity from the trusted main/local Tauri Webview,
  admits requests synchronously, and retires connections on navigation/destruction. Generated
  envelopes carry the existing Core protocol; renderer cancellation never becomes Runtime close.
- Seven connection tests and three renderer tests pass. The latter exercise actual generated
  Tauri command handlers with the production ACL context through Tauri's mock runtime, including
  targeted initial projections/outcomes, all six commands and foreign-window refusal. The red test
  caught missing plugin permissions; generated inlined-plugin metadata and main-only ACL fixed it.
  These are IPC boundary tests, not real Webview migration acceptance.
- Five TypeScript transport tests pass. Fresh wire IDs fence late responses/projections when a
  caller ID is reused; abort ends waiting immediately and native cancel follows admission ACK.
  Shared generated validators and RuntimeClient are reused. Desktop targeted types, all-targets
  Clippy, Rust formatting, generated bindings and changed-TypeScript Biome checks pass.
- Independent transport/plugin review and simplification found no additional blocker. The state
  retained by each layer represents transport identity or caller lifetime, not Account/key policy.
- Real Linux Tauri smoke also passes using the existing production composition: Login rendered,
  renderer reload kept the native PID, and process restart changed PID and reopened the isolated
  profile. The reusable [harness](../../../apps/desktop/tests/e2e/README.md) isolates home/XDG,
  native messaging registration and kernel keyring. WebKitGTK 2.52.6 / wry 0.55.1, Debian 13.6;
  custom-binary rerun verified final process cleanup. This is explicitly legacy-composition smoke.

Only the foundation is resolved. No production Runtime is activated beside the legacy owner;
ticket 66 performs the first UI cutover, and tickets 67–73 preserve all remaining product paths and
establish Desktop acceptance. Full Rust CI must be rerun after the formatting correction; a newly
exposed Web Node declaration type-check failure is being diagnosed before final full-CI acceptance.

2026-09-09: user requested renaming the Desktop adapter module to `runtime_host` to distinguish
it from the shared Runtime implementation. Moved the directory and updated imports, visibility,
exact child-process test selectors, maintained native acceptance launchers and planning references.
No Runtime policy or production activation changed. Historical logs retain the prior module prefix;
current commands use `runtime_host::`. The [continuation handoff](../handoff-2026-09-09-desktop-extension.md)
records verification and remaining migration work.

Rename verification: current Desktop library build passes, then `runtime_host::` runs89 passing tests
and5 opt-in ignored (`/tmp/bittery-runtime-host-rename-build-2.log`,
`/tmp/bittery-runtime-host-rename-tests.log`). Scoped launcher Biome and diff checks pass. This preserves
inactive assembly status and does not establish production activation or waive current71/full-CI gates.
