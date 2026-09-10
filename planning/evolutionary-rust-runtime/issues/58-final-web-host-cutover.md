# Complete the final Web host cutover

Type: task
Status: resolved
Blocked by: 57
Parent: [28 — finalized E1–E10 frontier](28-remaining-item-write-kinds.md#final-web-item-and-import-frontier)

## Outcome

Finish Web Item/Attachment/lifecycle/Import consumers through the shared Runtime client and prove
the production graphs reach no transitional owner for those paths.

## Current state

Commit `87386201` includes the formerly uncommitted host draft: mutation/Attachment hooks,
Item detail and Move dialog changes, drag/drop, Vault routes, client facade, and Web composition.
Review those committed paths against the finished ticket 57 contract; do not treat them as a dirty
worktree that must remain frozen. Ticket 57 is resolved; `item-write` is not yet in the
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

## Acceptance audit

Keep foreground Attachment rename/delete through the actual hook, Worker, and Core explicit in
the browser checks. Verify optional imported fields survive a subsequent UI edit and export;
provider title/count assertions alone do not prove field preservation. Ordinary in-app navigation
must preserve the Runtime process; deliberate restart tests must still exercise Quick Unlock.
The user waived full CI for this run; targeted acceptance, dependent types, formatting, generation
checks where inputs change, and independent review remain required.

## Corrective prerequisites

Browser acceptance exposed missing password-history behavior after a Runtime Item edit and an
empty Share history after successful Runtime Share creation. Preserve the existing password-history
rules in Core. Under the accepted [network ownership](06-network-ownership.md), add closed,
Account-scoped Runtime requests for existing Share history, access-log pages, and foreground revoke,
using private Session renewal and lifecycle publication fences. Keep the existing Server routes and
foreground revoke semantics: explicit success only, no new durable Operation, ambiguous automatic
replay, bearer export, or host authentication policy. Public recipient calls remain unchanged.
These repair prerequisites to the existing consumer acceptance; they introduce no new product policy.

## Completion

Web consumers now use the shared Runtime client, and production ownership graphs forbid legacy
Item/Import owners. Independent Standards and Spec reviews passed. All 37 distinct browser cases
passed across the acceptance sweep and targeted rerun: category edits, organization, Share options
and access logs, Import/export, foreground Attachments, durable restart/retry, offline reads, and
confirmed logout. The final rerun passed all five cases after correcting Move presentation ownership
and adapting persisted-identity/observation fixtures without weakening their assertions.

Focused Core/client/UI tests, dependent type checks, formatting, contract and binding generation
checks, and the rebuilt 135-assertion joined Worker/Core suite passed. Full CI was waived and not run.

## Simplification pass

Shared mutation lifecycle handling replaces duplicate Share bookkeeping; Move uses existing Vault
options and a presentation-only dialog, with its surviving pane owning request completion. Obsolete
wrappers, impossible branches, and aliases were removed. A mounted regression proves projection
removal cannot suppress successful Move navigation, while Lock, Account departure, and route unmount
still fence late results. Independent review approved the reductions. Distinct foreground/durable
services, legacy-host Attachment adaptation, and Export readiness behavior remain explicit.
