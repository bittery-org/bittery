# Atomically cut Import over to Server and Web Runtime ownership

Type: task
Status: ready-for-agent
Blocked by: 56
Parent: [28 — finalized E1–E10 frontier](28-remaining-item-write-kinds.md#final-web-item-and-import-frontier)

## Outcome

Complete the Import cutover so Server, Runtime dispatch, and Web share one durable `import_items`
contract. The Web hook retains provider presentation only; no transitional Import owner is reachable.

## Current state

Commit `87386201` delivered the Server Operation executor, paged Item authority route, generated
contracts, and Runtime acceptance byte bound. Its title overstates completion:

- `runtime/dispatch.rs` still skips `OperationKind::ImportItems`; the executor has no production port.
- `RuntimeProjection` has no Operations variant.
- `apps/web/src/hooks/use-vault-import.ts` still encrypts in TypeScript, calls the old importer shape,
  and uses the parking store. It is incompatible with the changed Server/API contract.
- The whole-repository Import gate is absent and seven provider round-trip E2Es remain skipped.

The old handoff's “uncommitted Server work / preserved dirty ticket 58 files” condition ended with
that commit. Resume from current source; a clean root CI or complete slice is not established here.

## Accepted decisions

- Use `POST /api/v1/vaults/{vaultId}/item-authority-pages` for the accepted identity set. Each page
  is exactly `Vec<ItemResponseDto>`; `Bittery-Next-Cursor` carries continuation bound to the sorted,
  deduplicated identity-set digest. Avoid 200 sequential single-Item fetches or host-reserialized
  list responses.
- Add one Account-scoped Operations projection for every accepted Operation: identity, kind,
  attempt count, next attempt time, and resolution state. It contains no plaintext.
  [Ticket 56](56-runtime-import-batch.md#progress) defines the Operation as the only progress record.
- Remove `runtime-import-parking.ts` and `runtime-import-lifecycle.ts` completely. Durable Operations
  and their projection replace the second owner of in-flight Import.
- Preserve exact ordered fingerprinting, all-or-nothing batches of at most 200, and applied empty
  zero. Empty success emits only outcome and `operation_resolved`; nonempty success also commits
  Items, one bulk audit, and `vault_updated`.
- Acceptance bounds exact serialized encrypted JSON to 15 MiB, below Server and aggregate authority
  limits of 16 MiB. The existing tests pin envelope/page headroom. Plaintext length or item count
  alone cannot determine whether an encrypted batch fits.

## Remaining work

1. Revalidate the landed Server half and its generated consumers. Preserve retained rejection,
   exact replay, transaction atomicity, paginated authority, and acceptance-byte tests.
2. Implement the production `ImportExecutorPort` and open dispatch. Reuse central Session renewal,
   Account fencing, persisted backoff, and exact replay. Contradictory authority must not spin:
   align with the existing create-Vault invariant-failure policy while preserving accepted bytes.
   Distinguish fenced/missing commits from an actually scheduled retry.
3. Generate and bind the Operations projection across Rust, Web, Kotlin, Swift, observation registry,
   client facade/testing transport, and the shallow React hook.
4. Replace the Web importer with Runtime calls plus parsing/preview/mapping/progress/warnings/
   summaries. Preserve existing/new Vault and multi-Account mapping, empty-Source-Vault filtering,
   all categories/favorites, earlier-batch success after later rejection, and exact final counts.
   Handle byte-limit refusal before acceptance without losing an oversized Item's valid siblings.
   Keep encrypted-size policy in Runtime/shared interface, not new host encryption.
5. Remove parking and transitional Import key/storage/crypto/HTTP/cache-repair paths. Add a sibling
   whole-repository gate over `buildRepositoryImportGraph()`, rooted at all app/shared production
   entries and following re-export, dynamic, CommonJS, and side-effect edges.
6. Replace parking coverage with projection coverage and restore the seven provider round-trip E2Es.
   Finish and verify the joined Server/Runtime/Web behavior before resolving this ticket.

## Verification

Cover all five categories plus favorite in new/existing Vaults, multi-Account mapping, empty zero,
200/201 and encrypted-byte limits, exact/changed replay, response loss, every retained rejection,
caller cancellation, and a later-batch failure preserving prior success. No pending/rejected batch
renders as imported; authoritative contradiction and fenced commits cannot spin.

Run focused Server/Runtime/Web and real-browser acceptance, all caller graphs, generated/OpenAPI
and dependent type checks, `pnpm check:ci`, `pnpm check:ci:rust`, and `git diff --check`.
Historical handoff failures are evidence to recheck, not permission to skip these gates.
