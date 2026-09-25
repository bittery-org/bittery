# 107 — Runtime recipient provisioning and Key rotation

Type: task
Status: ready-for-agent
Blocked by: 100, 105
Spec: ../recipient-provisioning-and-rotation.md

## Problem and frontier

101's actual recipient-sharing acceptance needs more than authenticated Team transport. The
existing Web Invitation and Add-Member callers use `core.vaultCrypto` backed by legacy unlock
material. `use-vault-key-rotation.ts` also reads `storage.getMasterUnlockKey`/`getVaultKeys`, writes
legacy wrapped keys and refreshes a legacy VaultRepository through legacy Account resolution.
Runtime Sign-in deliberately populates none of those owners.105 restores the first Team read path;
it cannot establish provisioning, Rotation or the entire Teams browser matrix.

Resolve and independently review the concrete shared-Core foreground workflow that replaces this
complete private-key, authenticated request and convergence closure. Preserve existing Server
Rotation plans/outcomes under29, mandatory exact-key verification under100/101, current RSA/AES
and persisted formats, current roles/entitlements and user-visible cancellation/ambiguity behavior.
Use existing Core Session, live key, foreground lifetime, Replica/Sync and retained-result owners.
Do not export credentials/private keys, insert a generic crypto or authenticated transport proxy,
or restore a legacy store merely to satisfy a transitional caller.

## Required scope to map before readiness

- Invitation composer reads, create/cancel/resend, and authenticated current-User invitation
  list/accept/decline; distinguish the existing public token preview/accept/signup routes.
- Existing-User Invitation Vault-key provisioning and Add-Member: Core must obtain current Vault
  authority and enforce the verified recipient key before producing or submitting wrappers.
- Vault/member/access reads and role changes needed by the actual gestures.
- Vault-member removal, Team-member removal and Team departure Rotation: exact existing start and
  finalize Operation identities/outcomes, closed preparation kinds and staged payloads, private
  re-encryption/wrapping, current-authority publication and fresh convergence after uncertainty.
- Interactive recipient verification, Lock/Account/caller loss, changed recipients, permission
  changes, partial staging, lost replies and cancellation at the actual private/HTTP boundaries.
  Specify whether each step continues, retires or remains uncertain using the existing owners.
- Executable caller closure, generated Rust-owned request/results, meaningful Core regressions
  and actual new/existing-recipient, Add-Member and all removal/leave browser scenarios. Existing
  invitation resend/cancel and standalone-Account pending-invitation cases must remain covered.

Keep101's existing enforcement throughout.102's proposed authenticated invitation/trust-directory
protocol is separate and is not authorized by this migration. Mark107 ready only after the
foreground workflow, acceptance mapping and dependencies are concrete and independently reviewed.
Both full CI commands and independent implementation review/simplification are required for closure.

## Comments

2026-09-24 bounded private Team-leave cleanup retirement correction: authorized
best-effort plan abandonment now uses a separate cancellation attached to the
existing foreground registration. Caller loss alone still permits cleanup;
Account Lock and Runtime close cancel and drain an in-flight DELETE before
retirement completes. Actual held-DELETE-then-public-Lock and held-DELETE-then-close
regressions failed on the previous Core source and pass with the correction.
Eight other private controls, seven finalization/Lock controls, one zero-plan
control and two preflight controls pass; Rust formatting and strict Core Clippy
pass. The v37 browser success remains historical prior-source evidence. Joined
WASM/full CI, other 107 callers and whole-phase acceptance remain open.

2026-09-24 bounded private Team-leave cleanup correction: after the last staged output,
an unsuccessful live Member read or changed role now reaches the same best-effort plan
abandon path as an earlier staging failure. Cleanup requires the current unlocked Account,
incarnation and exact staged Session; a pending Lock/retirement prevents another HTTP request.
The consumed selection remains consumed. Once the durable finalize commit is attempted,
cleanup sends no DELETE because its result may be uncertain. A frozen-plan
test changed a remaining Member's live role after two successful stages and passed its
authorized-abandon assertion after failing on the previous Core source. Eight private,
seven finalization/Lock, one zero-plan and two preflight Core controls pass, with Rust formatting
and strict Core Clippy. The pending-Lock-intent control exercises that exact guard; an earlier
spawned private Lock test timed out before observing intent, with cause unproved and its failure
retained in the private evidence. The real Web success run in the prior v37 receipt predates
this cleanup-only correction and is not final-source browser evidence. Fresh independent review,
joined CI, other 107 callers and whole-phase acceptance remain open.

2026-09-24 bounded private Team-leave correction: Core now checks the authenticated, paginated
current Vault Member IDs and roles, including the initiating Member's Vault role, against the
bound Rotation plan before each new private staged output. A changed permission or Member set
retires that consumed foreground attempt without accepting a finalize Operation; the existing
immutable plan, verified recipient keys, Account lifetime and Server finalize checks remain.
Six focused private Core cases pass, including held-stage role change, paginated Member changes,
exact staged bytes, caller loss and lost finalize reply; zero-plan and preflight controls pass.
A fresh real Web worker/IndexedDB/Server Team-leave run also passes through the actual dialog and
product recovery panel: the original Operation survives same-Account/User renewal, two private
outputs are staged, fresh versioned Sync converges, and the remaining owner reads the Item before
scoped cleanup. The private evidence receipt is
`/tmp/bittery-runtime-orchestration.7hGO37/rotation107-live-authority-v37/final-handoff-receipt.json`.
Other Rotation intents, the full caller/browser matrix, independent review and both full CI
commands remain open; ticket 107 is not complete.

2026-09-24 bounded private Rotation frontier: dependencies 100 and 105 are resolved and this
ticket is ready-for-agent. Extend the existing voluntary Team-leave intent first, with one
nonempty authoritative plan for a populated shared Vault, a remaining owner, and an Item whose
readability is proved independently after departure. Preparation returns the exact immutable
plan/member candidates; Core requires each remaining Member's exact 101 approval, consumes the
prepared selection before private work, and stages all closed Member, Item, and Attachment kinds
with their original contexts. Finalize retains per-plan results and atomically fences only the
affected Vaults; exact replay and a new version-capable Bootstrap plus complete catch-up must
prove current authority or departed-Vault absence before release. Exercise the migrated actual
Web Team-leave gesture through the worker, IndexedDB and Server, including same-User Session
renewal, lost/held replies, restart and selective availability, while preserving zero-plan,
Invitation and Add-Member controls. This is a bounded implementation path within the accepted
specification, not a decision to omit the other two intents or their required caller matrix.

2026-09-24 bounded Add-Member implementation: the Web Add Member dialog now obtains
available/current members through closed Runtime reads and submits a fixed Core command. Core
requires the exact locally verified User/key, rechecks the candidate and current managed Team
Vault authority after the human prompt, seals the current Vault key privately and sends the
existing non-idempotent Server PUT once. Lost replies produce an uncertain result without a
retry or inferred ciphertext proof from member presence. Focused Core tests cover refusals,
Lock/Account/caller loss, renewal and lost reply. A real worker/IndexedDB/Server browser path
verified the recipient's own Core fingerprint, rejected a wrong input before any PUT, then
accepted the exact key, added one member and decrypted a real shared Item as that recipient.
The disposable Vault and accounts were removed through closed Core/public routes. This is a
bounded implementation checkpoint, not ticket completion: Invitation provisioning, role and
access variants, Rotation, removals, Team departure, independent review and full CI remain.

2026-09-23 bounded Add-Member frontier: migrate the actual Web Add Member gesture through
closed Runtime available/current Vault-member reads and one fixed Add-Member command. The
available read supplies the candidate User ID, public key and display label for independent
101 verification. After the human prompt, Core re-reads the available User/key, current
managed Team Vault authority and its own exact wrapper, checks the stored 101 approval for
that exact User/key, unwraps the current Vault key and seals it inside Core, then sends the
existing Server PUT once. The host supplies only Account/Vault/User and a closed non-owner
role. The existing Server remains final entitlement and role authority. A confirmed PUT may
publish success; a lost reply remains typed uncertain. Current member identity/role and Sync
can guide reconciliation but cannot prove the exact submitted ciphertext, so Core never
blindly retries or infers success from list presence. The small end-to-end acceptance is the
migrated Web gesture followed by the recipient reading a real Item in the shared Vault.
This slice leaves role PATCH, remaining access reads, Rotation and removal/leave closure open.

2026-09-23 bounded real acceptance frontier: exercise the already implemented public
zero-plan Team-leave Runtime path through the Web worker, IndexedDB, fetch, and a real Server.
The fixture must create a fresh owner through public signup and a fresh member through the
actual Invitation/signup flow; ordinary signup creates a separate Team. Grant the new member
no shared Vault, require the Server's start result to return an empty plan set, and verify its
personal Vault survives departure. Add only the three closed generated-contract TypeScript
facade calls for prepare, complete, and inspect. Preserve exact start/finalize Operation and
Account identities across real Session revocation by using public same-User renewal, then
require fresh opted-in Bootstrap/catch-up before confirmed completion. After the normal path
passes, exercise a lost finalize response by allowing Server commit and dropping its response,
if the same fixture supports it. This slice leaves private nonempty Rotation, Web Team-leave
caller migration, the full browser matrix, and ticket closure open. Dependencies 100 and 105
are complete and this ticket is ready-for-agent.

2026-09-23 bounded public zero-plan acceptance: the three closed typed TypeScript facade
commands now call the Rust-generated Rotation contract. The browser fixture signs up a new
Organization Team owner through the public Team-plan flow, activates only the established
billing fixture columns, and signs up a distinct Member through the actual Invitation. The
Member has a personal Vault but no shared Vault. A real Web worker, IndexedDB and Server
return an empty start plan set, then finalize with exactly `{planIds:[]}` and zero rotations.
The Server revokes the departing Member's Session. Lock and Quick Unlock renew the same
Runtime Account/User/incarnation; retained start/finalize identities converge through
`InspectRotation`. The public personal Team and Vault survive. The accepted result requires
an opted-in version-marked full Bootstrap page and a later successful Catch-up in the
network snapshot captured when inspection returns `rotationCompleted`.

Both fresh browser cases pass on the final source. In the lost-reply case the fixture forwards
the original finalize request once, captures the Server's applied response, then drops only
that reply. Before renewal, Core retains the original `finalizing` attempt and no finalize
receipt. After renewal it replays the same Team, empty plan set and finalize Operation ID,
retains the applied receipt, and completes only after fresh Sync. Both cases publicly delete
their disposable owner and Member. The focused facade test passes 24 cases/64 assertions;
canonical Web types and changed-TypeScript formatting pass. The source and logs are pinned in
`/tmp/bittery-runtime-orchestration.7hGO37/rotation107-real-zero-plan-acceptance-manifest.json`.
This acceptance does not exercise nonempty private-key Rotation, migrate the Web Team-leave
caller, cover the full removal matrix, or close ticket 107.

2026-09-23 bounded correction for the v9 exact-layout gate: `assertStoreLayouts` now validates
the exact index-name set after the existing key-path, auto-increment and required `by_account`
checks. `heads` must have no indexes; every other Replica store must have only `by_account`.
This closes the reviewed P2 where an extra index passed `assertLegacySchema`. The migration
regression seeds both Accounts across every v9 store, including recognizable head and
`replica_metadata` values, then adds an extra index to an ordinary `operations` store and to
`heads`. Both v10 attempts are refused with the existing `STORAGE_UNAVAILABLE/unavailable`
classification; the reopened databases remain at version 9 with the original store and index
layouts and all seeded rows, and without `rotation_attempts`. The exact-v9 successful upgrade
and existing rollback cases continue to pass.

The captured behavioral RED had five existing migration cases pass and failed the new
regression because the malformed upgrade resolved. Final focused checks pass: six migration
tests/45 assertions, 27 executor tests/120 assertions, seven legacy migration tests/120
assertions, Biome on both changed TypeScript files, and `@bittery/client-runtime` type checking.
The source and command logs are pinned in
`/tmp/bittery-runtime-orchestration.7hGO37/rotation107-exact-v9-layout-root-verified-manifest.json`,
SHA-256 `622129863b9c786f9e7d3845f867f2bb4964f47d5bcbd8ab419e864bc8e40444`. This bounded
correction does not close ticket 107 or the phase.

2026-09-23 bounded implementation increment: complete the public Rust Runtime
`PrepareRotation`/`CompleteRotation` path for voluntary Team leave when the Server's
authoritative start result has zero plans. Preparation must force a new opted-in,
version-capable full Bootstrap and catch-up before accepting the retained start Operation;
it returns the exact Account/epoch-bound empty-plan selection only after the start
receipt and attempt commit. The accepted start Operation and its `starting` attempt
atomically retain the original proved preflight generation before HTTP; a lost reply,
reopen, or later unrelated Bootstrap cannot substitute a new generation for that
selection. Completion consumes that selection durably before any
private work, atomically accepts the exact empty-plan finalize Operation and attempt
fence, resolves its retained outcome, then forces a new opted-in full Bootstrap and
catch-up before publishing confirmed departure or a typed terminal rejection.
Ambiguous transport preserves exact replay and retained retry; failed refresh keeps
the attempt's retry duty. Any nonempty plan remains authoritative and must refuse
private completion until the full staged crypto path is implemented. This increment
does not close 107, migrate the Web callers, or claim the nonempty Rotation matrix.
The closed `InspectRotation {accountId,startOperationId}` continuation is necessary
after `CompleteRotation` consumes its selection: a lost caller or restart cannot
replay that selection to ask whether finalize committed. Inspection only reads the
Account's retained start attempt, exact finalize Operation/receipt and refresh duty,
then drives those existing owners; it accepts no host-selected plans, outcome or
alternate scheduler identity. `PrepareRotation` may likewise resume an accepted
start by its retained start Operation ID rather than minting another request.
An inspected `consumed` attempt with no accepted finalize reports that orphan; it
cannot mint a finalize request after the foreground owner vanished. A new start ID
and fresh plans are required. Inspection drives dispatch only for an already
accepted `finalizing` Operation and refresh only for a retained terminal receipt.
The same `RotationAttempt` persistence owner requires the Web IndexedDB Replica
executor to map its new physical store. The additive v9-to-v10 schema upgrade
must preserve every existing row and metadata field, accept only the exact known
v9 layout, and round-trip Rotation attempt rows across reopen. This is storage
support for the shared Rust wire, not a Web Rotation caller migration or a new
workflow owner.

2026-09-23 the first Invitation tranche is reviewed and integrated. Core owns the bounded
composer lease, exact-recipient verification, private wrapper preparation, send/cancel/resend,
authenticated current-User list/accept/decline and typed uncertain outcomes. The Web callers use
those closed commands; native one-time tokens remain opaque SecretString values. The Server
adds the specified exact-Accept opt-in Vault keyVersion and empty-page capability marker while
preserving ordinary bootstrap responses. Core's generated DTO accepts the optional fields but
does not yet request or use their version evidence; Rotation preflight remains unimplemented.

Independent Sol Spec and Luna Standards reviews pass the frozen Invitation/Server slice and
the final four-file generated-contract delta. Two optional earlier standards observations
(an empty Team-ID sentinel for the current-User route and repeated foreground setup) remain
recorded without blocking this slice. The final 47-file patch has SHA-256
`34a08c31b1c203e35a105ce01b67aa56498704f65b082e568683eb0bf158fdc0` and matches all integrated
file hashes. `/tmp/bittery107-joined-final-source.manifest.json`, SHA-256
`f16dbc3503bd391f4dee5f9deaf2e8d4ea1fc048168a789a5a1de875155ee8ca`, pins the source and logs.
Core all-target compilation, native generation, Server/Runtime/native/Web binding drift checks,
Rust formatting and Web types pass in the isolate. Focused Chromium cases pass for new-recipient
signup, admin resend/cancel, and current-User pending list/rejected acceptance/decline. Those
browser runs precede the final additive generated-DTO join; successful existing-User acceptance
and the complete Teams matrix are not claimed. Combined-main checks are next.

Rotation, Add-Member, Vault/member/access reads and role changes, removals and Team departure
still need their complete Core/Replica/Sync and caller closure. The next accepted path is forced
version-capable Bootstrap and full catch-up before any Rotation start, followed by retained
start/attempt ownership. Both full CI gates and whole107 acceptance remain required;101 and
the separate102 protocol frontier are unchanged.

2026-09-23 marked ready-for-agent after105 resolves with independent implementation review and
both full CI gates. Dependency100 is already resolved. The independently accepted focused
contract now has all prerequisites complete; implementation may begin with the smallest
Invitation path before broadening to provisioning and retained Rotation workflows. No107
implementation or browser acceptance is claimed by this readiness change, and102 remains separate.

2026-09-23 final independent Sol frontier review accepts the decision-complete contract after
the selectivity correction. The existing Sync, foreground lifetime and Replica journal owners
support the specified extensions; no further concrete source contradiction was found. Opt-in
compatibility, empty-page capability evidence, exact continuation/Operation identity, fresh
post-terminal catch-up and valid fallback behavior remain explicit acceptance requirements.
Coordinating review concurs. Status stays `needs-triage` until 105 closes as required above;
this is specification acceptance, not implementation, security-proof or browser acceptance.

2026-09-23 coordinating selectivity correction: current `MarkRefreshRequiredPlan` blocks all
Account mutations, so it cannot be the persistent owner of a selective Rotation refresh duty.
The draft now uses the existing guarded forced bootstrap from `Ready` and exact-generation
abandon/fallback behavior. The attempt retains its durable affected-Vault fence and retry duty.
Unrelated reads remain available; existing full bootstrap still temporarily pauses ordinary
Account mutations. A valid fallback restores their eligibility after failure without clearing
another authority refresh or replacing a newer generation. Independent re-review remains open.

2026-09-23 second independent frontier-review follow-up: release of a Rotation fence now
requires an additive, opt-in authenticated bootstrap Vault `keyVersion` on the existing route.
The exact closed `Accept` value and opt-in page marker (including empty Vault pages) preserve
old Server/default response and old strict Core compatibility; missing versions in old Server
responses or durable rows remain unknown. A
version-capable complete Sync preflight refuses before a Rotation start on an incompatible
Server. Terminal applied/rejected outcomes force a new full bootstrap even if Ready/empty-delta;
promotion alone cannot release the selective fence because pinned Sync cursors do not snapshot
Vault rows. Full catch-up and current version/authority checks, including a concurrent newer
rotation, are required. This is planning only; status remains `needs-triage` pending independent
re-review and 105 closure.

2026-09-23 independent frontier-review follow-up: the draft now specifies an explicit
post-response Invitation lease release from the Web dialog owner, bounded fallback expiry,
atomic start receipt-plus-plan and finalize Operation-plus-fence Replica commits, a durable
selective affected-Vault fence, authoritative Sync `keyVersion` as its release proof, and real
Team targets for empty-plan Operations. Rotation recovery follows the existing unbounded
dispatcher schedule with lookup as a hint before exact replay. These are required extensions to
existing owners, not implemented behavior. Independent re-review and 105 closure still gate
`ready-for-agent`; status remains `needs-triage`.

2026-09-23 source-derived frontier draft: [recipient provisioning and Key rotation](../recipient-provisioning-and-rotation.md)
maps the closed actions, Account/recipient/plan continuation, one-time Invitation-token
ambiguity, six retained Rotation Operation identities, exact staged-ciphertext replay,
unavailable-until-refresh publication, and acceptance/dependency groups. The draft now binds
the first Invitation response in a typed Core foreground lease and names Replica's Operation
record and Rotation attempt checkpoint; those extensions still need independent review.
Status stays `needs-triage`; this is not implementation authorization or 101 acceptance.

2026-09-23 source audit identifies the continuation and convergence decisions to preserve. The
current Invitation gesture first sends without wrappers, then verifies the returned existing User
and key, cancels that Invitation and sends its replacement with wrappers. Decision100 permits the
first unprovisioned Invitation to remain pending after cancelled verification. A Core migration
must account for each already-issued request and ambiguous reply; rerunning the complete gesture
is not an established idempotent retry. Add-Member wraps the current Vault key and submits through
the existing `PUT` route. These are complete semantic actions, not host-supplied wrapper uploads.

The current Rotation adapter replays start/finalize once with the same idempotency key after a
transport or retryable failure. Its ceremony processes closed Member, Item and Attachment pages,
uses verified other-Member keys and the current User's MUK wrapper, and abandons unfinished plans.
After successful finalize, local key/cache invalidation precedes authoritative refresh; refresh
failure is a distinct committed-but-unavailable outcome. The new Core path must preserve these
private lifetime and convergence boundaries using existing Runtime owners. The concrete prompt
continuation and ambiguous-finalize mapping still require the independent frontier review above;
this audit does not mark the ticket ready.

2026-09-22 coordinating source review extracted this missing capability from78's residual Web
scope. All cited callers are present in `apps/web/src/components/teams/invite-dialog.tsx`,
`apps/web/src/components/vaults/add-member-dialog.tsx`, `apps/web/src/hooks/use-vault-key-rotation.ts`
and `apps/web/src/lib/vault-key-rotation-adapter.ts`. This records required work; it does not claim
implementation readiness or repair of101's production acceptance.
