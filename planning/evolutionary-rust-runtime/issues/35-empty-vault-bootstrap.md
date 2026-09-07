# Empty Vault Bootstrap authority

Type: task
Status: resolved
Blocked by: 22
Spec: ../spec.md#bootstrap

## Delivered decision

Bootstrap is one bounded, resumable, two-phase feed. Standalone Vault summaries and wrapped keys
come first, including empty accessible Vaults; Item pages follow. Both phases share one pinned Sync
watermark and one old-or-new promotion boundary.

Phase is part of the request, response, stored page identity, cursor, and replay fingerprint.
Each phase obeys page/byte bounds. Promotion requires both terminal phases; an Item cursor cannot
stand in for a Vault cursor. No unbounded Vault side list or repeated embedded Vault authority is needed.

The Server, OpenAPI, generated consumers, Rust staging, and still-compiled transitional readers
were changed together.

## Verification

The Server/Runtime regression proves a new personal Vault with zero Items becomes authority and
allows its first offline Item. Replay, malformed continuation, cursor/phase binding, bounded pages,
and promotion have coverage. [Ticket 32](32-first-slice-end-to-end-acceptance.md) proves the real
browser path. Both full CI gates passed at delivery.
