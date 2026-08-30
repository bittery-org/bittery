# Complete the final Web host cutover

Type: task
Status: ready-for-agent
Blocked by: 57
Parent: [28 — finalized E1–E10 frontier](28-remaining-item-write-kinds.md#2026-08-30--final-web-item-and-import-frontier-resolved)

## Outcome

All remaining Web Item mutation, Attachment, lifecycle, projection, and Import consumers use the
shared Runtime client boundary; the preserved interrupted host work is reconciled, and the complete
Web production entry graph reaches no transitional Item writer or Import owner.

## Work

- Re-audit and reconcile the preserved dirty host files from Ticket 28 rather than discarding,
  stashing, regenerating over, or replacing them wholesale. Finish the remaining edit, delete,
  favorite, move, Share, Attachment, drag/drop, route, and lifecycle consumers through the narrow
  `packages/client-runtime/src/client` facade.
- Keep React hooks shallow: presentation and query subscription are allowed; keys, encryption,
  network, retry, outcomes, Replica policy, capability registries, and lifecycle machinery are not.
  Remove any direct export of a concrete source registry from `apps/web`.
- Delete obsolete Web mutation/read bridges and transitional cache repair only after their callers
  are cut over. Preserve all existing user-visible behavior already covered by Tickets 49–57.
- Harden the executable Web production-entry graph so `item-write`, every legacy Import read/writer,
  transitional Item repositories, and their re-export/dynamic/CommonJS aliases are forbidden.
  Re-run the whole-repository caller gates from Tickets 54 and 57 to prevent a shared/Desktop/Mobile
  edge from being reintroduced.

## Path ownership and failure domain

This slice owns only Web host integration under `apps/web`, shared UI callback signatures required
by that integration under `packages/ui`, the shallow client/Web composition surface under
`packages/client-runtime/src`, and the reachability tests/scripts. It may delete obsolete
transitional Web-facing paths after the graph proves them dead. It does not redesign Core Runtime,
Server operations, cryptography, Sync ownership, native host integration, or Attachment persistence.
Any deep-runtime defect discovered here must be split into a prerequisite ticket rather than patched
inside a Web hook.

## Verification

- Start with focused failing consumer and browser tests for every remaining mutation and lifecycle
  path, then prove all existing Web Item/Attachment/Share/import acceptance scenarios through the
  production Worker and real generated Core.
- Run the hardened Web graph and the whole-repository create/import graphs. They must start from real
  production entries, conservatively follow all supported import forms, and report zero forbidden
  reachability.
- Run changed TypeScript through Biome, targeted Bun/Playwright/Chromium tests, dependent type
  checks, `pnpm check:ci`, `pnpm check:ci:rust`, and `git diff --check`. Resolve Ticket 28 only after
  this ticket and its clean-tree gates are complete; Ticket 29 still owns final
  `idempotency_record` deletion and Ticket 30 still owns live Sync.
