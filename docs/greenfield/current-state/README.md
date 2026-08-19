# Frozen Bittery current-state catalog

Snapshot: `f021c85e1d3a9d3f3418ba67a9ff04f319987903`.

This catalog records the existing product so useful behavior and painful architecture are understood
before replacement. It does not impose compatibility on the greenfield product.

## Coverage

| Catalog | Status | Notes |
| --- | --- | --- |
| [product-capabilities.md](product-capabilities.md) | Pass 1 | Capability inventory from glossary, code topology, ADRs, and audits |
| [client-architecture.md](client-architecture.md) | Pass 1 | Web, extension, Desktop, mobile, shared packages |
| [server-sync-security.md](server-sync-security.md) | Pass 1 | Server, API, Sync, crypto and storage decisions |
| User journeys and screenshots | Not started | Must cover supported paths on every platform |
| Feature-by-feature executable evidence | Not started | Each capability needs tests/symbols and contradiction review |
| Administrative and deployment behavior | Partial | Current cloud/commercial assumptions need explicit cataloging |
| Accessibility and localization behavior | Not started | Platform-specific audit required |

Pass 1 is an orientation artifact, not the completion gate. A future current-state audit must account
for every route, server command, extension handler, native command, migration, public contract member,
and supported user journey.

