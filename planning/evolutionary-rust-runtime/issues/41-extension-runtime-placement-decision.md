# Extension Runtime placement decision

Type: task
Status: resolved
Blocked by: 30, 32, 34
Research: ../sqlite-everywhere-research-2026-08-24.md

## Accepted decision

2026-09-08, maintainer approved: the future Chrome Extension Rust cutover requires Chrome 116+.
One combined Runtime/Crypto dedicated Worker lives in one minimal offscreen document per browser
profile. IndexedDB executes the existing closed Replica contract. The MV3 service worker brokers
browser events, extension APIs and native messaging; popup and content-script callers do not create
Runtime owners. The offscreen document forwards messages and owns Worker construction, not Session,
key, Operation or Sync policy. Existing typed Runtime requests/projections remain the caller interface.

This ticket records placement and recovery policy. It does not deliver production Extension
integration or change the currently packaged legacy Extension. [Ticket 34's verdict](../web-sqlite-prototype-verdict.md)
does not authorize SQLite for the Extension.

## Lifecycle contract

| Event | Required behavior at the future cutover |
| --- | --- |
| Service-worker suspension/recycle, owner survives | Discover and reattach to the same offscreen document and Worker. Preserve its current lock state; do not create another Runtime or demand another unlock merely because the broker restarted. |
| Concurrent popup/content-script wake or calls | Serialize document/Worker creation behind one readiness step and route every caller to the same owner. Reject stale replies after owner replacement; never reconstruct a request outcome from a lost reply. |
| Actual Worker or offscreen-document loss | Reopen the same encrypted Replica with a new, locked Runtime. Require supported unlock before restoring live keys or work that needs them; existing Core eligibility still governs exact accepted ciphertext work with a usable Session. Do not restore unlocked state from browser-session storage, cached projections or a retained key capsule. |
| Extension update/reload or browser restart | Start a new locked owner; retain encrypted Replica and supported Quick unlock material. Missing or invalid material follows existing Full sign-in behavior. |
| Lock, removal or revocation during wake | Existing Runtime retirement wins over late callbacks and reattachment. No host restoration or keepalive may override it. |
| Desktop connection | Connected Desktop continues to own lock/unlock; disconnect locks, and revocation overrides. A replacement Extension owner starts locked and follows Desktop authority for its next unlock, rather than introducing an independent local bypass. |
| Owner unavailable during Sync or accepted work | Durable Operations, encrypted overlays and Cursor survive owner loss. Core resumes exact ciphertext dispatch/reconciliation when its existing Session and authority guards permit; supported unlock restores live-key work and readable catch-up. Caller closure or lost responses do not discard accepted work or justify replaying UI commands. |

Requiring unlock after actual owner loss is an **approved change** from legacy transparent
service-worker session restoration in `apps/extension/src/background/services/session-restore.ts`.
It does not apply to broker recycle while the original Worker survives. No cold-owner restoration
capsule or additional maintainer decision is required. Browser suspension is not a promise of
continuous background delivery: Core owns reconnect, Session renewal and Cursor recovery when running.
Do not add synthetic heartbeat traffic, a tab leader, a second owner, or host retry/authentication policy.

## Why this placement

Chrome normally retires an idle service worker after 30 seconds; event/request and fetch-response
limits also apply. Native messaging and qualifying WebSocket activity have documented lifetime
extensions, but held SSE is not a documented residency guarantee.
[Chrome lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
The [HTML Worker interface](https://html.spec.whatwg.org/multipage/workers.html#dedicated-workers-and-the-worker-interface)
does not expose Worker construction in ServiceWorkerGlobalScope. Direct WASM placement there would
require a different host entrypoint and repeated owner recovery instead of reusing the dedicated Worker.

The offscreen `WORKERS` reason is available from Chrome 114;
[Chrome's release explanation](https://developer.chrome.com/blog/extension-news-july-2023/) records it.
Chrome 116 adds `runtime.getContexts()` for discovery. Offscreen supports only `chrome.runtime`
among extension APIs and permits one document per profile (separate normal/split-incognito contexts).
Use that discovery path rather than the newer Chrome-150-only `offscreen.hasDocument()`.
[Offscreen reference](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
Its lifetime is independent of the service worker, not guaranteed permanent residency. The document
stays limited to the Worker capability and message plumbing.
[Chrome offscreen design](https://developer.chrome.com/blog/Offscreen-Documents-in-Manifest-v3)

## Firefox and Safari roadmap

Both remain unimplemented Extension hosts. Their separate intended placement is a nonpersistent
background document hosting one combined Runtime/Crypto Worker, with IndexedDB and the same Core
policy. No Chrome offscreen dependency or new browser-support claim is implied.

Firefox currently uses document backgrounds rather than extension service workers; MV3 backgrounds
are nonpersistent and restart on extension events after process loss.
[Firefox background scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts),
[manifest environments](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background)
Safari supports document/service-worker backgrounds; Apple requires nonpersistent backgrounds on iOS
and nonpersistent/service-worker forms for MV3.
[Apple guidance](https://developer.apple.com/documentation/safariservices/optimizing-your-web-extension-for-safari)
Each roadmap host needs its own manifest/version choice and real-host lifecycle acceptance before
support is claimed; generic WebKit does not prove Safari/macOS or Safari/iOS Extension behavior.

## Verification and simplification

Future integration must exercise broker recycle, actual Worker/document loss, concurrent callers,
update/restart, accepted-work recovery and Desktop Lock/disconnect/revocation through the production
Extension composition. Existing Web live-Sync and first-slice acceptance are supporting Core evidence,
not substitutes for those host tests.

The decision uses one existing Runtime interface and one lifecycle table; browser adapters supply
primitives and routing, with no duplicated policy, restoration format or speculative owner framework.
Independent Standards, Spec and simplification review approved the decision. Nine links were checked
and `git diff --check` passed. No production integration tests were required or run for this
documentation slice; full CI was waived and was not run.

2026-09-09 delivery-contract clarification under74: owner loss still creates a locked replacement
and never restores live keys from a capsule. The original table's broad “eligible work” phrasing
now distinguishes that unlock requirement from the existing shared dispatcher, which can reconcile
exact accepted ciphertext while locked when a usable Session and current guards permit it. Native
70/93 capability acceptance exercises this distinction. This adds no host-specific retry or unlock
policy and changes neither the accepted placement nor the cold-owner lock decision.
