# Complete the final Web host cutover

Type: task
Status: ready-for-agent
Blocked by: 57
Parent: [28 — finalized E1–E10 frontier](28-remaining-item-write-kinds.md#final-web-item-and-import-frontier)

## Outcome

Finish Web Item/Attachment/lifecycle/Import consumers through the shared Runtime client and prove
the production graphs reach no transitional owner for those paths.

## Current state

Commit `87386201` includes the formerly uncommitted host draft: mutation/Attachment hooks,
Item detail and Move dialog changes, drag/drop, Vault routes, client facade, and Web composition.
Review those committed paths against the finished ticket 57 contract; do not treat them as a dirty
worktree that must remain frozen. Import is still incomplete, and `item-write` is not yet in the
Web graph's `FORBIDDEN_KINDS`.

## Work

- Complete edit, trash/restore/permanent delete, favorite, Move, Share, Attachment, route, drag/drop,
  and lifecycle consumers through `packages/client-runtime/src/client`.
- Keep hooks to presentation/subscription. Runtime owns keys, encryption, network, retry, outcomes,
  Replica, capability registries, and lifecycle. Expose no concrete source registry from Web.
- Preserve ticket 49–57 behavior; delete obsolete Web bridges and cache repair once callers are
  cut over. Shared modules still needed by other hosts may remain, with Web reachability forbidden.
- Harden the real Web entry graph to forbid `item-write` and legacy Import/read ownership through
  every supported import form. Re-run whole-repository create/Import gates to catch other-host edges.
- Keep deep Runtime defects in prerequisite work instead of implementing policy in a React hook.

## Scope

Web integration, required shared UI callback signatures, shallow client/Web composition, and caller
graphs. Server protocol, crypto, native host integration, and live Sync retain their existing owners.
Vault update/delete/type conversion are separate product work, not silently added to this Item slice.

## Verification

Exercise every affected mutation and lifecycle through the production Worker/real Core, including
existing Item/Attachment/Share/Import browser scenarios. Prove zero forbidden reachability from actual
production entries. Run Biome, focused tests, dependent types, `pnpm check:ci`, `pnpm check:ci:rust`,
and `git diff --check`. Resolve ticket 28 only after this ticket's full gates pass.
Ticket 29 still owns response-cache deletion and ticket 30 live Sync.
