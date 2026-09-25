# Desktop atomic Runtime activation and first application trace

Type: task
Status: ready-for-agent
Blocked by: 63, 67, 68, 69, 70, 71, 80, 84, 85, 90, 91, 95, 97
Spec: ../desktop-extension/spec.md

## Contract

Prepare the complete reachable Desktop renderer/controller and native-handler closure against the sole native Runtime, then switch production startup atomically. Develop the smallest Sign-in/catalog/lock/password-unlock and first Item read/create trace before widening the prepared callers; production activation waits until every reachable owner has been replaced. Generate private Tauri envelopes from Rust under ADR 0012; reuse the existing RuntimeClient and projections. Renderer reconnection never replaces the process owner. No mirrored AccountStore, renderer Session/MUK export, copied authentication or Sync policy is allowed.97 owns the temporary privileged native compatibility boundary.

## Acceptance

Drive actual Tauri Sign-in, restart into a locked retained Account, password Quick unlock, offline Login read/create, lost caller response and reconnect to exactly one Server effect. Verify two renderer attachments use one owner. Carry accepted work through process restart; use the original request identity rather than replaying a UI create. Before activating this path in production, prove the executable startup/caller graph has no reachable legacy owner, including module initialization, mounted hooks, enabled queries, dialogs, menus and native handlers. Preserve every existing product action through the prepared Runtime callers. Ticket72 adds exhaustive gesture/variant evidence and removes unreachable Desktop-only modules; it does not finish migration of reachable callers after activation. No second test-only Tauri application or mixed-owner feature mode is required.

## Comments

2026-09-08: dependency-ordered delivery scope recorded. No implementation or acceptance is claimed.

2026-09-09: actual mounted dependency inspection widened the prerequisite closure. Login/unlock,
Account switcher/settings, Vault shell/detail hooks, inactivity policy and native socket still reach
legacy ownership eagerly. Prepare shared presentation under 80 and complete missing capabilities
before atomic startup cutover. Do not preserve a shim AccountStore, run both owners, or silently
drop unlock-all/biometry/management behavior to make the first path appear complete.

2026-09-09: returned to triage until [existing-profile handoff](82-existing-profile-runtime-handoff.md)
is sealed. Fresh-profile foundation tests do not prove upgrade of the currently populated Tauri
store/keychain or preservation of pending legacy work and existing security settings. Prepare the
shared Core admission path before atomic startup; do not drop existing Accounts or demand password
sign-in in place of valid local biometric material.

2026-09-09: [atomic startup and caller/test mapping](../desktop-extension/desktop-cutover.md)
now names the actual root, route guards, eager Vault/detail hooks, conditionally enabled settings
and Share queries, menu callbacks and native socket entry. Prepare their Runtime-only closure
before switching production startup;66's first trace cannot leave reachable old owners for72.
Reuse the existing native factory/renderer transport/RuntimeClient and80's shared presentation.
The proposed shared public/private Item prerequisite must be sealed before Desktop assembly so
Login edit, passkey removal and Duplicate preserve private state without renderer key projection.
No ticket number, readiness change, application implementation or acceptance is claimed here.

2026-09-09: the helper audit also found shared `InlineTotpDisplay` performing HMAC in renderer
WebCrypto despite no remaining direct CryptoPort caller. Coordinating review sealed the
[closed Item TOTP request](../desktop-extension/desktop-cutover.md#closed-item-totp-contract) for66
assembly: reuse the native-linked Rust algorithm, existing RuntimeClient/foreground read owner and
95's stateless readable source guard. The host supplies Item identity, never a secret or primitive
crypto command. Shared display injection preserves other hosts and current visible secret/copy/edit
behavior. Exact native/controller, stale-result and actual display/copy tests are recorded; no new
ticket, implementation, primitive-invoke exception or status change is introduced.

2026-09-09 final coordinating and independent source/mapping review passed after97 closed the
remaining protocol1 native compatibility frontier.95 preserves private Item edits/removal/Duplicate,
91 gates complete profile admission, and the closed native TOTP request preserves existing displays.
Ticket66 is `ready-for-agent` with incomplete prerequisites. Its entire reachable closure must be
prepared before the one production activation;72 cannot defer a reachable competing owner. The
privileged old native compatibility encoding is distinct from forbidden renderer Session/MUK export.
Fifty scoped links/anchors and the dependency graph passed validation. No application implementation
or actual Tauri/supported-OS acceptance is claimed by this readiness change.
