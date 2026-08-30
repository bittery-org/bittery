# Atomically cut Import over to Server and Web Runtime ownership

Type: task
Status: ready-for-agent
Blocked by: 56
Parent: [28 — finalized E1–E10 frontier](28-remaining-item-write-kinds.md#2026-08-30--final-web-item-and-import-frontier-resolved)

## Outcome

The existing Import route and Web Import workflow switch atomically to durable Runtime
`import_items`; provider presentation remains, but no transitional Import read, crypto, HTTP writer,
cache repair, or second owner is reachable anywhere in the repository.

## Work

- Replace the existing Import handler in place with the Operation executor. Require
  `Idempotency-Key`; fingerprint the canonical Vault path and exact ordered body; and atomically
  commit the complete Item set, bulk audit and `vault_updated` when nonempty, retained outcome, and
  `operation_resolved`. Empty applied batches emit only outcome and `operation_resolved`.
- Open Ticket 56's production Runtime dispatch and exact recovery path. Do not retain a parallel
  route, legacy response, or compatibility writer.
- Reduce `apps/web/src/hooks/use-vault-import.ts` to file/provider parsing, localized preview,
  mapping, progress, warnings, summaries, and calls to the shared Runtime client. Preserve
  empty-Source-Vault filtering, existing/new Vault and multi-Account mapping, 200-Item batching,
  earlier-batch success after a later rejection, failed-Vault summaries, and final counts.
- Remove all reachable transitional key/storage reads, TypeScript encryption, direct HTTP,
  invalidation, cache refresh, and repair code used by Import.
- Add an executable whole-repository entry graph rooted at every Web, Desktop, Mobile, Extension,
  and shared-package production entry. In the same commit it must fail on any legacy Import read or
  writer reached through static, re-exported, lazy/dynamic, CommonJS, or side-effect edges.

## Path ownership and failure domain

This slice owns the Server Import handler/transaction and public OpenAPI generation, production
Runtime transport/composition, Web Import hook/dialog integration, exact retired transitional Import
paths, and the whole-repo reachability gate. It owns atomic batch/route compatibility, presentation-
to-Runtime mapping, progress/summary, and cutover failures. It does not change provider parsing
semantics, create-Vault behavior delivered by Ticket 54, unrelated Item mutations, or native host
Runtime integration.

## Verification

- Start with failing Server and actual-browser acceptance for every category and a favorite in both
  newly created and existing Vaults, multi-Account mapping, empty zero, 200/201 bounds, response
  loss, exact replay, every rejection, and a later-batch rejection that preserves earlier counts.
- Prove no audit/`vault_updated` on empty, one atomic nonempty transaction, authoritative exact Item
  reconciliation, warnings and summaries unchanged, and caller cancellation cannot discard an
  accepted batch.
- Run the whole-repository entry gate, focused Server/Web/browser tests, OpenAPI/generator and
  affected type checks, `pnpm check:ci`, `pnpm check:ci:rust`, and `git diff --check`.
