# Evolutionary Rust runtime decision map

Label: `wayfinder:map`
Charted: 2026-08-22
Baseline: `legacy-v0.5.2` (`f021c85e1d3a9d3f3418ba67a9ff04f319987903`)

## Destination

A decision-complete migration path from the existing client architecture to one shared Rust runtime
and Sync implementation. Existing Server, Web, Desktop, and Extension behavior remains available
through the migration. Android follows as a native Compose host reusing the existing Kotlin platform
modules, then iOS follows as a native SwiftUI host.

The map is done when a specification author can define verified vertical implementation slices
without inferring runtime ownership, transaction semantics, host responsibilities, binding behavior,
or rollout order.

## Notes

Latest continuation: [Desktop/Extension handoff, 2026-09-09](handoff-2026-09-09-desktop-extension.md).
It records current unaccepted work, approved decisions, evidence and remaining checks.

### Standing constraints

- The active product baseline is `legacy-v0.5.2`; the `greenfield` branch is decision history and
  evidence rather than an implementation base.
- The existing Server and product surfaces evolve in place. There is no clean-room rewrite.
- Current SRP, KDF, encryption algorithms, key hierarchy, persisted cryptographic formats, and
  compatible Rust crypto behavior remain unchanged. Structural improvements must preserve behavior
  and pass existing and added vectors.
- There is no user compatibility period. Server schemas, OpenAPI, Sync contracts, and clients change
  together without parallel v1/v2 routes or a permanent dual stack.
- Delivery order is existing Server/Web/Desktop/Extension, Android Compose, then iOS SwiftUI.
- The external Rust runtime seam is designed once for all hosts. Platform adapters may differ; Domain
  and Sync behavior may not be reimplemented per host.

### Greenfield disposition

- Carry forward the semantic core of guarded Account-atomic Replica commits, durable local Operations,
  Account-lifetime idempotent outcomes, per-Account transaction Sync, staged Bootstrap, SSE as a hint,
  honest browser durability, closed provider access, and opaque local indexes.
- Adapt those decisions to the existing Account, Session, Vault, Item, ciphertext, key, and Server
  model. Remove dependencies on Account signatures, signed Item revisions, replacement envelopes,
  Device request signatures, and the replacement key hierarchy.
- Supersede the resolved OPAQUE/Argon2id, AES-GCM-SIV, HPKE, Ed25519 Account-key, replacement Recovery,
  signed Device, epoch rotation, and replacement quick-unlock decisions. The Greenfield
  `cryptographic-format.md` does not govern this effort.
- Retain Greenfield platform research and current-state verification as evidence.

## Decisions so far

- [Duplicate-only unpublished cache](desktop-extension/profile-handoff.md#duplicate-only-unpublished-cache-frontier):
  ticket91 may consume one nonactive generation only after exact raw equality to validated active
  records, explicit matching Account scope and unambiguous physical-key ownership. Unique evidence
  keeps its source; no new persistence owner or authority is inferred. The producer cut and bounded
  admission implementation are reviewed and integrated, with all 138 combined SQLite admission tests
  passing. Unique unpublished evidence and physical acceptance remain separate requirements.
- [Profile delivery allocation](desktop-extension/profile-handoff.md#delivery-allocation):91 owns
  shared Core and Desktop admission before66; [106](issues/106-extension-profile-admission.md)
  owns Chrome source primitives after73 and before74.73/77 retain actual application upgrades and
  owner-loss acceptance. This removes a scope dependency cycle without waiving any host evidence.
- [Web Team read ownership](web-team-recipient-runtime.md): the real Runtime Sign-in → Team-page
  failure is fixed, and [105](issues/105-web-team-recipient-runtime-operations.md) is resolved
  after independent review, real browser acceptance and both full CI gates. The complete recipient/Rotation caller audit also found legacy
  private-key and cache dependencies; [107](issues/107-runtime-recipient-provisioning-and-rotation.md)
  must implement its independently reviewed foreground workflow after105 before101's joined
  acceptance can close. The [contract](recipient-provisioning-and-rotation.md) keeps private
  provisioning, retained Rotation identities and fresh authority in the existing Core owners.

- [Durable Attachment upload renewal](issues/103-durable-attachment-upload-renewal.md): extend the
  existing reservation owner with fixed global file identity, exact ciphertext signing, renewable
  grants and retained cleanup duties after expiry/parent deletion. A committed cleanup attempt fences
  renewal after ambiguous external deletion. [Delivery104](issues/104-durable-attachment-upload-renewal.md)
  is resolved after independent review, ordinary/durable route regressions, actual nonempty
  upload/renewal/registration/download acceptance and both full CI checks. Ticket90 retains the
  cross-Account orchestration and full transfer acceptance.

- [Recipient key verification](issues/100-recipient-key-verification-policy.md): mandatory out-of-band
  verification of existing RSA recipient keys, retained locally by shared Core; no first-use trust.
  [Implementation101](issues/101-runtime-recipient-key-verification.md) covers existing sharing,
  Invitation provisioning and rotation callers under the [focused contract](recipient-key-verification.md).

- [Passkey counter ordering](issues/75-runtime-extension-passkeys.md): Core durably reserves a local
  counter before assertion disclosure, fails the ceremony if that commit fails, preserves read-only
  Vault authentication and synchronizes writable usage separately. This provides no global ordering
  across offline Devices. The reviewed capability is ready with incomplete74/95 dependencies;
  actual implementation and production acceptance remain outstanding.
- [Existing profile handoff](issues/82-existing-profile-runtime-handoff.md): one shared Core admission
  preserves exact legacy credentials, preferences and accepted work. Supported launch routes must
  converge on the new gated installation and every legacy writer must exit before capture; a new lease
  alone cannot fence old binaries. One existing-catalog lifecycle stages all Accounts and commits the
  profile together. Research and ticket91's concrete journal/inventory review are resolved;91's
  dependencies are complete and implementation begins. Platform/populated-profile acceptance remains.

- [Retained results/current authority](issues/88-retained-work-current-authority.md): exact replay
  proves the original action independently of current visibility. Reuse the existing receipt plus
  RefreshRequired, preserving newer authority; Bootstrap validates fresh visible data before publication.
  No duplicate completion checkpoint or host retry owner is added.

- [Connected Extension reads](issues/79-connected-extension-item-read-authority.md): render the
  Extension Runtime Replica and pending Operations. Desktop supplies Account/lock state and key
  authorization; Desktop changes arrive through Server convergence.

- [Native transfer](issues/64-runtime-native-transfer-contract.md): preserve Extension-local
  Operations through generation-bound export/import implemented once in shared Core; broker and
  native transport own no key policy and Desktop retains lock authority.
- [Temporary legacy native encoding](issues/96-legacy-native-compatibility-boundary.md): until
  Extension cutover76, the same Core native source owns the existing protocol1 private payloads
  and local biometric release. Delivery97 replaces legacy Desktop decryption and fences the old
  Extension's transport/material handoff, with no fabricated protocol2 destination or second owner.
- [Legacy native status projection](issues/97-runtime-legacy-native-compatibility.md#comments):
  protocol1 status projects Core67's existing Activity selection and Account timeout through the
  guarded native source. Unknown selection reports timeout0; removed selection uses Core67's
  ten-minute fallback; held revision/catalog change refuses stale status. A failed Replica Account
  is omitted without hiding an unrelated eligible Account, and a held failure transition refuses
  stale status. The corrected bounded path passes focused Core and unchanged old-consumer checks;
  fresh independent review, production theme forwarding66 and the remaining97 gates stay open.
- [Legacy native local access](issues/97-runtime-legacy-native-compatibility.md#comments):
  the headless source reports Core67 hardware with no inferred UI Active Account. An explicit
  single-Account request binds the validated Extension origin and current Account to Core67's
  retained-Session ceremony and source-guarded protocol1 wrapping. Single and one-prompt All
  final encoding reuse Core67's current re-entry and local Session deadlines, preserving the
  correlated single failure and All per-Account partial results when a deadline elapses. The
  bounded held Core and actual host/old-consumer checks pass; fresh review, remaining97,
  production66 and hardware73 remain open.
- [Legacy native event and material lifetime](issues/97-runtime-legacy-native-compatibility.md#comments):
  the opt-in native source delivers protocol1 events through current Core
  authority. The Extension Account lifetime covers native delivery and local
  authentication, restore, activation and password Unlock All. C1 cleanup also
  closes the shared local Vault projection, including direct Sign out and
  per-Account failure cleanup, and originating authentication
  reconciliation retains its captured publication. Focused source,
  host, old-consumer, Extension and shared Core checks, dependent types, format
  and the populated Lock trace pass. Independent review, joined CI and ticket97's
  remaining acceptance still gate integration.
- [Hidden Vault work](issues/65-hidden-vault-durable-work-contract.md): erase hidden Vault keys,
  authority, projections and unneeded files while retaining only inaccessible encrypted accepted-work
  evidence and indispensable artifacts until authoritative reconciliation.
- [Desktop placement](issues/61-desktop-runtime-placement.md): one Runtime in the Tauri Rust
  process, shared Core and SQLite, thin generated renderer bridge and Runtime-owned native
  projections. Maintainer acceptance explicitly requires no duplicated code; ADR 0010 is amended.
- [Extension acceptance scope](issues/62-extension-browser-acceptance-scope.md): Chrome 116+
  production acceptance under ticket 41; Firefox and Safari remain unimplemented roadmap hosts.
- [Desktop/Extension inventory](issues/60-desktop-extension-ownership-inventory.md): both hosts
  retain transitional ownership. Actual feature/caller matrices distinguish missing Core capability
  from absent host UI and identify remaining Web/Mobile callers that prevent shared deletion.

- [Replica recovery](browser-replica-recovery.md): protected Account-scoped export includes all
  required locally retained work and files, excludes credentials, and remains available while locked.
  Maintenance pauses the Runtime; guarded repair and explicit re-Bootstrap preserve proved accepted
  work. Chromium and Firefox recovery acceptance passed. Unknown state stays explicit, with no
  automatic reset and unchanged explicit Remove/Wipe.

- [Web deployment](issues/39-web-sqlite-deployment-decision.md): retain IndexedDB and existing
  headers/browser support; the maintainer explicitly declined conditional SQLite ticket 40.
- [Extension placement](issues/41-extension-runtime-placement-decision.md): the future Chrome 116+
  cutover uses one combined Worker in an offscreen document with IndexedDB and a service-worker
  broker. Broker recycle reattaches; actual owner loss requires unlock. Desktop lock authority
  remains intact; Firefox/Safari remain roadmap document hosts pending real-host acceptance.

- [Web SQLite feasibility](web-sqlite-prototype-verdict.md): official OPFS passes the exact corpus
  and first-slice scenario in Chromium/Firefox, but real Safari/iOS and deployment gates remain
  unmet; the Rust SAH-pool candidate fails simultaneous-tab ownership. Prototypes were captured
  and removed; ticket 39 owns the production decision.

- [Rotation outcomes](issues/29-rotation-operation-outcomes.md#accepted-decision): six distinct
  creation/finalization kinds retain original non-secret plan snapshots or rotation results, with
  closed per-kind rejections; incomplete staging requires a new finalization Operation after repair.

- [Persistence evolution](issues/38-replica-persistence-evolution.md): blocked/failed Web upgrades
  expose storage-unavailable with explicit retry; versionchange closes stale connections and failed
  migrations preserve the old database.
- [Conformance reproducibility](issues/59-bootstrap-write-order-nondeterminism.md): canonicalize
  generated histories by store/key only; physical migrations do not depend on write ordering.

- [ADR 0014](../../docs/adr/0014-evolve-the-existing-product-around-a-shared-rust-runtime.md): evolve
  the existing product around one shared Rust runtime, preserve current cryptographic behavior, change
  Server and clients together in place, then deliver Android and iOS in that order.
- [First existing-application slice](issues/01-first-existing-app-slice.md): Web begins with Sign-in in
  Rust, which owns the unchanged SRP ceremony, Session creation and renewal, Account persistence,
  bootstrap, offline Replica reads, durable Login-Item creation, retry, exactly-once Server effect,
  and authoritative reconciliation for one active Account and one personal Vault.
- [Web Runtime placement](issues/02-web-runtime-placement.md): Web crypto and the Rust Runtime share
  one process-wide Worker so existing opaque key handles remain valid and durable work is independent
  from React lifecycle.
- [ClientRuntime interface shape](issues/03-clientruntime-interface-shape.md): one closed typed
  `request`/`observe`/`close` protocol carries explicit Account-scoped commands and projections across
  Web and later native bindings; host adapters add ergonomics but no behavior.
- [Replica transaction ownership](issues/04-replica-transaction-ownership.md): Rust owns logical
  Replica policy and closed guarded commit plans; IndexedDB and SQLite adapters execute them
  atomically without reimplementing Domain or Sync behavior.
- [Operation outcome retention](issues/05-operation-outcome-retention.md): the Server retains each
  successful or terminal semantic outcome until Account deletion, independent of elapsed time,
  offline duration, or Sync-event retention.
- [Network ownership](issues/06-network-ownership.md): Rust owns request construction, immutable
  request bytes, retry, outcome interpretation, and Session creation and renewal; host transport
  adapters execute HTTP and SSE without owning authentication state.
- [First-slice Sync feed](issues/07-first-slice-sync-feed.md): retain the current bounded Bootstrap,
  event-plus-authoritative-fetch, opaque Cursor, and SSE-wakeup contract while adding atomic semantic
  Operation outcomes.
- [Runtime Account ownership](issues/08-runtime-account-ownership.md): one process-wide Runtime owns
  the Device Account catalog and scheduling while isolated internal Account modules own their Replicas,
  keys, Operations, and failures; Active account remains UI-only.
- [Transient Operation retry](issues/09-transient-operation-retry.md): an accepted Operation retries
  automatically without a fixed attempt limit, using bounded backoff, until an authoritative semantic
  outcome or removal of the Account from the Device ends local ownership.
- [Accepted Operation discard](issues/10-accepted-operation-discard.md): the first Runtime offers no
  per-Operation discard after durable acceptance; Device Account removal is separate and does not
  claim to cancel or reverse any Server effect.
- [Cross-host binding feasibility](issues/11-cross-host-binding-feasibility.md): extend the existing
  Web crypto Worker, use generated UniFFI bindings for native hosts, keep keys and native SQLite
  inside Rust, and gate production expansion on one focused compile/binding spike.
- [First-slice Replica contract](issues/12-first-slice-replica-contract.md): one revision- and
  incarnation-guarded logical Replica atomically owns encrypted authority, optimistic overlays,
  durable Operations, outcomes, Bootstrap generations, and Cursor across IndexedDB and SQLite.
- [Server Operation outcome contract](issues/13-server-operation-outcome-contract.md): one
  transaction-scoped domain Operation commits a retained User-scoped semantic outcome with its Item
  effect or proved rejection, audit, and Sync records; response-cache idempotency is replaced in place.
- [Runtime module and first-slice sequence](issues/14-runtime-module-and-first-slice-sequence.md): a
  deep Rust client core plus shallow generated bindings proceeds through binding, protocol, Web
  persistence, Sign-in, Bootstrap, Server outcome, offline create, and Web cutover gates.
- [Binding compile spike](issues/15-binding-compile-spike.md): native Kotlin/Swift retain UniFFI
  0.31.2, while Web uses a thin explicit `wasm-bindgen` adapter because UniFFI's experimental
  single-threaded WASM async foreign callback has a concrete `Send`-future mismatch.
- [Browser Replica engine](issues/33-browser-replica-engine.md): keep IndexedDB for Web and the
  Extension during the current migration, use Rust SQLite on native hosts, and preserve SQLite/OPFS
  as a later Web prototype plus a separate Extension-placement frontier rather than a universal
  requirement.
- [Empty Vault Bootstrap authority](issues/35-empty-vault-bootstrap.md): keep one bounded Bootstrap
  feed, but make it explicitly two-phase: cursor-paginated standalone Vault summaries and wrapped
  keys first, then cursor-paginated Items under the same pinned watermark and promotion boundary.
- [Final Web Item and Import frontier](issues/28-remaining-item-write-kinds.md#final-web-item-and-import-frontier):
  the shared Runtime owns all five Item categories, durable Vault creation, bounded durable image
  ingress/staging, and one durable Operation per Import batch. Tickets 49–56 delivered the
  foundations and create-Vault cutover. Tickets 57–58 finish Import and Web consumers; both cutovers
  require executable whole-repository caller graphs.
- [Account removal, Wipe, and Server deletion](issues/48-runtime-account-removal-and-wipe.md):
  Runtime owns explicit local teardown and authenticated deletion transport. Web retains the
  confirmed Server-first deletion gesture and its durable exact-retry marker. Local incomplete
  teardown cannot report success or infer another Account.

## Current delivery state

Ticket delivery validated the accumulated worktree; ticket notes record its targeted evidence. The earlier documentation review used `87386201` on 2026-09-07. Historical handoffs describe
earlier sessions; current tickets govern remaining work. Ticket acceptance used an explicit full-CI
waiver; the later publication checks are recorded below.

- First Web acceptance and its blockers (15–27, 31–32, 35–37) are resolved under the
  [first-slice specification](spec.md). Attachment/lifecycle corrections (43–48) and the final
  category/Vault/Import foundations (49–56) are resolved.
- [57 — Import cutover](issues/57-import-atomic-cutover.md) is resolved after independent review,
  eight provider browser cases, and 135 joined Worker/Core assertions including existing-Vault,
  later-batch rejection, and multi-Account coverage. Targeted checks passed; full CI was waived.
- [58 — final Web host cutover](issues/58-final-web-host-cutover.md) and its parent
  [28](issues/28-remaining-item-write-kinds.md) are resolved. Independent reviews and simplification
  passes, 37 distinct production browser cases, 28 ownership-graph tests, dependent types, and
  affected generation/formatting checks passed. Full CI was waived and not run.
- [29 — Rotation outcomes](issues/29-rotation-operation-outcomes.md) is resolved: all six routes use
  retained semantic outcomes and the zero-caller response-cache cleanup is complete. Independent
  reviews and targeted checks passed; ticket 48's Account-deletion replay protocol remains intact.
- [30 — live Sync](issues/30-runtime-owned-live-sync.md) is resolved after independent review and
  simplification. Seven production Sync scenarios, three affected restart/offline paths, 157 joined
  Worker/Core assertions, and targeted Core/Server/type/generation checks passed across targeted
  runs. Full CI was waived and not run.
- [42 — Replica recovery](issues/42-browser-replica-recovery.md) is resolved after independent
  review and simplification. Chromium/Firefox recovery cases and existing durability, Attachment
  Move and Sync regressions passed across targeted runs; [validation and limits](browser-replica-recovery.md#validation-and-limits)
  distinguish real browser loss from injected faults. Full CI was waived and not run.
- [38 — persistence evolution](issues/38-replica-persistence-evolution.md) is resolved with independent
  review and targeted validation: populated v5/v6 IndexedDB upgrades, blocked/versionchange handling,
  versioned SQLite migrations, and visible storage-unavailable retry. Full CI was waived for this run.
- [59 — conformance reproducibility](issues/59-bootstrap-write-order-nondeterminism.md) is resolved
  after independent review: generator-only canonicalization is stable across fresh processes,
  and shared Bootstrap/Import histories exercise multi-Item prepared writes.

## Completion checks for this run

After each ticket, a delegated simplification pass examines the complete change for duplicated
logic, unnecessary state or wrappers, and useful shared code for later hosts. Implement worthwhile
reductions while preserving accepted behavior, architecture, and coverage; avoid speculative
abstractions. An independent subagent reviews the result, followed by the affected targeted checks.
Record the result briefly in the ticket before closing it.

The newly requested pass also applies to tickets already resolved during this run. Tickets 28, 29,
30, 34, 38, 39, 40, 41, 42, 57, 58, and 59 completed the pass and independent review. All 59 tickets
are closed: 58 resolved and conditional ticket 40 explicitly declined (`wontfix`). Historical ticket
notes retain the full-CI waiver that applied when those tickets were accepted.

## Publication checks

2026-09-08: after ticket acceptance, the user requested full checks before commit, push and a draft
PR. This later publication gate supplements the targeted evidence and preserves the historical
waiver notes above.

- `pnpm check:ci` passed locally: 14 package tasks, 445 host tests, 27 root script tests and all
  nine Chromium test files.
- `pnpm check:ci:rust` passed locally, including 728 Core tests, 151 crypto tests and 10 vectors,
  generated contracts and native/Web bindings, and 50 Desktop tests.
- The full Server suite exposed a stale Move after Attachment Rename. The
  [ticket 28 follow-up](issues/28-remaining-item-write-kinds.md#publication-check-follow-up)
  records the parent Item revision correction and the matching-Authority Sync race found by browser
  acceptance. Exact foreground convergence preserves all guards and makes no additional write.
  The complete Server suite passed (544 library and 2 binary tests), as did Server formatting,
  Clippy and compilation. Final Chromium Attachment UI and durable Attachment Move acceptance
  passed (2/2).

Full-check fixture alignment covers explicit transport failures, valid shared-key ciphertext and
current host contracts while retaining authority, durability and cancellation assertions. These are
local command results; the hosted CI matrix has not been run for this publication.

## Remaining frontiers

The original 59 tickets are complete. The Desktop/Extension production migration requested on
2026-09-08 is now tracked separately; historical Web acceptance does not establish host integration.

- [63 — native foundation](issues/63-desktop-native-runtime-foundation.md): resolved with native
  SQLite/keychain/HTTP assembly, generated renderer bridge, actual native Server sign-in/process
  restart and independent review. The plugin remains inactive; real Tauri smoke uses the existing
  composition. Neither result establishes Desktop production migration acceptance.
- Native transfer and hidden-Vault accepted-work decisions (64/65) are resolved; native transfer68
  and protected-image93 capabilities now pass their phase gates. Incoming Travel71 and application
  production acceptance remain outstanding.
- [79 — connected Extension reads](issues/79-connected-extension-item-read-authority.md) is resolved:
  the Extension renders its own Runtime Replica; source snapshots retire with their last caller.

### Delivery dependencies

105 is resolved after100 and restores Team-page reads without a Session export.
107 retains recipient provisioning, Rotation and their complete private/transport/convergence
closure. Its frontier review is accepted and it is ready with both prerequisites complete.
Its first bounded Add-Member path now passes Core controls and a real recipient Item-read
browser acceptance; remaining 107 callers and full phase gates are still open.
101 now waits for107's implementation and complete browser acceptance.
106 retains Extension-specific admission after
91 and73;74 now waits for106 as well as73.106's detailed implementation readiness remains open.

[99 — connected selective Travel](issues/99-connected-native-selective-travel-policy.md) is resolved
after independent review of the [shared Core contract](desktop-extension/native-travel-policy.md).
The existing channel carries bounded acknowledged restrictions; the consumer’s existing retirement
journal owns erasure, while nonexpanding continuation preserves unrelated local access and Operations.
Independent Accounts preserve their own credential provenance. Desktop hard Lock/EOF remains
Account-wide. This seals71’s connected variant; production integration and acceptance remain open.

[73 — Desktop acceptance](issues/73-desktop-production-acceptance.md) has a
[concrete twelve-row matrix](desktop-extension/desktop-acceptance.md): full behavior/variants on
actual Linux Tauri, critical all-category and Account/restart/teardown histories on packaged
macOS/Windows, and every platform-specific path. Required hardware evidence is not waived; the
actual existing Extension97 avoids a dependency on migrated76.73 is ready after independent review;
incomplete72 still blocks execution. No production acceptance is claimed.

[98 — Extension page-feature/caller boundary](issues/98-extension-page-feature-and-caller-boundary.md)
is resolved. Its [sealed76 contract](desktop-extension/extension-cutover.md) maps47 background routes
plus popup Fill, ephemeral same-tab capture handoff, closed autofill/TOTP delivery and existing
Core activity/native ownership.76 is ready with incomplete dependencies after independent review;
the single visible timeout setting retains its actual selected-Account persistence and Device-wide effect.

[74 — Extension composition](issues/74-extension-offscreen-runtime-composition.md) is ready after
independent review of its generated routing, authenticated browser roles and single-owner lifetime.
Desktop acceptance73 still blocks implementation. Its explicit production-asset assembly fixture
does not replace77's unmodified release-package acceptance or prove broker/Worker loss behavior.

[75 — passkey ceremonies](issues/75-runtime-extension-passkeys.md) is ready with incomplete74
dependencies after independent counter/recovery and browser-context review. The sole Core owns
private signing, local reservation and separate ordinary usage Operations; actual physical-storage
and Chrome ceremony acceptance remain required.

[97 — legacy native compatibility](issues/97-runtime-legacy-native-compatibility.md) is ready under
resolved96, is unblocked after95 and precedes Desktop activation66. It preserves
the actual old Extension until76 through one guarded Core native source and transport lifetime;
neither a private renderer projection nor a second Desktop credential owner is permitted.
The prior bounded native/Extension implementation passed independent review and is integrated.
An isolated release-package Chromium run now passes the actual worker, native host and Core private
read, retained local Operation through reconnect, Server effect, Core Lock and wrong-challenge
refusal. Independent review of this packaged path, joined full CI and97's remaining matrix still
gate completion; Linux does not establish supported-OS hardware73.
The fresh shared-Member ReadOnly slice now also passes a Server-synced private Login through the
feature-enabled native host, guarded Core socket, unchanged old snapshot decoder and key-material
hydration, with an unshared recipient control and scoped fixture deletion. Its focused evidence
awaits independent review and the same remaining gates.

[66 — Desktop activation](issues/66-desktop-first-runtime-path.md) and
[72 — gesture acceptance/cleanup](issues/72-desktop-complete-production-caller-cutover.md) are ready
after independent review of their complete caller, native, private Item, TOTP and profile boundaries.
Incomplete capabilities still block implementation.66 switches only after every reachable caller
is prepared;72 adds exhaustive variants and removes proven unused Desktop modules.

[95 — private credentials and public Item commands](issues/95-private-credentials-and-public-item-commands.md)
is resolved after independent review, real credential/browser acceptance and both full CI gates.
Its implementation preserves ordinary edits, exact
credential removal, Desktop Duplicate and private Import/Export while removing private passkeys from
routine Core projections. It precedes Desktop activation; Extension ceremonies consume it later,
without a dependency from Desktop to74/75. The accepted durable local counter lifecycle remains in75.

2026-09-09 completed capability baseline validation: literal `pnpm check:ci` passed on the
Desktop/native capability, protected-image and corrected retirement-dispatch changes, including fresh
generated Chromium bindings, all nine Chromium files,14 package test tasks and27 root script tests
(`/tmp/bittery-desktop-extension-progress-check-ci-10.log`). Production Web bindings also rebuilt
successfully (`/tmp/bittery-runtime-final-dispatch-bindings.log`). Literal `pnpm check:ci:rust`
attempt7 also passed (`/tmp/bittery-desktop-extension-progress-check-ci-rust-7.log`), including972
Core tests, generated contracts/bindings,192 Desktop library tests and60 native-host tests.
These full checks precede the ongoing71 policy, foreground settings, Export and connected-native changes;
those changes still require fresh full checks and their remaining acceptance variants.71 records the
later native sign-in stack correction and successful maintained incoming-Travel attempt6
(`/tmp/bittery-native-incoming-travel-runtime-sixth.log`, one actual case,2.6minutes total).
The three earlier Core failures were corrected fixture assumptions;93 records exact diagnostics,
default-suite opt-in limits and the disposable-index comparison. Capabilities68/70/93/94 are resolved.
Native transport cancellation and the unchanged70/93 four-process restart/image baseline pass;
their tickets record exact evidence. Independent closure review added70's missing incoming personal/
shared conversion history; its targeted verification and full Rust suite now pass. Incoming verified
Travel-policy integration belongs to71, whose dependencies include93; its unchanged real hidden-image
history is now a distinct maintained case beside the70/93 four-process image/recovery baseline.
That maintained case now passes real second-device Enable and proof-backed Disable, incoming Sync
policy verification, selected all-generation authority erasure, retained accepted ciphertext with
zero uploads while hidden, unrelated Move/Attachment progress, fresh-authority image restoration,
and final scoped public User deletion with HTTP200. This is the native Core/SQLite/keychain/Server
assembly case; connected two-owner native propagation, remaining71 foreground/Export variants and
fresh full checks are still open. It does not establish Desktop renderer or Chrome Extension
production migration; both production compositions still require their cutovers.
The maintained native foreground cases also pass actual Save/Enable and Disable socket loss before
and after Server execution, explicit fresh-password retry and unavailable current-policy reads.
Core preserves Uncertain/Unverified until a separate fresh read confirms current policy, with no
password-proof replay or login finish. Exact selection, fresh selected-authority restoration, the
four-process accepted-work/image baseline and mandatory scoped User deletion pass
(`/tmp/bittery-native-foreground-travel-before-and-after-first.log`,2/2;
`/tmp/bittery-native-foreground-travel-uncertain-first.log`,1/1). Actual invalid-password acceptance
also passes: real Server401, current-policy reconciliation and separate correct-password retry,
with no login finish and mandatory public User deletion
(`/tmp/bittery-native-foreground-travel-wrong-password-first.log`,1/1).71 retains further foreground,
retirement-overlap and Export lifetime variants plus fresh full checks; this native assembly
capability evidence does not activate Desktop or establish either application's production acceptance.

[89 — retained-result reconciliation](issues/89-retained-results-current-authority.md) is resolved after87
under [the reviewed contract](desktop-extension/retained-current-authority.md). It widens direct visible
Item reconciliation and adds one receipt-and-refresh fallback for unavailable authority, applied
Import and Create-Vault. Fresh-source full host CI, targeted Core/physical-adapter checks and independent review establish this
capability. Remaining70/71 convergence and actual application acceptance are still outstanding.

[87 — durable Vault retirement](issues/87-durable-vault-authority-retirement.md) records one guarded
all-generation purge, idempotent cleanup journal and minimal accepted-work category witness in its
[focused contract](desktop-extension/vault-retirement.md). This foundation preserves outcome validation
after overlay erasure and prevents stale Session writeback from reinstalling retired wrapped keys.
Actual Runtime erasure integrates it with 86 under 70/71 before production acceptance.

[86 — selective Vault capabilities](issues/86-selective-vault-capability-retirement.md) is resolved and extends the
existing native/browser file, image and foreground owners with exact Account/Vault retirement.
Its [contract](desktop-extension/selective-vault-capabilities.md) binds the actual Vault before
selection and claim, fences late grants, and requires fresh Core authority for re-admission.
The same Item or Attachment ID in another Vault remains independent. This foundation gates the
remaining 70/71 purge integration; it does not establish all-generation or Session-key erasure.

[85 — shared-Vault Item creation](issues/85-shared-vault-item-creation.md) is resolved as a Core
capability after closing an actual gap hidden by the first slice: Desktop creates all five categories
in writable shared Vaults, while Core rejected their Vault type and could not open RSA member keys. Its
[focused contract](desktop-extension/shared-vault-item-create.md) reuses the existing creator and
wrapped-key format, retaining role and Account guards. Capability delivery precedes 66/72; actual
Desktop/Server acceptance remains 73.

[84 — Account refresh](issues/84-runtime-desktop-account-refresh.md) is resolved as a Core capability and resolves the mounted Desktop
metadata and locked-Session validation frontier in [its focused contract](desktop-extension/account-refresh.md).
Core's existing driver owns the timed authenticated reads and exact-generation retirement;
Desktop startup cutover depends on this capability. Web behavior remains unchanged until migrated.

[66](issues/66-desktop-first-runtime-path.md) is the first-application gate, now correctly blocked
on its eagerly mounted capability/controller dependencies. [80](issues/80-shared-runtime-presentation.md)
is resolved with shared Web/Desktop presentation and real Web regression acceptance, without activating a second owner.
[67](issues/67-runtime-local-biometric-and-device-setup.md) is resolved as a Core capability;
[69](issues/69-desktop-native-binary-and-recovery-capabilities.md) is resolved after real native
file/Server/recovery acceptance and targeted checks. Native capabilities do not depend on renderer cutover, and capability closure does
not establish production UI or supported-OS acceptance. [70](issues/70-runtime-vault-update-and-delete.md) has its durable Vault
contract and is resolved as a capability after native acceptance and full checks. Other later tickets remain
`needs-triage` until their capability contracts/test mapping are sealed; a dependency list alone is
not readiness.

[71 — Travel mode](issues/71-runtime-travel-management-and-erasure.md) is resolved as a shared
Runtime capability after real Server settings and ambiguity/caller/process-loss histories, actual
native pending-Move and borrowed/independent restoration, joined Web Export acceptance, independent
simplification/review and both literal full CI commands. Desktop and Extension product migrations
remain in their application tickets.
[90 — cross-Account Move](issues/90-runtime-cross-account-item-move-workflow.md) is also resolved,
including its [durable upload prerequisite104](issues/104-durable-attachment-upload-renewal.md).
No-file and nonempty Attachment execution, permission and identity variants, both participant
fences, explicit Resume, retained outcomes and native Vault retirement pass. Actual native-process/
Server acceptance preserves the original ciphertext through a lost grant reply, process restart
and sweep, then finishes registration, source destruction and verified Download. All eight browser
artifact recovery histories, browser shutdown ordering, interrupted streams, current file changes
and a two-file cross-Server/shared-Member restart pass. Independent closure review and both literal
full CI commands pass on the final correction, including1,148 Core tests,194 Desktop tests,60
native-host tests and all11 Chromium suites; normal production bindings are verified. Full evidence
is recorded in90. The next unblocked capability is
[91 — existing-profile admission](issues/91-existing-profile-runtime-admission.md), starting with
the reviewed destination-inventory refusal and populated locked Desktop Account path.

- Desktop: [67 — local unlock/setup](issues/67-runtime-local-biometric-and-device-setup.md),
  [68 — native transfer](issues/68-runtime-native-transfer-and-desktop-messaging.md),
  [69 — files/recovery](issues/69-desktop-native-binary-and-recovery-capabilities.md),
  [70 — Vault writes](issues/70-runtime-vault-update-and-delete.md),
  [71 — Travel mode](issues/71-runtime-travel-management-and-erasure.md), then
  [72 — all callers](issues/72-desktop-complete-production-caller-cutover.md) and
  [73 — production acceptance](issues/73-desktop-production-acceptance.md).
- Extension, after Desktop acceptance: [74 — offscreen composition](issues/74-extension-offscreen-runtime-composition.md),
  [75 — passkeys](issues/75-runtime-extension-passkeys.md),
  [76 — all callers](issues/76-extension-production-caller-cutover.md), and
  [77 — production acceptance](issues/77-extension-production-acceptance.md).
- [78 — final cleanup/conformance](issues/78-cross-host-runtime-cleanup-and-conformance.md) removes
  shared transitional code only after the whole-repository graph proves no remaining caller.

[94 — populated Account deletion](issues/94-populated-account-deletion.md) records the real
Server500 found during native transfer acceptance. The [corrective contract](desktop-extension/account-deletion.md)
orders the existing owned-Vault cascade before User deletion in the same retained-result transaction;
it adds no deletion targets, route, authorization policy or host retry owner. The real Server regression
and populated native two-Account acceptance now pass, including scoped Server/local teardown;
parent phase CI now passes and closes94. Ticket68's native composition evidence does not
establish production Tauri or Chrome acceptance.

### Not yet specified

- [78's residual Web inventory](issues/78-cross-host-runtime-cleanup-and-conformance.md) includes
  same-profile tab authentication and Session coordination. A second tab's fresh Session can replace
  the first tab's Session for their shared client ID; per-context Runtime ownership and exact Session
  refusal are specified, but ordinary cross-tab handoff/refresh arbitration is not.107's independent
  browser-context acceptance does not establish this capability.
- [102 — authenticated invitations and Team key trust](issues/102-authenticated-invitations-and-team-key-trust.md)
  records the requested send-link/accept/confirm UX, signed Team directory and trusted-device transfer.
  First-contact authentication, signing authority, history freshness and recovery need a reviewed
  protocol before implementation. Existing mandatory verification under100/101 remains in force.

Desktop/Extension inventory and placement decisions are complete. These remaining capability
contracts need their detailed acceptance mapping before their delivery tickets become ready:

- [Native transfer control](desktop-extension/native-transfer.md) is sealed under ticket 68.
  [Extension passkey mapping](desktop-extension/passkeys.md) records the actual private/public
  surfaces and preservation prerequisites. The maintainer accepted durable local reservation before
  assertion disclosure, including read-only Vault authentication and local-commit failure;
  ticket75 is ready after closed ceremony and browser-control review, with incomplete74/95
  dependencies. Its local counter lifecycle/recovery contract is reviewed, and95 owns the shared
  projection prerequisite. Local access and native file contracts are
  specified and implementation is underway.
- [Cross-Account Item Move](issues/83-runtime-cross-account-item-move.md) is delivered in Core by
  [90](issues/90-runtime-cross-account-item-move-workflow.md), including explicit reauthorization/
  resume after re-adding the same destination Server/User. Desktop caller cutover remains separate.
- [Existing profile admission](issues/91-existing-profile-runtime-admission.md) has a reviewed catalog
  lifecycle, typed stopped-work mapping and source/reset primitive contract under resolved research82.
  Ticket91 is ready with complete dependencies. Native inventory, bounded source/credential reads and
  initial strict Desktop decoding pass their targeted checks and independent review. The
  [bounded manifest proof](desktop-extension/profile-handoff.md#bounded-manifest-verification-and-desktop-reopen)
  and durable Complete-marker preservation now pass focused checks and review. Preparing/resume and
  the first locked whole-profile commit pass public crash tests and isolated actual Linux
  credential/SQLite acceptance. Scoped cleanup/Complete, Reset crash recovery, retained encrypted cache
  and nonauthorizing partial-Session preservation now pass their bounded checks. Explicit Abort and
  its guarded deletion pass restart tests; disabled/enabled Travel policy without pending work and
  normal Create, Update, metadata/lifecycle and same-Account Move paths pass focused checks and
  independent review. Recovery checks immutable overlay evidence and either-Vault Move retirement;
  normal retry history/deadlines and departed claims are preserved. First stopped Create retains
  inactive work without an overlay, with fresh outcome proof, backoff and scope fencing; newer
  same-Item work survives completion. All 79 public admission cases, twelve held runtime tests,
  existing dispatch/Sync regressions and strict Core lint pass with review. The browser timer
  preserves long deadlines with cancellable bounded waits, proved by actual Chromium regression.
  The first cross-Account conversion passes 85 shared admission tests, original-child runtime
  convergence, domain/recovery checks, strict lint and independent review. Captured failed-Create
  cache preservation passes 92 shared admission tests, runtime/recovery checks and strict lint with
  review. It forces refresh while retaining source baseline evidence because the old producer can
  overwrite a confirmed cached Item, and preserves held readable evidence in read-only Vaults.
  All exact-base ordinary
  holds now pass 103 shared admission tests, durable/recovery checks, real-crypto proof and
  coexistence tests, strict lint and independent review. Both literal CI gates pass on the same
  frozen checkpoint, including 1,247 Core tests, all generated/binding checks, actual Chromium and
  Desktop tests, without generated drift. Newer-cache held Update now passes 106 shared admission
  tests, 23 recovery tests, thirteen real-crypto Runtime tests and strict Core lint with review;
  the actual TypeScript conflict producer's awaited reconciliation and unchanged request are tested.
  Normal workflow scheduling history now passes 109 shared admission tests, seven workflow-domain
  tests, four workflow-recovery tests, three new public-scheduler Runtime tests and strict Core lint
  with independent review. The existing four workflow Runtime tests retain their passing path.
  Actual TypeScript queue and serializer oracles prove whole-workflow retries and original child IDs.
  Original-child proof recovery after remote progress now passes ten new real-crypto Runtime tests,
  eight existing regression tests and strict Core lint with review. Exact per-child proof, current
  authority, SQLite lost replies and source-free locked reopen are covered; actual TypeScript executor
  tests confirm child identities across lost replies. Durable baseline scope validation now rejects
  a foreign Server even for Cold evidence, with nine domain tests, 109 public admission tests and
  strict Core lint passing with independent review. The
  [first stopped workflow proof path](desktop-extension/profile-handoff.md#first-stopped-cross-account-proof-path)
  now passes 116 public admission tests, domain/Recovery and genuine-Server Runtime proof/lifecycle
  checks, normal regressions, generated bindings, dependent types and strict Core lint with review.
  Its public runner preserves held evidence while independent same-source work completes. The
  [first explicit held reauthorization path](desktop-extension/profile-handoff.md#first-stopped-work-destination-reauthorization)
  now passes 15 domain, seven Recovery and seven new Runtime tests, seven existing normal/Attachment
  Resume tests, all 116 public admission tests and strict Core lint with review. The
  [SourceTrash continuation](desktop-extension/profile-handoff.md#stopped-sourcetrash-destination-reauthorization)
  now passes both child shapes, genuine rejected/late-Applied proof refusals and domain/lint checks,
  with independent Spec and Standards review. The next
  [SourceDelete continuation](desktop-extension/profile-handoff.md#stopped-sourcedelete-destination-reauthorization)
  now passes both child shapes, domain and genuine rejection/completed-absence refusal cases with
  independent review and strict lint. The next
  [remote-completion reconciliation](desktop-extension/profile-handoff.md#stopped-remote-completion-reconciliation)
  passes four new Runtime cases, 23 domain tests, recovery/normal/Attachment regressions and strict
  lint with independent review, including actual lost completion reply and no Pending publication.
  The next [absent-target authorization](desktop-extension/profile-handoff.md#stopped-absent-target-destination-reauthorization)
  passes both holds, five evidence variants, held proof controls and strict lint. The next
  [completion after active-cache progress](desktop-extension/profile-handoff.md#stopped-completion-after-active-cache-progress)
  passes 25 domain tests, three real Sync/reopen cases, 14 existing Runtime regressions and strict
  lint with independent Spec and Standards review. The next
  [SourceDelete continuation from trashed cache](desktop-extension/profile-handoff.md#stopped-sourcedelete-continuation-from-a-trashed-active-cache)
  passes 30 domain tests, three actual Sync/lifecycle/reopen cases, completion-cache and 22 existing
  Recovery/Runtime regressions and strict lint with independent review. The next
  [completion before fixed Delete materialization](desktop-extension/profile-handoff.md#stopped-completion-before-the-fixed-delete-child-is-materialized)
  passes 32 domain tests, four new Runtime cases, 28 existing regressions and strict lint with
  independent review, including a final-read-only absence refusal and genuine wrong/Missing/Rejected
  proof controls. The next
  [full remote completion from earlier Item prefixes](desktop-extension/profile-handoff.md#stopped-full-remote-completion-from-an-earlier-item-prefix)
  passes 28 reauthorization domain tests, three new Runtime tests across five genuine fixtures,
  32 existing regressions and strict lint, with independent Standards and Spec review. The next
  [parked admission after source-cache removal](desktop-extension/profile-handoff.md#parked-admission-after-source-cache-removal-before-queue-acknowledgement)
  passes eleven Domain and five public tests, 197 Replica and 118 profile-admission regressions,
  all 134 existing cross-Account Runtime regressions, dependent types, generated/native drift checks
  and strict lint, with final Standards and Spec review. It preserves genuine Pending
  acknowledgement-crash work in the same owner, with normal source reservation and no fabricated
  authority, Attachment history or execution. The next
  [successful retry acknowledgement capture](desktop-extension/profile-handoff.md#parked-admission-after-a-successful-retry-and-source-cache-acknowledgement)
  passes fourteen Domain and six public tests, two actual producer cases, dependent types and
  strict lint, with final Standards and Spec review. It preserves reminted attempt and retry history
  in the same parked version-one entry under the original semantic identity. The next
  [exhausted-retry hold after independent deletion](desktop-extension/profile-handoff.md#held-admission-after-exhausted-acquisition-retries-and-independent-source-deletion)
  passes nineteen Domain and nine public tests, 187 other Replica and 116 other admission tests,
  three producer cases, dependent types and strict lint, with final Standards and Spec review.
  Actual five acquisition failures, fresh repository/queue restore, permanent-deletion Sync and
  maintained full refresh produce consistent Ready evidence. The inactive Failed hold preserves
  readable scopes, LegacyHeld precedence and every identity fence, while forbidding its own overlay
  or execution and permitting independent same-Item work. The next
  [first-attempt conflict with its independent copy](desktop-extension/profile-handoff.md#held-admission-after-a-first-attempt-conflict-and-independent-source-deletion)
  passes 23 Domain and ten public tests, 187 other Replica and 116 other admission tests, four real
  producer cases, dependent types and strict lint, with final Standards and Spec review. Genuine
  producer crypto proves the independently accepted copy remains readable after source-free unlock;
  its exact outcome lookup/Create dispatch leaves the original Conflicted0 hold unchanged. Historical
  copy provenance creates no additional ownership link; the original Move remains non-executable.
  The next [first-attempt semantic rejection after independent deletion](desktop-extension/profile-handoff.md#held-admission-after-a-first-attempt-semantic-rejection-and-independent-source-deletion)
  passes 26 Domain and eleven public tests, 187 other Replica and 116 other admission tests, five
  producer cases, dependent types and strict lint, with final Standards and Spec review. It preserves
  the actual Failed0 command, original request and zero-count inactive hold after source-free unlock;
  no rejection proof or original execution policy is added.
  The next [terminal holds after acquisition retries](desktop-extension/profile-handoff.md#held-admission-after-acquisition-retries-and-a-terminal-semantic-outcome)
  passes 28 Domain and thirteen public tests, 187 other Replica and 116 other admission tests,
  thirteen producer cases, dependent types and strict lint, with final Standards and Spec review.
  Actual Failed/Conflicted counts one through four retain reminted attempts and inactive holds;
  the genuine independent copy keeps its own normal request and deadline. Reconciliation-read
  retries and retained-deadline terminal failures remain distinct frontiers.
  The next [held reconciliation-read retries](desktop-extension/profile-handoff.md#held-admission-after-reconciliation-read-retries-without-attempt-replacement)
  has a sealed frontier for unchanged-attempt Conflicted counts one through four and exhausted
  Failed5, using actual executor conflict and reconciliation-read failures. Normal same-attempt
  acknowledgement requires a separate remote-progress predecessor and remains outside this slice.
  Broader Attachment/source-cache/authorization variants remain required frontiers. Both full-CI
  commands remain required before the phase completes.
  Isolated native fixtures
  pass public Wipe, original-password QuickUnlock and offline authoritative Item projection.
  A real Server lost-Create test also proves original outcome lookup and exact replay through
  isolated native admission, with scoped Account/profile/credential cleanup.
  Twelve actual Linux import and cleanup crash cuts are reviewed and pass with strict Desktop
  all-target Clippy. The earlier six platform-write, Replica Install, Account-checkpoint and
  committed-catalog cuts retain their separate assertions. Three added cuts stop after exact
  DesktopStore removal, protected Account SecretKey removal, and the final Committed/all-Absent
  cleanup receipt before Complete compaction; Resume refuses a second Replica Install. All twelve
  pass again after a fresh joined Core compile. The real locked SQLite fixture has a revision-zero
  head and zero rows, proving logical head/row continuity without a populated-profile or SQLite/WAL
  byte-equality claim.
  Ten separate whole-profile Wipe process cuts now pass. The initial Reset/Wiping catalog Set
  survives SIGKILL before acknowledgement and a fresh no-open retry completes the same scope and wipe
  ID through Wiped; real NativeFiles and protected/runtime deletion preserve near-miss and unrelated
  data. The DesktopStore deletion and receipt cuts hold around removal of `store.json`; recovery
  observes Store `AlreadyAbsent` and completes at Wiped revision four without a duplicate receipt.
  Four cuts hold around SyncStore deletion/receipt and Credentials deletion/receipt. They preserve the
  exact immutable source scope; SyncStore cuts retain legacy credentials and Runtime/host values,
  while credential cuts prove owned legacy selectors absent and preserve foreign and near-miss
  entries. The receipts reach revisions two and three; the Credentials receipt leaves Runtime and
  host cleanup unproved until retry completes at Wiped revision four. Three further cuts hold after
  actual DevicePlain and DeviceSecret Runtime DeletePrefix writes and the final Wiped catalog Set,
  each before Core acknowledgement. The deletion cuts observe Wiping revision three and retain the
  original immutable scope and wipe ID; DevicePlain deletion leaves the owned DeviceSecret value
  present, and DeviceSecret deletion leaves both owned Runtime values absent. Both preserve foreign
  near-miss keys and retry the original Wipe to Wiped revision four. Both prefix retries reacquire
  the exact durable scope through a fresh provider, then observe actual `AlreadyAbsent` results for
  all three previously receipted families through the acquired reset handle and original wipe ID,
  with no byte payload or repeated receipt. Their observer captures the ID from the successful
  initial Wiping revision-zero catalog Set and compares subsequent writes and the cut marker through
  held revision three and recovered revision four. The Wiped-write cut observes Wiped revision four
  with the same scope and ID, then recovers by normal Runtime open with zero
  profile-source requests and an unchanged Wiped tombstone. The exact seeded abandoned host file is
  proven absent before a reopened NativeFiles owner can recreate its directory. All 22 exact
  physical cases pass serially; the dangling-symlink absence regression, strict Desktop all-target
  Clippy and Rust formatting checks pass. The actual Replica and artifact SQLite owners remain
  empty, so this proves neither populated-profile recovery nor SQLite/WAL byte equality. Final source
  and raw-log hashes are recorded in the external evidence manifest named in
  [ticket91](issues/91-existing-profile-runtime-admission.md#comments), including the follow-up
  exact-scope retry observer evidence. The fixture retains the exact
  orphan `_secret_key` reference and proves it present before Credentials deletion, absent at both
  Credentials cuts and after retry. Provider-loss recovery, actual legacy-writer exit/exclusion,
  supported-startup and platform acceptance, remaining accepted-work and Extension variants, and
  both full-CI commands remain open; ticket91 is not complete.
  One further Linux process cut now holds after a genuinely populated SQLite Replica's
  `WipeDevice` commit and before Core receives the response. The same original Wipe scope and ID
  recover to `Reset/Wiped` revision four; ordinary open makes no legacy source request and leaves
  the Replica head and rows empty. This is logical SQLite recovery after process loss, not a
  power-loss or SQLite/WAL byte-equality claim. Populated Attachment/image artifacts, old-writer
  exclusion, production startup/cutover and supported macOS/Windows remain open under
  [ticket91](issues/91-existing-profile-runtime-admission.md#comments).
- [Travel configuration lifetime](issues/81-travel-command-lifetime.md) is resolved: foreground Core
  settings, current-policy reconciliation after an ambiguous disable response, and fresh password
  retry. Its detailed implementation/acceptance mapping remains; hidden accepted-work retention is settled.
- Vault update/delete has a durable contract in ticket70 and is capability-complete after native acceptance/full checks. Incoming type
  conversion follows current authority; actual inventories govern caller scope. Historical Web
  tickets establish no acceptance for these hosts.
- Final cross-host conformance and deletion of shared transitional modules after their last caller
  migrates.

## Out of scope

- Replacing current cryptographic algorithms or persisted cryptographic formats.
- Parallel public protocol versions or permanent dual stacks. The exclusive one-time existing-profile
  handoff in [82](issues/82-existing-profile-runtime-handoff.md) is required for Desktop/Extension cutover.
- Rebuilding existing product surfaces merely to adopt the runtime.
- Android work before the existing applications prove the runtime and Sync path.
- iOS work before Android proves the native host path.
