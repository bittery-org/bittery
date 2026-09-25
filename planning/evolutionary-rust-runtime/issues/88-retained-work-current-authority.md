# Retained work and changed or unavailable current authority

Type: research
Status: resolved
Blocked by: 87

## Question

How does Core reconcile an exact retained result when current authority has changed since the action,
or when verified Vault retirement prohibits installing or decrypting the returned authority?

This is an implementation frontier under existing retained-outcome and hidden-work decisions, not a
new product choice about discarding Operations. Preserve the original result, current verified
visibility, cryptographic validation and one guarded reconciliation owner. Resolve the contract and
observable test mapping before creating a ready implementation slice.

## Actual evidence

- [Item completion](../../../packages/client-runtime/crates/bittery-client-core/src/runtime/outcome.rs)
  now handles an authenticated current Item404, but present authority must still equal the original
  result's version and destination Vault. A later legitimate edit or Move can violate that equality.
  A hidden Vault can also return ciphertext through current Server Item routes even though Core
  correctly erased the key and forbids authority installation.
- [Import completion](../../../packages/client-runtime/crates/bittery-client-core/src/runtime/import_executor.rs)
  proves the exact immutable replay, then requires all originally imported Items with their initial
  ciphertext and version. The [Server authority-page reader](../../../apps/server/src/domains/vaults/items.rs)
  returns only requested Items currently in that Vault, and its access check returns403 after Vault
  removal or membership loss. [Auth HTTP](../../../packages/client-runtime/crates/bittery-client-core/src/auth_http.rs)
  currently maps that response to retry. Thus a retained applied batch can fail or retry indefinitely
  after later Item/Vault changes. Actual Core Import admission owns one batch Operation with no
  optimistic Item overlays; preserve that existing invariant.
- Create-Vault completion checks current metadata/key/role against its original intent. Current rename,
  conversion or later removal must not be mistaken for a contradiction of an earlier retained action.
- [Vault metadata completion](../../../packages/client-runtime/crates/bittery-client-core/src/replica/domain.rs)
  already distinguishes its retained action from subsequent Bootstrap authority. Tickets70/87 preserve
  the evidence and local erasure, but do not yet establish these remaining completion variants.

Do not solve this by weakening present ciphertext validation, treating every403 as Item absence,
using old operation material as key authority, recreating hidden projections, dropping accepted
requests, or adding host retries. Full current Bootstrap/policy evidence may be needed where an
individual response cannot distinguish historical action from current visibility. Reuse the existing
Sync/Replica owner and retain bounded network/authentication behavior.

## Required investigation and acceptance mapping

Trace each Operation kind through exact replay, current reads, guarded receipt/authority commit and
artifact cleanup. Specify which evidence proves current availability independently of the retained
result. Cover visible later versions, moves between visible/hidden Vaults, unavailable current Vaults,
partial Import result sets, Create-Vault rename/conversion/removal, locked reconciliation and restart.
Failed or stale commit preserves exact requests and indispensable artifacts. Current visible data
must not be overwritten or removed merely because an older result is replayed.

Use reproducing Core/Server cases, followed by real native multi-client deletion/Travel convergence.
This frontier gates remaining70/71 completion and production acceptance; no implementation or
acceptance is claimed by this inventory.

## Reviewed decision

[Focused contract](../desktop-extension/retained-current-authority.md): preserve exact retained-result
proof independently from current verified authority. Ordinary visible Item completion may install a
crypto-valid later version or location under exact captured guards, preserving newer cached data;
lower versions, category/ciphertext contradictions and present permanent-delete contradictions remain
failures. Unavailable visibility uses the existing original receipt plus durable RefreshRequired.

All applied Import/Create-Vault completions use one atomic receipt-and-refresh transition, avoiding
separate changed-metadata/partial-batch policy. Rejected results needing no authority keep receipt-only
behavior. The exact guarded transition records the original result, removes only its owned work,
abandons pre-proof staging and marks refresh required while preserving all current authority and
other Operations. Original requests/artifacts survive stale or failed commits; existing post-receipt
artifact cleanup retains its established obligation.

Independent review removed the initially proposed second completion checkpoint/result and required
Bootstrap-generation binding. Exact Server replay already proves the historical result. Current crypto
validation is required before installing/publishing current data, not before a receipt that installs
none. Fresh Bootstrap owns current visibility, key validation and convergence. Abandoning pre-proof
staging atomically with the receipt ensures that refresh begins after the retained answer was proved,
without another queue or persisted result representation.

Actual Bootstrap inspection found a liveness constraint: structural Sync pages reconcile Operations
before hydration; ordinary pages cannot advance past pending owned Operations. Receipt-only completion
removes that dependency. Catch-up must notice RefreshRequired/page invalidation and enter its existing
bounded hydration step instead of continuing the old page or returning ordinary Retry forever. Keep
one renewal allowance within an attempt; a separately scheduled Sync attempt has its normal budget.

Root approved this routine preservation refinement after independent challenge. Ticket87 is resolved. [Implementation89](89-retained-results-current-authority.md) carries the
reviewed contract through test-first Core/adapter verification. No source implementation or production
acceptance is claimed by this research.

## Comments

2026-09-09: root found these remaining concrete paths while reviewing87 erasure and Server access
behavior. They are recorded before widening implementation. Item404 support alone and historical
Web acceptance do not prove complete retained-work convergence for Desktop/Extension.

2026-09-09: bounded source investigation traced Item outcome/domain guards, Import exact replay and
authority-page filtering, Create-Vault intent/current-key equality, physical receipt behavior and
Bootstrap structural-page ordering. The focused proposal also records that current Bootstrap crypto
projection happens after catch-up, so receipt finalization must not simply trust successful hydration
without moving the existing validation ahead of that final transition. Old creation wrappers remain
accepted evidence only; hidden responses cannot borrow them for decryption. Independent review is
the remaining decision gate, followed by a dependency-ordered implementation ticket and actual tests.

2026-09-09 independent simplification review: the initial checkpoint duplicated the existing receipt
and made fresh-generation rebinding necessary only because it waited to acknowledge an already proved
action. Review separated the historical result from current-data publication instead. The final focused
contract uses existing receipt/RefreshRequired state, preserves newer Item authority, and specifies
both structural and ordinary Sync invalidation behavior. Crypto-before-current-publication remains
mandatory. No second completion checkpoint or persisted-format extension is proposed.
