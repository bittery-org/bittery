# Desktop complete gesture acceptance and legacy cleanup

Type: task
Status: ready-for-agent
Blocked by: 66, 68, 69, 70, 71, 83, 85, 95
Spec: ../desktop-extension/spec.md

## Contract

Complete gesture and variant acceptance for the Runtime callers already wired before ticket66's atomic activation: all five Item categories and all fields, tags/favorites/search/trash/history/TOTP/passkeys, Move/DnD, Attachments, Share history/revoke/logs, Vault edits/delete, travel, account selection/teardown, device setup and safe Replica recovery. Remove obsolete Desktop-only modules after proving they have no callers. Preserve Web handoffs for absent local Import/account-recovery UI. No reachable legacy owner is deferred from66 to this ticket.

## Acceptance

Exercise the reviewed complete path-to-test mapping against the activated application, including category, permission, cancellation, restart and stale-result variants. Repeat executable entry/caller graph checks to prove no legacy Desktop auth/key/Replica/Operation/retry/Sync/lifecycle owner remains reachable, then remove obsolete application-local providers/storage/queues/crypto and native cache code with zero callers. Shared Mobile and remaining Web callers keep their modules.

## Comments

2026-09-08: dependency-ordered delivery scope recorded. No implementation or acceptance is claimed.

2026-09-09: [caller closure and acceptance mapping](../desktop-extension/desktop-cutover.md)
specifies the66 activation boundary and72's exhaustive inventory coverage/removal proof. A reachable
legacy hook or dialog handler must already use the sole Runtime when66 activates;72 widens real
gesture/variant evidence and removes obsolete Desktop-only code after graph proof. Shared modules
with remaining Mobile/Web callers stay. The proposed shared public/private Item prerequisite is
linked explicitly, without depending on Extension74/75 or allocating a ticket here. Keep triage
pending independent mapping review and prerequisite sealing; no implementation or real-host result
is claimed by this planning update.

2026-09-09 final coordinating and independent mapping review passed after95's private Item contract,
91's profile admission and97's temporary native compatibility contract were sealed. The complete
startup/gesture/TOTP/native closure and its test mapping need no unresolved product or architecture
choice. Ticket72 is `ready-for-agent` with incomplete prerequisites;66 must migrate every reachable
caller before activation. Fifty scoped links/anchors and the dependency graph passed validation.
No production implementation, cleanup or actual Tauri acceptance follows from readiness.
