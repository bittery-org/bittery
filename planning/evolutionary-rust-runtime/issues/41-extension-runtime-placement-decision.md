# Extension Runtime placement decision

Type: task
Status: needs-info
Blocked by: 30, 32, 34
Research: ../sqlite-everywhere-research-2026-08-24.md

## Question

Where does one restorable Extension Runtime and Replica owner live in Chrome MV3, Firefox, and Safari,
and does each browser keep IndexedDB or adopt SQLite/OPFS?

## Recommendation

Keep IndexedDB unless every supported browser proves one recoverable writer. For Chrome, compare the
current MV3 service-worker owner with `service worker -> offscreen document -> combined dedicated
Runtime Worker`; for Firefox and Safari, decide their background-document compositions separately.
Ask the maintainer in German after the host acceptance and live-Sync behavior are available to test.

## Verification

The decision records lifecycle recovery after service-worker suspension, extension update, Worker or
offscreen-document loss, concurrent popup/content-script calls, and browser restart. A normal Web
SQLite prototype is evidence about the VFS only, not proof of Extension placement.
