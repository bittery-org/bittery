# Cross-Account Item Move ownership

Type: research
Status: resolved
Blocked by: 60
Spec: ../desktop-extension/cross-account-move.md

## Question

How must shared Core preserve Desktop's existing cross-Account Item Move, including its durable
source/destination steps, without replaying creates or retaining the TypeScript semantic executor?

## Actual caller evidence

`apps/desktop/src/components/vault/move-item-dialog.tsx` lists destination Accounts and passes
`targetAccountId`. `packages/core/src/services/item-commands.ts` creates a stable target Item ID and
queues `cross_account_move`, distinct from same-Account `move`. Rust's current `MoveItem` request only
names one Account and a target Vault; it does not implement this production variant. The initial
inventory's generic Account/Vault-boundary wording does not establish capability coverage.

Inventory the actual semantic executor, persisted queue shape, Server retained outcomes and staged
source deletion, including same/different Servers, Attachment behavior, permission failures, offline
restart and both Accounts' lock/removal. Inspect the migrated Web caller too; a historical Web ticket
cannot authorize removing this Desktop option. Preserve current supported variants and explicitly
identify any existing refusal rather than silently dropping files or narrowing destination choices.

Specify a single Core durable workflow with exact accepted evidence, stable step identities,
reconciliation and cleanup. Resolve genuine product ambiguities before its implementation ticket is
ready. Coordinate existing pending-command admission with research82; no old behavioral owner may
continue alongside Runtime after application cutover.

## Comments

2026-09-09: concrete production caller gap found during pre-cutover audit; independent investigation
assigned. Desktop first-path and complete-caller tickets await this capability closure. No implementation
or acceptance is claimed, and filtering other Accounts from the Move UI is not an authorized workaround.

## Actual production inventory

| Boundary | Existing behavior and evidence |
| --- | --- |
| Desktop presentation | [Move dialog](../../../apps/desktop/src/components/vault/move-item-dialog.tsx) groups Vaults from every unlocked Account, including another Server; its request supplies source and target Account IDs. Cross-Account acceptance shows the existing pending toast and keeps the source view rather than navigating to the same Item ID. [Drag/drop](../../../apps/desktop/src/providers/dnd-provider.tsx) supplies the same target Account identity. |
| Durable admission | [ItemCommands.move](../../../packages/core/src/services/item-commands.ts) generates a new target Item ID, encrypts the destination Item under the target Account/Vault at version 1, and enqueues one source-owned `cross_account_move`. The [persisted command](../../../packages/types/src/index.ts) retains source Account/Item/Vault/base version, target Account/Item/Vault, category, destination ciphertext and encrypting User ID, stable Operation ID and replaceable attempt ID. The command is generic across Item categories. |
| Pending/read projection | [AccountVaultReplica](../../../packages/core/src/services/account-vault-replica.ts) leaves the source Item visible while this command is pending. Acknowledgement removes the source cached Item. Source conflicts can produce a conflict copy in the source Vault; they are not an instruction to overwrite a changed source. |
| Account/Server access | [Account Sync](../../../packages/core/src/services/account-sync.ts) installs the semantic executor and resolves an authenticated client separately for each Account. [Stored-account HTTP](../../../packages/core/src/services/api-client.ts) reads each Account's own Server URL and Session. There is no same-Server restriction. |
| Target creation | [CrossAccountItemCommandExecutor](../../../packages/core/src/services/cross-account-item-command-executor.ts) probes both Items, checks any existing target's exact Vault/category/ciphertext, requires the source's original strong version, and creates the fixed target ID with `${operationId}:create-target`. A rejected target create preserves the source and skips attachment transfer. |
| Source finalization | After target creation and attachment migration, the executor trashes the source with its original version and `${operationId}:trash-source`, then permanently deletes with version + 1 and `${operationId}:delete-source`. Retry probes distinguish absent source plus matching target, and already-trashed source at the expected version. A missing source and missing target is an error. This spans independently authenticated Servers and cannot be a single Server transaction. |
| Attachments | Source attachments are listed and both Account-scoped Vault keys are obtained before target creation. Each source envelope is downloaded/decrypted under the source Attachment ID, uploader and Vault; a new target Attachment ID and key are created and encrypted under the target User/Vault scope. Registration uses an attempt-specific per-source-attachment idempotency identity. If a target already exists, legacy retry deletes its attachments and rebuilds them before deleting the source. |
| Existing limitations | The legacy executor has no durable per-attachment ciphertext checkpoint, no cancellation signal, and no two-Account incarnation/access fences. It buffers whole attachment envelopes. It checks target-create semantic rejection but does not inspect the trash/permanent-delete semantic result before synthesizing an acknowledgement. These limitations are not an accepted Runtime contract or evidence that target edits may be destroyed. |
| Completed Web comparison | The [Web Runtime Move hook](../../../apps/web/src/hooks/use-runtime-item-mutations.ts) explicitly rejects differing Account IDs with `Cross-Account Item moves are unavailable`. The [Web dialog](../../../apps/web/src/components/vault/move-item-dialog.tsx) sees only the active Account's Runtime Vault projection. Web therefore does not supply this missing capability; its narrowed presentation cannot authorize removing Desktop's existing destination choices. |

The [legacy executor tests](../../../packages/core/src/services/cross-account-item-command-executor.test.ts)
cover stable step identities, lost create/delete responses, exact target matching, source version
conflict, target rejection, key prerequisites, failed download and attachment attempt identity using
controlled clients/crypto. No real cross-Account Server/attachment/lock/teardown acceptance was found.
The current Rust `MoveItem` is a one-Account operation. Its existing bounded
[AttachmentMoveTranscryptor](../../../packages/crypto/core/crates/bittery-crypto-core/src/attachment_move.rs)
already accepts independent source and target scopes/keys; preserving algorithms does not require
copying the legacy whole-buffer crypto implementation. Core still needs the two-Account durable
workflow, authorization/retirement rules and artifact ownership.

## Accepted architectural contract

One source-owned durable Core workflow retains the exact destination identity, target Item ID,
encrypted payload, accepted step identities and attachment dependencies. It verifies the complete
target copy before source trash/delete. Each Server result is a retained semantic outcome, and each
retry first reconciles authoritative source and target state. A response lost after success does not
produce another target Item or turn a rejected source deletion into success. A changed/nonmatching
target, including changed attachments, preserves the source and blocks or rejects further work;
legacy deletion of all target attachments is not the proposed conflict behavior.

Admission and every plaintext preparation bind both Accounts' canonical Server/User identities,
current incarnations and access generations. Core acquires Account fences in deterministic order,
owns retry/Sync and bounded authenticated transcryption, and persists the exact accepted encrypted
artifacts required across interruption. Account projections expose the pending move and bounded
failure/recovery state; hosts do not orchestrate source/destination API calls. Existing retained
TypeScript commands must enter this single owner through research 82 before their executor is removed.

Lock or owner loss retires live access and pending plaintext work without deleting accepted encrypted
evidence. Removing either Account stops further cross-Account mutations and clears that Account's
keys. Source-owned accepted evidence remains while the source Account exists; explicit source
removal ends that local ownership. Neither removal nor cancellation compensates by deleting an
already-created destination Item. Target Account removal is recorded as a retired destination
binding, not silently converted into ordinary transient offline retry.

### Explicit destination reauthorization (accepted)

The maintainer accepted explicit reauthorization and resume after destination removal, when the
new local Account has the exact same normalized Server URL and Server User ID. Adding or unlocking
that Account alone must not resume the workflow. Core verifies both current Accounts, unchanged
expected source/target content and attachments, the original target Item identity, retained step
outcomes and required encrypted artifacts before recording a new destination binding. Preserve the
original Operation, target Item and accepted step identities. A different Server/User, an edited
target, missing proof or stale confirmation remains blocked, with source and evidence preserved.

This resolves the product frontier. The implementation is specified in
[cross-account-move.md](../desktop-extension/cross-account-move.md) and drafted in
[ticket90](90-runtime-cross-account-item-move-workflow.md). Research resolution does not establish
that the Runtime workflow, profile admission or application acceptance exists.

Acceptance must cover same/different Servers, all supported Item categories, attachment-bearing
moves with actual nonempty retained ciphertext, target permission/plan failures, source and target
edits, interruption after every retained step, offline/restart/reconnect, both Accounts' lock/removal,
and the chosen re-add policy. Verify real Desktop dialog and drag/drop after capability cutover.
The implementation ticket remains subject to its durable contract review and completed dependencies.

2026-09-09: precise destination-removal/re-add question sent to the maintainer. Recommended explicit
reauthorization/resume preserves original Operation/step/target Item identities, verifies the same
normalized Server/User and both current Accounts, and stops on edited target or unproven prior outcome.
The alternative keeps that Move blocked after destination removal. No reply is inferred from elapsed
time; the workflow remains unimplemented while independent capability work proceeds.


2026-09-09 maintainer answer: permit explicit destination reauthorization/resume for the exact same
canonical Server/User identity. Re-add/unlock alone does not restart work. Both current Account
permissions/generations, original target identity, unchanged content/attachments and retained outcomes
must be verified; preserve all original Operation/step identities, and keep edited or unproven work
blocked. The research frontier is resolved. Ticket90 is a draft pending durable-contract review;
no implementation, profile upgrade, socket or product acceptance is claimed.
