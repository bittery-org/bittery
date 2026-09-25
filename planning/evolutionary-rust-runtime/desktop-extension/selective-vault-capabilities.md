# Selective Vault capability retirement

Ticket: [86](../issues/86-selective-vault-capability-retirement.md)

Status: accepted capability contract; implementation proceeds under ticket 86. Dependencies [63](../issues/63-desktop-native-runtime-foundation.md),
[65](../issues/65-hidden-vault-durable-work-contract.md),
[67](../issues/67-runtime-local-biometric-and-device-setup.md) and
[69](../issues/69-desktop-native-binary-and-recovery-capabilities.md) are resolved capability contracts.

## Problem and ownership

Confirmed Vault deletion and hidden-Vault erasure must retire the affected plaintext/file capabilities
without locking an entire Account or cancelling unrelated Vault work. Core determines the target set
from its accepted, generation-checked authority. Hosts execute exact retirement requests and own OS
or browser resource cleanup; they never infer membership, visibility, Travel policy or deletion.

This slice extends existing capability owners. Ticket 70/71 owns durable purge intent/progress,
all-generation Replica authority, wrapped/live/borrowed Session keys, authority re-admission and the
minimal retained encrypted accepted-work exception. Ticket 86 does not delete accepted Operations or
indispensable encrypted artifacts and does not add another scheduler, storage owner or retry policy.

## Actual inventory

| Owner | Current identity and lifetime | Selective gap |
| --- | --- | --- |
| [Native files](../../../apps/desktop/src-tauri/src/runtime_host/file_capabilities.rs) | Unused and claimed upload entries bind Account + Item + exact file metadata; downloads bind Account + Attachment. Caller and Account epochs fence late replies. Blocking reads/writes/finalization retain the registry mutex. | Only Account/runtime retirement exists. The scope captured before a dialog contains no target generation, so deleting matching entries alone cannot fence a late grant. |
| [Web upload sources](../../../packages/client-runtime/src/web-attachment-upload-source.ts) | Grants bind Account + Item; generation, tombstones, per-entry queued IO and cleanup promises own plaintext reads and close. Upload control is generated from Rust. | Account retirement fences unrelated Item sources too. Need exact Item target retirement and matching late-grant generation capture. |
| [Web download sinks](../../../packages/client-runtime/src/web-attachment-download-sink.ts) | Grants bind Account + Attachment; queued writes and cleanup protect outstanding binary loans and verified commit. | Retirement is Account-only. The closed control type/parser is handwritten in TS and [the Rust bridge](../../../packages/client-runtime/crates/bittery-client-bindings/src/web_attachment_move_bridge.rs); extend through the existing Rust transfer-control generation and delete the mirrors. |
| [Native image sources](../../../apps/desktop/src-tauri/src/runtime_host/vault_image_source.rs) | Picker scope binds Account/caller/epoch. Core claim supplies exact Operation + Vault, but the native entry/closed tombstone retains only Operation. A source lease includes blocking reads, then a separate acceptance lease spans durable acceptance. | Cannot identify unused Update image selections by Vault or selectively drain claimed/closed acceptance. Preserve the actual Vault binding; do not fabricate one for a new Create draft. |
| [Web image sources](../../../packages/client-runtime/src/web-vault-image-source.ts) | Grant currently requires both Operation/Vault or neither. Exact Core claim binds an unbound draft; per-entry IO, tombstones and Account acceptance counts drain retirement. | Permit Vault-only prebinding for Update, retain claimed Vault in tombstones/acceptance bookkeeping, and drain only matching Vault entries/acceptances. |
| [Core foreground registry](../../../packages/client-runtime/crates/bittery-client-core/src/runtime/foreground_attachment_lifecycle.rs) | Active cancellations and publication/finalization fences share a scope keyed only by Account and optional incarnation. Upload/download preparation can register before resolving Replica authority. | Add exact resource target to the scope, including unresolved claims; Account-wide publication fencing cannot implement selective retirement. |
| [Move lifecycle](../../../packages/client-runtime/crates/bittery-client-core/src/runtime/attachment_move_lifecycle.rs) and [scheduler](../../../packages/client-runtime/crates/bittery-client-core/src/runtime/attachment_move_scheduler.rs) | Account lease plus execution fence spans sweep/drive. Lease loss drops the drive; preparation knows source/destination Vaults. Scheduler's active-Account set only excludes concurrent writers. | Register the actual drive with a selective source/destination target and cancel/drain it before purge waits for the execution fence. Retain the existing writer, lease, crypto and artifact owners. |

The shared [Attachment ports](../../../packages/client-runtime/crates/bittery-client-core/src/runtime/attachment.rs)
and [image source port/facade](../../../packages/client-runtime/crates/bittery-client-core/src/vault_image.rs)
currently expose Account and Runtime retirement. The source-claim path already has Item IDs and the
sink-claim path Attachment IDs before authority resolution; no host Vault lookup is needed.

The current [Web image grant caller](../../../apps/web/src/lib/runtime-vault-image.ts) accepts only
Account + File for new-Vault creation. It remains an unbound draft. Native acceptance tests exercise
image replacement through the same Account-only picker, so those replacement callers must become
explicitly bound to the existing Vault before selection. Production Desktop dialogs remain ticket 66.

## Interfaces and fences

Core supplies a `VaultCapabilityTargets` value containing the exact Vault ID, Item IDs and Attachment
IDs within the existing Account/incarnation lifecycle scope. It derives the IDs before purging the
records that prove them. The primitive does not discover additional targets or classify durable work.

Extend the existing file ports with exact `retire_vaults(account, vault_ids)` and the image port
with `retire_vaults(runtime_incarnation, account, vault_ids)`, plus corresponding explicit
completion/re-admission operations. File grants and Core claims bind both the actual Vault and
Item/Attachment identity; selecting by Vault closes stale unused capabilities as well as claimed work. Empty sets are valid no-ops; duplicates are normalized without
changing meaning. Account/runtime retirement continues to dominate narrower generations.

Each existing registry keeps target generations under its existing mutex/queue state. Capture the
actual Vault and its generation before opening a dialog or another
asynchronous selection boundary. Retirement fences matching scopes before its first drain await,
closes unused handles, cancels matching claimed resources, then waits for their existing cleanup
owners. Repeat calls and dropped awaiters must preserve cleanup obligations. Old scope/handle
identities never become valid after completion; replacement scopes receive a fresh generation.

The accepted mechanism keeps target generations retired until Core explicitly re-admits them from
fresh verified Vault/Item/Attachment authority. Reactivation opens only a new generation; old scopes
and old acceptance leases never revive. Account removal clears all narrower target state. Core
captures targets before erasure; purge journals/drains retain only indispensable nonsecret IDs. No
host clock, polling loop or inferred visibility reopens a target.

Image selection has two real states:

- An existing-Vault update is prebound to that Vault before selection. Core generates the Operation
  later, and the first exact claim must match the prebound Vault and all original file metadata.
- A new Create image is an Account-scoped unbound draft. Deleting some other Vault does not retire
  it. Its first exact Core claim binds the generated new Vault and Operation atomically. After that
  claim it participates in the same selective retirement as every other bound image.

Closed image tombstones and acceptance leases retain that actual claimed Vault identity. Existing
`begin_acceptance(account, operation)` / `end_acceptance(account, operation)` can resolve the target
from the exact closed source binding; no second image identity or Operation-to-Vault policy map is
needed. Retirement waits only for matching acceptance leases and never invalidates already admitted
durable acceptance merely to make the cleanup test finish.

The Core foreground scope gains the actual Vault or source/destination Vault pair plus its known
Item/Attachment identity. Any unresolved cleanup scope carries its known resource rather than a
fabricated Vault; it cannot disclose plaintext or bypass the host grant's actual Vault fence.
The existing cancellation/publication/finalization guard handles all scopes. A selective retirement
fences matching publication/finalization admission synchronously and drains only those active guards;
a finalization admitted earlier remains owned until completion. Move preparation registers the
actual source/destination pair and observes the same cancellation beside existing lease loss. The
existing Account writer and execution fence continue to serialize durable effects.

Root-owned integration calls the synchronous begin fence before waiting for work holding the Account
execution lock. It then drains the captured work and invokes exact host retirement before recording
the corresponding durable purge phase complete. A cancelled caller cannot turn partial cleanup into
a completed purge. Generation checks prevent an old waiter from fencing replacement Account/target
scopes. Core admission prevents new hidden/deleted-target work throughout the transition.

## Cross-language and host completeness

Add the new closed source/sink controls to
[the Rust transfer contract](../../../packages/client-runtime/crates/bittery-client-bindings/src/web_binary_transfer_control.rs)
and image controls to
[the Rust image contract](../../../packages/client-runtime/crates/bittery-client-bindings/src/vault_image_control.rs).
Generate schemas, TypeScript types, validators and fixture coverage with the existing scripts under
ADR 0012. The native and Web bridges execute the same trait obligations; no default successful
no-op implementation may hide an incomplete host. Existing Account/runtime tests must still pass.

This capability is not consumed by Vault purge until both native and Web implementations and their
Core orchestration are complete. Runtime image input/crypto/persisted artifact formats remain intact;
new host selection identity is a capability boundary, not persisted Domain policy.

## Test-first acceptance

1. Actual native filesystem: retire one Vault's Core-supplied Item/Attachment targets with unused and
   claimed upload/download entries, including a pre-dialog captured scope. Old reads, writes,
   commits and late grants fail. Another Vault in the same Account and another Account continue.
2. Held IO/loan: selective retirement cannot report completion while matching plaintext reads,
   borrowed buffers, writes or already-admitted finalization remain owned. It does not wait for an
   unrelated target. Drop the awaiter and verify the existing cleanup owner still drains.
3. Image source: Update prebinding, unbound Create survival, exact first binding, held claimed read,
   closed-source acceptance, caller release, retirement/re-admission and late waiter races. Include
   actual native File -> Core ingress -> SQLite where the existing harness supports it.
4. Core foreground and Move: selective cancellation before publication/finalization or transcryption,
   source- and destination-Vault matching, Account isolation, no cancellation of unrelated work,
   and retained immutable accepted evidence/artifacts despite interruption.
5. Web registries/bindings: generated closed control validation, pending browser read/write loan
   wiping/drain, target generation and per-Vault isolation. Run the existing real Chromium capability
   harnesses for relevant source/sink paths; mocks alone are not production application acceptance.
6. Targeted Core/native/registry tests, dependent type checks, generated contract checks and Clippy;
   root phase acceptance still requires full `pnpm check:ci` / `pnpm check:ci:rust` and real application
   deletion/Travel paths under tickets 70/71/73.

## Moved-resource identity

An Item or Attachment can have the same ID in a hidden/deleted Vault's older authority generation
and a different currently visible Vault. Bare Item/Attachment retirement would cancel new work in
the other Vault. File grants and exact Core claims therefore need their actual Vault binding in
addition to Item/Attachment identity, captured before selection when known. Old-Vault loans retire;
new-Vault work with the same resource ID survives. No host infers that binding from IDs or storage.

With explicit Vault binding, the common host retirement primitive selects Account + Vault
IDs directly. This also closes stale unused handles whose Item no longer appears in the current
Replica: an enumerated Item list alone could miss them. Core retains Item/Attachment IDs for its
Vault-bound foreground scopes and durable witnesses. Exact claim still checks Vault + resource identity.
Core resolves current cached authority before claiming a capability; unavailable authority fails and
the existing host finally/release path owns the unused selection. Core integration uses this seam before consuming selective retirement; the native primitive can be
verified independently while the shared claim/control migration is completed.

At inventory, the Web Attachment upload caller had no finally/release path and its source registry
exposed no public discard. Before moving authority resolution ahead of claim, add an idempotent release via
the existing cleanup owner and invoke it in the real caller's finally block. The inventoried Web attachment-owner
presentation type omitted Vault identity; supply its actual projected Vault for grants.
Native already exposes caller-scoped release; Web image grants already expose discard. These are
necessary capability caller migrations, not an additional authentication or file-storage policy.

### Share management target refinement

The existing foreground registry also owns Account-wide live Sync and Share management HTTP tasks.
Live Sync keeps its Account lifetime. `ListItemShareLinks` already names an Item; `ListShareAccessLogs`
and `RevokeShareLink` named only a Link at inventory. The actual Web history hook retains their parent
Item, but the Runtime request omitted it. Server `domains/shares/mod.rs::load_visible_share_link` resolves
that Link through its Item's current Vault; neither that query nor `db/events.rs::load_scoped_item_access`
filters Travel mode. Server permission checks alone therefore do not prove current local visibility.
There is no Account-wide Share listing in the current Runtime protocol.

Accepted mechanism: add the parent Item identity to the two Link-scoped Runtime requests. Core resolves
its current visible Vault before foreground admission, then proves Link membership through the
existing authenticated Item Share listing before access-log reading or revoke. A host-supplied parent
alone is not proof. Preserve existing entitlement/role/error behavior and use the same Vault-bound
foreground fence for the proof, action and publication. No new Server route, Share cache or host
membership owner is introduced. A Move associates the Link with its Item's current Vault, matching the
Server join. Root approved this routine refinement under ticket 86; generated public protocol and
actual caller tests must cover the additional binding before this lane is accepted.

### Retirement drain ordering

The consuming Core retirement driver must publish its synchronous target fence and initiate host
source/sink/image retirement alongside foreground/Move draining, before awaiting any one owner.
An upload selection may be in an asynchronous host claim while already holding its Core foreground
loan. Serially waiting for that loan before starting host retirement can deadlock when the host claim
itself needs retirement to settle. Core retains the claim future; if it returns a late claimed handle,
Core closes that handle through the existing cleanup owner before releasing the foreground loan.
Dropping the claim future and losing its cleanup obligation is not a permitted shortcut. The
controlled `selective_retirement_starts_host_cleanup_before_waiting_for_a_held_claim` test exercises
this order and verifies late handle cleanup. Already-running platform IO still drains normally; this
does not promise that OS IO can be forcibly interrupted.

The Web image registry uses one opaque transition identity for Runtime activation, retirement and
close. An activation that waited on image IO or acceptance must still own that identity before
publishing its new incarnation; an old retirement must not clear a replacement owner. Begun image
acceptance remains separately owned until Core explicitly ends it, including through caller discard.
