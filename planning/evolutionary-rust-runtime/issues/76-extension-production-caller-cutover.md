# Extension complete production caller cutover

Type: task
Status: ready-for-agent
Blocked by: 68, 75, 98
Spec: ../desktop-extension/extension-cutover.md

## Contract

Migrate auth, Account catalog, lock/auto-lock, projection reads, capture/TOTP writes, Login/Card/Identity autofill, passkeys, Desktop transfer and popup/content consumers. Preserve limited category detail behavior and Desktop/Web deep-link handoffs. Remove popup MUK restoration and obsolete session/cache/queue/Sync/auth owners after callers migrate.

## Acceptance

Whole Extension entry graph covers background, popup, content, main-world and iframe entries and reaches no competing owner. Test actual pages, per-Account teardown, offline writes and reconnect with original durable IDs. Keep shared transitional code only for remaining applications. The sealed spec maps every existing route and entry; verify every disposition through actual application paths.

## Comments

2026-09-08: dependency-ordered delivery scope recorded. No implementation or acceptance is claimed.

2026-09-09: research98 now owns the remaining closed page-feature/activity/handoff frontier. The
focused spec maps all47 old background routes plus FILL_ITEM and the full import/entry graph to
74/75/79/95/97 ownership. It records actual active-Account capture and timeout selectors, the existing
no-password five-minute popup confirmation, ephemeral same-tab navigation handoff and original
prompt deadline. This remains needs-triage pending independent concrete review; no implementation
or readiness follows from the inventory.

2026-09-09 research98 and independent review sealed the focused caller contract, including the
47 routes plus popup Fill, capture handoff, private Core matching, existing activity semantics and
complete legacy-owner removal.76 is ready; incomplete75 and its Desktop-first prerequisites still
block implementation. No production activation or acceptance was performed by this planning work.
