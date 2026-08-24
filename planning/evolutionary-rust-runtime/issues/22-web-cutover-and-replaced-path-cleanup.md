# Web cutover and replaced-path cleanup

Type: task
Status: ready-for-human
Blocked by: 21, 27
Spec: ../spec.md#web-cutover

## Outcome

Make the Rust Runtime the only active Web owner for the first-slice paths and remove Web-specific
transitional orchestration without breaking Desktop or Extension.

## Work

- Switch the Web composition root, providers, Sign-in, Items projection, Sync ownership, and create
  flow completely to Runtime.
- Prove no Account can activate both transitional and Runtime writers.
- Delete Web-only providers/hooks/adapters and dead branches replaced by the Runtime.
- Retain shared TypeScript modules still imported by Desktop/Extension and label their ownership in
  the next-host tickets rather than wrapping them as permanent compatibility.
- Update architecture docs, diagrams, generated-file instructions, and checks.

## Verification

Web unit, integration, offline, and end-to-end suites pass on the Runtime path; a dependency/import
audit finds no Web reachability into replaced TS auth/Replica/Sync mutation owners. `pnpm check:ci`
and `pnpm check:ci:rust` pass.

## Comments

### 2026-08-23 — transitional readers still live after the Items swap

The Items read swap covered `routes/_app/vaults/*` only. `useItems` from `@bittery/core/hooks` is
still the live source in `components/dashboard/recent-activity-card.tsx`,
`components/dashboard/security-posture-card.tsx`, and `routes/_app/security.lazy.tsx`, so the
dashboard and the security report read the transitional repository while the vault reads the Runtime.
After a Runtime Sign-in the two disagree.

Writes did not move either. `/vaults` mixes `useRuntimeItems()` with `useAllVaultKeys()`,
`useCreateItem()`, `useUpdateItem()`, and `useDeleteItem()`, and passes a Runtime `AccountId` into
transitional mutations that have never seen it. Because `canWriteItems` resolves through the
transitional `vaultKeys`, which are empty after a Runtime Sign-in, every Item currently renders
read-only and the create sheet has no Vault to select. Vault metadata, tag grouping, and Item counts
must move to Runtime projections in this ticket, not only the Item list.

The `not.toMatch(/\buseItems\b/)` assertion added alongside the swap greps five hand-picked files, so
it reports the migration complete while three transitional consumers remain. Replace it with a
reachability audit over the whole Web entry graph, which this ticket's verification already requires.

### 2026-08-24 — release gate: the Replica schema upgrade is destructive

`packages/client-runtime/src/indexeddb-executor.ts` deletes every object store on any
`DATABASE_VERSION` bump and rebuilds the schema. Since ticket 21 that also destroys accepted
Operations and their compact receipts, not just cached authority.

It is tolerable now only because this branch has no users, so a bump costs a developer their own
pending offline work. It contradicts the standing rule that an accepted Operation stays durable
until an authoritative semantic outcome, and it deletes the receipts that refuse a completed
Operation ID a second time. Replace it with an additive migration before release; a destructive
upgrade must not survive the cutover this ticket performs.

### 2026-08-24 — decision: do not gate the not-yet-ported write paths

The first Runtime slice knows only `CreateLoginItem`, so after this cutover update, delete,
favorite, move, and share still write to the transitional repository the vault pages no longer
read, and appear to do nothing.

Decided: do not spend work making those actions refuse or explain themselves. This rebuild ships
only once every path is ported and tested, so no user ever meets the gap, and gating UI that is
about to be replaced is throwaway work. Pull the remaining operations over step by step instead.

Consequence for this ticket's scope: it covers the read cutover, the create path, deletion of the
Web-only orchestration those replace, and the import audit. The remaining write kinds move in
ticket 28, which is sequenced immediately after and is the real end of the Web cutover. Until 28
lands, the import audit in this ticket's verification can only assert that no Web *read* path and
no *create* path reaches a transitional owner.

### 2026-08-24 — the narrowed scope is delivered

The read cutover is complete. `useItems`, `useVaultInfo` and `useAllVaultKeys` have no Web reader
left: the dashboard's recent activity and security cards, the security report, the Vault page header
and role, the nav sidebar, its tag grouping and its Item counts all read one `Items` observation.
The Items projection now names each Item's Vault, so a list row, a sidebar entry and a Vault header
never disagree.

`VaultProjection.writable` became `VaultProjection.role`, carrying the Server's own closed
`VaultRole` spelling. The sidebar needs Owner/Admin to offer edit and delete, and the Vault page
needs it for member management and type conversion; neither is derivable from a boolean, while
"may I write here" is derivable from the role. It stays inside the declared `Items` variant, so no
third observation was invented.

Web owns no transitional Sync loop any more. `useWebSync`, its `AccountSyncLifecycle`, its assembled
`SyncSource`, its SSE connection and `useVaultKeysSync` are deleted, not disabled. What is left is
`providers/transitional-sync-provider.tsx`: React Query invalidation for the Teams, invitations and
Vault-member REST reads, plus an inert outbound queue so `PlatformProvider` still builds. The
remaining transitional writes therefore behave exactly as the decision below accepted — they apply
locally and go nowhere.

The fake audit is replaced. `apps/web/scripts/web-import-graph.ts` walks the whole Web entry graph
from `router.tsx` and `routeTree.gen.ts`, following `import()` so lazy routes cannot hide, and
`transitional-reachability.ts` classifies every transitional symbol it reaches. A symbol the table
does not classify fails, so a new consumer cannot slip in the way `useItems` did. Ticket 28 tightens
it by adding `item-write` to `FORBIDDEN_KINDS`.

What ticket 28 still owes, as the audit records it: the five write kinds; the four holdout reads that
exist only to serve them (`useDeletedItems` in Trash, `useMoveTargetVaults` in the move dialog,
`useAllVaultKeys` in bulk import, `useItemAttachments` in the detail pane); and Attachments, which
the first Runtime slice does not model at all.

Two things are outside every ticket so far and want an owner. Vault create, update, delete and type
conversion are still transitional and have no ticket. `tests/e2e/sync.spec.ts` asserts live
cross-device propagation, which is a capability Web no longer has until the Runtime owns live Sync;
it is annotated in `apps/web/tests/CONTEXT.md` rather than deleted.
