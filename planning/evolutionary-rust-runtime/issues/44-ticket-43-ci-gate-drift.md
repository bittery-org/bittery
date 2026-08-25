# Repair the clean-tree CI drift blocking Ticket 43

Type: task
Status: claimed
Blocked by: 24
Spec: ../spec.md#end-to-end

## Outcome

The committed Attachment Move contract and Rust dependency graph are represented by every still-built
caller and lockfile, so Ticket 43 can run both required CI gates from a clean tree.

## Problem

Ticket 43's first clean-tree `pnpm check:ci` run exposed two earlier integration drifts unrelated to
its uploader-AAD correction:

- Server staging commit `005b10be` made `MoveItemBody.mode` required, while the still-reachable
  transitional Sync queue constructs the old prepared body without that discriminator. TypeScript
  compilation now fails before Ticket 28's later Web cutover removes this queue.
- Cargo checking the Server updates `apps/server/Cargo.lock` with direct `aes`, `ghash`, and `zeroize`
  edges that committed crypto-core already declares. The checked-in Server lockfile therefore does
  not describe the committed dependency graph and makes a clean gate dirty.

Neither failure permits softening the generated contract or ignoring lockfile drift.

## Work

This ticket is split before implementation because the transitional TypeScript caller and generated
Rust lockfile have disjoint causes, paths, and verification:

1. **Prepared Move caller contract (A):** update only the transitional Sync Move request and its
   behavioral test to send the closed prepared variant (`mode: "prepared"` and the exact no-Attachment
   shape it owns). Prove the generated API contract type-check fails before the fix and the focused
   executor test observes the exact request. Do not widen the queue or delay its Ticket 28 deletion.
2. **Server lockfile closure (B):** update only `apps/server/Cargo.lock` from the committed manifests.
   Prove `cargo check --manifest-path apps/server/Cargo.toml --locked` fails before regeneration and
   passes afterwards with no further diff. Do not change dependency versions or manifests.

Each slice receives a fresh implementer and reviewer and is committed independently. Ticket 43 then
reruns `pnpm check:ci` and `pnpm check:ci:rust` from a clean tree.

## Verification

The focused Sync test and type-check pass; Server `cargo check --locked` passes without modifying the
tree; both repository CI gates pass from a clean tree; `git diff --check` passes.

## Comments

### 2026-08-26 — filed and split from Ticket 43's first clean-tree gate

The failing `pnpm check:ci` log named the missing prepared `mode` at
`packages/sync/src/outbound-queue.ts:970`. The same run generated five Server lockfile dependency
edges and no manifest edit. These are recorded as gate defects from earlier committed slices, not as
Ticket 43 uploader-AAD findings.

### 2026-08-26 — Slice A delivered the prepared Move caller contract

The transitional Sync queue now sends the generated closed prepared variant with
`mode: "prepared"` and its existing encrypted Item fields. It deliberately omits `attachments`:
the prepared contract defaults that optional field to an empty set, and the Server rejects an
attachment-bearing Item with `attachment_state_conflict` rather than silently moving unstaged blobs.
A behavioral test captures the actual `client.items.move` input and asserts the exact request.

Independent review found no product or fixture defect and confirmed this changes no retry, discard,
logging, Account scope, or writer behavior. Deliberately left open: Ticket 28 will delete this
transitional queue at Web cutover; Slice B still owns only the stale generated Server lockfile.

### 2026-08-26 — Slice B delivered the Server lockfile closure

The Server lockfile now records the direct `aes` and `ghash` dependencies already declared by
crypto-core and the `zeroize` feature edges already selected for `aes`, `ghash`, and `polyval`.
An isolated committed snapshot fails `cargo check --locked`; minimal offline Cargo reconciliation is
byte-for-byte identical to the five-line checked-in delta. The worktree Server check passes under
`--locked` without changing the lockfile hash.

Independent review found no product or fixture defect and confirmed no package, version, checksum,
or manifest changed. Deliberately left open: this ticket and Ticket 43 remain claimed until both full
repository gates pass from the now-clean tree.

### 2026-08-26 — Rust gate added a path-disjoint Desktop lockfile slice

The subsequent clean-tree `pnpm check:ci:rust` completed successfully but updated
`apps/desktop/src-tauri/Cargo.lock` with the same five committed crypto-core dependency edges as the
Server lockfile. A successful command that dirties the tree does not satisfy the release gate.

Ticket 44 therefore gains a third sequential slice, **Desktop lockfile closure (C)**, owning only
that lockfile. A fresh implementer and reviewer must reproduce the committed Desktop `--locked`
failure in an isolated snapshot, prove minimal offline reconciliation is byte-identical to the gate
delta, and pass the worktree Desktop locked check without further changes. No manifest, source,
generated binding, Server lockfile, or dependency version belongs to this slice. Both full gates are
rerun from a clean tree afterwards.

### 2026-08-26 — Slice C delivered the Desktop lockfile closure

The Desktop lockfile now records the same five committed crypto-core dependency edges as the Server
lockfile. An isolated committed snapshot fails its offline locked check; minimal targeted offline
reconciliation is byte-for-byte identical to the checked-in delta. Repeated worktree locked checks
leave the lockfile hash unchanged.

Independent review classified this as stale generated lockfile metadata, not a product-code defect,
and confirmed no package, version, source, checksum, manifest, or generated binding changed.
Deliberately left open: the full clean-tree CI and Rust gates must now pass once more before Tickets 44
and 43 resolve.
