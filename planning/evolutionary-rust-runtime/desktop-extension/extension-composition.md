# Extension owner and trusted caller composition

This is the reviewed concrete contract for [ticket74](../issues/74-extension-offscreen-runtime-composition.md),
under accepted [placement41](../issues/41-extension-runtime-placement-decision.md) and
[Chrome scope62](../issues/62-extension-browser-acceptance-scope.md). It records source inspection and
routine binding choices after independent review. No Extension implementation or actual Chrome
acceptance is claimed. Desktop acceptance73 precedes implementation.

## Existing owners and the assembly boundary

The packaged [background entry](../../../apps/extension/src/background/index.ts) imports a legacy
Runtime, Desktop Sync and Account/Item owners before its startup function. Its
[router](../../../apps/extension/src/background/router/index.ts) ignores `MessageSender` and validates
only a message discriminant. [Lifecycle](../../../apps/extension/src/background/services/service-worker-lifecycle.ts)
restores live keys on every service-worker start. [Storage](../../../apps/extension/src/lib/storage.ts)
instantiates AccountStore/ItemCache in both popup and background realms. These are actual replacement
targets, not reusable authorization or reattachment mechanisms.

Reuse the completed Web [Worker service](../../../packages/client-runtime/src/web/worker-entry.ts),
[shared Worker owner](../../../packages/client-runtime/src/worker/owner.ts), generated Runtime protocol
and [RuntimeTransport](../../../packages/client-runtime/src/client/transport.ts). The latter already
separates request/observe/unobserve/caller-close from Runtime policy. Deepen the shared composition
with host primitives; do not copy its Runtime construction, cancellation, storage recovery or Sync
loop into an Extension-specific implementation. Web's
[DOM storage executor](../../../packages/client-runtime/src/web-platform-storage-host.ts) cannot be
used unchanged: the Extension needs the existing Chrome storage lifetimes below.

| Location | Owned resources and allowed work |
| --- | --- |
| Dedicated Worker | The one combined WASM instance, Core Runtime, live keys, Replica, Operations, Sync, recovery and Account policy. Reuse IndexedDB physical executors and ordinary Worker HTTP/timer primitives. |
| Offscreen document | One Worker construction promise/owner, private Worker RPC channel, broker attachment and caller-route registrations. Retain no independent Account/session snapshot or unlocked restoration state. |
| Service worker | Authenticate browser senders, discover the offscreen document, route caller traffic and perform closed Chrome/native primitives. No key import, Item decrypt, credential matching, request retry, Session renewal or policy interpretation. |
| Popup/full product UI | One shared RuntimeClient over a connection-scoped transport; active Account is a UI pointer reconciled by existing shared session derivation. No Worker, AccountStore or raw storage/crypto bridge. |
| Content script and embedded prompt | Only the registered feature/call capability for their exact document and gesture. A web-accessible Extension iframe is not a full product UI merely because its URL has the Extension origin. |

The Worker package may retain a private combined crypto channel required by existing assembly, but
it is not exposed over Chrome messages. Future callers use the closed Runtime capabilities; there is
no Extension `crypto.invoke`, arbitrary `KeyRef`, plaintext private-key or Session-token projection.
The offscreen entry and Worker assets are not web-accessible resources.

## Startup, discovery and attachment

Add the already accepted `minimum_chrome_version: "116"`, `offscreen` permission and static packaged
offscreen entry to the [release manifest](../../../apps/extension/manifest.config.js). Use reason
`WORKERS` and a bundled module Worker with the bundler-recognized literal `new Worker(new URL(...))`.
Do not introduce an audio keepalive, a hidden tab, periodic traffic or a second owner when startup is
slow. Chrome's [offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
allows only the runtime Extension API in that document; `getContexts()` is available at the accepted
minimum whereas `offscreen.hasDocument()` requires a newer browser.

One broker-local readiness promise serializes discovery and creation using `getContexts` restricted
to the exact packaged URL and current browser profile context, without a context-type filter. Zero
matches permits creation; before admission require exactly one match whose actual type is
`OFFSCREEN_DOCUMENT`. A same-URL tab/popup or duplicate frame is explicit unavailability. A creation race/failure is followed
by rediscovery, not blind repeated construction. The discovered document itself owns one Worker
promise, so replacing the broker cannot construct another Worker in a surviving document. A hung
or malformed handshake is an explicit unavailable owner, not evidence that it is safe to launch a
second one. Replacement requires actual owner teardown/absence and the existing storage-open fence.

One logical private attachment uses two unidirectional Chrome Ports: the broker opens the command
Port received by the offscreen document, and the document opens the return Port received by the
broker. Only each receiver's `onConnect` supplies `Port.sender`; do not claim that the initiating
Port authenticates its remote peer. Both receiving registrations validate actual Extension identity
and the exact compiled sender role/URL, then pair the halves using one fresh handshake correlation
and owner/broker generation. Accept payloads only on the authenticated receiving half; ignore
reverse-direction data. Either half's loss retires the one bounded attachment record exactly once
under its generation guard. This is not two caller registries or another Runtime owner.
[Chrome Port sender](https://developer.chrome.com/docs/extensions/reference/api/runtime#type-Port)

Chrome may deliver connection events to multiple Extension contexts. Only the intended compiled
entry installs the private receiver; popup, prompt and content routes cannot opt in by port name or
payload `role`. Registration and pairing complete before any primitive or caller payload is sent.
No confidentiality claim is made against compromised trusted Extension code, which already has
the browser-profile storage boundary. Initial/disconnect-triggered attachment is event-driven,
with no periodic ping, semantic request retry or residency promise.

Pinned Chrome116 source requires an explicit non-tab distinction. Its
[Worker IPC sender](https://chromium.googlesource.com/chromium/src/+/116.0.5845.96/extensions/renderer/ipc_message_sender.cc)
supplies the service-worker script URL, initialized by
[Dispatcher](https://chromium.googlesource.com/chromium/src/+/116.0.5845.96/extensions/renderer/dispatcher.cc).
The [receiver](https://chromium.googlesource.com/chromium/src/+/116.0.5845.96/extensions/renderer/api/messaging/native_renderer_messaging_service.cc)
omits absent document fields. [MessageService](https://chromium.googlesource.com/chromium/src/+/116.0.5845.96/extensions/browser/api/messaging/message_service.cc)
and [Chrome's tab mapping](https://chromium.googlesource.com/chromium/src/+/116.0.5845.96/chrome/browser/extensions/api/messaging/chrome_messaging_delegate.cc)
also mean a non-tab offscreen sender can lack `documentId`. Do not demand one from the broker or
invent one for offscreen authentication. Bind its received exact packaged URL/no-tab identity to
the unique current `getContexts` offscreen context and pair correlation; if a document ID is supplied
it must agree. Refuse ambiguous matching contexts or a changed context during handshake. Rediscovery
and handshake completion recheck the captured context before admission; an old half cannot be rebound
to a replacement document at the same URL. Real116 acceptance must exercise these actual optional
fields and replacement races. Tab/content registrations still require the real document identity.

The pinned [getContexts implementation](https://chromium.googlesource.com/chromium/src/+/116.0.5845.96/extensions/browser/api/runtime/runtime_api.cc)
enumerates the Extension's RenderFrameHosts, maps the actual tab/popup/offscreen view type, and
returns context/document/frame identities and committed URL before applying the requested filter.
This supports the unfiltered-type, exact-URL uniqueness check above, including relevant child frames;
unsupported browser context classes are not admitted by this contract.

At offscreen module evaluation, create only its private one-time document nonce and attachment
listener. Do not construct the Worker unconditionally. An initial `Offer` reports that nonce and
whether a Worker already exists. The broker authenticates the received sender, resolves the unique
offscreen context, and returns `AdmitPair` with the same nonce, captured context/document IDs and
broker generation. Both halves must be paired and the browser context rechecked before first Worker
construction. `Opening`/`Ready` then bind the resulting owner generation into that same attachment.
A surviving owner's handshake retains its existing generation instead of constructing another.
A manually opened offscreen asset, duplicate context, stale nonce or replaced half cannot reach
Worker construction; it stays unavailable. Neither the nonce nor browser context records contain
keys or durable admission state.

The handshake reports a protocol version, nonsecret Worker-owner generation and startup state
`Opening`, `Ready` or existing typed startup failure. A new broker gets a new attachment generation;
the surviving Worker retains its owner generation. No Account access, Session or queued mutation is
reconstructed from the handshake. A failed-open Runtime remains the same existing recovery/Wipe
owner; reattachment must not hide that failure by silently resetting storage.

Before `Ready`, the common [profile admission91](profile-handoff.md) and normal Runtime open must
finish their required gates, including incomplete admission/reset and old cleanup. Normal browser
feature, native-import and plaintext caller activation waits. Status and the already specified
admission/recovery/Wipe controls remain available through the same startup owner. Extension Session
loss follows91; neither broker recycle nor offscreen creation runs legacy session restore.

Ticket74 compiles the exact future production broker/offscreen/Worker entries as packaged assets;
the ordinary release manifest retains its existing entry until76. For bounded assembly acceptance,
the existing persistent-Chrome harness copies that build into an isolated temporary package. It makes
two named fixture mutations: select the future broker and omit legacy content auto-entry registrations
in the temporary manifest while retaining its genuine popup route; substitute the boot content of
the genuine compiled `popup.html` with the actual production RuntimeClient/transport bootstrap,
omitting legacy UI/store imports.
It does not implement a test broker, Worker, Runtime, alternate policy mode or fallback application.
No legacy owner module is loaded in that profile.

The probe context runs the actual shared RuntimeClient and future production transport from the
genuine popup URL/context. Its bootstrap module is shared with the eventual migrated existing popup
and imports no legacy owners. The unchanged strict production caller classifier admits that route;
tests add no never-shipped trusted test URL, allow-anything role or arbitrary evaluated full-UI page.
Where the future full-UI
shell is not yet mounted, the fixture drives its real transport entry and tests that exact compiled
role, and separately proves wrong URLs, embedded contexts and forged roles are refused. This is
assembly/transport evidence, not a claim that the complete popup has migrated.

[Caller cutover76](../issues/76-extension-production-caller-cutover.md) selects those same entries in
the ordinary manifest and switches all imported owner modules and registered routes together after
their capabilities are complete.77 must load the unmodified full production HTML and manifest and
real popup/content gestures. Both fixture substitutions are test-owned packaging only, never shipped or
selected by a product setting. An unimplemented feature cannot invoke legacy crypto/storage/Sync
as a Runtime fallback, and new and legacy owners never run over one profile together.

## Closed routing and caller capabilities

Generate the Extension control envelope under ADR0012 alongside the existing Runtime/native
contracts. It carries canonical JSON strings over Chrome ports; the existing private Worker channel
continues using its audited structured-clone wire. Chrome's
[message transport](https://developer.chrome.com/docs/extensions/develop/concepts/messaging) uses JSON,
so File, ArrayBuffer, class instances, transferable ownership and arbitrary Worker messages must not
be presumed portable through it. Binary host capabilities, when used by their own feature slice,
must keep their existing bounded generated chunk/encoding contract and lifecycle; do not embed a
general binary/file/Fetch escape hatch in74.

Established routing records contain `version`, `ownerGeneration`, `brokerGeneration`, `connectionId`,
and a connection-local request or observation ID. All identities are bounded strings, not unbounded
JSON numbers; reject unknown fields and malformed generated variants. The owner mints connection IDs after trusted sender
registration; callers cannot select another route's identity. The closed operations are
`AttachCaller`, `Request`, `Cancel`, `Observe`, `Unobserve`, `DetachCaller`, and their typed
reply/projection/error forms. `AttachCaller` is private broker-to-owner control carrying authenticated
sender facts plus the owner/broker binding; it returns the new connection ID and admitted caller
class. It is not a public Runtime command. A pending duplicate request/observation ID is rejected;
completed IDs cannot be reused within that connection. It never creates a second Core request or
replaces the active cancellation token. Bounded monotonic counters may exhaust by closing the
connection rather than keeping an unbounded historical request registry. The transport assigns
these wire sequences and maps the existing RuntimeClient's opaque IDs; it does not change the
shared client interface or mistake an Operation ID for transport correlation.

The owner registers a closed caller class from those facts:

| Caller class | Maximum admitted surface |
| --- | --- |
| Full UI | Existing generated Runtime requests/observations used by the compiled popup/product entry, subject to all Core Account and foreground guards. A sender's self-declared class cannot grant this surface. |
| Page feature | Only that generated feature's public intent/cancel/result controls. Passkeys use75's closed ceremony controls; autofill/capture use76's feature mapping and79's own-Replica authority. No raw full-Items, arbitrary Runtime request or private primitive forwarding. |
| Embedded prompt | Only the existing prompt's opaque selection/cancel capability and display projection, bound to its opening page ceremony and prompt revision. It cannot attach a full-UI connection or select an unrelated ceremony. |

Full-UI registration additionally proves the compiled top-level product context (popup or allowed
top-level Extension page), not just its URL/origin. The web-accessible prompt/frame inventory never
inherits that permission. Preserve the packaged incognito mode: do not enable split-incognito or
add another owner merely because an initiating tab is incognito. Route through the browser's actual
profile/context placement and reject mismatched bindings.

The generated endpoint's Core binding validates caller class and capability; the broker validates
sender/transport shape without repeating RP, Vault, Account, role, credential selection or Item
admission policy. Feature controls not yet defined by their dependent slice are unavailable, not
opaque arbitrary payloads. This transport contract does not claim76's caller inventory is complete.

Offscreen routing prefixes/remaps external IDs into one private Worker RPC namespace and installs
each cancellation/observation registration before dispatch. One caller cannot cancel another's
matching numeric ID. The shared request/observation owner remains responsible for Core invocation;
reuse the [native connection lifetime](../../../apps/desktop/src-tauri/src/runtime_host/connection.rs)
semantics rather than adding an Extension operation scheduler. A transport-close implementation
closes only that caller, never the shared Worker Runtime. Runtime shutdown belongs to actual owner
retirement or explicit complete Device lifecycle.

Replies and projections are sent only through the still-current owner/broker/connection binding.
Core checks its existing foreground delivery guard at owner emission; each browser hop checks the
exact live route and preserves observation/retirement order. Browser code does not recreate a Core
guard or claim to recall plaintext already handed to a live caller. Closed feature ceremonies such
as75 additionally require their specified final Core/context check and exact page delivery guard.
There is no reply cache across detachment. Losing a reply after Core
acceptance does not undo the Operation or justify resubmitting the UI command. A reattached UI opens
fresh observations and learns its current outcome from ordinary Replica/Operation projections.

## Private primitives and exact document facts

Only the Worker-originated reverse-RPC lane can request platform operations. Its closed selectors
delegate generated PlatformStorage operations to Chrome: DeviceRecord and DeviceSecret use the
existing profile-local storage (`devicePlain` and `deviceSecret`), while `sessionSecret` uses
`chrome.storage.session`. It is still the
[existing browser-profile secret boundary](../../../packages/storage/src/adapters/chrome.ts), not
an OS keychain or new live-key capsule. Preserve empty strings versus absence, reject malformed
stored values and restrict namespace deletion to Core-owned keys. Account interpretations and
serialization stay in Core. Browser restart/update may erase SessionSecret; broker recreation does
not. Do not copy it into persistent storage to avoid that lifetime.

Chrome storage access levels apply to the whole `local`/`session` area, not a Runtime namespace.
Set these existing areas to `TRUSTED_CONTEXTS` before new source/caller activation at atomic cutover,
preserving trusted91 admission access. Full legacy caller closure is a prerequisite for that switch.
The shared API is available in the accepted Chrome range; actual restriction is part of acceptance.
This does not pretend to isolate secrets from all trusted Extension code.
[Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage)

The inspected [content entry](../../../apps/extension/src/content-script/init.ts), passkey bridge,
autofill/capture/detection modules and their messaging/field-detection imports contain no direct
Chrome storage reader. Existing content data and pending-save restoration already use broker
messages. [Overlay theme](../../../apps/extension/src/lib/theme.ts) is a separate nonsecret DOM
`localStorage` preference/cache with storage/media listeners in trusted Extension iframe documents;
changing Chrome storage access levels must not replace or break that behavior.76 repeats the import
closure at activation. If another actual content preference reader exists by then, move only its
closed nonsecret preference snapshot/change notification through the existing presentation broker
before restricting the area. Never expose arbitrary storage keys, Account records or secret material
as a preference fallback. Test saved autofill/capture behavior and live overlay theme after restriction.

The browser-facts lane is one generated reverse capability used by
[passkey75](passkeys.md#reviewed-browser-context-correction-and-feasibility), not a page message that
asserts an origin. The broker records authenticated `MessageSender` Extension/profile/tab/frame/
document identity when the trusted isolated content entry opens its Port. A fresh probe travels
over that registered exact-document Port and returns through its private listener, carrying Core's
single-use correlation and the live isolated activation generation. No injected function is expected
to access another function's closure; no second scripting probe/fact registry is introduced.
`documentLifecycle` at original port creation is not current proof.
[Chrome sender identity](https://developer.chrome.com/docs/extensions/reference/api/runtime#type-MessageSender)

The trusted isolated entry captures the native origin/ancestor, secure-context, effective-policy
and user-activation getters in its own world and reads them afresh for each probe. It retains its
activation generation and unconsumed probe correlation in its private closure, never on a DOM
attribute, page-visible message or MAIN-world property. A page
may initiate its supported ceremony but cannot register a context, submit probe results or replace
the broker's authenticated identity. Core receives the frozen challenge/options separately from
trusted context facts and owns origin/RP/permissions interpretation as75 specifies. Fresh probes
at begin, selection and final release run outside Account execution and revalidate on return.
[Chrome isolated worlds](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts#work_in_isolated_worlds)

`pagehide`, actual document departure, BFCache suspension/restore and connection replacement retire
that activation/caller generation; an unchanged `documentId` on BFCache return is not permission to
reuse it. Late probe results, prompt selections or terminal answers from an old generation cannot
bind to a new connection. A broker reattachment never rebinds an old ceremony. Final page delivery
uses the exact live port/document and page request generation, including nested frame paths.

Native messaging is another private primitive lane. The broker holds the actual `connectNative`
port and transports only the generated68 frames, cancellation and connection events. The same
Worker Core owns native challenges/import, Desktop source identity and generation checks. Adapt the
WASM binding to that existing Core owner; do not reconstruct native authority with TS status or
persist a transfer reply for later import. No general key export endpoint is introduced.

## Loss, reattachment and native authority

| Event | Exact disposition |
| --- | --- |
| Popup/content caller disconnect | Cancel that connection's unaccepted foreground work, observations, prompt and host grants. Independently accepted Operations survive. Other callers and standalone Account unlock remain live. |
| Broker attachment disappears, Worker survives, standalone | The offscreen owner immediately detaches old broker-scoped callers and reverse primitive requests; it preserves the Runtime and its live keys. A fresh authenticated broker handshake opens new connections/observations. No replay or implicit unlock. |
| Broker attachment disappears with an associated native channel | Retire that existing native channel in Core immediately because the owning broker/native port can no longer supply authority. This happens even if the onDisconnect callback was lost with the broker. The surviving Runtime remains the owner;68's connected Account retirement takes effect. A new native port is a new channel with fresh protocol/import, not a reattachment to old grants. |
| Actual native port EOF/disconnect, broker survives | Forward exact channel loss to Core before any replacement channel can authorize. Reject held frame/biometric replies from that generation. Keep unrelated Accounts under existing68 rules. |
| Actual Worker/offscreen loss | Drop every old route/probe/grant. Open the same durable Replica with a new locked Runtime after normal startup/admission. No SessionSecret-based automatic live-key restoration. Existing Core eligibility permits exact accepted ciphertext dispatch/reconciliation while locked with a usable Session; preparation requiring live keys waits for supported unlock. The host adds no blanket unlock gate. |
| Extension reload/update or browser restart | New owner and broker generations; locked startup, preserved encrypted Device state and supported QuickUnlock, ordinary SessionSecret loss. Complete91 reconciliation first where required. |

The closed exception to caller-disconnect cancellation is76's
[registered capture handoff](extension-cutover.md#capture-scope-and-navigation-handoff). On its
source document's departure or broker detachment, retire every old route, prompt, probe and host
grant normally. Only the already-registered unaccepted capture intent may remain in the same
surviving Core owner, for its original Account and original30-second deadline, while an authenticated
successor in the same browser profile/tab claims it. This includes preparation before presentation.
Claiming creates a fresh live document binding and prompt revision; it never restores old route
authority, changes the captured Account, resets the deadline or resumes another feature's work.
Account retirement/selection departure, tab closure, cancellation, expiry and actual Core owner loss
still retire that intent. Broker recycle is not permission to reconstruct it from host storage.

Broker loss therefore preserves standalone unlock, but does not suppress an actual native-port loss
to claim that a connected Account must remain unlocked. No timer/heartbeat decides whether a known
native channel is alive. Endpoint failure is an explicit unavailable primitive; the existing Core
retry/reconnect owner decides eligible semantic work. Reverse requests interrupted by broker loss
return failure/cancellation to that owner, not a fabricated success or broker-side replay.

Worker loss detection is bounded by the actual platform signals. The existing shared Worker owner
handles `onerror`, `onmessageerror` and explicit close/failure, rejects outstanding requests, drains
its host cleanup and calls the real `Worker.terminate()`; its failed instance is not automatically
reused. A new factory can construct a replacement only after that termination/cleanup boundary is
known complete, or after the old offscreen document is actually gone and fresh discovery/admission
permits construction. Reuse this path, including unavailable cleanup, rather than adding a second
automatic Worker-recovery loop.

A dedicated Worker has no universal public close event, and silent browser/debugger termination is
not promised to emit `onerror` or disconnect the surviving offscreen/broker Port. If a current request
or readiness handshake times out, report unavailable and cancel that caller; do not infer the Worker
is dead and launch another. An unresponsive owner remains unavailable until its existing shutdown
can prove termination or actual document loss/replacement supplies that proof. No heartbeat or
synthetic restored state fills this gap. Actual known termination and unresponsive-owner refusal are
separate acceptance cases, not interchangeable mock events.

## Dependency-ordered evidence

74 first proves the owner/transport with actual packaged Chrome and generated status/read/request
paths against a fresh isolated profile. It can test capability rejection without implementing75 or
the full76 migration. Actual passkey, autofill, capture and production-native gestures remain in
their dependent capability/acceptance tickets. No74↔75 cycle or Desktop-before-Extension exception
is required. Record the tested browser build separately from the minimum manifest version.

| Acceptance | Required observation |
| --- | --- |
| Release assets/minimum | Load the declared temporary assembly package built from production assets in a persistent Chrome116 profile and a current supported Chrome, recording both fixture mutations above; packaged Worker/WASM/CSP paths work with no remote asset or newer-only API.77 owns the unmodified full release package. |
| Concurrent wake | Popup and multiple actual frame callers race first wake; one document, one Worker, one Core owner and one Replica admission exist. Duplicate IDs are scoped/refused. |
| Surviving owner | Terminate the actual service worker after standalone unlock; owner identity and unlock survive, old callbacks fail, new observations work. No restored MUK or accepted-command replay. |
| Independent owner loss | Exercise a known completed Worker termination through the existing owner and actual offscreen destruction separately; permitted replacements are locked and reject stale replies/probes. Separately terminate/hang a Worker without a guaranteed host signal: caller becomes unavailable and no second Worker starts before proven teardown. Encrypted Replica/accepted work survive; frozen work follows Core eligibility and key-dependent preparation waits for unlock. |
| Native authority | Actual browser native port plus Desktop; broker death, native EOF, Desktop Lock/revocation and held biometric reply follow68. Include an unaffected second Account. |
| Trusted lanes | Page/embedded iframe/full UI cannot forge offscreen registration, primitive request, full-UI role, another connection ID or probe answer; raw storage is unavailable to content scripts. |
| Exact documents | Real authorized and denied frame paths, navigation, same-document/BFCache changes, prompt replacement and delayed probes cannot cross caller generations.75 supplies the complete origin/create/get matrix. |
| Admission/recovery | Populated91 profile, interrupted admission/reset, missing SessionSecret and malformed Replica preserve startup gates and supported Wipe. No legacy owner runs beside the Worker. |
| Durable versus foreground | Kill callers/broker/owner with accepted work and held plaintext separately; durable effects survive, retired foreground responses cannot disclose, reconnect does not resubmit UI commands. |

Root CI and existing Worker unit tests support this work but do not load an Extension or establish
Chrome lifecycle/native behavior. Firefox/Safari and untested Chromium brands retain62's stated
limits. Independent review establishes contract readiness; implementation requires completion of
the existing dependency gates. Neither establishes actual application acceptance.
