# Web cutover and replaced-path cleanup

Type: task
Status: ready-for-agent
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
