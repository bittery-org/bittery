# Extension offscreen Runtime composition

Type: task
Status: ready-for-agent
Blocked by: 62, 73, 106
Spec: ../desktop-extension/extension-composition.md

## Contract

Apply ticket 41: Chrome 116+, one combined Runtime/Crypto dedicated Worker in one offscreen document, IndexedDB, and service-worker broker. Generate release manifest/page/Worker assets; use getContexts and serialized creation. Route requests and observations to one owner without broker auth/retry or session-restoration policy.

## Acceptance

Actual persistent Chromium Extension concurrent wake, broker termination/reattachment preserving standalone unlock, associated native-channel retirement, independent Worker/document destruction producing a locked replacement, browser restart and stale reply rejection. Use the spec's explicitly modified assembly package and actual production transport/classifier;77 requires the unmodified full release package. No heartbeat or cold-owner restoration capsule. Firefox/Safari remain roadmap. The reviewed spec defines generated routing and closed caller/primitive capabilities.

## Comments

2026-09-08: dependency-ordered delivery scope recorded. No implementation or acceptance is claimed.

2026-09-09: proposed [concrete composition contract](../desktop-extension/extension-composition.md)
records the actual legacy import/startup owners, shared Web Worker/RuntimeTransport reuse, generated
caller/primitive lanes, authenticated browser sender and exact-document probe registration,91 startup
admission and actual Chrome116 acceptance matrix. Broker attachment loss preserves a surviving
standalone owner but retires its real native channel; Worker loss creates a locked replacement.
No restored key capsule, host policy owner or UI-command replay is permitted. Kept `needs-triage`
pending independent contract review; dependencies and production activation gates are unchanged.

2026-09-09 coordinating and independent source reviews sealed the generated control envelope,
authenticated paired receiving Ports, browser-context admission before Worker construction, exact
document facts and existing shared owner/transport reuse. A surviving standalone owner preserves
unlock on broker loss; an associated native channel retires, and actual owner loss is separately
tested. Unresponsive Worker refusal cannot substitute for proven termination or start a second owner.
The74 fixture selects production assets and substitutes genuine popup boot content explicitly;
no alternate trusted role is introduced.77 retains unmodified full production acceptance.
The contract is now `ready-for-agent`; incomplete73 and106 still block all implementation. No Chrome
production migration, browser lifecycle acceptance or Firefox/Safari support is claimed.
