# Runtime Extension passkey ceremonies

Type: task
Status: ready-for-agent
Blocked by: 74, 95
Spec: ../desktop-extension/passkeys.md

## Contract

Move existing ES256 credential creation/assertion, matching, private-key lifetime and counter reservation into shared Core. Reserve durably before assertion disclosure, including read-only Vault authentication; synchronize writable usage through ordinary Operations separately. Browser hosts supply authenticated context facts and render Core selections through74's closed routing. Preserve existing persisted credential and attestation formats and connected Desktop authority.

## Acceptance

Real page create/assert/cancel, Account/Vault matching, prompt closure and lock, repeated/restarted Operations, durable local counter and separate usage convergence, and no private key in broker/popup. Cover failed/ambiguous local commits, read-only authentication, actual SQLite/IndexedDB restart/recovery and74's exact-document browser matrix. Keep existing vectors and generate closed request/result bindings. The focused spec defines the complete ceremony, lifetime and acceptance contract; no global ordering across offline Devices is claimed.

## Comments

2026-09-09: independent74/75 interface review simplified the fresh browser-facts primitive to the
already authenticated exact-document isolated-content Port. The existing trusted entry owns native
getters, activation generation and single-use probe correlation in one private closure; injected
functions are not expected to read that closure and no second facts registry is added. Browser
sender identity is checked at receive-side registration; fresh private responses and final page
generation guards cover navigation/BFCache/connection loss. The coordinating and independent
capability reviews accepted this bounded mapping; actual forged-page/nested-frame/lifetime Chrome
acceptance remains required. Status is unchanged while the combined contracts finish review.

2026-09-08: dependency-ordered delivery scope recorded. No implementation or acceptance is claimed.

2026-09-09 actual caller audit during Desktop capability work: Extension's1225-line
`background/passkey-handlers.ts` still owns ES256 key generation/signing, matching, suspect status,
creation target selection and usage updates. `computeNextSignCount` uses an unscoped in-memory map
keyed only by credential ID and takes max(stored+1, local+1, epoch seconds). Assertion persistence
errors are logged and the successful assertion is still returned; Cancel only records an event.
These are actual remaining owners, not Runtime integration or reliable counter/cancellation evidence.

Core's current shared `Passkey` persisted payload includes private_key, and ordinary Login Item
projections reuse that shape. A dedicated ceremony alone therefore cannot establish the required
absence of private keys from the broker/popup. Seal a shared public Item/passkey projection and
edit-preservation contract, including existing Web/Desktop editing, Import and scoped Export, before
cutover. Preserve encrypted credential payload/attestation/algorithm formats while moving private
material and matching/signing policy into Core. Browser-origin facts must come from the authenticated
content connection; a page-provided string or an unbound popup choice is not authority.

Required remaining frontier: durable counter/result ordering across concurrent assertions, failed
local writes, cancellation after acceptance, owner loss and conflict/current-authority convergence.
The migration must explicitly reconcile existing best-effort persistence with Runtime durability;
no implementation or ready status is claimed from this inventory. Real page create/assert/fallback,
prompt cancellation, connected lock and Chrome owner-loss acceptance remain77.

2026-09-09 focused [capability mapping](../desktop-extension/passkeys.md) records actual ES256,
matching, RP/browser-context, UV, cancellation and multi-Account/native authority behavior, plus the
shared public Item prerequisite. Web `.bttrx` Export currently consumes ordinary projections;
Bittery Import preserves full payloads. Redaction must preserve those explicit transfer paths and
lossless ordinary edits/removal. Share intentionally excludes passkeys in both shared types and
Core's allow-list; preserve that exclusion.

The maintainer is being asked one precise remaining decision: require a durable local
Account/credential counter reservation before signature disclosure, failing when that reservation
cannot commit, while preserving readable read-only Vault authentication and synchronizing writable
usage/status separately through ordinary Operations. This changes the legacy successful-assertion
behavior when usage persistence fails. Status is `needs-info`; the reservation contract and ticket
refinement remain conditional on that answer. No Extension implementation or readiness is claimed.

2026-09-09 maintainer decision: require durable local counter reservation before returning an
assertion. A failed local commit fails the ceremony. Preserve authentication from readable read-only
Vaults; synchronize writable Item usage separately through the existing durable Operations owner.
Committed counts survive restart and are never reused within their retained local lifetime; this
provides no global ordering across offline Devices. The product choice is resolved. Ticket75 returns
to `needs-triage` for its exact Replica/recovery/lifecycle shape, shared public projection and lossless
edit/Import/Export prerequisite, generated ceremony contract and dependency refinement. Desktop73 and
offscreen74 still precede Extension implementation; no readiness or production acceptance is claimed.

2026-09-09: the accepted decision now has a proposed concrete
[Replica lifecycle and recovery shape](../desktop-extension/passkeys.md#reviewed-concrete-reservation-lifecycle).
Private signing precedes one guarded floor/desired-usage commit and final live-context disclosure;
failed or ambiguous persistence disposes the result. The existing Replica owns a Device-key-protected
digest/count row and optional head inventory commitment; no private credential or global index owner
is added. Read-only authentication commits the local floor without an Item write. Writable desired
usage coalesces on that row until the existing dispatcher can admit an ordinary current-authority
Update; exact accepted IDs and covered revisions prevent duplicate requests and stale completion.
Terminal rejection cannot regenerate unchanged usage from an authority change alone.

Hidden retirement erases target/usage associations and every ordinary private read surface, retaining
only the indispensable opaque protected floor and independently accepted encrypted work. Recovery
authenticates available floor coverage, carries digest/count only inside the encrypted archive,
retags under the destination's existing DeviceKey and max-merges proven available floors. Missing
expected current evidence cannot be replaced by a lower archive count and called complete. The
retained head detects expected-row loss, not wholesale coherent rollback of all historical evidence.
Account removal/Wipe ends that local floor lifetime; no unrequested cross-Account registry survives.
Same-identity full Sign-in after sign-out is not removal: its existing guarded Replica replacement
must preserve floor rows and inventory. Stable canonical Account-bound floor AAD avoids rewrapping
on access-incarnation changes; the existing Replica guard still fences the active generation.
Failed and lost-reply replacement histories are required acceptance.

The [shared public Item prerequisite](../desktop-extension/passkeys.md#shared-prerequisite-before-desktop-cutover)
must land before Desktop caller cutover independently of74/75. It covers private/public draft
separation, current-identity/version edits, exact credential removal, the actual Desktop Duplicate
action and scoped full-fidelity Import/Export. Initial Export preserves stored counters;75 later
extends that same owner with local floors, avoiding a Desktop/Extension dependency cycle. Ticket
number and dependency edits await coordinating review. These are proposed implementation shapes
under the accepted behavior, not new product decisions or readiness;75 remains needs-triage.

2026-09-09: independent review traced the proposed floor/usage and public/private surfaces against
actual Replica head transforms, guarded installation/read-back, recovery coverage and publication,
Item admission and Web archive owners. Private sign → guarded floor commit → live-scope disclosure,
shared duplicate-credential floors, read-only assertion, same-identity replacement preservation and
hidden usage erasure fit those existing owners; no separate scheduler, journal or key owner is needed.
Root accepted three concrete routine refinements now recorded in the spec: witnessed missing floor
evidence cannot yield an apparently complete `.bttrx` export; Item/credential removal, replacement
and Move retire obsolete usage associations without deleting floors or accepted requests; and the
existing recovery proof carries closed floor coverage separate from immutable accepted rows and
rebuildable authority, validating source inventory before portable retag/max-merge. Exact existing
archive/Account/accepted-work gates remain. Required histories are explicit; no implementation,
real-browser evidence, new product decision or readiness/status change is claimed by this review.

2026-09-09: the [closed ceremony/context draft](../desktop-extension/passkeys.md#closed-ceremony-controls-and-caller-lifetime)
now records Begin/Continue/Cancel, private registration acceptance, existing assertion reservation,
Core-issued prompt selections, deadline/connection/document retirement and one-shot final delivery.
The existing page handler's hardcoded iframe `crossOrigin:false`, supplied hash/origin and incomplete
RP suffix check are recorded as context defects, not protected persisted formats. Root accepted
authenticated isolated-document browser facts under existing permissions, Core full-registry RP
authorization, accurate client data built from frozen challenge/context, and existing trustworthy
localhost development without a remote HTTP/IP bypass. Pinned Chromium116 source proves ancestor
and effective-policy mechanisms; official Chrome123 evidence identifies the later authorized
cross-origin Create capability. Keep successful browser-authorized frames; do not bypass denied or
unprovable browser context or claim full WebAuthn conformance. The exact real-page matrix and
limitations are recorded. No implementation/build ran;75 remains in triage for independent concrete
control/routing review, with74/95 dependencies unchanged.

2026-09-09 coordinating source review accepted the closed browser-context/ceremony direction and
TOTP prerequisite separation. The actual suspect-status failure path is now distinguished from
successful assertion reservation: retain its scoped best-effort ordinary Update admission, with no
new floor or retry queue on a failed signature. Failed counter persistence does not fabricate a
signing-error annotation. The concrete74 trusted-routing contract and independent control review
still precede75 readiness; no Extension implementation has started.

2026-09-09 final independent and coordinating reviews sealed the complete counter/usage/recovery,
private/public prerequisite and closed ceremony/browser-fact contract against reviewed74 routing.
The accepted durable local reservation decision is implementation-ready, including failed-commit
ceremony failure and preservation of read-only authentication. No unresolved product or architecture
choice remains in this slice. Ticket75 is `ready-for-agent` with incomplete74/95 dependencies;
Desktop acceptance73 still precedes Extension implementation. Actual Chrome116/current-browser
ceremonies, native lock authority and physical persistence acceptance remain required, not inferred
from this review. Forty local spec links/anchors and the dependency graph passed validation.
