# Desktop, then Extension Runtime migration

This specification extends the existing [map](../map.md) following inventories in
[ticket 60](../issues/60-desktop-extension-ownership-inventory.md), accepted native placement in
[61](../issues/61-desktop-runtime-placement.md), and Chrome scope in
[62](../issues/62-extension-browser-acceptance-scope.md). Later capability contracts are refined
before their delivery tickets become ready; the inventory is not permission to invent policy.

## Ownership and scope

Desktop has one native Rust Runtime in the Tauri application process. It calls the shared Core and
shared SQLite adapter, with no copied Domain/authentication/Sync code. Its renderer observes and
requests through the existing generated closed protocol. The native-host binary transports messages
to the same owner. Renderer closure retires caller observations, never accepted work or the Runtime.

Chrome 116+ has one combined Runtime/Crypto Worker in one offscreen document, IndexedDB, and a
service-worker broker under ticket 41. Desktop production acceptance precedes Extension cutover.
Firefox and Safari remain roadmap hosts. Record actual browser/OS versions for every acceptance run.

Preserve all actual paths in the three inventories. Missing host UI stays explicitly absent rather
than being counted as tested or silently expanded into a new product surface. Hosts retain form
detection, browser/OS APIs, file selection, clipboard, UI preferences, pure projection derivations
and rendering. Runtime owns keys, Account access, authenticated requests, encryption, Replica,
Operations, retries, Sync, travel enforcement, and teardown. Shared transitional modules stay until
their last application caller migrates, including Mobile and remaining Web ceremonies.

## Native foundation

The first delivery slice links a configured Core Runtime into Desktop with real SQLite, existing
OS keychain-backed Device secrets and durable plain Device records. Core selects Desktop's existing
restart-surviving Session placement in the secret tier, as defined in `packages/storage/CONTEXT.md`;
the SessionSecret primitive itself remains process-lifetime for callers that request it. Reuse the
Rust-defined storage/HTTP contract rather than restating its shapes. Network
executors perform exact Core requests and cancellation; Core alone chooses headers, authentication,
renewal, retries, outcomes and live Sync scheduling. Do not add host polling or retry loops.

The renderer bridge transports serialized generated Runtime requests/responses and observations.
Caller IDs are scoped to the renderer connection; duplicate registrations do not create owners.
Closing/cancelling a caller stops waiting or observing. Runtime close is reserved for application
shutdown. No general key export, authentication-token projection or primitive crypto invoke is added.

Acceptance at this foundation seam: the actual Desktop-linked Core opens an empty durable Device,
publishes status, performs real Server Sign-in, closes/reopens locked with the same Account identity,
and emits scoped projections through the transport. Use real SQLite and loopback HTTP transport tests
for capability behavior; OS secret-store doubles are supporting tests only. Production application
acceptance remains open until the actual Tauri application and native messaging paths run.

## Test seams and acceptance

The agreed shared seams are Core's closed request/observe/close protocol, platform capability
contracts, the generated renderer/native IPC boundaries, and real application gestures. Use
test-first vertical cases at these seams, extending existing conformance/crypto vectors instead of
duplicating their implementation. Independent agents simplify and review each completed slice.

Desktop acceptance covers real Sign-in/add Account, restart, renderer reconnection, lock/password
Quick unlock, local biometric unlock and re-entry, offline reads and writes, reconnect convergence,
all five categories and supported edits, Attachments/Move, Share history, Vault edits/deletion,
travel mode erasure, Account isolation/teardown, recovery, and native messaging. No Session creation
is allowed as a substitute for biometric release; no new durable Auth key or login secret is stored.

Extension acceptance adds release-build loading into a persistent Chromium profile, concurrent
wake, actual broker restart reattachment, actual Worker/document loss, pending durable work recovery,
browser restart, Login/Card/Identity autofill, credential capture/TOTP, passkey create/assert/cancel,
and actual browser native messaging to Desktop. Disconnect/Lock/revocation and teardown win over
late native or biometric replies. Mock state transitions alone do not establish these properties.

[Extension composition](extension-composition.md) seals74's concrete owner discovery, authenticated
caller/primitive routing,91 startup admission and broker/native/Worker loss distinctions.74 is ready
with incomplete dependencies; Desktop acceptance73 still blocks implementation.

[Desktop acceptance](desktop-acceptance.md) fixes73's twelve application/OS rows: full behavior on
Linux Tauri, critical product histories on packaged macOS/Windows and every platform-specific path.
It distinguishes the existing smoke/native fixtures from actual populated-profile, renderer,
browser/native and hardware evidence.73 remains under final review with72 incomplete.

For each path record command, tested revision, actual host/browser, result and limitations. Run
targeted checks per ticket, then `pnpm check:ci` and `pnpm check:ci:rust` before a phase is complete.
Linux cannot establish real macOS Touch ID or Windows Hello acceptance. Missing real-host evidence
keeps the corresponding acceptance ticket open rather than converting compilation into acceptance.

## Shared presentation

[Ticket 80](../issues/80-shared-runtime-presentation.md) extracts existing Web projection and
presentation helpers before Desktop uses them. Keep generated Runtime types and the shared
RuntimeClient as the interface, preserve null/optional category data, Vault metadata, optimistic
status and Account-scoped retirement, and retain Web's behavioral tests. Host form/list field
adaptation may live in existing shared presentation code; do not copy it into Desktop or couple
shared Runtime machinery to a host singleton. This preparation starts after foundation 63 and
does not activate native startup or leave a second behavioral owner running.

The actual Desktop inventory shows eager legacy dependencies throughout the mounted Vault shell,
Account switcher, settings and detail controllers. Prepare their Runtime-only dependency chain
before atomic startup/native-socket cutover. The first UI path must preserve multi-Account unlock,
inactivity lock and native authority; a new sign-in screen alone cannot establish ticket 66.

[Desktop startup/caller mapping](desktop-cutover.md) records the inspected production entry,
eager versus conditionally enabled callers, atomic activation ordering and66/72 acceptance groups.
It preserves ticket73's separate real Tauri, browser/native and supported-OS gates.

## Remaining contract frontiers

- Native biometric enrollment/release and password re-entry policy in Core, preserving existing
  wrapped material and one OS prompt for supported multi-Account unlock.
- Runtime-authorized Desktop–Extension transfer, account provenance, connection generation and
  retirement; no broker or popup live-key ownership.
- Durable Vault update/delete and image ingress, plus shared conversion caller disposition.
- Travel configuration and password-disable proof in Core, with hidden-Vault erasure and preserved
  Account isolation; scoped Secret Key disclosure for existing device setup.
- Passkey create/assertion and durable counter/status updates in Core with existing ES256 format.
- Native binary artifact/recovery capabilities and real platform acceptance automation.

These are researched against existing product behavior before their task specifications are sealed.
