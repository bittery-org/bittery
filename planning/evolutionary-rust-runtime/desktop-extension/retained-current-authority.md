# Retained results and current authority

Research: [88](../issues/88-retained-work-current-authority.md).
Status: reviewed decision; [implementation89](../issues/89-retained-results-current-authority.md) is ready after87 closure.

## Frontier and actual callers

A retained result proves what the Server decided for exact accepted request bytes. It does not prove
that the affected Item or Vault still has its original version, location, metadata or visibility.
Keep those two proofs separate in Core, with one guarded receipt owner and the existing Sync driver.
This extends [87](vault-retirement.md) and preserves the accepted hidden-work contract; it adds no
host retry policy, cryptographic algorithm, login secret or Server outcome version.

Inspection found these remaining assumptions:

| Current production Core path | Assumption that fails after a later legitimate action |
| --- | --- |
| [Item completion](../../../packages/client-runtime/crates/bittery-client-core/src/runtime/outcome.rs) and its domain reconciliation | Present applied authority must have exactly the retained version and original target Vault. A later edit or Move violates that equality. |
| [Import executor](../../../packages/client-runtime/crates/bittery-client-core/src/runtime/import_executor.rs) | Current authority must contain the complete original batch, in the original Vault, with original ciphertext and version1. The actual Server reader omits moved/deleted Items and returns403 when Vault access is lost. |
| [Create-Vault executor](../../../packages/client-runtime/crates/bittery-client-core/src/runtime/create_vault_executor.rs) | Current name/type/icon/image/role/wrapped key must match the original creation intent. Later rename, conversion or removal is mistaken for a failed historical creation. |
| [Bootstrap catch-up](../../../packages/client-runtime/crates/bittery-client-core/src/runtime/bootstrap.rs) | A structural page reconciles its Operation events before hydrating fresh authority. Returning ordinary Retry while waiting for that hydration can prevent it forever. |

Current Import admission has one immutable batch Operation and no optimistic Item overlays. Its
receipt count describes that accepted batch, not how many of its Items remain visible today.
Create-Vault's accepted encrypted wrapper and image artifacts remain exact request/retry evidence;
they are never a substitute for current key authority after retirement.

## Exact result proof

Keep the existing lookup as a hint, exact immutable replay, semantic response decoding, and matching
Operation ID/kind/fingerprint checks. Contradictory hints, identity reuse and contradictory terminal
answers retain their existing failure behavior. A current403 is not an Item404 and never independently
proves absence. Transient responses retain accepted work and ordinary bounded retry scheduling.

The existing receipt is sufficient durable evidence of a proved terminal result. Do not add another
completion checkpoint, duplicate result, required-generation field or per-Operation refresh queue.
Crypto validation is required before installing or publishing current data. It is not a prerequisite
for recording an independently proved historical receipt when that transition installs no data.
Validate every result against its exact accepted intent, including original Item identity and Import
batch count. Preserve existing contradictory-answer failure behavior.

## Ordinary Item completion

Keep the direct path when an authenticated present Item belongs to current verified visible authority.
Require the exact Item ID, the accepted category, a version at least the retained applied version,
valid current Vault/key scope, and valid ciphertext/plaintext before committing a receipt or exposing
data. A later version or Move into another currently visible Vault is legitimate. A lower version,
category mismatch or corrupt present ciphertext remains a contradiction. A present Item after a
retained permanent-delete result remains a contradiction; do not relax that existing guard.

Capture current Account incarnation, lock/access/key generation, active Bootstrap generation and
Replica revision for the fetch/validation. Commit against that exact captured state. Do not rebase a
fetched row onto another authority generation. If another path already installed a newer verified
Item, preserve it; an older fetched row cannot overwrite it. Re-read and validate the current state
on a later bounded attempt instead of recomputing a plan with stale network data.

For an authenticated current404, use the same receipt-and-refresh transition without deleting cached
current authority. For present data outside verified visible authority, or when the current response
cannot establish visibility, use that shared transition as well. Never decrypt that response with a retired Session wrapper, an older
Bootstrap generation, or key material retained in an accepted Operation. Locked/missing-live-key
validation waits through existing Runtime eligibility; it does not permanently fail the Account.

Rejected Item results retain the existing current-authority semantics and receive the same scope,
crypto and exact-commit protection. This change does not turn a rejection into an applied result.

## One receipt-and-refresh transition

Reuse the existing receipt plus `RefreshRequired` model used by Vault metadata completion. Apply it
for every applied Import and applied Create-Vault result, and ordinary Item results for which point
fetch cannot safely install current visible authority. Avoid separate changed-metadata predicates
and partial-batch point-reader reconciliation. Rejected Import/Create-Vault results needing no current
authority retain their existing receipt-only behavior.

Under one exact current Account/incarnation/Replica/access guard, record the original retained receipt,
remove only that Operation and its owned optimistic effect/preparation, abandon pre-proof Bootstrap
staging, and mark refresh required. Keep all current authority and every other Operation's overlay.
In particular, do not reuse Item reconciliation's `authority: None` deletion behavior: receipt without
authority installation means preserve current authority, not delete the Item. A matching Item ID may
already have a newer version or reside in another visible Vault. The transition must not clear it.
Use a narrow closed domain transition sharing existing receipt validation/removal, rather than a
second completion owner or manually assembled per-kind receipt payloads.

A failed or stale commit preserves the exact request, accepted category witness, artifacts and current
data. The atomic receipt commit ends accepted ownership of that Operation because exact Server replay
already proved its terminal result. Its original receipt remains durable across restart. Existing
post-commit Move/image artifact cleanup runs only after that commit and retains its existing failure
obligation; a subsequent Bootstrap failure cannot cause the original action to be sent under a new
identity or its cleanup to be falsely acknowledged.

Applied Import still proves exactly its accepted batch identity and original count through unchanged
request bytes and the terminal result. That count is independent of how many Items remain visible
now. The fresh snapshot can legitimately contain none, some or all of those Items, later versions or
moves into other visible Vaults. There is no second Import authority mapper or initial-ciphertext
comparison. Applied Create-Vault likewise remains applied after later name/type/image/role/key changes
or removal. Accepted creation wrappers never reinstall authority. Only the ordinary current Bootstrap
key/Item validation can make fresh data usable.

Abandoning pre-proof staging in the same receipt commit ensures the subsequent complete Bootstrap
begins after the exact result was proved. A generation already fetching before replay cannot satisfy
that required refresh. No explicit required-generation checkpoint is needed because receipt completion
is not waiting for a particular future generation; durable RefreshRequired already owns the remaining
convergence obligation. Resume only a chain begun after that invalidation, and preserve the existing
pinned-watermark/page/replay guards through normal begin/stage/promote behavior.

Before exposing fresh visible data, ordinary Bootstrap must enforce current Travel/retirement policy,
validate current Vault/key scope and decrypt/authenticate ciphertext under current live access. Hidden
data is neither decrypted nor republished. Missing live keys waits through existing eligibility. Corrupt
visible current data follows existing Bootstrap failure behavior; it does not retrospectively make a
proved historical Server result false. A receipt may therefore exist while the Account is still
RefreshRequired, locked, or failed at current-data validation. UI projections must report that state
honestly rather than treating a receipt as proof that refreshed Items are available.

## Existing-driver progression and bounds

The receipt transition publishes the durable change and wakes the existing live-Sync owner, which
already consumes local RefreshRequired changes while an SSE connection is quiet. It returns completed
work to dispatch; it does not add another host command, scheduler or runner.

Sync catch-up must notice when completion changed Bootstrap state or invalidated its captured page.
Stop processing that old page without advancing its cursor. The existing bounded Bootstrap owner
hydrates fresh authority and resumes from the promoted watermark. In the structural-refresh branch,
Operations can now complete their receipts without waiting for hydration, so the branch can reach its
existing refresh step. In an ordinary Operation page, a completed receipt that marked RefreshRequired
must route to hydration before processing more Item events or attempting the old cursor advance.
Do not keep fetching the old page, return Retry forever, or interpret state invalidation as successful
catch-up. Full verified Bootstrap may supersede that old page because its locally accepted Operations
are either still durable or already represented by exact receipts.

Keep the direct visible-Item path bounded and preserve its existing exact replay/current-read budget.
Receipt-and-refresh ends that completion attempt; the next existing Sync attempt has its own normal
budget. If a bounded Sync pass continues directly from replay into hydration, thread the same renewal
allowance through both phases. Do not reset authentication allowances per page or in nested helpers.
No recursive Account execution-lock acquisition or unbounded replay/refresh loop is permitted. The
existing page/byte bounds, retry schedule and generation fences remain in force. Lock, replacement,
owner loss and teardown cannot turn stale current data into authority.

## Implementation and acceptance ordering

Following independent decision review, ticket89 depends on87 and begins with an actual Core reproduction
of retained Item replay after a later visible edit. Widen only after that path passes. The observable
matrix must include:

- Every ordinary Item mutation, later visible version/Move, lower version, wrong category, corrupt
  ciphertext, present permanent-delete contradiction, authenticated404 and stale concurrent fetch.
- Applied Import with all five categories, partially deleted/moved batches, no visible original Vault,
  exact original count, corrupt visible data and preservation of unrelated accepted work.
- Applied Create-Vault followed by rename, conversion, key/role/image change and removal; existing
  rejected results and exact image-release retry behavior remain covered.
- Receipt-plus-refresh during pre-proof staging, restart between receipt and hydration, concurrent
  receipt commits, stale promotion/receipt commit, quiet SSE wake, and ordinary/structural pages that
  otherwise cannot reach hydration. Assert bounded requests and one renewal allowance per attempt.
- Real SQLite and generated IndexedDB histories, encrypted recovery with exact accepted work/receipt
  evidence, and failures at every physical commit boundary that could lose accepted work.
- Lock/unlock and current policy retirement before crypto validation, without hidden plaintext or
  retained-key fallback; a receipt may precede that validation but cannot expose unverified data.
  Then real native multi-client deletion/Travel/reconnect paths in70/71 and
  application acceptance tickets66/72/73.

Core fixtures and compiler success establish capability evidence only. Actual Desktop/Extension
acceptance and required full repository checks remain separate explicit gates.

## Retained Item result with current access refusal

The Server's current Item read distinguishes a missing Item (`404`) from a still-existing Item whose
Vault membership the authenticated caller has lost (`403`): `get_vault_item` loads the row before
`assert_item_read_access` checks the current Vault grant. An exact retained Operation may therefore
remain provable while its subsequent current Item read is forbidden. Retrying that completion forever
prevents structural Sync from reaching the fresh Bootstrap which could establish current visibility.

The accepted narrow seam is a typed current-authority answer with `Present`, `Absent` and `Unavailable`
variants. Only the retained-completion HTTP entry exposes authenticated `403` as `Unavailable`, using
the existing bounded authenticated JSON transport/decoder and renewal allowance. Existing ordinary
Item, complete live-Sync authority and Attachment reads preserve their current refusal/retry behavior;
there is no global `403`-as-absence conversion. A call-site inventory currently finds the completion
fetch helper used only by its Applied and ordinary Rejected branches; recheck that graph when editing.

After the exact accepted request/result identity is proved, either `Absent` or `Unavailable` can choose
the existing `ReconcileRetainedResult` receipt transition. They remain distinct transport facts and
neither writes an Item deletion, infers a deleted Vault, removes unrelated authority or publishes
plaintext. Applied results retain the original result and require ordinary current Bootstrap refresh;
rejected results preserve the existing shared rejection transition. Present data keeps its existing
category/version/visibility and cryptographic checks. Wrong fingerprints and contradictory retained
results remain invariant failures, regardless of the current read status. Transient failures cannot
stand in for visibility evidence, and `401` still consumes at most the existing one-renewal budget.

Implement after the current full-Rust-check freeze, test-first: reproduce exact retained Create and
ordinary Item results followed by current `403`, including rejection; assert the original receipt,
unchanged cached authority and bounded requests. Exercise structural Sync through that completion into
fresh Bootstrap rather than calling a manual completion cycle alone. Add a wrong-identity negative
case and preserve the ordinary Item/live-Sync/Attachment `403`, transient and authentication mappings.
This is a completion-policy correction under ticket89, not a new Session owner, host policy or runner.

## Completion publication and dependent presentation

Item, Import and Create-Vault completion share the existing captured-snapshot completion helper for
exact commit and publication. Receipt-only plans install no authority, so that helper skips unnecessary
decryption for them. A physical write error is never a semantic rejection: unchanged current scope
uses the existing durable retry scheduler, while changed scope leaves the accepted work fenced.

The actual Import browser path must continue from a retained Create-Vault receipt through verified
Bootstrap before dependent batch admission, and repeat that sequence between batches. A controlled
browser test holds the real Bootstrap HTTP exchange, observes the original receipt, advances React
presentation frames, then releases the exchange; no batch reaches the Server while it is held. The
existing Core Account execution fence queues admission and the complete new/existing/multi-Account
and independently rejected batch sequences pass. No additional readiness projection, host retry loop
or catalog filtering is justified by this evidence. Cached Vault presentation remains unchanged.
