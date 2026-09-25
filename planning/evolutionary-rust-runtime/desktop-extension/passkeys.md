# Extension passkey capability mapping

Status: reviewed; durable local counter reservation accepted. This is the focused contract for
[ticket 75](../issues/75-runtime-extension-passkeys.md), not permission to implement Extension
before [Desktop acceptance](../issues/73-desktop-production-acceptance.md). The findings below are
source inspection on 2026-09-09, not production ceremony acceptance.

## Accepted placement

[Placement 41](../issues/41-extension-runtime-placement-decision.md) puts the Runtime and Crypto in
one dedicated Worker in the Chrome 116+ offscreen document. The service worker brokers browser
capabilities; it does not own authentication, signing, matching, retry or durable work.
[Decision 64](../issues/64-runtime-native-transfer-contract.md) keeps accepted Extension Operations
in its local Core/Replica. [Decision 79](../issues/79-connected-extension-item-read-authority.md)
makes that Replica the connected Extension's Item read authority. Desktop contributes the private
authority admitted by [native transfer](native-transfer.md), never a parallel passkey Item store.

Core owns a private, foreground ceremony: normalized matching, exact Account/Vault/Item/credential
selection, credential generation, signing, mutation admission and final result eligibility. Reuse
the existing crypto primitives and shared authority/Operation machinery. The host intercepts page
WebAuthn calls, supplies authenticated browser context, displays Core's nonsecret choices, and
constructs the existing browser result objects. Neither prompts nor the broker receive private
credential keys, decrypted Item drafts or native unlock material.

## Actual ceremony surface

The current owners are [background handlers](../../../apps/extension/src/background/passkey-handlers.ts),
[page interception](../../../apps/extension/src/page-script/passkey.ts),
[bridge](../../../apps/extension/src/content-script/passkey-bridge.ts), and
[serialized options](../../../apps/extension/src/passkey/types.ts).

| Concern | Actual behavior to account for |
| --- | --- |
| Algorithm and stored format | Registration supports ES256 (-7), a P-256 private scalar, a random 32-byte credential ID, COSE EC2 public key, and the current encrypted Login passkey payload. No RSA or EdDSA production path was found. |
| Attestation and assertion | Existing [Crypto primitives](../../../packages/crypto/core/crates/bittery-crypto-core/src/passkey.rs) produce `fmt: none`, the fixed Bittery AAGUID, registration flags `0x5d`, assertion flags `0x1d`, a big-endian u32 counter and DER ECDSA signatures over authenticator data plus client-data hash. Reuse these bytes and existing vectors. |
| Registration targets | Match existing Login URLs/registrable domains; a sole candidate or a sole case-insensitive username match can attach automatically. Ambiguity prompts. New Items use an active Account's selected writable Vault, RP-based title/URL and supplied username. Creation writes the Item before returning the credential. |
| Assertion matching | Exact normalized stored RP ID, optional nonempty public-key allow-list, and descending last-used/created ordering. One match still requires explicit selection. Suspect entries are not automatically excluded. |
| Read authority | `getLoginItems` reads decrypted Login Items from [mode-specific collection](../../../apps/extension/src/background/vault-utils.ts); the handler does not filter assertion matches by writable Vault role. Read-only assertion availability follows from this code plus tolerated update failure; it is not an existing real-browser test result. |
| Usage/status | Successful signing attempts set count/last-used/active status through a whole-Item update. That update can fail while the assertion still succeeds. Unknown-credential or signing-error can mark a uniquely identified candidate suspect; ambiguous candidates are not marked indiscriminately. No relying-party acceptance callback exists. |
| Fallback | Unsupported creation algorithms and unavailable/failed handled paths fall back to native browser WebAuthn. Conditional/silent get uses the existing stabilization/prompt flow; this is not evidence of complete conditional mediation conformance. |
| Cancellation | Page abort closes local presentation and sends cancel; the background cancel handler only logs. Local timeouts/late-response filtering do not cancel signing or a durable write. |

Do not infer feature support from serialized option fields. `excludeCredentials`, attestation
preference, authenticator selection and user-verification preferences are transported but are not
fully enforced by the current handler. Crypto sets UV unconditionally; a prompt choice or the mere
presence of that flag is not new proof of per-ceremony biometric verification. This migration adds
no algorithm, attestation mode or verification promise and does not silently remove existing
successful ceremonies. Conformance improvements beyond the existing supported behavior are not
acceptance evidence for this ownership migration.

### Browser facts and matching authority

The current bridge validates same-window message source/origin, but forwards page-supplied origin
and hash. The [background router](../../../apps/extension/src/background/router/index.ts) ignores
`MessageSender`. A page-provided origin or a picker credential ID alone must not authorize Core.
The private browser capability must bind the request to browser-supplied origin, tab, frame and
document identity, plus a fresh request identity. Chrome exposes this context in
[MessageSender](https://developer.chrome.com/docs/extensions/reference/api/runtime#type-MessageSender).
Core constructs client-data bytes from that authenticated context and the frozen challenge; page
client-data/hash fields are not signing authority. A redirect, replacement document or mismatched
reply cannot reuse the context or change the signed request.

Current RP derivation accepts the exact origin hostname or a dot-delimited parent suffix.
[Hostname helpers](../../../apps/extension/src/lib/hostname.ts) use a limited suffix list for
registrable-domain candidate matching, not a complete public-suffix validator. Preserve candidate
matching vectors while keeping trusted browser-origin/RP validation distinct from URL heuristics.
These are inherited matching behaviors, not sufficient RP authorization. The accepted correction
below uses full registry rules for authorization while preserving candidate-matching vectors.
There is one shared Core matching/authorization policy; hosts provide browser facts, not competing
selection or Item authorization rules.

Picker handles must resolve inside the live ceremony to exact Account identity/incarnation,
Vault/Item and credential, rather than email, current active Account, credential ID alone or a
stale passkey-array index. Copied credentials, equal emails on different Servers and simultaneous
Accounts must not select or update each other's material. Recheck current readable/writable
authority when acting; an earlier displayed option grants neither.

### Reviewed browser-context correction and feasibility

The current [manifest](../../../apps/extension/manifest.config.js) injects both passkey scripts into
all frames. [Page serialization](../../../apps/extension/src/page-script/passkey.ts) nevertheless
hardcodes `crossOrigin: false`; the background also accepts a page-provided origin/hash and only a
hostname-suffix RP check. These are existing context/protocol defects, not preserved cryptographic
algorithms or persisted credential formats. On 2026-09-09 the coordinating review accepted correcting
them within75, while retaining authorized frame ceremonies and current ES256 credential bytes.

The existing isolated content entry and its authenticated exact-document Chrome Port provide one
bounded fact source without adding `webNavigation` or another browser permission.74 registers the
browser-supplied `MessageSender` document/profile/tab/frame identity on receipt of that connection.
Core's fresh correlated probe travels over that exact Port to a private listener in the existing
isolated entry, which captures native getters and reads current document/ancestor origins,
secure-context state, effective feature policy and transient user activation. Its activation and
unconsumed probe correlation stay in the same private closure. There is no MAIN-world probe, active-tab
lookup, injected function pretending to read another closure, or parallel scripting fact registry.
The listener performs no credential selection, RP authorization, signing or key access. Page messages
cannot register facts, substitute a probe result or invoke the trusted listener. Chrome's
[isolated worlds](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts#work_in_isolated_worlds)
and [Port/sender identity](https://developer.chrome.com/docs/extensions/reference/api/runtime#type-MessageSender)
supply these primitives at the accepted116 minimum; actual frame/lifetime acceptance remains required.

Pinned Chromium116.0.5845.96 source establishes the available mechanisms:

- [Location](https://chromium.googlesource.com/chromium/src/+/116.0.5845.96/third_party/blink/renderer/core/frame/location.cc)
  computes `ancestorOrigins` from the actual frame ancestry; Core compares the complete chain with
  the initiating origin and obtains the top origin from its final entry. This is not a page-supplied
  ancestor list or a parsed `iframe.allow` string.
- [DOM feature policy](https://chromium.googlesource.com/chromium/src/+/116.0.5845.96/third_party/blink/renderer/core/permissions_policy/dom_feature_policy.cc)
  reads the effective document policy. Capture `Unsupported`, `Denied` or `Allowed` distinctly for
  each relevant feature; an unknown feature is not proof of permission.
- [Credential checks](https://chromium.googlesource.com/chromium/src/+/116.0.5845.96/third_party/blink/renderer/modules/credentialmanagement/credentials_container.cc)
  and [browser-side ancestor checks](https://chromium.googlesource.com/chromium/src/+/116.0.5845.96/content/browser/webauth/webauth_request_security_checker.cc)
  allow delegated cross-origin assertion in116, but prohibit cross-origin registration there.
  [Chrome123](https://developer.chrome.com/blog/chrome-123-beta) added cross-origin registration with
  the relevant effective permission and transient activation. Keep the116 minimum; running-browser
  facts distinguish this support rather than assuming the newer path exists everywhere.
- [Origin/RP checks](https://chromium.googlesource.com/chromium/src/+/116.0.5845.96/content/public/browser/webauthn_security_utils.cc)
  reject opaque origins, non-HTTP(S) schemes and IP hosts, retain potentially trustworthy localhost
  development, and use registry checks including private and unknown registries for a parent RP.

Core owns the closed authorization rule: require a nonopaque authenticated origin and secure browser
context; allow HTTPS plus the browser-compatible trustworthy localhost development exception, with
no arbitrary remote HTTP, IP-host or privileged-origin bypass. Require the exact effective host or
an allowed registrable parent RP using a pinned complete PSL with private/unknown-registry semantics.
Do not use the limited candidate suffix list, strip arbitrary URL syntax from an RP ID, or let a
host supply an already-authorized boolean in place of the underlying browser facts. Reuse one Core
domain helper; no independent renderer/broker authorization implementation or network PSL fetch is
needed during a ceremony.

Require the running browser's effective assertion permission for Get. For Create,116's supported
same-origin-with-all-ancestors path remains; a cross-origin path requires browser support, effective
create permission and authenticated activation at initiation. Later supporting browsers' effective
create policy still applies to same-origin requests. Unsupported or browser-denied contexts follow
the existing native-fallback/error presentation without signing through an Extension bypass. No
Secure Payment Confirmation, related-origin request or other special browser override is added.

Core snapshots the exact challenge bytes and requested ceremony kind before any prompt; constructs
one UTF-8 client-data JSON value with canonical base64url challenge, authenticated origin, accurate
`crossOrigin` and the corresponding cross-origin top-origin field; hashes those bytes itself; and
uses/returns that identical byte sequence in the existing result. A page cannot change the challenge
on Continue or replace the JSON/hash. This follows the narrow context requirements in
[WebAuthn client data and origin scoping](https://www.w3.org/TR/webauthn-3/), without claiming full
WebAuthn conformance or changing stored key, signature, attestation or counter formats.

### Closed ceremony controls and caller lifetime

Generate the following closed controls and records from Rust under ADR0012 through the existing
RuntimeClient/74 routing. A browser request context is a live foreground capability, not a durable
ceremony journal, new Account owner or general-purpose browser execution port.

| Control or record | Closed ownership and behavior |
| --- | --- |
| Trusted browser context | The registered browser primitive captures exact profile/tab/frame/document/connection identity, an isolated-document activation generation, authenticated origin/ancestor facts, secure-context and per-feature policy states, initiation activation and a fresh Core probe correlation. Core owns the opaque live context handle. Public page/popup requests cannot construct or rebind that handle. |
| `PasskeyBegin` | Supplies that context handle and one frozen Create or Get options record. Generate the fields of the current serialized options explicitly: challenge/descriptor/user-ID bytes, RP and user display fields, algorithm list and currently transported timeout/mediation/authenticator preferences. Preserve supported options; do not make transported but previously ignored preferences a new verification promise. Core decodes binary encodings once, snapshots bytes, validates kind/context/RP, and allocates one live ceremony identity. A reused consumed context or duplicate Begin cannot generate another key, floor or Operation. |
| `PasskeyContinue` | Names the same ceremony, current prompt revision and an opaque Core-issued selection handle. Closed selections are exact assertion credential, attach-existing Item, or create-new writable Vault. Handles bind Account/incarnation/epoch, Vault/Item and credential/public-key identity as applicable. No host-selected email, array index or bare credential ID determines authority. Continue neither resends mutable options nor re-runs Begin. |
| Prompt result | Closed `ChooseAssertion` or `ChooseRegistrationTarget` with existing nonsecret display fields and opaque selections. Core owns matching/order and automatic single-target registration rules. Each prompt revision consumes its preceding options; stale or foreign choices fail instead of switching targets. The Extension-owned prompt frame validates its exact origin/window/request identity before relaying a choice. |
| Terminal result | Closed `Created`, `Asserted`, `NativeFallback` or `Failed` outcome, correlated to the live context and ceremony. Created/Asserted contain only the existing public browser-result fields and Core-constructed client-data bytes. No private key, full Item draft, MUK, reusable signature capsule or general result-fetch command is exposed. Ordinary typed failures map to existing page fallback/error behavior. |
| `PasskeyCancel` / caller retirement | Names the scoped ceremony/context through the existing caller cancellation lane. Idempotently retire prompt, pending response and foreground work. Page abort, bridge timeout, prompt dismissal/replacement, document departure and connection loss all reach this same cancellation; none merely logs or deletes presentation while Core keeps an eligible result. |

At Begin, before acting on a selection, and before result release, request fresh facts for the same
document through the authenticated primitive. Compare its exact document and activation generation,
origin/ancestor chain and relevant current permissions with the retained context; pending retirement
wins. Do not reuse `MessageSender.documentLifecycle` from initial port creation as a current probe.
The isolated document retires its activation generation on page departure, including back/forward
cache entry, and a restored document cannot revive old ceremonies even if Chrome retains its
document ID. Browser connection loss retires that caller;74 reattaches to a surviving Core owner
without restoring the old ceremony or changing other Accounts' unlock state. No heartbeat or durable
browser-context capsule is introduced.

Fresh browser probes are external waits outside Account execution. Reacquire execution and recheck
the retained foreground Account/Item authority after each wait, before private crypto or a guarded
commit. Core maintains the existing15-second bridge deadline, shortened by the page's existing
effective timeout where applicable; the host may cancel earlier. Prompt-only30-second timeout and
conditional/silent550ms presentation stabilization never extend the live Core deadline. Starting a
new prompt in the same document retires its old prompt/ceremony. This causes no Account-wide
retirement; unrelated ceremonies in other documents retain their own scope and lifetime.

Registration privately generates one credential and prepares the existing exact Create/Update
Operation against the current selected target through95's internal private admission. It must
durably accept that encrypted Item work before returning Created; failed/ambiguous acceptance
discloses no success, and uncertain read-back cannot replay the original browser result. Once
accepted, cancellation or caller loss leaves the immutable work for the existing dispatcher.
Assertion follows the reviewed private-sign/floor-commit/disclose sequence below, independently of
its later ordinary usage outcome. Neither ceremony waits for an invented relying-party receipt.

Final transport delivery targets the original document and isolated request generation, using the
existing bound connection or [document-targeted messaging](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-sendMessage).
The content bridge checks that its exact page request is still live before constructing/delivering
the result; late replies cannot target the tab's replacement frame or a reused page request ID.
Loss between Core release and page delivery may consume a count or leave accepted registration work,
but never authorizes replay or cancellation of that work. A fresh page request starts a fresh ceremony.

Required real-page cases include top-level and same-origin nested Create/Get; delegated cross-origin
Get at116; denied delegation; cross-origin Create unsupported at116 and permitted only with supported
browser capability, delegation and initiation activation; accurate `crossOrigin`/top-origin/challenge
signature bytes; trustworthy localhost versus remote HTTP/IP/opaque origin; valid parent RP versus
public/private suffix and forged origin; MAIN-world forged facts versus the isolated capability;
frame/ancestor navigation, back/forward-cache restore, broker recycle, prompt replacement, timeout,
abort and a held result with a second unaffected Account. These are future tests, not acceptance
claimed from source inspection. Real116 and a browser supporting cross-origin Create are distinct
matrix entries; a synthetic boolean capability fixture does not establish either browser behavior.

## Required public Item surface prerequisite

[Core protocol](../../../packages/client-runtime/crates/bittery-client-core/src/protocol.rs) currently
uses the persisted `Passkey` including `private_key` in `LoginItemData`, `ItemDraft`, and ordinary
`ItemProjection`. [Shared presentation](../../../packages/ui/src/runtime-presentation/items.ts)
passes that data through. Moving signing alone therefore does not make keys private.

Separate nonsecret passkey metadata in ordinary Item projections from Core's persisted private
credential payload. Preserve credential ID, RP/user display fields, public metadata, count,
timestamps and suspect status needed by [Login detail](../../../packages/ui/src/components/vault/item-detail/login-detail.tsx).
Absence of a private field in a public edit must never mean deletion of the stored key. Core must
merge ordinary Login edits against current private state, preserving untouched passkeys and
concurrent ceremony updates; an explicit credential removal targets the exact selected Item and
credential. Generic host draft replacement must not become a private-key insertion/overwrite seam.

| Existing caller | Required preservation and verification |
| --- | --- |
| Web ordinary edit | [Mutation mapping](../../../apps/web/src/hooks/use-runtime-item-mutations.ts) currently spreads projected Item data into a full draft. Editing title/password/URLs after redaction must preserve the exact stored credential and concurrent counter/status state. |
| Desktop detail and remaining Extension callers | [Desktop removal](../../../apps/desktop/src/components/vault/item-detail-page.tsx) filters credential IDs from a full decrypted draft. Replace this dependency with exact semantic removal without losing siblings. Audit remaining legacy Item writers before shared shape cutover; do not fix only the new Worker. |
| Desktop Duplicate | The same detail page spreads the complete decrypted Item into CreateItem with a replacement title, including Login passkeys. Preserve this same-Vault action through a Core-owned duplicate of the exact current source Item; redacted metadata is not sufficient to recreate its private credentials. |
| Bittery Export | [Web archive](../../../apps/web/src/lib/runtime-vault-export.ts) directly writes projected `item.data.data` to `.bttrx`. A metadata-only projection would silently omit private keys. Preserve the existing full backup through a separate, explicit, scoped Export capability with current Account/Vault authority, cancellation and final-delivery checks; no routine projection exception. |
| Bittery Import | [Provider](../../../apps/web/src/lib/import/providers/bittery-bttrx.ts) preserves `item.data`; [Import submission](../../../apps/web/src/hooks/use-vault-import.ts) submits it as `ItemDraft`. Preserve full credential round-trip through explicit Import input and existing Core admission. Do not strip keys because the ordinary projection type changed. |
| Third-party Import | [Bitwarden provider](../../../apps/web/src/lib/import/providers/bitwarden.ts) explicitly reports `passkeys-skipped`. Preserve existing format capabilities and warnings; this ticket does not add unsupported passkey imports. |
| Share snapshot | [Shared payload contract](../../../packages/shared/src/types.ts) intentionally excludes passkeys. Core [snapshot allow-list](../../../packages/client-runtime/crates/bittery-client-core/src/runtime/create.rs) and [forbidden-field test](../../../packages/client-runtime/crates/bittery-client-core/src/runtime/create_tests.rs) agree. Keep passkeys excluded; do not substitute an unrestricted private export payload for Share. |

Import/Export are explicit user-authorized plaintext transfer paths, not routine broker/popup Item
disclosure. Their existing feature support must remain lossless across this shared shape change.
Generated closed request/result bindings must distinguish public metadata, semantic changes and
those scoped transfer inputs/outputs. No persisted credential-format migration is implied.

### Shared prerequisite before Desktop cutover

This reviewed shared capability is [ticket95](../issues/95-private-credentials-and-public-item-commands.md).
It does not depend on75's counter implementation or74's Extension placement, which would create a
Desktop/Extension dependency cycle. Desktop assembly/caller tickets consume this shared surface,
and75 consumes it later. Required existing authority, accepted-operation and Export lifetimes still
gate its implementation; this contract does not establish Desktop delivery or acceptance.

Reviewed [legacy native compatibility97](native-legacy-compatibility.md) reuses the same internal
private Item read/format owner until Extension cutover76. Its closed authenticated native-peer
encoding is separate from every ordinary renderer/broker projection and adds no public private-field
flag or dependency from95 to97. The temporary old Extension consumer still receives its existing
private payload until that cutover; the migrated75/76 broker never receives it.

Keep the persisted private Login/passkey shape unchanged inside Core and explicit transfer inputs.
The generated public protocol separates these closed surfaces:

- `PublicPasskey` exposes the current metadata fields except `private_key`.
  `PublicLoginItemData` and `ItemProjection` use it. There is no routine full-private projection or
  flag that a broker, popup or ordinary Item observer can request.
- Ordinary `EditableLoginItemData` contains Login's normal editable fields and no passkey array.
  The other categories retain their existing editable shapes. CreateItem and UpdateItem use the
  corresponding ordinary editable draft; importing a private credential is reserved for explicit
  Import or Core's private registration/duplication path. Unknown private fields fail validation.
- A current authoritative Item projection supplies an optional stateless `ItemEditGuard` containing
  Account ID/incarnation/lock epoch, Item ID and authoritative Item version. Ordinary Update
  and credential removal take that guard. Core compares it with its current authority
  under execution; the guard is stale-input evidence, not authorization or a registered capability.
  A pending/failed local Item without the required authority supplies no fabricated edit guard.
- UpdateItem re-reads the current authoritative Item under existing Account execution, verifies
  the guard, category, current Item version and Vault authority, then merges ordinary edited fields into that
  private state. Passkeys and current usage/status come from Core, never a stale public draft. Keep
  the existing same-Item pending-operation admission guard and immutable `If-Match` request: an edit
  cannot rewrite an already accepted update or silently rebase its ciphertext. A competing current
  Item/authority change requires the existing refusal/refresh path. No host merge chooses private
  key or counter precedence.
- Semantic credential removal names the exact Account/Item plus RP, credential ID and public-key
  fingerprint observed in the selected public entry. Core revalidates current scope and matching
  credential under the same mutation fence, removes only that identity, and admits the existing
  ordinary encrypted Item update. A replaced credential, stale Item or pending conflicting work
  leaves the draft unaccepted; it cannot remove a newly substituted key or lose siblings.
- Same-Vault Duplicate names the exact current source Account/Item and requested replacement title.
  Its stateless source guard also captures the current Replica revision and whether the selected
  readable source is authoritative or an existing accepted local overlay (with that exact owner ID).
  Duplication does not fabricate authoritative Item version for readable pending/failed local data.
  Core obtains its private draft under current readable authority, validates the ordinary writable
  destination and uses existing CreateItem admission. Preserve the actual Desktop action's full
  Item data and credential identities without exposing its private draft to the host. This does
  not add cross-Account duplication or Attachment copying beyond that caller's supported behavior.

Explicit Import retains the existing full private transfer draft and existing accepted Import owner.
Export gets a separate explicit scoped capability, with Account/selected Vault/Item identities and
the current owner/incarnation/epoch plus existing foreground read/delivery fencing. Reuse the
current `.bttrx` formatter and bounded attachment download owner; only this user-requested export
can receive the full private Item payload needed by that format. The capability is not transferable
to routine observers, prompt mediation or Share. Revalidate selected authority before each bounded
private payload release and final archive delivery; lock, hiding, cancellation and owner loss retire
the attempt. A host-held old snapshot or filename is not export authority.

The shared prerequisite initially exports the stored `signCount` faithfully and has no reservation
floor owner. When75 later supplies that capability, it extends this same explicit export owner to
use the maximum available local floor; no second Export implementation or dependency back-edge is
needed. Keep ES256 payload, `.bttrx` and Share format behavior unchanged. Existing unrelated edits,
credential removal, Desktop Duplicate, Import and Export must pass lossless real-credential vectors
before ordinary private projections disappear. Read-only export remains governed by readable
authority, not Item mutation eligibility.

## Accepted decision: durable assertion reservation

The current `computeNextSignCount` chooses the maximum of stored count plus one, an in-memory
credential-ID-only map plus one, and epoch seconds. Signing happens before a best-effort usage
write, whose error is ignored for the returned assertion. Restart, concurrent owners, duplicate
credentials and storage failure are not covered by that map.

On 2026-09-09 the maintainer required durable local counter reservation before returning an
assertion. A failed reservation commit fails the ceremony. Readable passkeys in read-only Vaults
remain usable; writable Item usage/status synchronizes separately through ordinary Operations.
This resolves the observable storage-failure choice without claiming global counter ordering across
offline Devices.

The bounded contract and concrete Replica/recovery lifecycle below passed independent review.
Ticket75 is `ready-for-agent` after review of the closed ceremony controls and browser acceptance
mapping, with Desktop acceptance and offscreen composition still required before implementation.

- Core reserves before disclosure, serializes concurrent reservations for the same local
  Account/credential identity, and never reuses a committed count after cancellation, conflict,
  rejected usage write or owner loss. Check u32 exhaustion explicitly; no wraparound.
- Use the existing Replica transaction/recovery owner, with exact Account identity and lifecycle
  binding. Item duplicates within that Account cannot create independent local floors for the
  same credential. Received/stored counters can raise the floor, never lower it. Specify recovery,
  removal/reimport and Account retirement behavior before creating ready implementation tickets.
- A readable passkey in a read-only Vault remains usable after local reservation. Reservation is
  local bookkeeping, not a forbidden shared Item write. Writable usage/status synchronization is
  an ordinary locally accepted Operation, with existing retry/current-authority/conflict outcomes;
  it is not a second transport or best-effort host updater. Do not overwrite unrelated Item fields
  from an old picker snapshot.
- Distinguish local signature creation, local reservation and Item Operation outcome. None proves
  the relying party accepted an assertion. Retain no replayable signature/result capsule across
  owner loss; a new page request needs a fresh ceremony and authority.

WebAuthn describes increasing counters and recognizes non-increasing observations can also result
from malfunction or reordered requests, not only cloning. Local durability cannot promise global
ordering across offline Devices or restored external copies; do not claim it does or silently
switch to an unsupported-counter value of zero.
[WebAuthn signature-counter semantics](https://www.w3.org/TR/webauthn-3/#sctn-sign-counter).

## Lifetime and acceptance mapping

### Reviewed concrete reservation lifecycle

This section refines the accepted decision using existing owners and passed independent review.
Add a closed version-1 `PasskeyCounterFloors` store to the
existing Replica persistence contract and corresponding guarded plan mutations. SQLite, IndexedDB,
generated conformance and recovery use that same store; there is no passkey database, credential
keystore, counter service or separate scheduler.

The stable credential digest covers a domain separator, Core-normalized RP ID and decoded credential
ID bytes using unambiguous length framing. It is Account-scoped by the enclosing Replica: duplicate
copies within the Account share a floor across Items/Vaults, while another Account has an independent
local lifetime. Selection still identifies the exact Item and credential/public-key fingerprint;
sharing a floor grants no permission to use a different copy or key.

| Existing owner / proposed field | Exact role |
| --- | --- |
| Floor row identity | An opaque, domain-separated keyed tag of the Account ID and credential digest under the existing DeviceKey. Access incarnation is not part of this lookup identity. The stable digest itself is not the physical row key. No raw RP, credential ID, username, Item/Vault identity or private key belongs to this reservation identity. |
| Protected floor payload | Existing authenticated small-document crypto protects `{ version: 1, credential_digest, floor: u32 }` under the existing DeviceKey, binding the stable canonical Server/User/Account identity, row tag and format version. AAD does not bind a transient access incarnation; active incarnation/revision belong to the existing admission/commit guard. Validate tag-to-digest agreement on every read. Reuse the crypto owner and secret port; never create a new persisted key or return floor-decryption capability to a host. |
| Visible usage associations | On that same row, a closed list keyed by exact Item/Vault and selected public-credential fingerprint holds only latest desired count/time/status, its producing Replica revision, an optional accepted ordinary Operation ID with the revision it covers, and the last settled desired revision. No private credential, decrypted Item snapshot or duplicate frozen request is stored here. |
| Inventory commitment | Optional version-1 commitment on the existing `ReplicaHead`: floor entry count and a digest over canonical sorted opaque row tags plus protected-counter-envelope hashes. First reservation updates it atomically with the floor. It witnesses expected floor presence without storing a second credential list or registry. Every ordinary head transform preserves it; there is no independent metadata row or index. |

Coordinating and independent review accept this head commitment and its persistence/recovery mapping.
Once present,
missing or malformed expected rows, inconsistent count/digest, failed envelope authentication or a
missing DeviceKey make the counter capability unavailable and recovery explicitly incomplete. Do
not initialize a replacement floor or DeviceKey to conceal that failure. An absent commitment is
compatible with a legacy Account only when no floor rows exist. This detects loss relative to the
retained head; it cannot establish an unwitnessed historical count after wholesale deletion or
rollback of both the head and its rows to an older consistent state. Do not claim that guarantee.

Use the existing Account execution fence and current foreground ceremony loan for this sequence:

1. Validate exact current Account/User/incarnation/epoch, selected Item/credential and readable Vault
   authority, including the private key. Read and authenticate the local floor and current stored
   count. Choose the checked u32 maximum of stored count plus one, committed floor plus one and
   Core clock epoch seconds, preserving the existing counter convention without overflow.
2. Produce the signature privately while the execution fence serializes this Account's reservations.
   This is bounded local crypto, not a network wait. The signature and key remain ephemeral and are
   not disclosed or placed in a durable result capsule.
3. Commit the floor, inventory commitment and any desired writable usage evidence in one existing
   guarded Replica plan. A failed or ambiguous commit fails the ceremony and disposes the signature.
   Reading back an uncertain commit may reconcile the local floor, but cannot authorize disclosure
   from the failed ceremony. A later request allocates above whatever floor actually committed.
4. Recheck the live browser/Account/Vault ceremony scope before disclosure. Cancellation, lock,
   hidden authority or owner loss makes the result ineligible; a committed count stays consumed.
   Signing failure before commit discloses nothing and needs no reservation rollback.

A readable read-only Vault needs only the local floor commit. It does not need writable Item
authority or a remote usage result. For a writable selected Item, desired usage is recorded as local
intent in the same commit; admitting its HTTP Operation may wait for current Item authority or an
already-pending Item Operation. Such a wait cannot block the assertion or invent a writable role.
Suspect status preserves the existing best-effort failure annotation separately from a successful
assertion reservation. Only the current uniquely identified candidate may receive the existing
`unknown-credential` or `signing-error` annotation; malformed browser context, cancellation, a failed
local counter commit or an unobserved relying-party result is not evidence for either reason. Under
fresh writable Item/credential authority, merge only that annotation through the same private Item
admission owner and accept one ordinary Update if eligible. Pending work, read-only authority or
failed admission leaves the original fallback/failure unchanged, as today; it creates no floor row,
new retry queue or durable desired-usage record for a signature that was never returned. Once
accepted, that exact encrypted Update has the ordinary durable lifetime. A later successful assertion
records its newer active status through the floor/desired-usage path, preserving ordinary Item
ordering and sibling credentials. No host whole-Item updater or relying-party rejection inference
remains.

The existing dispatcher reconciles these visible associations. When the current Item is writable
and otherwise eligible, Core merges only the desired credential metadata into freshly read private
Item state, preserving unrelated fields, sibling passkeys and the maximum current floor. It freezes
one ordinary UpdateItem request through the existing admission owner and records its ID and covered
desired revision atomically with that acceptance. While it remains accepted, later reservations
coalesce into newer desired metadata; they cannot replace its request or allocate another request
for the same covered revision. Existing Operation retry owns transport and authentication failure.

A proven terminal outcome settles only its covered desired revision and clears that exact pending
reference. Newer desired evidence survives and may be admitted separately. A rejection cannot
regenerate the unchanged desired update on a timer, authority refresh or role change. Only a fresh
explicit ceremony producing newer desired evidence can authorize another usage update absent a
separately proven retry contract. Missing/changed references or stale completion plans do not clear
newer intent. Use the existing Replica revision guard; do not add a competing workflow revision or
request-body copy. No usage disposition authorizes recreating a removed credential.

### Hidden authority, teardown and recovery

[65's hidden-work contract](../issues/65-hidden-vault-durable-work-contract.md) applies to all private
credential/read material and usage targets. Existing all-generation Vault retirement erases every
matching visible usage association, including its Item/Vault mapping and any unaccepted desired
metadata. The independently retained floor contains only the concealed digest and counter; it is
non-authorizing local bookkeeping and cannot select, decrypt or sign with a hidden credential.
An already accepted ordinary Operation retains only its existing encrypted request/evidence under65.
It needs no new floor-origin field: while visible, the association's exact Operation ID and covered
revision match the existing receipt; after erasure there is no association for that receipt to revive.
Its later receipt cannot recreate an association erased by hiding. Unhiding alone also
does not restore old desired usage; a fresh explicit ceremony supplies new intent.

The same existing authoritative Item/retirement plans retire an association when its selected Item
or credential is removed, replaced or moved out of the exact recorded Vault scope. Erase the obsolete
unaccepted desired metadata and its association/receipt link; preserve the opaque floor and any
independently accepted immutable Operation. Do not move old desired usage to a new target or infer
new intent when the same credential later reappears at the same Item. A new explicit ceremony may
create a currently authorized association and still allocates above the preserved floor. This is
target retirement under the existing Replica owner, not another credential lifecycle registry.

Floors survive ordinary lock, sign-out, worker loss, Bootstrap replacement, Vault hiding and Item or
credential removal while this Account's local installation remains. An access incarnation is not
that installation's lifetime: [full Sign-in replacement](../../../packages/client-runtime/crates/bittery-client-core/src/runtime/install.rs)
matches canonical Server/User and reuses Account ID while allocating a new incarnation. The existing
[guarded installation](../../../packages/client-runtime/crates/bittery-client-core/src/replica/persistence_contract.rs)
already preserves accepted Operations/receipts while resetting Bootstrap. It must also preserve
every floor row and its inventory commitment under the same guarded `PreparedReplicaInstall`.
Their stable cryptographic identity requires no rewrapping or separate installation payload on an
access-incarnation change. The lookup identities and counts do not reset. A failed pre-commit replacement leaves the old
floor/head intact; lost replies use existing physical installation read-back and validate the new
inventory before admitting any assertion. Different canonical Server/User identities never merge.
Usage associations obey verified policy and current-authority gating through replacement; hidden
targets are erased and independently accepted ordinary requests remain immutable.

Reimporting the same
credential into that Account cannot lower the floor. Existing RemoveAccount and Device Wipe delete
the floor and its head commitment with the Account namespace. Do not retain an unrequested global
credential registry or copy a floor into an unrelated replacement Account. This local-lifetime rule
does not promise counter ordering between offline Devices or unavailable external copies.

Recovery treats floor evidence as non-disposable local state, not derived authority that Bootstrap
may rebuild. Before exporting a floor, the existing recovery owner authenticates its envelope,
Account boundary, keyed tag, digest/count and inventory coverage. The password-encrypted archive
may carry the validated stable digest and floor, with no raw RP/credential/Item/Vault mapping. On a
different Device the same recovery owner computes a destination tag and protected envelope under
the existing destination DeviceKey; it does not transfer that DeviceKey or add an index-key owner.
The destination max-merges every independently validated available floor for the same Account and
digest and rebuilds the head commitment in the guarded repair publication.

The existing [recovery coverage proof](../../../packages/client-runtime/crates/bittery-client-core/src/replica/recovery.rs)
currently separates exact accepted rows from derived authority. Add closed floor coverage to that
same proof and capture/repair pipeline: floor rows are neither disposable authority nor members of
the byte-identical `accepted_rows()` comparison. Validate the original source inventory and protected
rows before producing portable logical digest/count evidence; validate that evidence and its Account
boundary before destination retagging, envelope protection and max-merge. A changed DeviceKey can
legitimately change physical tags/envelope hashes, so source and destination physical hashes are not
the merge identity. Keep independently accepted Operations/receipts subject to their existing exact
set/byte comparisons. Missing expected floor coverage cannot authorize repair or Bootstrap publication
that resets it. Existing archive revision, Account/Server/User and accepted-work admissibility checks
remain intact; different-Device protection does not add an unrelated-Account recovery importer.

An older archive is not proof of an unavailable newer floor. Missing expected current floor evidence
remains explicit incomplete recovery, not permission to reset to the archive's lower count. The
normal exact accepted-Operation and receipt checks remain intact; counter max-merge cannot resurrect
acknowledged work. Archive usage associations never restore erased Item/Vault targets: preserve only
the currently valid local associations under their ordinary proof, while existing accepted encrypted
Operations remain their own recovery evidence. Explicit `.bttrx` export lifts the existing private
payload's `signCount` to the maximum available local floor; Import preserves that count and respects
any existing destination floor. No new persisted credential or `.bttrx` format is required.

For that explicit export, "available" does not permit a fallback to stored `signCount` when the
retained commitment proves that counter evidence is missing, malformed or cannot be authenticated,
including an unavailable required DeviceKey. The scoped export owner must fail rather than deliver
an apparently complete backup with a potentially lowered count; recovery reports the missing proof
through its existing incomplete classification. A legacy Account with no commitment and no floor
rows can still export its stored count. This check is added when75 extends the shared Export owner;
the preceding shared prerequisite does not invent a floor or silently strip private credentials.

The maintained matrix must include atomic floor/head loss points, missing-row detection, preservation
through every unrelated head transform, read-back after lost commit replies, concurrent duplicate credentials,
checked exhaustion, failed/uncertain commit with no signature, cancellation after successful commit,
read-only assertion, ordinary Item edits and usage competing for acceptance, newer desired usage
during an older outcome, terminal rejection without regeneration, hidden association erasure while
an accepted encrypted update survives, same-Account remove/reimport, Account/Wipe removal, and
same-identity full Sign-in after sign-out including failed replacement and lost installation replies,
same/different-Device recovery with exact available maxima and missing-floor refusal. Real SQLite
and IndexedDB histories are required; an in-memory count map is insufficient.
Include exact Item/credential removal, replacement and Move followed by reimport, proving that old
desired usage never revives while the floor and accepted requests survive. Export with witnessed
missing/unauthenticatable floor evidence must not return a complete `.bttrx` archive. Recovery
retag/max-merge must preserve the original accepted-row comparison and independently prove floor
coverage; neither a derived-authority rebuild nor an older archive may erase that requirement.

Capture the existing owner, Account incarnation/lock epoch and Vault authority for every ceremony.
Prompt cancellation, page abort/timeout, document loss and retired native authority cancel its
foreground work and make held responses ineligible. Cancellation after a committed registration
Operation does not discard accepted work; cancellation after a proposed reservation does not
return its count to a pool. The public ceremony response remains one-shot and live-context-only.

Service-worker recycle reconnects to the surviving offscreen owner under decision 41; it cannot
replay page commands. Actual Worker/offscreen/browser loss starts a Locked owner. Connected Desktop
Lock, disconnect and revocation use the already accepted native authority retirement path and
final-delivery guard. Locking one Account must not cancel another Account's ceremony. Fresh explicit
standalone unlock may authorize a new request where the existing native contract permits it; an
old prompt, native reply or signature never revives.

| Layer | Observable acceptance before cutover |
| --- | --- |
| Shared private/public surface | Persist a real ES256 credential; ordinary projections and broker/popup traffic contain no private key; unrelated Web/Desktop edits preserve it; explicit removal affects only its target; `.bttrx` round-trip signs with the same key; Share excludes passkeys. |
| Core matching and crypto | Existing matching/picker/status vectors plus exact multi-Account/duplicate credential identity; existing registration/authenticator bytes and signature verification; no supported-algorithm regression or fabricated UV claim. |
| Accepted durable ordering | Concurrent assertions, failed local reservation, read-only Vault, restart, remote higher/lower count, terminal Item conflict, cancellation on either side of commit and checked exhaustion; actual SQLite and IndexedDB durability, not only a fake map. |
| Browser boundary | Real page create/assert/native fallback, matched and mismatched browser context, prompt close/abort/timeout and held reply, exact document replacement and navigation binding; no host private key or unbound selection. |
| Owner/native isolation | Surviving owner after broker recycle; Locked owner after Worker/document/browser loss; actual connected Desktop Lock/disconnect with held result and an unaffected second Account. |

Existing [handler tests](../../../apps/extension/tests/background/passkey-handlers.test.ts) cover
helper matching/selection cases. They are not real-page, durable-write, cancellation or restart
acceptance. Run Extension test files in separate Bun processes. Real Chromium production acceptance
belongs to [ticket 77](../issues/77-extension-production-acceptance.md), after the production caller
cutover; mock handlers or a desktop-native socket harness cannot establish it.

## Implementation order

1. Complete the reviewed shared metadata/edit/scoped Import-Export prerequisite, ticket95;
   it preserves existing Web/Desktop behavior before Desktop caller cutover and Extension consumption.
   It is independent of74/75;75 depends on it, never the reverse.
2. Complete Desktop acceptance 73, then the independently specified offscreen composition 74.
   No Extension production implementation starts on this research artifact.
3. Implement the smallest Core ES256 create/assert path with generated closed controls, private
   matching, the decided durability ordering and foreground cancellation; widen existing matching,
   multi-Account and authority variants only after that path passes.
4. Cut over the actual Extension callers in 76 and run the real production acceptance in 77.

Ticket75 retains its dependencies on74 and95. The shared prerequisite and this capability are ready
with incomplete dependencies after independent and coordinating review of the concrete controls,
browser-fact integration and acceptance mapping above. Implementation waits for those dependencies;
no status here claims implementation or production acceptance.
