# Durable Attachment upload renewal

Type: task
Status: resolved
Blocked by: 103
Spec: 103-durable-attachment-upload-renewal.md

## Outcome

Extend the existing Attachment reservation owner and grant route so a sealed cross-Account Move can
renew a grant for its original destination file ID, storage key and ciphertext. Preserve ordinary
Upload behavior. Current access and quota still govern renewal; consumed or retired identities never
receive overwrite grants. Cleanup evidence survives parent deletion and late external PUTs.

The accepted research fixes the optional request/response, immutable global claim and original scope,
nullable live references, ordinary cascade trigger, exact lock order, scheduled object cleanup and
signed-header passage. Implement that contract without adding a second upload registry/backend or
persisting invocation URLs. Registration remains the existing real Attachment API, not a retained
Item Operation. Core's Move orchestration and full cross-Server transfer remain ticket90.

## Acceptance

Start with an actual Server route test proving a lost durable grant response and exact retry return
the same ID/key, then expiry plus cleanup and exact renewal. Extend that path through a nonempty
encrypted object and real registration before widening variants.

Cover conflicting request bytes/digests/sizes/Users/Items, ordinary/durable global ID collisions,
permissions, plan/quota changes, consumed/published/retired identities, and provider checksum/size
refusal. Prove exact quota accounting during concurrent renewal. Use the accepted lock order and
held object I/O to exercise cleanup versus renewal/registration, failed deletion and retry, and late
PUT after successful cleanup. Prove the revised103 pre-I/O fence against a late remote DELETE,
owner loss after the committed fence, a stale original cleanup owner and successful recovery deletion
that must never clear an inherited fence. A 202 DELETE is not definite completion. Normal confirmed
expiry cleanup must still permit exact renewal. Attachment/Item/Vault/User/Team deletion must preserve nonrenewable
claims and future cleanup duties; current exact object references remain protected. Jobs must visit
a bounded fair batch once, rescheduling failures as well as successful deletion.

Generate OpenAPI, API and Core server contracts normally. Verify native and actual browser passage
of the signed Content-Type and both SHA-256 headers; Web validates the fixed signed Content-Length
and derives it from the body. Run ordinary Upload regressions and focused Server/Core/host checks.
Perform independent simplification and review, then run literal `pnpm check:ci` and
`pnpm check:ci:rust` before resolution. Record concrete results; compilation and controlled object
fixtures do not substitute for required actual nonempty route/binary acceptance.

## Comments

2026-09-14 ready after research103's parent and independent review. This capability was discovered
while implementing90: the existing grant allocates a new ID and expiring key on each call. The
reviewed extension preserves the already-accepted fixed-ID/restart behavior. No product choice is
outstanding; no Server implementation or acceptance is claimed by this ticket's creation.

2026-09-14 the first13-case Server matrix, ordinary regressions, actual native/browser header passage
and real Server/nonempty PUT/registration/download/decryption path passed. Final review found the
late-DELETE ambiguity described in revised103, so these results do not close the ticket. The same-row
durable cleanup fence, its failure histories, final independent review and both full CI checks remain.

2026-09-14 the revised fence is implemented and independently reviewed. The concrete late remote
DELETE reproduction failed before the change; the corrected 15-case durable matrix passes, including
owner loss before I/O, stale-owner token handoff, recovery that retains the fence, and final SQL
failure. The S3 adapter accepts only a completed 204 DELETE; its completed/202 tests pass 2/2.
The final joined ordinary/durable Attachment regression passes 66/66 in 47.32 seconds
(`/tmp/bittery104-final-attachment-regression.log`), and final Server test Clippy passes.

Native binary transfer passes 12/12. The Web executor passes 33/33, the actual MV3 signed-header
case passes 1/1, and the combined WASM bridge harness passes 12/12. The final real Server case passes
1/1 in 1.7 minutes (`/tmp/bittery104-durable-upload-binary-final.log`): lost committed grant response,
exact retry and expired-lease renewal preserve the original ID/key; repeated nonempty encrypted PUT,
HEAD-backed registration, download and decryption preserve the complete file and metadata. The
existing loopback object fixture checks size and checksums but does not verify AWS signatures.
Public Runtime User deletion succeeds; the isolated test database contains zero Users afterward.

Literal `pnpm check:ci` passes (`/tmp/bittery104-check-ci-second.log`), including all 38 joined Web
cases and 574 assertions. Its first attempt identified three stale version8 expectations after90's
additive version9 migration; those expectations and their focused regression now pass. Normal native
and production Web bindings are refreshed; production Web smoke passes 11/11 with its intentional
feature-only skip. Platform-storage and Server contract checks pass. A final independent
simplification/review of Core, native, WASM and browser header passage found no blocker or worthwhile
structural reduction: the checks enforce their distinct ownership and transport constraints.
Literal `pnpm check:ci:rust` is running; this ticket remains open until that final gate passes.

The first full Rust attempt passed Server checks, 152 crypto tests, 11 vectors and Runtime Clippy,
then exposed a stack overflow in the existing public multi-Account password-unlock test. Its isolated
default-stack reproduction also failed. The general command dispatcher was nested by batch unlock;
moving only batch orchestration outside that dispatcher preserves the original guarded per-Account
command and fixes the regression (1/1,18.93seconds). Captured-scope and acceptance/cancellation
regressions also pass. Fresh literal host and Rust checks are running on that correction; no stack
setting or test exemption was introduced.

The third host attempt overlapped the full Rust crypto suite and exceeded existing Web graph and
IndexedDB test deadlines; later asynchronous failures followed those timed-out cases. The host gate
will be rerun unchanged after Rust finishes. Its timeouts are not waived or raised. The corrected
production WASM is regenerated and passes its normal smoke suite; JavaScript/declaration output is
unchanged. Independent review of the batch-unlock routing correction found no ownership,
cancellation, callback or teardown change.

The second Rust attempt passed 1,093 Core cases but exposed an unbounded wait in the existing
Vault-image lifecycle test. Its isolated, bounded reproduction identifies Remove returning before
image retirement because `Runtime::new()` supplies unavailable PlatformStorage. Remove must read
durable retirement intent before cleanup; that production ordering remains intact. The test now
uses consistent empty storage, real in-memory SQLite artifact cleanup and exact host responses,
requires Remove/Wipe to report complete cleanup, and bounds both the retirement signal and final
join. Independent simplification/review accepted the fixture correction. Both full gates will run
sequentially on the final tree.

The corrected bounded Vault-image test passes 1/1 in 0.01 seconds. The unchanged sequential host
gate now passes in full (`/tmp/bittery104-check-ci-fourth.log`), including 484 Runtime-host tests,
540 Web tests, all38 joined Chromium cases/574 assertions and the actual Import hook. No timeout
setting was changed. The final literal Rust gate now runs alone on this same production tree.

Final closure: literal `pnpm check:ci:rust` passes (`/tmp/bittery104-check-ci-rust-third.log`):
Server formatting/Clippy/check, 152 crypto tests and 11 vectors, 51 binding tests and five generated
contract tests, all 1,094 Core tests, artifact/conformance/Server contract suites, generator tests,
all checked-in contract and native/Web binding comparisons, and Desktop formatting/Clippy plus
60 tests. Both prior regressions pass in the full suite. Production Web smoke passes 11 tests with
its intentional feature-only skip. The Desktop generated comparison used the documented disposable
Git index; the real index was not changed. Independent simplification/review, the final 66-case
Attachment regression, actual nonempty binary acceptance and both literal full gates are complete.
This resolves the Server/transport prerequisite; ticket90 still owns cross-Account orchestration
and its actual full transfer acceptance.
