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

## Comments

### 2026-09-01 — ready for agent

Ticket 56 is resolved in commit `5dbbeec8cb806a56c83b053f34445966486ccbb4` with independent final
standards and specification approval. It was this ticket's sole declared dependency, and the parent
Ticket 28 E7–E10 frontier is decision-complete. The existing `ready-for-agent` status is therefore
fully unblocked: this slice may open production Import dispatch, replace the Server Import handler in
place, and cut the Web Import workflow over to the shared Runtime client.

One working condition carries over. The worktree still holds the preserved uncommitted Ticket 58 Web
aggregate described in the [2026-09-01 handoff](../handoff-2026-09-01.md), so root `pnpm check:ci` is
expected to stop at that Biome and type-check overlap until Ticket 58 reconciles it. Keep those bytes
unchanged and report the gate honestly instead of claiming a clean root CI pass.

### 2026-09-01 — handovers from Ticket 56

Ticket 56 left three decisions to whoever wires `runtime/import_executor.rs` into production
dispatch:

- **Repeated authority contradiction has no scheduling answer yet.** A failed `validate_authority`
  or a changed `importedCount` currently returns `Err(InvariantViolation)` without advancing the
  durable backoff. Once the executor runs inside the production scheduling loop, an authority that
  keeps contradicting the retained outcome can spin. Decide how that case is scheduled — parked,
  backed off, or surfaced as a terminal local failure — before opening the gate.
- **`ImportExecutorPass::RetryScheduled` is misnamed at one edge.** The executor also returns it for
  fenced or missing guarded commits, where nothing was scheduled at all. Revisit the name, or split
  the variant, while wiring; do not build host behavior on the current spelling.
- **The host-observable progress surface does not exist.** `RuntimeProjection` has no Operation
  variant, so a host cannot observe an in-flight Import batch today. Ticket 56's progress effect is
  the Operation itself, as recorded in
  [its interpretation comment](56-runtime-import-batch.md#2026-09-01--interpretation-the-local-progress-effect).
  This ticket must therefore deliver that projection, not merely style an existing one.

### 2026-09-01 — frontier resolved before implementation

Three questions blocked the slice. Ticket 56 named two of them; scoping this ticket found the third.
The maintainer decided all three. Each answer is now binding for this slice.

**The authority fetch needs a Server route that does not exist yet.** `ImportExecutorPort::fetch_items`
expects a body that decodes as `Vec<ItemResponseDto>` under `deny_unknown_fields`, with a cursor. Today
the repository has only `GET /items/{itemId}` (one Item) and `GET /vaults/{vaultId}/items`, which
returns `CursorPage<VaultItemDetailsResponse>` — the same Item fields plus `attachments`, so it cannot
decode. Decision: **this slice adds a paged bulk authority read route** that returns exactly
`Vec<ItemResponseDto>` for the accepted Item identities, and the production port calls it once per
page. The rejected alternatives were 200 sequential single-Item fetches, which would hold the Account
execution lock for minutes and stall every other Operation on that Account, and re-serializing the
existing list route client-side, which would make `raw_response_body` client-authored bytes and read
the whole Vault instead of the accepted batch. This ticket already owns public OpenAPI generation, so
the route regenerates `openapi.v1.json`, `@bittery/api-contract`, the Runtime server contract, and the
route/operation count assertions.

**The Operation projection is cut broad, not Import-shaped.** Decision: add one **Account-scoped
Operations projection** covering every accepted Operation — kind, Operation identity, attempt count,
next attempt time, and resolution state — rather than a variant that only describes an in-flight
Import batch. One cross-language surface then serves Ticket 58 and every later host instead of
forcing a second variant or a rename. It carries no plaintext: Ticket 56's interpretation forbids
showing an imported Item before authority confirms it, so this projection describes accepted work,
never Item content.

**The parking store is retired in full.** `apps/web/src/hooks/runtime-import-parking.ts` and
`apps/web/src/lib/runtime-import-lifecycle.ts` are removed, not reduced. The durable Operation plus
the new projection become the single owner of "an Import is in flight". Leaving decrypted drafts in a
module singleton would keep a second, independently stale owner reachable, which is exactly what this
ticket forbids. The seven Chromium parking tests, the two AST wiring tests, and the active e2e test
at `import-export.spec.ts:309` are replaced by coverage of the projection.

**One derived scoping answer needs no maintainer.** The whole-repository Import gate is a **new
sibling script**, not an edit to `apps/web/scripts/transitional-reachability.ts`. That file and its
test are preserved uncommitted Ticket 58 work, and `create-vault-reachability.test.ts` is the existing
precedent for a separate gate over `buildRepositoryImportGraph()`.
