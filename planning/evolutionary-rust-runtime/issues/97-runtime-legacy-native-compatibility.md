# Runtime-owned legacy Extension native compatibility

Type: task
Status: ready-for-agent
Blocked by: 67, 68, 71, 95, 96
Spec: ../desktop-extension/native-legacy-compatibility.md

## Contract

Implement the reviewed protocol1 compatibility mapping in the existing Core native authority owner,
with source-only guarded response construction and final encoding. Preserve the existing generated
native wire and actual old Extension consumers until76. Reuse current Account/Session/Vault authority,
private Item reads and67 local biometric ceremony; never synthesize a protocol2 destination grant,
mirror Desktop credentials, decrypt in a host or expose this surface to renderer RuntimeRequest.

Keep current native launch-origin and OS-peer checks, bounded framing and connection cancellation.
Adapt the actual legacy native-host stdin/IPC loop so browser loss cancels a held request/prompt;
it currently blocks the next EOF read behind that await and queues responses without a bound.
Use one delivery generation in the existing old Extension transport/cache owners to reject a pending
reply or cache/material publication after Core-derived invalidation or port replacement. This is
transport lifetime, with no copied Account/Travel/Session or retry policy.
The same lifetime owns a bounded mutation lease covering nested material-setter/restore awaits;
retirement fences old and fresh acquisition, drains started writes, and waits for the existing C1
cleanup acknowledgement before admitting a successor. It does not hold network/Travel waits or
replace existing cleanup strength. Every clear-keys/native-loss/biometric path uses that one guard;
stale failure cleanup cannot erase a successor's material or wait on its own unreleased lease.
The old Extension retains its existing local owner until its own atomic cutover; its accepted work
is never moved into Desktop. Profile admission91 precedes production66 activation, rather than
creating a dependency from this capability to its consuming application.

## Acceptance

Begin with populated native SQLite/Core authority and the actual existing protocol1 decoders: exact
identity/optionality, current wrapped MUK/Device-key decoding, full five-category private Item payload,
read-only access and current-authority retirement. Then use the actual native binary/socket and old
Extension consumer for status/events, one/all biometric flow, Item reads and an Extension-local write,
including accepted local work retained through reconnect. Test held response/prompt loss against Lock,
hidden policy, Account replacement/removal, source port/owner loss and failed startup. Public renderer
projections and commands remain unable to obtain the privileged compatibility payload.

The focused spec's complete matrix, independent simplification/review, generated contracts, affected
host/crypto checks and both full CI commands gate completion. Actual Tauri activation remains66,
supported-OS production acceptance73, and removal of this temporary surface76. No capability double
alone establishes legacy Extension or supported-OS acceptance.

## Comments

2026-09-24 the bounded shared-Member ReadOnly path passes with a fresh Team owner and invited
Member created through the public Server flow. Before the Vault grant, the Member's real native
Core snapshot and wrapped-key reply omit the private Login and Vault key. After the owner's
verified-recipient ReadOnly grant, the same Member's Server-synced native Core publishes the exact
private Login and current team Vault role, name, type and icon. The feature-enabled native host,
authenticated socket, unchanged Extension snapshot decoder and existing Desktop key-material
hydration accept the corresponding private Item and RSA-wrapped Member key. Browser-served Web
bindings match the maintained build; scoped public deletion of both Users and the Vault succeeds.
This is focused acceptance evidence, with independent review, joined full CI, the rest of97's
matrix, production activation66 and supported-OS hardware73 still open.

2026-09-24 the bounded packaged existing-Extension path passes in an isolated Chromium profile.
The maintained MV3 service worker uses real native messaging and the feature-enabled native
host/Core source to read the exact populated private Login through its public route. An existing
Extension-local Item command keeps its Operation and Item identities through native reconnect and
cold worker restoration, then reaches the matching applied Server outcome. Core Lock retires the
worker's private read; a real native biometric response is refused by the unchanged decoder when
the current challenge differs. The release build checks that its worker module graph contains no
DOM-dependent preload path. Focused Extension tests, dependent types, edited Rust formatting and
strict feature-enabled Desktop Clippy pass. This bounded acceptance awaits independent review and
joined full CI; ticket97's remaining matrix, supported-OS hardware73, production activation66 and
Extension migration74 remain open.

2026-09-24 the bounded Extension cleanup correction closes the shared Account and Vault
projection when C1 retires Account material, including ownerless native cleanup and ordinary
Lock. A follow-up correction routes direct Sign out and per-Account failure cleanup through the
same admitted transport handoff, including incomplete C1 outcomes. Existing C1 cleanup
strength remains unchanged.
Login, Quick Unlock and password Unlock All carry their captured material publication
through local reconciliation; a later independent refresh can open a fresh delivery. Real
AccountStore, VaultRepository and ClientRuntime regressions cover completed and held local
opening, cleanup failure and successor admission. Focused checks pass; independent review,
joined CI, packaged Chromium, supported-OS hardware and ticket97's remaining matrix still
gate integration and completion.

2026-09-24 the bounded native and Extension material path uses the existing Core
source and local Account lifetime for protocol1 events, authentication, restore,
activation and password Unlock All. Account cleanup and refreshed unlocked state
now follow captured publication ownership. Focused native-source, host, old-consumer,
Extension and shared Core checks, dependent types, formatting and the populated
Lock trace pass. Fresh independent review, joined CI and ticket97's remaining
acceptance matrix gate integration and completion. Packaged Chromium, supported-OS
hardware and production activation remain open.

2026-09-23 the next bounded local-access frontier is the existing protocol1
`CHECK_BIOMETRIC_AVAILABLE` and explicit-`accountId` `BIOMETRIC_UNLOCK_REQUEST` through the
validated-origin Core source. The former reports the installed Core67 hardware availability and
`appRunning: true`; this headless native source has no UI Active Account, so its account-specific
`enabled` bit is false rather than inferred from catalog order or the last-active timestamp. An
absent single-request Account ID fails without a prompt. The explicit request must match the
authenticated launch origin's Extension ID, capture that exact current Account, and run Core67's
existing local ceremony with its retained usable Session, preference, re-entry, Travel and prompt
cancellation policy. Only a successful current ceremony may expose the existing Device-key wrapped
MUK, Device key, optional usable Session token and current visible wrapped Vault keys. Its Base64
`challenge:encrypted_session` correlation preserves protocol1 bytes but does not authenticate the
destination. Core's existing native source owns wrapping, guarded final encoding and temporary
secret disposal; a protocol2 `NativeImportChallenge` would invent a destination and is excluded.
The actual unchanged Extension decoder and real host/socket are the first RED/GREEN path. All-account
transfer follows only after that path passes. A controlled test BiometricPort is a primitive fixture,
not supported-OS hardware acceptance under73. This records a frontier, not request acceptance or
completion of97.

2026-09-23 the bounded `GET_DESKTOP_STATUS` frontier is resolved from Core67's existing
`Activity {account_id, incarnation, received_at_ms, revision }`, its Account-scoped stored
timeout, the guarded Core native source, and protocol1's existing unknown-timeout value `0`.
This request projects the captured Core activity selection; it does not select a UI Active
Account or start another timer. No selection reports unknown `0`. A current selected
incarnation reports its stored timeout, including Never (`-1`). If the selected incarnation
was removed or replaced, the existing Core67 ten-minute fallback (`600000`) protects other
unlocked Accounts. A policy read failure reports a present but locked/empty status with
unknown timeout `0`; a clock failure refuses the response because Core cannot supply the
wire's numeric timestamp. In neither case may unreadable state disclose unlocked authority.
After the async policy read, the source rechecks the exact activity revision, selected
incarnation, current catalog and unlocked eligibility at final encoding. Any change refuses
the stale response, so a new request can report the new selection. The timestamp comes from
Core's clock. The headless fixture omits optional theme; forwarding a production host theme
belongs to66. Source-open failure never falls back to legacy nativeView. This decision
authorizes only this bounded status path; the remaining97 gates stay open.

2026-09-23 this bounded status path now passes the actual feature-enabled native binary,
authenticated Core source socket and unchanged `NativeMessagingClient` /
`DesktopClient.getLockStatus` in a separate Bun process. The preserved old native host
failed the same populated real-Account tracer (one behavioral RED, exit101); the rebuilt
host passed it (one GREEN, exit0) with `available=true`, the exact eligible Account,
Core's numeric timestamp/default ten-minute timeout and no headless theme. Core's final
status suite passes five tests for Never, unknown/removed selection, unreadable policy/clock,
Lock, Activity revision and timeout change, removal/replacement, source peer loss and
Runtime close; a second source peer remains usable after the first closes. Seven existing
Core inactivity, nine legacy authority and ten held legacy authority regressions pass.
Default-off and feature-on host status routing each pass one test; actual host EOF passes
one. Strict Core/bindings and both Desktop composition all-target Clippy checks and Rust
formatting pass. The fixture never activates production66 or proves supported-OS73,
packaged Chromium, event/biometric delivery, Extension-local mutation, or the rest of97's
matrix; independent review and joined full CI remain required.

2026-09-23 the next bounded request frontier is `GET_DESKTOP_AUTH_TOKEN {accountId}` through
the default-off feature-enabled native host, validated-origin source attachment, and unchanged
old `DesktopClient.getAuthToken`/`hydrateDesktopAccountMaterial` consumer. Core will disclose only
the exact current Account's locally usable effective Session, selecting the existing borrowed or
independent authority and checking the injected-clock expiration policy again at final encoding.
The response preserves the existing protocol1 identity and optional numeric expiration/User fields.
Missing, expired, replaced or retired Session, Account/source loss and changed local access refuse
disclosure. This increment adds no refresh, token mirror, renderer RuntimeRequest, protocol2 grant,
or default production activation. The actual consumer tracer will start without a local token and
observe `storeAuthToken(token, accountId)` through the real host and populated fixture. No token
request acceptance is claimed by this frontier record; the remaining ticket97 matrix stays open.

2026-09-23 the bounded auth-token request passes the feature-enabled actual native host and
unchanged `DesktopClient.getAuthToken` / `hydrateDesktopAccountMaterial` path. The populated
real Account starts this tracer without an Extension-local token; its exact current token is
stored once under its exact Account ID. The old feature host produced the expected first-frame
behavioral RED on this tracer; the rebuilt host passes it. Core controls pass exact Account,
missing and expired Session refusal, held Session replacement and injected-clock expiry, Lock,
peer and Runtime close, removal and Account replacement. A borrowed destination with an effective
Session correctly refuses `attach_source_scoped`; this establishes the source ownership boundary,
not successful borrowed token disclosure. Default-off application-owner and feature-on Core-source
routing each pass. Existing actual Accounts, five-category/six-Item snapshot (sparse and rich
Login), and wrapped-key hydration regressions pass, as do strict Core and feature Desktop Clippy.
The browser wire and generated contracts did not change. This remains only the bounded token
increment: the remaining ticket97 matrix, full CI, production66 activation and supported-OS73
acceptance stay open.

2026-09-23 the accepted bounded request increment is `GET_DESKTOP_ACCOUNTS` through the existing
guarded Core native source encoder, the default-off feature-enabled native host route, and the
unchanged protocol1 `DesktopClient.getAccounts` / `DesktopSyncService` installation path. Core
publishes the current Device catalog's installed Account identities with the existing current
Account display metadata, including locked Accounts; `unlockedAccounts` contains only exact
Account IDs whose current Core local-read eligibility passes. This process has no UI Active-account
selection, so `activeAccount` is explicitly `null` and is never inferred from last-active history or
the legacy key-reference view. Preserve the existing `DesktopAccountEntry` fields, omission/null
rules, numeric timestamps, and exact Account IDs. The wire gains no `serverUrl` or
`insecureTransportConfirmed`; the actual old consumer supplies its configured Server URL and
`false`. Equal emails do not identify or retarget Accounts. Final encoding rechecks the source,
catalog membership/incarnation, current metadata identity, and unlocked eligibility against removal
or replacement. This increment adds no RuntimeRequest, renderer command, catalog owner, or default
production activation. Acceptance will exercise the actual native binary and old consumer converter
with the existing idempotent populated fixture, plus Core controls for locked/unlocked identity and
removed/replaced catalog authority. No request had passed when this frontier was recorded.

2026-09-23 this bounded account increment now passes the Core wire and held lock, peer-close,
Runtime-close, removal, and replacement controls; the feature-enabled actual native binary also
passes the populated fixture through the unchanged old `DesktopClient.getAccounts`,
`DesktopSyncService.syncAccountsFromDesktop`, and `desktopAccountToMetadata` path. The consumer
installs by exact Account ID, keeps a distinct same-email account, uses its configured Server URL
and `false` transport consent, and leaves headless `activeAccount` null. Default and feature-on
routing composition tests and strict Core/Desktop Clippy pass. The existing actual snapshot tracer
still passes all five categories across six Items (including sparse and rich Login), and wrapped
Vault-key acceptance still passes. This records only the bounded Account request; ticket97's other
acceptance gates remain open.

2026-09-23 the bounded wrapped-Vault-key slice is integrated after fresh independent Sol Spec
and Luna Standards reviews. Review caught an acceptance gap in the first fixture: its parsing
checks duplicated the hydration consumer. The correction calls the unchanged
`hydrateDesktopAccountMaterial` through the real old `DesktopClient` and `NativeMessagingClient`,
with controlled storage, status and biometric dependencies. It verifies that `storeVaultKeys`
receives the exact Account, current wrapped-key bytes and compatible metadata. The fixture supplies
an existing local token and controls session restore; this does not establish token or biometric
hydration. The real populated Account acceptance and strict feature-enabled Desktop all-target
Clippy pass after the correction. The preceding joined baseline also passes all five actual native
cases and strict lint with the thirteen-cut physical fixture present.

The one-file correction has SHA-256
`42226ea7c3ccce5b541f1ac5f6d87f6e40003d9bb87b7932f9241ac5e9a33d22`;
`/tmp/bittery97-ee40-hydration-correction.manifest`, SHA-256
`373c9406bf0e1954449d4e9830a6802f2abab2bdf471a4db8b210aad1f225e5f`, pins its source and
passing evidence. Coordinating verification matches all five correction artifacts and the six-file
cumulative freeze. Spec review reports no findings; Standards reports no hard violations, with an
optional shared authority-guard value deferred. Default production routing remains unchanged.
Shared-member Server proof, replaced-authority controls, other protocol1 requests, material-lifetime
and packaged-consumer acceptance, and both whole-phase CI commands still gate ticket97 completion.

2026-09-23 the joined `c6011b53` baseline passed focused private-wipe, injected-clock and
held Core Lock/EOF checks, a rebuilt feature-enabled native host, the real Account's old
Extension decoder/ES256 tracer, and actual host EOF/stdout-loss tests before new source edits.
The separately integrated `e941b7c8` baseline adds only named test-audit aliases for joined
strict Clippy. The next bounded fixture imports all five categories through the existing public
Runtime/Server path, retaining the sparse signing Login and adding a rich Login for optional
field coverage. The actual old decoder rejected the seeded TOTP at `category-totp` because Core
serialized `Authenticator`; the closed Core protocol1 formatter now emits the old `totp` name.
The actual binary, authenticated peer/origin checks and unchanged old decoder pass all five
categories, exact private fields/IDs and absent versus null metadata; CryptoPort retains ES256
verification, and the fixture rerun is idempotent. The seeded category RED and final GREEN logs
have SHA-256
`4cc1d0eaeeae3851965f57bdf3002d3e2baa00c0ef2fed9b4ecf65ea7e565fd4` and
`5cf640f28bbba2134f6fcf1a8347e478ef44bc5546ca8c8a9b1e5e3a7ea58bf9`.
Focused private scrub/read and held Core/host checks also pass after the mapping. This remains
isolated source capability evidence: actual shared-member read-only authority, remaining
protocol1 status/key/biometric/events requests, old Extension material-lifetime races, packaged
Chromium consumption and full CI gates remain open. No default production activation or ticket
closure is claimed.


Independent review also found that the expanded fixture had to clear every decrypted category,
including on early errors. The correction gives the existing VaultExport projection a `Zeroize`
implementation using the shared exhaustive private-draft scrub, wraps the fixture observation
immediately, and owns the parsed response through recursive cleanup of nested strings and keys.
A CVV canary reproduces the former omission; the disposal, success/error and actual native tracer
checks pass after the fix. Strict Core/bindings and Desktop feature all-target Clippy pass.
Final independent Spec and Standards re-reviews report zero findings. The integrated Rust files
match the cumulative patch SHA-256
`8065ed43baeff4afc72405a754d1fdbb4c75616017215fda6f959351efd729dc`;
`/tmp/bittery97-e941-private-cleanup.manifest`, SHA-256
`9ffb7ec25791c28c99f690ec390e5f77ad7d2bd78a80aec663f9adcd2f38a610`, pins source and evidence.
The coordinating verifier matches all 21 hashed artifacts. An initial held-host command selected
ignored cases and is explicitly excluded; the corrected actual-host rerun executes both cases.

2026-09-23 the next bounded request frontier is `GET_DESKTOP_VAULT_KEYS {accountId}` through
the actual native binary and unchanged old `DesktopClient.getVaultKeys`/key-hydration parser.
The feature-enabled host will explicitly route this request to the same validated-origin Core
source attachment; the default route stays on the existing protocol1 Desktop composition until66.
Core selects only the exact Account's current visible active-Bootstrap Vault records and preserves
their wrapped-key string bytes, role/type spelling and optional/null metadata at final encoding.
Local/offline Account and Vault guards apply without borrowing the auth-token usable-Session gate.
The existing real Account and Server-synced personal Vault provide the first matching-ID tracer;
unknown/mismatched Account, Lock, hidden Vault and replaced authority are refusal controls.
Core fixtures cover role conversion while actual Server shared-member `read-only` proof remains
separate. `GET_DESKTOP_ACCOUNTS` follows from the Device catalog and Account metadata; headless
Core has no UI Account selection, so `activeAccount: null` is legitimate there and must not be
inferred from last-active history or the legacy key-reference view. No new request acceptance or
production activation is claimed by this frontier record.

The bounded wrapped-key tracer is now source-complete for review, with the feature-enabled native
host rebuilt against this Core source. The real populated Account's exact-ID request reached the
old `DesktopClient.getVaultKeys` and parsed its current MUK-wrapped Vault key; a separate actual
host request for an unknown Account ID returned only the correlated generic source `ERROR`. Core
tests cover current Bootstrap wrapper/identity, hidden-Vault omission, Lock refusal, held source
EOF, and a local team/read-only metadata conversion fixture. Default and feature-enabled native
host composition tests each executed one test; strict Core/bindings and feature Desktop all-target
Clippy passed. The diagnostic first attempt failed only the new fixture's incorrect null-icon
expectation: this real Vault was created with icon `folder`; the corrected actual decoder passed.
Real Server shared-member ReadOnly proof, replaced-authority control, `GET_DESKTOP_ACCOUNTS`, and
the remaining request/event/biometric delivery matrix remain open. Feature-on is preparation-only
until #66 switches Desktop listener and host together; no default production activation occurred.

2026-09-23 the first native compatibility tracer and its review corrections are integrated.
Normal public Runtime Sign-in, Vault creation and ImportItems supply a populated real SQLite/Core
ES256 Login. The rebuilt native binary relays Core's opaque protocol1 Items envelope into the
unchanged old Extension decoder and CryptoPort; independent public-key verification proves the
resulting assertion. Ordinary Items still omit the private scalar. The staged source route stays
behind default-off `native-runtime-legacy-source`; both default and enabled host routing pass.

Independent review found that the original decrypted ItemDrafts needed explicit cleanup and the
timestamp needed Core's injected clock. The correction shares an exhaustive private-draft wipe
between the private read collector and the native formatting owner. Fresh tests cover a later
private-read failure, successful/refused formatting, the injected clock, held Core Lock/EOF and
actual host stdin EOF/stdout-reader loss. The missing-row regression is deliberate seam fault
injection, not a producer-reachable frame. Strict Desktop all-target Clippy passes in both feature
modes. Independent final Sol Spec and Luna Standards reviews report zero findings.

The final cumulative patch has SHA-256
`f790dd7e9586841bc8aad7060bb4e1f0374560319ed75c1e25a6ba7dba199d04`; all 12 integrated files
match the reviewed fixture. `/tmp/bittery97-native-p2-final.manifest`, SHA-256
`b5a0d8c2c8a59a2bd10bdfdff43bddf59e261ceeeb839d25c1b698e833622f1e`, pins source, binary and
test logs; coordinating verification matches all 33 hashed artifacts. These checks ran in the
isolated fixture based on `6c6e73f`; combined-main validation remains a separate next check.
All five-category variants, the remaining native request/key/status matrix, old Extension
delivery/material lifetime, packaged consumer acceptance and both full CI gates remain open.
This is not completion of97, production activation66 or supported-OS acceptance73.

2026-09-23 the maintained self-hosted signup helper now completes the same public Runtime
Sign-in handoff as cloud signup. Independent Sol Spec and Luna Standards reviews pass the
bounded helper patch, SHA-256
`de6f7ca9efeeeaee6d74957daca2e942cb0147ec96e326d18ad13ac45d8068ce`.
Actual Chromium against a separate empty self-hosted fixture Server proves that the helper
returns an unlocked `/home`, publishes the exact Runtime Account identity, and completes
scoped public Account deletion with the matching Runtime result and HTTP 200. The tested and
integrated helper has SHA-256
`d3f5c1190a5ba626e263277a58c1ec904c7c544f9f4b7f1dcc4785434dfe3e14`.
Browser log SHA-256 is
`e26351b112457ef0a43af0ea9f7ddccce8f13b17b4da478cff0ea2601593dc28`; evidence and cleanup
receipts are under `/var/tmp/bittery97-signup-helper-validation.YPmSkK/evidence`.
The fixture's private recovery files, owned services and disposable database are removed.
The earlier native-compatibility Account and its services remain available for native reruns.
This validates ordinary self-hosted signup preparation; it does not claim the invited/cloud
browser matrix or protocol1 compatibility acceptance.

2026-09-23 coordinating source review caught an early-activation hazard in the provisional tracer:
unconditionally changing the native binary's snapshot request would make it incompatible with the
current production `lib.rs` listener before66 replaces that owner. Coordinating and independent Sol
review accept the explicit default-off `native-runtime-legacy-source` build composition recorded
in the [startup contract](../desktop-extension/native-legacy-compatibility.md#startup-acceptance-and-removal).
The actual acceptance binary opts in and pairs with the new Core listener; the default production
host retains its current route until66 switches both atomically and removes this preparation switch.
No failed-Core fallback or inferred owner selection is permitted. This resolves staging of the
capability, not its private-read, held-delivery or actual consumer acceptance.

2026-09-23 the first actual native-host tracer is behaviorally RED in isolated checkout
`/tmp/bittery97-native-fixture-6c6e73f`. Normal public Runtime Sign-in, Vault creation and
`ImportItems` create a real Server-synced ES256 Login in native SQLite/Core. Ordinary Items omit
the private scalar; explicit VaultExport verifies the fixture. The actual native binary passes
its normal launch-origin and OS-peer checks, but the existing Core source listener rejects its
protocol1 first frame. The parent classifies this failure only after setup, scoped local cleanup
and Runtime shutdown have completed. Log `captures/native-legacy/protocol1-first-red.log`
has SHA-256 `2436bbe7624b13bb67b9da3569819fb8f9992e5e956417d79cba0be1c0d70e39`.

The coordinating review accepts the already specified closed internal legacy source handshake
as the next implementation step. It carries the validated origin into the existing attachment,
uses the existing effective private Item selection, and checks captured authority at final
encoding. Item and wrapped-key reads retain local/offline access rules; they do not acquire the
usable-Session gate of auth-token disclosure or biometric release. The unchanged browser wire,
real old decoder and static Extension CryptoPort form the tracer's green path; none has passed
yet. The disposable Server Account remains reserved for reruns and separately owned public
cleanup. This is fixture evidence, not packaged Extension or supported-OS acceptance.

2026-09-23 the first native fixture now has a real disposable Account created through public
self-hosted signup and authenticated through normal Runtime Sign-in. The current Server refused
the existing development database because migration `20260830224707` has a checksum mismatch;
that database was left intact. A separately named fixture database was created and migrated by
normal Server startup, with isolated loopback API/Web ports. Credentials are retained only in a
mode 0600 temporary file; coordinating cleanup owns exact public Account deletion after the native
runs. No Core authentication installer or credential bypass is exposed.

Setup also reproduced a maintained helper gap: `signUpSelfHosted` reaches `/home` but waits for
`#app-scroll-area` without completing the legacy-browser-to-Runtime handoff already handled by
`signUp`. The setup retained the newly created Secret Key and used ordinary Sign-in in a fresh
browser context; `captureFixtureAccount` then verified the Runtime identity. The maintained native
acceptance caller must include this public handoff. This is fixture preparation, not protocol1
compatibility or native acceptance evidence.

2026-09-23 dependency95 is resolved after both literal full CI gates and independent review;
all97 prerequisites are now complete. Implementation starts with a populated real SQLite/Core
ES256 Login and generated protocol1 snapshot into the actual old Extension decoder, then held
Lock/EOF refusal. The existing native SQLite fixture contains an Account but no readable
Vault/Item, so the tracer must add real authority and key setup. Later real native-binary and
packaged-Extension acceptance remains required; no legacy Tauri-cache fallback or fabricated
protocol1 success satisfies the first tracer.

2026-09-23 read-only Linux acceptance preparation: the release Extension builds into
`apps/extension/dist`; its existing Playwright suite has no persistent-browser/native-host
fixture. The real native source process test already owns an isolated Core/SQLite helper and
actual binaries, but sends protocol2 frames directly and does not exercise the old consumer.
The first protocol1 tracer needs a populated real ES256 Login, the actual old snapshot decoder,
and then a persistent full-Chromium profile with the packaged Extension and an isolated native
manifest. Determine the Extension's actual ID before building/configuring the host: both the
manifest origin and the host's compiled origin check must agree. Use test-owned profile and
runtime directories; the production installer is not the isolated fixture mechanism. Connect
the real browser through its existing Item read and credential-save routes, then prove local
write identity through reconnect and Lock/EOF retirement without logging private scalars.
This missing browser/source-helper fixture is acceptance work, not a new production owner.
No source change or acceptance launch is claimed; 95 still blocks implementation.

2026-09-09: reserved after96 discovered the mandatory remaining Desktop-first compatibility boundary.
The focused draft is awaiting coordinating review; no implementation or readiness is claimed. Existing
66 dependencies and status are unchanged pending that review.

2026-09-09: independent source review confirmed two concrete consumer races beyond native framing:
DesktopClient can repopulate caches after a lock event, and native key hydration/biometric consumers
can resume nested AccountStore writes or live-key publication after old cleanup has finished. The
coordinator accepted one generation/Account/invocation-bound mutation lease in the existing native
transport lifetime, wired through the current vault-session lifecycle adapter into unchanged C1.
Its drain excludes network/Travel waits, blocks successor material until cleanup acknowledges, and
guards old failure cleanup against both new generations and newer publications in the same
generation. Required tests hold actual nested writes and cleanup, native loss without subscribers,
and late old failure after a fresh authorized successor. This seals routine transport/lifecycle
ordering without adding a Session owner or changing accepted work; no implementation is claimed.

2026-09-09 research96 is resolved after coordinating and independent review of the complete
source-only encoding and transport/material lifetime contract. Ticket97 is `ready-for-agent`
with incomplete68/71/95 dependencies; it now gates66's atomic production activation. Required
real native-binary/packaged-old-Extension acceptance and both full checks remain outstanding.

2026-09-23 independent review of the bounded status increment found that a failed Replica
Account made `GET_DESKTOP_STATUS` return `ERROR`, hiding an unrelated healthy unlocked Account.
The correction keeps failed Accounts out of `unlockedAccounts` through Core's existing eligibility
rule and includes the captured failure state in the final status guard. A fresh request may report
the remaining healthy Account; a held request crossing a failure transition still refuses stale
status. The corrected two-Account fixture first failed against the exact pre-fix encoder after
proving the healthy Account was eligible, then passed with the correction. Seven focused status
tests, eleven held legacy native tests, strict Core/bindings Clippy, Rust formatting, and the
unchanged old `DesktopClient.getLockStatus` through the feature-enabled native host pass. The
feature host is byte-identical to the preserved previous binary because this change is in Core's
Desktop-side status encoder; the acceptance test rebuilt the Desktop library against the changed
Core. The external v20 receipt pins source bytes, commands and logs. This is a correction candidate
for fresh independent review, not full97 acceptance, default production66 activation or
supported-OS73 acceptance. The remaining protocol1, packaged Extension and whole-phase CI gates
remain open.

2026-09-24 the bounded local-access candidate now applies Core67's current re-entry policy and
local Session deadline check at final guarded protocol1 single/All encoding. Controlled-clock held
admission, the bridge and selected Core67/native guard regressions, and the rebuilt Desktop feature
executable's actual native-host single, All, availability and held browser-EOF old-consumer traces
pass. The native-host executable is byte-identical to the preserved predecessor because its
forwarding code did not change. Fresh independent review, the remaining97 matrix, both full CI
commands, production66 activation and supported-OS hardware acceptance73 remain open.

2026-09-24 a follow-up correction preserves protocol1 biometric result shapes when a local
deadline passes after a successful prompt. Single returns its correlated failure envelope; All
retains still-current Accounts and lists elapsed Accounts in `failed`, or returns its existing
all-failed envelope when none remain. Core67's current predicate runs under the final source,
generation and publication guards, and prepared material for an elapsed Account is discarded.
The held two-Account and single response regressions first failed on the preceding candidate.
They and the all-none cases now pass. The full eight-case biometric bridge, 28 selected Core67,
three native owner and one shared-ceremony controls pass. The rebuilt feature Desktop test
executable passes all four actual native-host old-consumer biometric traces; the host binary is
unchanged. The external v26 receipt pins source, executable, command and log hashes for
independent review.
This bounded correction does not close the remaining97 matrix, full CI, production66 activation
or supported-OS hardware acceptance73.
