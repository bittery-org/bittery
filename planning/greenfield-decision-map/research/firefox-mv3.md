# Firefox MV3 versus Chromium MV3, for a password-manager extension

Produced by a subagent resolving ticket 03
(`planning/greenfield-decision-map/issues/03-firefox-mv3-parity-facts.md`).
Every source below was fetched and read on **2026-08-20**. Status: evidence. Facts only. This file
makes no decision and gives no recommendation.

Where a primary source could not be found, the text says **unverified** and names what was searched.

Primary sources used: MDN WebExtensions docs and their source Markdown in `mdn/content`; MDN
`browser-compat-data` (BCD) JSON, which is the dataset that generates every MDN compatibility table;
`mozilla-central` source and in-tree docs on `hg.mozilla.org` and `searchfox.org`; Bugzilla REST;
Mozilla Extension Workshop; the Mozilla Add-ons blog; Chrome for Developers extension docs; and W3C
WebExtensions Community Group (WECG) issues.

BCD at retrieval already carries entries up to Firefox 153 and Chrome 152. Version numbers below are
"support added in", not "current release".

---

## Firefox MV3 background model: event pages versus service workers, termination, persistent background

**Firefox has no extension service worker. It runs MV3 background code as a non-persistent
background page (an event page).**

- MDN states it plainly: "Firefox: `background.service_worker` is not supported (see Firefox bug
  1573659). supports `background.scripts` (or `background.page`) if `service_worker` is not
  specified or the service worker feature is disabled." Before Firefox 120 the background page did
  not start when `service_worker` was present; "From Firefox 121, the background page starts as
  expected, regardless of the presence of `service_worker`."
  Source: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background`
- BCD agrees: `manifest.background.service_worker` — chrome 88, firefox `false`.
  Source: `https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/manifest/background.json`
- The tracking bug is still open. Bugzilla bug 1573659, "[meta] Background Service Worker for
  Manifest v3": `status: NEW`, `resolution: ""`, `priority: P3`, `severity: S3`,
  `last_change_time: 2026-08-12`.
  Source: `https://bugzilla.mozilla.org/rest/bug?id=1573659`
- Mozilla says the divergence is deliberate: "Safari also supports event-driven background scripts;
  however, Chromium has adopted service workers instead."
  Source: `https://extensionworkshop.com/documentation/develop/manifest-v3-migration-guide/`

**Persistent background is gone in MV3 on both engines.** `background.persistent` "defaults to
`true` in Manifest V2 and `false` in Manifest V3. Setting to `true` in Manifest V3 results in an
error." Firefox supports persistent and non-persistent pages for MV2 from Firefox 106; MV3 is always
non-persistent.
Sources: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background`,
`https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/manifest/background.json`

**Firefox termination rules (read from the implementation, not from prose):**

- The idle timeout is the pref `extensions.background.idle.timeout`, default **30000 ms**, clamped by
  the code to "Minimum 100ms, max 5min".
  Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/toolkit/components/extensions/parent/ext-backgroundPage.js` (lines 27-35)
- In-tree docs describe the timeout as "how long to wait (between API events being notified to the
  extension event page) before considering the Event Page in the idle state and suspend it".
  Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/toolkit/components/extensions/docs/events.md`
- `terminateBackground` refuses to suspend the event page when any of these hold
  (`ext-backgroundPage.js`, lines ~856-960):
  1. DevTools is attached to the extension.
  2. `backgroundContext.hasActiveNativeAppPorts` — a native messaging port is open or a
     `sendNativeMessage` reply is pending. The in-code comment: "Similar to what happens in recent
     Chrome version for MV3 extensions, extensions non-persistent background scripts with a
     nativeMessaging port still open or a sendNativeMessage request still pending an answer are
     exempt from being terminated when the idle timeout expires."
  3. `pendingRunListenerPromisesCount` — a promise returned from an API event listener has not
     settled. This resets the idle timer once.
  4. An active `StreamFilter` exists (needs `webRequestBlocking`).
  Then it fires `runtime.onSuspend` and suspends.
- Listener registration survives suspension. Firefox stores "Persisted Event Listeners" in the
  StartupCache and creates "Primed Event Listeners" that wake the event page.
  Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/toolkit/components/extensions/docs/events.md`
- `runtime.onSuspend` / `onSuspendCanceled` exist in Firefox from 100, but BCD notes: "This event
  does not fire until Firefox 106, when event pages are available."
  Source: `https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/runtime.json`
- If the extension process crashes, "non-persistent background scripts ... are not reloaded. However,
  they are restarted automatically when Firefox calls one of their WebExtensions API events
  listeners."
  Source: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts`

**Chromium termination rules, for comparison:** the service worker stops "After 30 seconds of
inactivity. Receiving an event or calling an extension API resets this timer"; "When a single
request, such as an event or API call, takes longer than 5 minutes to process"; "When a `fetch()`
response takes more than 30 seconds to arrive". From Chrome 114 "Sending a message with long-lived
messaging keeps the service worker alive. Opening a port no longer resets the timers." And:
"Connecting to a native messaging host using `chrome.runtime.connectNative()` will keep a service
worker alive."
Source: `https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle`

**What the event page gives that a service worker does not:** "Background scripts run in the context
of a special page called a background page. This gives them a `window` global, along with all the
standard DOM APIs provided by that object." Firefox's exception: `alert()`, `confirm()` and
`prompt()` do not work in background pages.
Source: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts`

---

## API gaps and behavioural differences: storage, alarms, native messaging, offscreen, declarativeNetRequest, content-script timing

All version data in this section comes from BCD JSON, fetched 2026-08-20 from
`https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/`.

### `storage`

| Item | Chrome | Firefox |
| --- | --- | --- |
| `storage.session` | 102 (quota was 1 MB before 112) | 115 |
| `storage.session.QUOTA_BYTES` | 102 | 131 |
| `storage.session.getBytesInUse` | 102 | 131 |
| `storage.session.setAccessLevel` | 102 | **`false` — not supported** |
| `storage.StorageArea.setAccessLevel` | 96 (all areas from Chrome 140) | **`false`** |
| `storage.local.getBytesInUse` | 19 | 144 |
| `storage.StorageArea.getKeys` | 130 | 143 |
| `storage.managed` | 33 | 57, with caveats: "Platform-specific storage backends, such as Windows registry keys, are not supported"; "Enforcement of extension-provided storage schemas is not supported"; "The `onChanged` event is not supported" |
| `storage.sync` | 19 | 53 (quota limits not enforced before 79) |

`storage.session` semantics are the same on both: "Items in `session` storage are stored in memory
for the duration of the browser session and are not persisted to disk", limit 10 MB, and "By default,
session storage is not exposed to content scripts".
Source: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/session`

Consequence for a vault session: on Chromium you can widen or narrow content-script visibility of
`storage.session` with `setAccessLevel`. On Firefox you cannot call it at all; the default
(background-only) is the only behaviour available. Firefox has no documented way to expose session
storage to content scripts.

### `alarms`

Both engines support the whole `alarms` surface (Chrome 22, Firefox 45), so the API shape is equal.
The behaviour differs:

- Chrome clamps: "In Chrome, unless the extension is loaded unpackaged, alarms do not fire more than
  once every 30 seconds. ... Before Chrome 120, this limit was one minute." MDN attributes this
  clamp to Chrome only and states no Firefox equivalent.
  Source: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/alarms/create`
- Chrome limits alarm count: "From Chrome 117, alarms are limited to 500 per extension. From Chrome
  150, alarm names are limited to 1024 bytes." BCD records no matching Firefox limit.
- MDN's advice for both is the same: "DOM-based timers, such as `setTimeout()`, do not remain active
  after an event page has idled. Instead, use the `alarms` API if you need a timer to wake an event
  page."
  Source: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts`

A Firefox minimum alarm period is **unverified**: searched the MDN `alarms.create` page, the MDN
`alarms` page and BCD `alarms.json`; none states a Firefox clamp.

### Native messaging

Available on both (`runtime.connectNative` chrome 29 / firefox 50; `sendNativeMessage` chrome 29 /
firefox 50). Both engines keep the background context alive while a native port is open. Details are
in the "Native messaging on Firefox" section below.

### Offscreen documents

- **Chrome-only.** `chrome.offscreen` is "Chrome 109+ MV3+".
  Sources: `https://developer.chrome.com/docs/extensions/reference/api/offscreen`,
  `https://developer.chrome.com/docs/extensions/reference/api`
- MDN does not document an `offscreen` API. `.../webextensions/api/offscreen` returns HTTP 404, and
  BCD has no `webextensions/api/offscreen.json` (raw fetch returns 404). BCD's `webextensions/api`
  directory listing contains no `offscreen` and no `webAuthenticationProxy` entry.
  Source: `https://api.github.com/repos/mdn/browser-compat-data/contents/webextensions/api`
- WECG issue 170 "Proposal: Offscreen Documents for Manifest V3" is open, labelled
  `implemented: chrome` and `neutral: safari`. There is **no Firefox position label** on the issue.
  Source: `https://github.com/w3c/webextensions/issues/170`
- On that thread, Apple's WebKit representative states the workaround for the other engines: "In
  Firefox, like Safari, you can use background `scripts` or `page` with v3 still."
  Source: same issue, comment by `xeenon`, 2025-10-02.
- Firefox needs no offscreen document for DOM work, because the event page is a document with a
  `window` and DOM APIs (see previous section). It does need one in Chromium.

### `declarativeNetRequest`

- Firefox has it from 113; Chrome from 84. Firefox additions track later: `updateStaticRules`,
  `getDisabledRuleIds` and `MAX_NUMBER_OF_DISABLED_STATIC_RULES` from Firefox 128.
- Not implemented in Firefox: `getMatchedRules`, `onRuleMatchedDebug`, `setExtensionActionOptions`,
  `GETMATCHEDRULES_QUOTA_INTERVAL`, `MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL`,
  `MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES`, `MAX_NUMBER_OF_UNSAFE_SESSION_RULES`, the
  `responseHeaders` / `excludedResponseHeaders` rule conditions, and the `webbundle` and
  `webtransport` resource types.
  Source: `https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/declarativeNetRequest.json`
- Firefox-specific ordering: "After rule priority and rule action, Firefox considers the ruleset the
  rule belongs to, in this order of precedence: session > dynamic > static rulesets. This cannot be
  relied upon across browsers." The debugging APIs "are only available after setting the
  `extensions.dnr.feedback` preference to `true`".
  Source: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest`
- **Firefox keeps blocking `webRequest` in MV3; Chromium does not.** BCD on the
  `webRequestBlocking` permission: chrome 17 with the note "In Manifest V3, no longer available for
  most extensions (the exception being policy-installed extensions). Use the `declarativeNetRequest`
  API instead"; firefox 48 with no MV3 restriction. Firefox also has two permissions Chrome lacks:
  `webRequestFilterResponse` (firefox 110) and `webRequestFilterResponse_serviceWorkerScript`
  (firefox 95); `webRequest.filterResponseData` and `StreamFilter` are firefox 57, chrome `false`.
  Sources: `https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/manifest/permissions.json`,
  `https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/webRequest.json`
- Mozilla states the policy directly: "The webRequest API is not on a deprecation path in Firefox."
  Source: `https://blog.mozilla.org/addons/2024/06/13/manifest-v3-updates-landed-in-firefox-127/`

### Content-script injection timing

- **Injection into already-open tabs differs.** BCD attaches this caveat to Chrome only:
  "Content scripts are not applied to tabs already open when the extension is loaded."
  Source: `https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/manifest/content_scripts.json`
  Firefox does inject into open documents. `ExtensionProcessScript.sys.mjs` calls
  `policy.injectContentScripts()` in `initExtension`, and
  `ExtensionPolicyService::InjectContentScripts` walks every in-process content browsing context,
  matches each document against the extension's content scripts, and executes the `document_start`,
  `document_end` and `document_idle` sets in order.
  Sources: `https://hg.mozilla.org/mozilla-central/raw-file/tip/toolkit/components/extensions/ExtensionProcessScript.sys.mjs` (line 225),
  `https://hg.mozilla.org/mozilla-central/raw-file/tip/toolkit/components/extensions/ExtensionPolicyService.cpp` (line 403)
- `run_at` ordering and load order are identical in both. Firefox caveat: "in Firefox, content
  scripts won't be injected into empty iframes at `document_start`, even if you specify that value
  in `run_at`."
  Source: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_scripts`
- MAIN-world injection, which is how extensions reach page JavaScript objects, arrived late in
  Firefox: manifest `content_scripts.world` — chrome 111, firefox 128;
  `scripting.ExecutionWorld.MAIN` and `scripting.RegisteredContentScript.world` — chrome 102,
  firefox 128; `match_origin_as_fallback` — chrome 99, firefox 128.
- `scripting` API: chrome 88, firefox 102. `persistAcrossSessions` is firefox 102, but "Prior to
  Firefox 105, this option was required and only accepted the `false` value".
  `scripting.executeScript.InjectionResult.error` is firefox-only (chrome `false`).
  `RegisteredContentScript.cssOrigin` and the manifest `content_scripts.css_origin` key are
  firefox 144, chrome `false`.
- Firefox keeps `contentScripts.register` (firefox 59, chrome `false`) as an MV2-era alternative.
- Content-script environments are not the same. Firefox uses Xray vision: "the global scope
  (`globalThis`) is composed of standard JavaScript features as usual, plus `window` as the prototype
  of the global scope. Most DOM APIs are inherited from the page through `window`, through Xray
  vision". Chrome uses an isolated world where "Content scripts cannot directly access JavaScript
  objects from the web page". Three concrete consequences MDN calls out:
  - Event handlers: "In Firefox: separate event handlers are not maintained per world. This means
    that the most recent content script to request `element.onclick = xxx` overwrites the page's or
    other extensions' event handlers." Chrome keeps them per world. Workaround: `addEventListener()`.
  - `eval`: "In Firefox: `eval` runs code in the context of the content script and `window.eval` runs
    code in the context of the page. In Chrome: `eval` and `window.eval` always runs code in the
    context of the content script."
  - Lifecycle: "In Firefox: Content scripts remain injected in a web page after the user has
    navigated away. However, window object properties are destroyed." Chrome destroys and re-injects.
  - Relative URLs: "In Firefox: When a content script makes an HTTP(S) request, you must provide
    absolute URLs."
  Source: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities`
- MV3 restricts content scripts on both engines: "Cross-origin requests, permitted by extension
  permissions, using XHR and fetch in content scripts are no longer allowed" and "In Manifest V3,
  content scripts are subject to the same CSP as other parts of the extension."
  Source: `https://extensionworkshop.com/documentation/develop/manifest-v3-migration-guide/`

### Other differences that hit this product

- **`web_accessible_resources` URLs are not stable in Firefox.** "In Firefox: Resources are assigned
  a random UUID that changes for every instance of Firefox: `moz-extension://«random-UUID»/«path»`.
  This randomness can prevent you from doing things, such as adding your extension's URL to another
  domain's CSP policy." Chrome uses the fixed `chrome-extension://«your-extension-id»/«path»`.
  Firefox also does not support `use_dynamic_url`, and the Chrome manifest `key` property is
  unsupported.
  Sources: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities`,
  `https://extensionworkshop.com/documentation/develop/manifest-v3-migration-guide/`
- **Private browsing.** "By default, extensions do not run in private browsing windows. Whether an
  extension can access private browsing windows is under user control." And: "Firefox doesn't support
  `split` mode. Extensions that request this option in Firefox are installed using `not_allowed`."
  Source: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/incognito`
- **Message serialisation.** Firefox uses the structured clone algorithm for `runtime.sendMessage`,
  `tabs.sendMessage`, `Port.postMessage`; Chrome uses JSON serialisation. Objects with `toJSON` cross
  Chrome but not Firefox; `URL` instances are one example.
  Source: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities`
- **Host permissions at install.** "From Firefox 127, host permissions listed in `host_permissions`
  and `content_scripts` are displayed in the install prompt and granted on installation." Users can
  still revoke them at any time, so "your extension should check whether any required host
  permissions are available and request them if necessary". Also: "if an extension update grants new
  host permissions, these are not shown to the user."
  Source: `https://extensionworkshop.com/documentation/develop/manifest-v3-migration-guide/`
- **`runtime.getContexts`** — chrome 116, firefox 127 (the `documentId` filter only from firefox 153).
- **Not implemented in Firefox at all:** the `debugger` API (bug 1316741) and `declarativeContent`
  (bug 1435864); Firefox "will not support" `declarativeContent.RequestContentScript`.
  Source: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities`

---

## WebAuthn and passkey mediation available to a Firefox extension, including conditional mediation

**No browser exposes a passkey-provider or credential-provider extension API on desktop. Not Firefox,
not Chromium.**

- The Chrome extension API index lists no credential, passkey, autofill or password-management API.
  The only WebAuthn-adjacent API is `chrome.webAuthenticationProxy` ("Chrome 115+ MV3+"), and it is
  scoped to remote desktop: "The `chrome.webAuthenticationProxy` API lets remote desktop software
  running on a remote host intercept Web Authentication API (WebAuthn) requests in order to handle
  them on a local client." It needs the `webAuthenticationProxy` permission.
  Sources: `https://developer.chrome.com/docs/extensions/reference/api`,
  `https://developer.chrome.com/docs/extensions/reference/api/webAuthenticationProxy`
- Firefox has no equivalent. BCD's `webextensions/api` directory contains no `webAuthenticationProxy`
  entry, and MDN documents no such API.
  Source: `https://api.github.com/repos/mdn/browser-compat-data/contents/webextensions/api`
- WECG issue 361, "Add an API to integrate with the Credential Management Web API", is **open**, with
  labels `enhancement`, `opposed: safari`, `neutral: chrome`. No Firefox position label is present.
  The issue text records today's reality: "Currently password manager extensions have to rely on
  heuristics and / or overriding the `navigator.credentials` JS API to effectively work for their
  users."
  Source: `https://github.com/w3c/webextensions/issues/361`
- WECG issue 984, "Proposal: AutoFill Provider API" (opened 2026-04-16), was **closed as duplicate**
  on 2026-04-23, label `neutral: safari`. It argued for an Android/iOS-style provider integration and
  listed today's weaknesses of the injected-DOM approach.
  Source: `https://github.com/w3c/webextensions/issues/984`

**So on both engines the mechanism is the same: run a script in the page's MAIN world and take over
`navigator.credentials`.** That mechanism is available in Firefox only from **Firefox 128**
(`content_scripts.world`, `scripting.ExecutionWorld.MAIN`, `RegisteredContentScript.world`), against
Chrome 102-111. Before that, a Firefox extension had to reach the page through Xray-wrapper
techniques from a content script.
Source: `https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/manifest/content_scripts.json`

**Page-level WebAuthn support in Firefox (what an injected script can see and shim):**

| Feature | Chrome | Firefox |
| --- | --- | --- |
| `PublicKeyCredential` | 67 | 60 |
| `PublicKeyCredential.isConditionalMediationAvailable()` | 108 | **119** |
| `parseCreationOptionsFromJSON` / `parseRequestOptionsFromJSON` / `toJSON` | 129 | 119 |
| `getClientCapabilities()` | 133 | 135 |
| `PublicKeyCredential.signalAllAcceptedCredentials` / `signalCurrentUserDetails` / `signalUnknownCredential` | 132 | **`false`** |
| `create()` `residentKey` option | 89 | 114 |
| `create()` `requireResidentKey` option | 89 | **`false`** |
| `create()` / `get()` `hints` option | 128 | **`false`** |
| `prf` extension | 116 | 139 (135-139 was partial, "Not supported on macOS") |
| `largeBlob` extension | 113 | 139 |
| `credProps` extension | 89 | 119 |
| `credProtect` extension | 76 | 139 |
| `payment` extension | 95 | **`false`** |

Source: `https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/PublicKeyCredential.json`,
`https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/CredentialsContainer.json`

Conditional mediation itself works in Firefox from 119: the page calls
`PublicKeyCredential.isConditionalMediationAvailable()` and then `navigator.credentials.get()` with
`mediation: "conditional"`. MDN notes the constraint that applies to both engines: "only discoverable
credentials are included in calls that use conditional mediation, because the browser needs to
request applicable credentials without knowing the credential ID values for them."
Source: `https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API`

Whether Firefox's conditional-mediation autofill surface can be populated by an extension rather than
by Firefox's own credential store is **unverified**: searched MDN's WebAuthn pages, the MDN
WebExtensions API index, BCD `webextensions/api`, and WECG issues for "credential", "passkey",
"webauthn" and "autofill". No API or vendor statement was found either way. The only pathway found in
primary sources is overriding `navigator.credentials` in the page.

**One structural fact for extension-origin credentials.** WECG issue 238, "WebExtensions should use
asset links model for WebAuthn RP ID", is still open (created 2022-07-07). It states: "WebAuthn
credentials are origin-bound. ... Browser extensions have a similar problem as mobile apps, except in
this case, there is a web origin, but it is locally-specific to the extension. ... The browser /
platform will never allow a WebAuthn credential for `vault.bitwarden.com` to be used to for those
extensions because of this mismatch, by design. The formal ask is to evaluate an asset-links style
model for web extensions that allow a formal link back to the primary web origin."
Source: `https://github.com/w3c/webextensions/issues/238`
This blocks "unlock the vault with a passkey bound to our web origin, from inside the extension page"
on both engines equally. Firefox's random per-profile `moz-extension://«UUID»` origin makes it worse
than Chromium's stable extension origin.

---

## Native messaging on Firefox: manifest location per OS, allowed-extensions binding, difference from Chromium

The extension side is near-identical. `runtime.connectNative` and `runtime.sendNativeMessage` exist
in Firefox from 50, and both need the `nativeMessaging` permission. The wire format is the same:
"Each message is serialized using JSON, UTF-8 encoded and is preceded with an unsigned 32-bit value
containing the message length in native byte order."
Source: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging`

**Firefox app-manifest fields:** `name` (must match `^\w+(\.\w+)*$` and the name passed to
`connectNative`), `description`, `path` ("On Windows, may be relative to the manifest. On macOS and
Linux, must be absolute"), `type` (only `"stdio"`), and `allowed_extensions` (an array of add-on IDs).
Source: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_manifests`

**Firefox manifest locations:**

| OS | Global | Per-user |
| --- | --- | --- |
| Windows | `HKEY_LOCAL_MACHINE\SOFTWARE\Mozilla\NativeMessagingHosts\<name>` | `HKEY_CURRENT_USER\SOFTWARE\Mozilla\NativeMessagingHosts\<name>` |
| macOS | `/Library/Application Support/Mozilla/NativeMessagingHosts/<name>.json` | `~/Library/Application Support/Mozilla/NativeMessagingHosts/<name>.json` |
| Linux | `/usr/lib/mozilla/native-messaging-hosts/<name>.json` or `/usr/lib64/mozilla/native-messaging-hosts/<name>.json` | `~/.mozilla/native-messaging-hosts/<name>.json` |

On Windows the registry key's default value is the path to the app manifest.
Source: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_manifests`

**Chrome manifest locations, per Chrome's own docs:** registry at
`HKEY_LOCAL_MACHINE\SOFTWARE\Google\Chrome\NativeMessagingHosts\[name]` (or `HKEY_CURRENT_USER`);
macOS system-wide `/Library/Google/Chrome/NativeMessagingHosts/[name].json`; Linux system-wide
`/etc/opt/chrome/native-messaging-hosts/[name].json`; user paths under `~/.config/` and
`~/Library/Application Support/`.
Source: `https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging`

**The binding difference.** MDN states both differences in one place: "The app manifest lists
`allowed_extensions` as an array of app IDs, while Chrome lists `allowed_origins`, as an array of
`"chrome-extension"` URLs. The app manifest is stored in a different location compared to Chrome."
Chrome's docs add that `allowed_origins` "can't contain wildcards".
So one host binary needs **two manifest files** with different key names and different install
locations, and the Firefox one binds to an add-on ID such as `bittery@example.com`, while the Chrome
one binds to `chrome-extension://«id»/`.
Sources: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging`,
`https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging`

**Arguments passed to the host process differ.**

- Firefox passes the complete path to the app manifest and, from Firefox 55, "the ID (as given in the
  `browser_specific_settings` manifest.json key) of the add-on that started it".
  Source: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging`
- Chrome on Linux and macOS passes one argument, the extension origin
  `chrome-extension://«extensionID»/` with a trailing slash; on Windows it passes two, the origin and
  a window handle.
  Source: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities`

**Message size limits differ, in both directions.**

| Direction | Firefox | Chrome |
| --- | --- | --- |
| App to browser | 1 MB | 1 MB |
| Browser to app | 4 GB | 64 MiB |

Sources: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging`,
`https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging`

**Process lifetime.** Firefox: "The application stays running until the extension calls
`Port.disconnect()` or the page that connected to it is closed." On teardown, "Firefox kills the
subprocesses if they do not break away. On Windows, the browser puts the native application's process
into a Job object and kills the job"; a child that must outlive the host has to use `CreateProcess`
with `CREATE_BREAKAWAY_FROM_JOB`. Chrome "starts native messaging host process and keeps it running
until the port is destroyed".
Sources: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging`,
`https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities`,
`https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging`

**Both engines exempt an open native port from background idle termination** — see the first section.
This is the one place where the two lifecycle models converge by design; the Firefox source comment
says it copies Chrome deliberately.

---

## Firefox add-on signing and review constraints for an extension shipping WASM

**Signing is mandatory.** "Extensions and themes need to be signed by Mozilla before they can be
installed in release and beta versions of Firefox." Unsigned extensions load only in Developer
Edition, Nightly and ESR with `xpinstall.signatures.required` flipped, and even then "your extension
must have an add-on ID". Self-distributed (unlisted) add-ons still get signed by Mozilla, and "All
add-ons, including self-distributed ones, are subject to be manually reviewed at any time after
submission."
Source: `https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/`

**An explicit extension ID is mandatory for MV3.** "Manifest V3: Mandatory for signing extensions,
i.e., distribution through addons.mozilla.org (AMO) or self-distribution, to provide an extension
ID." And: "You must create an ID for signing Manifest V3 extensions; AMO does not assign an ID." The
ID must be a GUID or an email-shaped string matching `^[a-zA-Z0-9-._]*@[a-zA-Z0-9-._]+$`. The frozen
extension has no `browser_specific_settings`, so this key must be added before any Firefox build can
be signed.
Source: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings`

Related version floor from the same page: "The minimum supported version capable of receiving updates
is 115.0 (ESR) or, if ESR versions are not included, 128.0. This is due to the expiration of the root
certificate in Firefox in March 2025."

**Firefox for Android needs an explicit opt-in:** "To support Firefox for Android without specifying a
version range, the `gecko_android` sub-key must be an empty object, i.e., `"gecko_android": {}`.
Otherwise, the extension is only made available on desktop Firefox."
Source: same page.

**New AMO submissions must declare data collection.** "Must be provided with details specified for
`browser_specific_settings.gecko.data_collection_permissions` for new extension submitted to
addons.mozilla.org from November 3, 2025." `required` must contain `none` or values from a fixed list
that includes `authenticationInfo`, `personallyIdentifyingInfo`, `websiteContent` and
`financialAndPaymentInfo`. BCD records `permissions.Permissions.data_collection` as firefox 140,
chrome `false`.
Sources: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings`,
`https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/permissions.json`
The matching policy: users need "a clear way to control the add-on's data transmission, either
through a consent experience created by the add-on developer, or by using Firefox's built in data
collection and transmission consent experience", and "Before an add-on may transmit personal
information, it must clearly describe, and the user must affirmatively consent (i.e., explicitly
opt-in) to the type of personal data being transmitted."
Source: `https://extensionworkshop.com/documentation/publish/add-on-policies/`

**WASM: enabled by CSP, and governed by the general reviewable-source rule.**

- CSP. In MV3 "all CSP sources that refer to external or non-static content are forbidden in CSP
  directives covering script content. The only permitted values are `'none'`, `'self'`, and
  `'wasm-unsafe-eval'`." So a WASM build needs
  `"content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'" }`. MV2
  Firefox tolerated WASM without the keyword, "However, this behavior isn't guaranteed. See Firefox
  bug 1770909." Extension Workshop repeats the rule: "`'wasm-unsafe-eval'` must be specified in the
  CSP if an extension is to use WebAssembly."
  Sources: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_security_policy`,
  `https://extensionworkshop.com/documentation/develop/manifest-v3-migration-guide/`
- Review. AMO policy 3.1: "Code must be provided in a way that is reviewable. Add-ons may contain
  transpiled, minified or otherwise machine-generated code, but Mozilla needs to review a copy of the
  source code before any of these steps have been applied." Also "Add-ons are not allowed to contain
  obfuscated code, nor code that hides the purpose of the functionality involved" and (4.2)
  "Add-ons must be self-contained and not load remote code for execution."
  Source: `https://extensionworkshop.com/documentation/publish/add-on-policies/`
- The Source code submission page lists the trigger cases as minifiers, bundlers ("browserify or
  webpack"), template engines, and "any other custom tool that takes files, applies pre-processing,
  and generates file(s) to include in the extension". Reviewers must be able to rebuild the extension
  from the sources: the README must give the OS and environment, versions and install instructions
  for every tool, the exact commands, and lockfiles. Build tools must be "open source" and "able to
  be run on the reviewer's computer" — no web-based tools.
  Source: `https://extensionworkshop.com/documentation/publish/source-code-submission/`
- **The words "WebAssembly", "wasm", "binary", "compiled", "Rust" and "Emscripten" do not appear on
  the Source code submission page.** There is no WASM-specific AMO rule in the pages fetched. A
  `.wasm` artifact is machine-generated output of a custom build tool, so policy 3.1 and the fourth
  trigger case apply on their face: ship the toolchain and a reproducible build. Whether AMO
  reviewers demand byte-reproducible WASM output is **unverified**; searched the Source code
  submission page, Add-on Policies, and the Add-on Policies FAQ.
- Review turnaround figures are **unverified**: `https://extensionworkshop.com/documentation/publish/what-to-expect/`
  returned HTTP 404 at retrieval, and no other fetched page states a review time.

**Chromium comparison.** The Chrome Web Store has no source-upload step equivalent to AMO's. This was
not verified against a CWS policy page in this session, so treat the contrast as **unverified**; only
the Firefox side above is sourced.

---

## Whether one MV3 codebase can serve both, and what the standard build-time split looks like

**Yes for the manifest, and MDN documents the exact pattern.** The `background` key takes both
properties at once, and each browser picks the one it supports:

```json
{
  "manifest_version": 3,
  "background": {
    "scripts": ["background.js"],
    "service_worker": "background.js"
  }
}
```

"in Chrome, the `service_worker` property is used ... in Firefox, the `scripts` property is used, and
an event page starts because Firefox only supports scripts for background scripts. in Safari, the
`scripts` property is used by default." And: "You do not need to include `preferred_environment` for
this fallback behavior. Use `preferred_environment` only when you want Safari, or another browser
that supports more than one background environment, to prefer `service_worker` where available."
Source: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background`

This works only from Firefox 121: before Firefox 120 "Firefox did not start the background page if
`service_worker` was present". Chrome ignores `scripts`/`page` in MV3 only from Chrome 121; before
that "Chrome refuses to load a Manifest V3 extension with `background.scripts` or `background.page`
present". So the single-manifest trick needs Firefox >= 121 and Chrome >= 121.
Source: same page, plus
`https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/manifest/background.json`
(`background.preferred_environment` — firefox 136, chrome `false`).

**The API namespace is no longer a split point.** MDN: "Support for the `browser` namespace and
promises are no longer a source of incompatibility." Chrome exposed only `chrome` "Before Chrome
148"; for `devtools_page` extensions, "Chrome support for the `browser` namespace and promises was
introduced in Chrome 152". For older Chrome, "Firefox offers a polyfill that provides the `browser`
namespace and promise support: https://github.com/mozilla/webextension-polyfill".
Source: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities`

**What still forces a build-time or runtime split, from the facts above:**

1. **The background entry point is one file but two environments.** In Chrome it is a worker global
   with no DOM. In Firefox it is a document with `window` and DOM. Any code path that touches the DOM
   must branch, or must be moved behind an abstraction with a Chromium offscreen-document
   implementation and a Firefox in-page implementation.
2. **Keys only one engine accepts.** `browser_specific_settings` (Firefox-only, and mandatory for
   MV3 signing), `data_collection_permissions` (Firefox), `gecko_android` (Firefox), `key`
   (Chrome-only, unsupported in Firefox), `use_dynamic_url` in `web_accessible_resources`
   (unsupported in Firefox), `css_origin` in `content_scripts` (Firefox 144, chrome `false`).
3. **Permission sets differ.** `offscreen` (Chrome-only), `webAuthenticationProxy` (Chrome-only),
   `webRequestBlocking` (usable in Firefox MV3, not in Chrome MV3), `webRequestFilterResponse`
   (Firefox-only). Firefox exposes `userScripts` as an optional-only permission where Chrome takes it
   as a normal permission.
4. **Two native-messaging host manifests** — `allowed_extensions` versus `allowed_origins`, and
   different install paths per OS.
5. **Feature floors.** MAIN-world content scripts need Firefox 128. `storage.session` needs
   Firefox 115, `QUOTA_BYTES`/`getBytesInUse` on it need 131. `runtime.getContexts` needs
   Firefox 127. `strict_min_version` is where you encode that decision.

MDN does not prescribe a bundler pattern, and no primary source fetched here names one. The
"standard build-time split" as a tooling recipe is therefore **unverified**; what is verified is the
list of manifest and API divergences above that any such split must cover, and MDN's own recommended
technique of one shared manifest with both `scripts` and `service_worker` plus runtime feature
detection.

---

## Delta table

| Capability | Chromium MV3 | Firefox MV3 | Impact on a password-manager extension |
| --- | --- | --- | --- |
| Background environment | Service worker only (`background.service_worker`, Chrome 88) | Event page only; `service_worker` unsupported, bug 1573659 still `NEW` at 2026-08-12 | The sync owner and vault session run in two different globals. Worker-shaped code (no `window`, no DOM, `importScripts`/ESM) must also run in a document, or the background must be written to the narrower of the two. |
| Persistent background | Not available | Not available; `persistent: true` in MV3 is an error | Neither engine can hold an unlocked vault in a guaranteed-live process. Session state must survive suspension by design on both. |
| Idle termination | 30 s idle, 5 min per request, 30 s `fetch` cap | 30 s default (`extensions.background.idle.timeout`, clamped 100 ms-5 min) | Same order of magnitude. An auto-lock timer cannot rely on the background staying alive; it needs `alarms` plus persisted state on both. |
| Native port keeps background alive | Yes (`connectNative`) | Yes (`hasActiveNativeAppPorts` blocks suspension) | A live desktop-app port pins the background on both engines. This is the most reliable keep-alive available and it behaves the same. |
| DOM in the background | No; needs `chrome.offscreen` (Chrome 109) | Yes; the event page is a document | Any DOM-dependent work (parsing, clipboard, `DOMParser`, blob work) needs an offscreen document on Chromium and no extra machinery on Firefox. Two code paths. |
| `offscreen` API | Chrome 109+ | Not implemented; no MDN page, no BCD entry, no Firefox position on WECG issue 170 | Do not build the architecture around offscreen documents. Treat them as a Chromium shim over a missing DOM. |
| `storage.session` | Chrome 102, 10 MB | Firefox 115, 10 MB; `QUOTA_BYTES`/`getBytesInUse` only from 131 | Usable on both as the in-memory home for an unlocked session. Set `strict_min_version` at or above 115. |
| `storage.session.setAccessLevel` | Chrome 102 | **Not supported** | Content scripts can never read session storage on Firefox. Autofill must get secrets by message from the background, never by direct read. That is the safer design anyway, so make it the only design. |
| `storage.managed` | Chrome 33, full | Firefox 57, no registry backend, no schema enforcement, no `onChanged` | Enterprise policy configuration is weaker on Firefox and cannot be watched for changes. |
| `alarms` | Full; min period 30 s (was 60 s before Chrome 120); max 500 alarms | Full; no documented clamp or count limit found | An auto-lock or sync-poll interval below 30 s silently becomes 30 s on Chromium. Design for the Chromium floor. |
| Native messaging binding | `allowed_origins`: `chrome-extension://«id»/` | `allowed_extensions`: add-on ID from `browser_specific_settings.gecko.id` | The desktop app installer must write two manifest shapes to two path sets per OS, and the Firefox side needs a stable, self-chosen add-on ID. |
| Native message size, browser to host | 64 MiB | 4 GB | Firefox is more permissive. Cap at the Chromium limit to keep one protocol. |
| Blocking `webRequest` | Removed for most MV3 extensions | Kept; "The webRequest API is not on a deprecation path in Firefox"; plus Firefox-only `filterResponseData` | Any request-interception feature can be richer on Firefox, but building on it creates a Firefox-only capability with no Chromium fallback. |
| `declarativeNetRequest` | Chrome 84, full | Firefox 113; no `getMatchedRules`, no `onRuleMatchedDebug`, no response-header conditions, no unsafe-rule limits; ruleset precedence differs | Rule-based blocking or redirection must stay inside the Firefox subset, and match-diagnostics tooling will not work on Firefox. |
| Content scripts in already-open tabs | Not injected when the extension loads | Injected (`ExtensionPolicyService::InjectContentScripts`) | After install or update, autofill is live in open tabs on Firefox and dead until reload on Chromium. Chromium needs an explicit `scripting.executeScript` sweep; Firefox must tolerate double injection. |
| MAIN-world injection | Chrome 102-111 | Firefox 128 | This is the only route to `navigator.credentials` interception. It sets the Firefox floor at 128 for passkey work. |
| Content-script isolation model | Isolated world; per-world event handlers; `eval` always in the content script | Xray vision; **no** per-world event handlers, so `element.onclick = ...` overwrites the page's and other extensions' handlers; `window.eval` runs in the page | Field detection and event hooking must use `addEventListener` only. Assigning `on*` properties from a Firefox content script breaks the page and clashes with other password managers. |
| Web-accessible resource URLs | Stable `chrome-extension://«id»/…` | Random per-profile `moz-extension://«UUID»/…`; no `use_dynamic_url` | Injected iframe UI cannot be allowlisted in a site's CSP on Firefox, and the extension origin cannot be pinned or registered anywhere. |
| Message serialisation | JSON | Structured clone | Messages carrying `URL` or other `toJSON`-only objects cross Chromium and throw on Firefox. Send plain data. |
| Private browsing | Opt-in; `split` supported | Opt-in; **`split` not supported**, it downgrades to `not_allowed` | No separate vault instance for private windows on Firefox. `spanning` is the only mode, so private and normal state share one background. |
| Passkey provider API | None (only `webAuthenticationProxy`, remote-desktop scoped) | None | Passkey mediation is `navigator.credentials` override in the page on both. WECG issue 361 is open; issue 984 was closed as duplicate. No standard route is coming soon. |
| Conditional mediation in the page | Chrome 108 | Firefox 119 | Both support the autofill-UI flow. Whether an extension can populate that UI is unverified on both. |
| WebAuthn extension surface | `prf` 116, `largeBlob` 113, `hints` 128, signal methods 132 | `prf` 139, `largeBlob` 139, `hints` unsupported, signal methods unsupported | Feature-detect every extension. A `prf`-based unlock needs Firefox 139+, and it was macOS-broken before 139. |
| Extension ID | Optional; `key` pins it when unpacked | **Mandatory for MV3 signing**; AMO assigns none | `browser_specific_settings.gecko.id` must be added and then treated as a permanent identity, since the native-messaging host binds to it. |
| Signing and review | Chrome Web Store review | Mozilla signing mandatory for release/beta; unlisted builds still signed and reviewable at any time | Self-distribution alongside the desktop app is possible but still goes through Mozilla. |
| WASM | Needs `'wasm-unsafe-eval'` in the MV3 CSP | Same CSP requirement; plus AMO policy 3.1 requires reviewable pre-build source and a reproducible, open-source, locally runnable build | Shipping a WASM crypto core to Firefox means publishing the toolchain and a scripted, reproducible build with lockfiles. No WASM-specific AMO rule was found; the general machine-generated-code rule governs. |
| Data-collection declaration | None | `data_collection_permissions` required for new AMO submissions from 2025-11-03 | A password manager must declare `authenticationInfo` and friends up front, and match it with a consent experience. |
| Android | Not applicable | `"gecko_android": {}` required, or the add-on is desktop-only | Firefox for Android support is an explicit choice, not a default. |
