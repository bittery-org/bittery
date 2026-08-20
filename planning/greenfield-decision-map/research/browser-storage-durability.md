# What durability a browser can guarantee

Produced by a subagent resolving ticket 01 (`planning/greenfield-decision-map/issues/01-browser-storage-durability-facts.md`).
Every source below was retrieved **2026-08-20**. Status: evidence. Facts only; this file makes no
decision and gives no recommendation.

Where the three engines differ, each is stated separately. Where a primary source could not be
found, the text says **unverified** and names what was searched.

## Eviction of IndexedDB and OPFS under storage pressure, and what `navigator.storage.persist()` changes

Two different things get called "durability". Keep them apart:

- **Eviction** — will the browser delete the whole origin's data later?
- **Write durability** — when a write reports success, is the byte on the platter?

### The model the specifications define

- A storage bucket "has a mode, which is 'best-effort' or 'persistent'. It is initially
  'best-effort'." Source: `https://storage.spec.whatwg.org/`
- Under pressure: "A user agent that comes under storage pressure should clear network state and
  local storage buckets whose mode is 'best-effort', ideally prioritizing removal in a manner that
  least impacts the user." Persistent buckets "cannot be cleared without consent by the user"; if
  space stays constrained the user agent "should inform the user and offer a way to clear the
  remaining local storage buckets". Source: `https://storage.spec.whatwg.org/`
- Registered storage endpoints named in the Storage Standard: `caches`, `indexedDB`, `localStorage`,
  `serviceWorkerRegistrations`, `sessionStorage`. No File System endpoint identifier was found in
  either the Storage Standard or the File System Standard at retrieval, so "is OPFS a formally
  registered storage endpoint" is **unverified at spec level**. In practice MDN states it plainly:
  OPFS "is subject to browser storage quota restrictions, just like any other origin-partitioned
  storage mechanism" and "Clearing storage data for the site deletes the OPFS". Sources:
  `https://storage.spec.whatwg.org/`, `https://fs.spec.whatwg.org/`,
  `https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system`

### What counts, and what eviction takes

- Counting against the shared origin quota: **IndexedDB, Cache API, OPFS, and WebAssembly code
  caching**. `localStorage`/`sessionStorage` sit outside it on a separate 10 MiB budget (5 MiB each).
- Eviction is **all-or-nothing per origin**: "When an origin's data is evicted by the browser, all
  of its data, not parts of it, is deleted at the same time." So an evicted origin loses IndexedDB
  *and* OPFS together — there is no "keep the outbox, drop the cache" outcome.
- Policy is **LRU**: "The data from the least recently used origin is deleted. If storage pressure
  continues, the browser moves on to the second least recently used origin, and so on."
- "This eviction mechanism only applies to origins that are not persistent and skips over origins
  that have been granted data persistence."
- Over quota, writes fail with `QuotaExceededError` rather than silently evicting.
- Source for all of the above:
  `https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria`

### Quota per engine

| Engine | Best-effort quota | Persistent quota | Browser-wide cap |
| --- | --- | --- | --- |
| Chromium | 60% of total disk | 60% of total disk (same) | 80% of total disk |
| Firefox | min(10% of disk, 10 GiB group limit per site) | 50% of disk, capped 8 TiB, no group limit | not stated |
| Safari / WebKit | ~60% of disk in a browser app; ~15% in embedded web content (WKWebView); cross-origin frames ~1/10 of parent | same origin quota; persistent mode changes eviction, not size | 80% (browser app), 20% (non-browser app) |

Sources: `https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria`,
`https://webkit.org/blog/14403/updates-to-storage-policy/` (WebKit, "Updates to Storage Policy", Sihui Liu, 2023-08-10).

A Home Screen / Dock web app on Safari "uses the same origin quota as the browser app (around 60% of
disk space)" rather than the 15% embedded figure. Source: MDN, as above.

**Superseded figure, flagged.** Google's `https://web.dev/articles/storage-for-the-web` (page says
last updated 2024-09-23) still states "Safari (both desktop and mobile) appears to allow about 1GB.
When the limit is reached, Safari will prompt the user, increasing the limit in 200MB increments"
and "Firefox allows the browser to use up to 50% of free disk space. An eTLD+1 group may use up to
2GB." Both contradict MDN and WebKit's own 2023 post. The WebKit post is explicit that the 1 GiB
prompt regime ended: "Safari 17.0 no longer prompts users about a website wanting to use more space."
Treat the web.dev numbers as stale.

### What `navigator.storage.persist()` changes, per engine

- **Chromium.** No prompt. Chrome "automatically handles the permission request, and does not show
  any prompts to the user." The documented heuristics are: "How high is the level of site
  engagement?", "Has the site been installed or bookmarked?", "Has the site been granted permission
  to show notifications?" When granted, "the browser won't evict data stored in" Cache API, Cookies,
  DOM Storage, File System API, IndexedDB, and Service Workers. Quota is unchanged (60% either way).
  Source: `https://web.dev/articles/persistent-storage` (page says last updated 2020-05-12 — the
  freshest first-party Chrome statement found; **no newer Chrome-authored description of the
  heuristics was located**).
- **Firefox.** Prompts. "In Firefox, when a site chooses to use persistent storage, the user is
  notified with a UI popup that their permission is requested." Granting also raises the quota
  ceiling from the 10 GiB group limit to 50% of disk / 8 TiB. Source: MDN storage-quotas page above.
- **Safari / WebKit.** No prompt, heuristic grant. WebKit "currently grants a request based on
  heuristics like whether the website is opened as a Home Screen Web App". Separately, an origin
  "might be excluded from eviction if it has active page at the time of eviction, or its storage is
  in persistent mode." Source: `https://webkit.org/blog/14403/updates-to-storage-policy/`

Availability (MDN browser-compat-data, `https://github.com/mdn/browser-compat-data`, files
`api/StorageManager.json`):

| Feature | Chrome | Firefox | Safari |
| --- | --- | --- | --- |
| `StorageManager`, `persist()`, `persisted()` | 55 | 57 | 15.2 |
| `estimate()` | 61 | 57 | 17 |
| `navigator.storage.getDirectory()` (OPFS) | 86 (Android 109) | 111 | 15.2 |

Two constraints on `persist()` itself, from
`https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist`:

- It "is available only in secure contexts (HTTPS)".
- It "is **not** available in Web Workers, though the `StorageManager` interface is." A worker that
  owns the OPFS database therefore cannot request persistence itself; a window context must.

### Write durability: the IndexedDB `durability` hint

The spec defines three hints (`https://w3c.github.io/IndexedDB/`):

- `"strict"` — "The user agent may consider that the transaction has successfully committed only
  after verifying that all outstanding changes have been successfully written to a persistent
  storage medium."
- `"relaxed"` — "...as soon as all outstanding changes have been written to the operating system,
  without subsequent verification."
- `"default"` — "The user agent should use its default durability behavior for the storage bucket.
  This is the default for transactions if not otherwise specified."

**All three engines now default to `relaxed`.**

- Chromium changed its default from `strict` to `relaxed`. Chrome's blog says "The default
  durability mode in IndexedDB is changing from `strict` to `relaxed` from Chrome 121"
  (`https://developer.chrome.com/blog/indexeddb-durability-mode-now-defaults-to-relaxed`, page says
  last updated 2023-11-03). The Chrome Platform Status entry's ship stage records desktop and
  Android milestone **122** with developer trial at 120
  (`https://chromestatus.com/api/v0/features/5084460341264384`). The two first-party sources
  disagree by one milestone; both are cited rather than picking one.
- The same Chrome Platform Status summary states the motive and the prior art verbatim: "If not
  specified, the current default in Chromium is `strict`. Due to performance considerations, we plan
  to change the default to `relaxed`, which also aligns Chromium with FireFox and Safari." That is
  first-party Chromium evidence that **Gecko and WebKit already defaulted to relaxed**.
- Firefox went non-durable by default long before that, in Firefox 40 — Mozilla bug 1112702, "Switch
  IndexedDB transactions to be non-durable by default" (`https://bugzilla.mozilla.org/show_bug.cgi?id=1112702`,
  bug tracker). Firefox implemented the standard `durability` option only in **Firefox 126**, as an
  Interop 2024 item: Mozilla bug 1878143, "Implement IDBTransaction durability option", RESOLVED
  FIXED, target milestone Firefox 126 (`https://bugzilla.mozilla.org/show_bug.cgi?id=1878143`, bug
  tracker).

What the modes actually mean, in each engine's own words:

- Chrome: strict "explicitly instructs the OS to flush changes to disk before issuing the `complete`
  event"; relaxed "relies on default OS flushing behavior and issues the `complete` event after
  changes make it to the OS buffer, which is typically flushed every couple seconds." Chrome adds an
  important caveat: "It's important to note that `strict` does not ensure that changes are
  *actually* written immediately to disk. After a site calls `put()`, there's still some finite
  amount of time during which a power failure could cause the change to not make it to disk."
  Source: `https://developer.chrome.com/blog/indexeddb-durability-mode-now-defaults-to-relaxed`
- WebKit: strict causes a full SQLite checkpoint. From the ChangeLog of WebKit changeset 280415
  ("Implement IDBTransaction.durability", 2021-07-28): strict means the "backend would try syncing
  data to database file after transaction commit, which enforces durability"; relaxed means "data
  may stay in the OS buffer some time after transaction commit". The code is
  `if (transaction->durability() == IDBTransactionDurability::Strict) m_sqliteDB->checkpoint(SQLiteDatabase::CheckpointMode::Full);`
  Source: `https://trac.webkit.org/changeset/280415/webkit`
- Firefox: what `strict` does at the fsync level in Gecko is **unverified**. Bug 1878143 records the
  option being implemented for Interop 2024 but its comments do not say whether Gecko enforces a
  flush or only reflects the attribute. Searched: bugzilla.mozilla.org, MDN, searchfox.

The `durability` **property** is readable in all three engines — Chrome 83, Firefox 126, Safari 15
(MDN browser-compat-data, `api/IDBTransaction.json`). Note the gap: an app on Firefox 126 or older
Safari that passes `{durability: "strict"}` gets the option accepted or ignored with no error
either way; there is no feature test that proves the flush happened.

### Storage Buckets: finer control, Chromium only

The Storage Buckets API exposes the same durability hint at bucket level, plus per-bucket
persistence and eviction priority. Chrome describes `"strict"` as "attempt to minimize the risk of
data loss on power failure. This may come at the cost of reduced performance" and `"relaxed"` as
"may 'forget' writes that were completed in the last few seconds, when a power loss occurs."
Source: `https://developer.chrome.com/docs/web-platform/storage-buckets`

Availability is the catch. MDN browser-compat-data (`api/StorageBucketManager.json`) records
`StorageBucketManager`: **Chrome 122; Firefox not supported** (tracking bug
`https://bugzil.la/1594740`); **Safari not supported**. Chrome's own page also notes the coverage
limit: "Apart from IndexedDB, the explainer mentions several other storage APIs. For example, the
Cache API and File API. The current implementation is only the IndexedDB API." So per-bucket
persistence does not cover OPFS in Chrome today.

## Safari's seven-day cap on script-writable storage

### The rule still exists, unchanged in wording, in current Safari

Current Safari at retrieval is **26.6**, released **2026-07-27** (build 20624.4.5), per Apple's
release-notes index `https://developer.apple.com/documentation/safari-release-notes` and
`https://webkit.org/blog/18178/webkit-features-for-safari-26-6/`.

WebKit's living tracking-prevention reference `https://webkit.org/tracking-prevention/` states it
verbatim today:

> "**7-Day Cap on All Script-Writeable Storage** — Trackers executing script in the first-party
> context often make use of first-party storage to save and recall cross-site tracking information.
> Therefore, ITP deletes all cookies created in JavaScript and all other script-writeable storage
> after 7 days of no user interaction with the website. The latter storage forms are: IndexedDB,
> LocalStorage, Media keys, SessionStorage, Service Worker registrations and cache."

That list is identical to the original announcement, "Full Third-Party Cookie Blocking and More",
John Wilander, 2020-03-24, `https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/`:
"deleting all of a website's script-writable storage after seven days of Safari use without user
interaction on the site."

The Storage sections of the Safari 26.0, 26.4, 26.5 and 26.6 release notes were read; **no change to
the 7-day storage-lifetime rule appears in any of them** — only bug fixes. Sources:
`https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes` and the
`safari-26_4` / `safari-26_5` / `safari-26_6` pages under the same path.

One change in Safari 26.0 makes things *stricter*, not looser, for scripts on WebKit's
fingerprinting list: "Safari additionally prevents these scripts from setting long-lived
script-written storage such as cookies or LocalStorage."
Source: `https://webkit.org/blog/17333/webkit-features-in-safari-26-0/` (2025-09-15).

### Scope, item by item

| Storage | In 7-day scope? | Evidence |
| --- | --- | --- |
| IndexedDB | **Yes**, named explicitly | `https://webkit.org/tracking-prevention/` |
| localStorage / sessionStorage | **Yes**, named explicitly | same |
| Media keys | **Yes**, named explicitly | same |
| Service Worker registrations and cache | **Yes**, named explicitly | same |
| Standalone Cache API without a service worker | **Unverified.** The list says "Service Worker registrations and cache"; the Cache API is not named separately | same |
| Cookies set by `document.cookie` | **Yes** — "ITP deletes all cookies created in JavaScript" | same |
| Cookies set by an HTTP `Set-Cookie` header | **No.** ITP 2.1: "Only cookies created through document.cookie are affected by this change… authentication cookies should not be affected by the lifetime cap. If they are, you need to set your authentication cookies in an HTTP response and mark them Secure and HttpOnly." | `https://webkit.org/blog/8613/intelligent-tracking-prevention-2-1/` (2019-02-21) |
| **OPFS** | **Not named in the ITP list.** Strongly implied only. WebKit's OPFS announcement says "its storage lifetime is the same as other persistent storage types like IndexedDB and localStorage. The storage policy will conform to the Storage Standard." Since IndexedDB *is* in the list, OPFS behaving identically is the strong reading — but **no primary sentence names OPFS in the 7-day list**. | `https://webkit.org/blog/12257/the-file-system-access-api-with-origin-private-file-system/` (2022-02-14) |
| **Safari web-extension storage** (`browser.storage.local`, extension-context IndexedDB) | **Unverified.** No explicit primary statement either way. | see below |
| HTTP cache | Out of scope of both the script-writable cap and the quota policy | `https://webkit.org/blog/14403/updates-to-storage-policy/` |

On extensions, searched without result: `https://webkit.org/tracking-prevention/` (never mentions
extensions), the 2020 announcement, Apple's
`https://developer.apple.com/documentation/safariservices/assessing-your-safari-web-extension-s-browser-compatibility`
(covers extension storage only as a quota: "Local storage limit is 5 MB. In Safari 15 or earlier,
setting this to `unlimited` increases the extension's storage limit to 10 MB. In Safari 16 or later,
setting this to `unlimited` grants unlimited storage." — nothing on lifetime, eviction or ITP), and
Safari 26.0–26.6 release notes. **This needs an on-device empirical test, not a document.**

Do not confuse the 7-day cap with the separate, broader ITP rule for *classified* tracker domains:
"All website data is deleted for classified domains which have not received user interaction as
first-party… in the last 30 days of browser use." Source: `https://webkit.org/tracking-prevention/`

### What resets or exempts the clock

- **User interaction, defined verbatim:** "User interaction is a user click, tap, or keyboard entry
  on a website. Some refer to it as a user gesture. **Scrolling is not considered user interaction.**"
  Source: `https://webkit.org/tracking-prevention/`
- The clock counts **days of Safari use**, not wall-clock days: "seven days of Safari use without
  user interaction on the site." Source: `https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/`
- **Home Screen web apps are explicitly exempt**, and this is the only unambiguous exemption:
  "The first-party domain of home screen web applications is exempt from ITP's 7-day cap on all
  script-writeable storage, i.e. ITP always skips that domain in its website data removal algorithm.
  In addition, the website data of home screen web applications is kept isolated from Safari and
  thus will not be affected by ITP's classification of tracking behavior in Safari."
  Source: `https://webkit.org/tracking-prevention/`
- **Does `navigator.storage.persist()` exempt an ordinary Safari tab? Unverified.** The closest
  primary text is `https://webkit.org/blog/14403/updates-to-storage-policy/`: eviction "can happen…
  when the site has not been interacted with by the user for some time (see Intelligent Tracking
  Prevention)", and "Origin **might** be excluded from eviction if it has active page at the time of
  eviction, or its storage is in persistent mode." Read together that suggests persistence exempts,
  but WebKit never states it, and hedges with "might". Bug-tracker corroboration, marked as such:
  `https://bugs.webkit.org/show_bug.cgi?id=209501` ("Implement Persistent Storage before shipping
  '7-Day Cap on All Script-Writeable Storage'", RESOLVED DUPLICATE) — the WebKit engineer's later
  comment points only to the home-screen carveout, not to a persistence carveout.
- **What `persist()` grants on Safari is, in practice, the same carveout.** WebKit: "Starting in
  Safari 17.0… the Storage API is fully supported… **WebKit currently grants a request based on
  heuristics like whether the website is opened as a Home Screen Web App.**"
  Source: `https://webkit.org/blog/14403/updates-to-storage-policy/`

## MV3 service-worker termination

### Chromium: the 30-second idle timer, and no hard lifetime cap any more

Chrome documents exactly three shutdown triggers
(`https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle`):

> - "After 30 seconds of inactivity. Receiving an event or calling an extension API resets this timer."
> - "When a single request, such as an event or API call, takes longer than 5 minutes to process."
> - "When a `fetch()` response takes more than 30 seconds to arrive."

The old unconditional five-minute lifetime cap was **removed in Chrome 110**. The change "removes the
hard five-minute maximum lifetime for extension service workers"; "extension service workers stay
alive as long as they're receiving events"; "the idle timeout will not occur if there are pending
events". Source: `https://developer.chrome.com/blog/longer-esw-lifetimes` (page says last updated
2023-01-27). Five minutes still exists, but now as a **per-request** cap, not a total lifetime.

Currency check: the lifecycle page's version-improvement list tops out at Chrome 120, and Chrome's
extension docs currently cover up to Chrome 153 (`https://developer.chrome.com/docs/extensions/whats-new`,
posted 2026-08-03). So **Chrome has documented no lifetime-rule change between Chrome 121 and 153.**

### What resets the idle timer

All from the lifecycle page above unless noted:

- General rule: "Events and calls to extension APIs reset these timers, and if the service worker
  has gone dormant, an incoming event will revive them."
- Chrome 105: `chrome.runtime.connectNative()` native-messaging connections keep it alive.
- Chrome 109: "Messages sent from an offscreen document reset the timers."
- Chrome 110: "Extension API calls reset the timers."
- Chrome 114: "Sending a message with long-lived messaging keeps the service worker alive. **Opening
  a port no longer resets the timers.**" Traffic counts; an idle port does not.
- Chrome 116: "Active WebSocket connections now extend extension service worker lifetimes."
- Chrome 118: active `chrome.debugger` sessions keep it alive.
- Chrome 120: "Alarms can now be set to a minimum period of 30s to match the service worker lifecycle."

**Explicitly not keep-alives:**

- `setTimeout` / `setInterval` — "the timers are canceled whenever the service worker is terminated."
  Source: `https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers`
- `fetch()` — the opposite: a slow fetch is a *termination trigger* at 30 seconds.
- A bare pending Promise — not on the reset list. Only *pending events* hold the worker open.
- **An in-flight IndexedDB operation — unverified, and presumed not.** IndexedDB is not an extension
  API, so it does not fall under "Extension API calls reset the timers", and it appears nowhere on
  the reset list. Searched: the lifecycle, migrate-to-service-workers, about-service-workers and
  events-in-service-workers pages on developer.chrome.com.

Chrome's own documented workaround is to poll a trivial extension API
(`https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers`):

```js
async function waitUntil(promise) {
  const keepAlive = setInterval(chrome.runtime.getPlatformInfo, 25 * 1000);
  try { await promise; } finally { clearInterval(keepAlive); }
}
```

Chrome also documents a 20-second `chrome.storage.local.set` heartbeat for indefinite lifetime but
restricts the advice: it "only applies to extensions running on managed devices for enterprise or
education use cases."

### What happens to an in-flight IndexedDB transaction on termination

**Chrome does not document this. Unverified.** Checked the lifecycle page, the
migrate-to-service-workers page, the about-extension-service-workers page, the
events-in-service-workers page, and the Chrome blog post "Chrome Extensions: eyeo's journey to
testing service worker suspension" (last updated 2024-02-27). None states the fate of a pending IDB
transaction on suspension.

What *is* on the record:

- Generic state loss is documented: "any global variables you set will be lost if the service worker
  shuts down", with the guidance to treat `chrome.storage`, IndexedDB or CacheStorage as the source
  of truth. Source: the lifecycle page.
- The IndexedDB spec says a transaction may be aborted "at any time before reaching its finished
  state" and that on abort the implementation must "undo (roll back) any changes that were made to
  the database during that transaction". It says a connection closes when the execution context in
  which it was created is destroyed, but **is silent on the fate of open transactions at global
  termination.** Source: `https://w3c.github.io/IndexedDB/`
- MDN lists automatic abort causes (I/O error, quota exceeded, user-agent or worker crash) but does
  not cover deliberate termination. Source: `https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction`

Practical reading: **rollback, not commit, is the specified behaviour for an unfinished transaction,
and no Chrome document promises Chrome waits.** A write that has not reached `complete` when the
worker is killed must be assumed lost.

MDN also states the relaxed-durability loss window plainly: in Firefox 40+ `complete` fires "after
the OS has been told to write the data but potentially before that data has actually been flushed to
disk… there exists a small chance that the entire transaction will be lost if the OS crashes or
there is a loss of system power before the data is flushed to disk."
Source: `https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction`

### `waitUntil` does not exist for extension events

`ExtendableEvent.waitUntil()` extends a service worker's lifetime per
`https://w3c.github.io/ServiceWorker/` §4.4.1. But **`chrome.*` event listeners are not
ExtendableEvents and have no `waitUntil`.** Chrome's migration guide says an "official API similar
to `waitUntil()` is currently being discussed in the WECG" and ships the polling shim instead. The
W3C WebExtensions CG issue `https://github.com/w3c/webextensions/issues/416` ("Introduce
runtime.waitUntil API…", opened 2023-07-05) is **still open** as of retrieval, with supportive vendor
positions from Chrome, Firefox and Safari recorded but **nothing shipped anywhere**.

Standard *web* service-worker events inside an extension SW (`fetch`, `install`, `activate`,
`message`) are ExtendableEvents and do honour `waitUntil` per spec.

### `chrome.alarms`

Source: `https://developer.chrome.com/docs/extensions/reference/api/alarms` (page says last updated
2026-08-13).

- "Chrome limits alarms to at most once every 30 seconds but may delay them an arbitrary amount
  more. That is, setting `delayInMinutes` or `periodInMinutes` to less than `0.5` will not be
  honored and will cause a warning." The floor dropped from 1 minute to 30 seconds in **Chrome 120**.
- "To help you debug your app or extension, when you've loaded it unpacked, there's no limit to how
  often the alarm can fire."
- Alarms are documented as the way to **wake** a dormant worker, replacing `setTimeout`/`setInterval`
  — **not** as a keep-alive. The documented keep-alive is the 25-second `getPlatformInfo` interval.
- Chrome 123: "Alarms set using the `chrome.alarms` API are no longer delayed when a device goes to
  sleep." Source: `https://developer.chrome.com/docs/extensions/whats-new`
- Newer than the assistant's training data, so worth naming: `persistAcrossSessions` on
  `Alarm`/`AlarmCreateInfo` is marked **Chrome 150+** — "Whether the alarm should persist across
  sessions (browser restarts). In Chrome, this defaults to true to match historical behavior, but
  you should set this explicitly to maximize compatibility across browsers." A `name` parameter on
  `AlarmCreateInfo` is marked **Chrome 152+**.

### A structural limit: a service worker cannot spawn a Worker, so it cannot use OPFS sync handles

- `Worker` is not exposed in `ServiceWorkerGlobalScope`. MDN: "This feature is available in Web
  Workers, except for Service Workers."
  Source: `https://developer.mozilla.org/en-US/docs/Web/API/Worker`
- `FileSystemSyncAccessHandle` is `[Exposed=DedicatedWorker, SecureContext]`, and
  `createSyncAccessHandle()` "is available only in DedicatedWorker contexts."
  Sources: `https://fs.spec.whatwg.org/`,
  `https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle`
- Therefore an MV3 extension service worker cannot itself run a synchronous OPFS handle and cannot
  create a dedicated worker to run one. The documented route is `chrome.offscreen` (Chrome 109+),
  whose reason list includes **`WORKERS`**. An offscreen document "is an instance of `window`" with
  full DOM access; "an installed extension can only have one open at a time"; and only the
  `AUDIO_PLAYBACK` reason has a lifetime limit (closes after 30 seconds without audio) — "All other
  reasons don't set lifetime limits", closing otherwise requires an explicit `closeDocument()` call.
  Messages sent from an offscreen document also reset the service worker's idle timer (Chrome 109).
  Source: `https://developer.chrome.com/docs/extensions/reference/api/offscreen`

### Firefox: event pages, not service workers

- "In Manifest V3, only non-persistent background scripts or a page are supported."
  Source: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts`
- **`background.service_worker` is not supported in Firefox** (Firefox bug 1573659). Before Firefox
  120 its presence stopped the background page from starting; from **Firefox 121** the background
  page starts regardless (Firefox bug 1860304).
  Source: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background`
- **Persistent background pages are not available in MV3.** `persistent` defaults to `true` in MV2
  and `false` in MV3; "setting to `true` results in an error" in MV3. Same source.
- Non-persistent background pages arrived in **Firefox 106**; "In Firefox 105 and earlier, event
  pages are run as if they are a persistent background page."
  Source: `https://extensionworkshop.com/documentation/develop/manifest-v3-migration-guide/`
- **Idle timeout value.** MDN only says "Background scripts unload after a few seconds of
  inactivity" and gives no number. The concrete number is in the **bug tracker, not documentation**:
  `https://bugzilla.mozilla.org/show_bug.cgi?id=1771203` records a default of **30 seconds** under
  the pref `extensions.background.idle.timeout` (minimum 0.1 s, maximum 300 s), and "This timer is
  reset when an extension event is received." The bug is still NEW.
- Suspension is cancellable: "if during the suspension of a background script another event wakes
  the background script, `runtime.onSuspendCanceled` is called and the background script continues
  running." Source: MDN Background_scripts.
- Debugging exception: "When you debug a non-persistent background script, the background script
  won't go idle while the toolbox is open."
  Source: `https://extensionworkshop.com/documentation/develop/debugging/`

### Safari: nonpersistent background pages, timeout undocumented

Source: `https://developer.apple.com/documentation/safariservices/optimizing-your-web-extension-for-safari`

- "In iOS, you must make your background page nonpersistent. Safari unloads your nonpersistent
  background page when the user isn't directly interacting with the extension."
- "Your background page must be nonpersistent or you must declare your background script as a
  service worker if you're using manifest version 3."
- Required practice when nonpersistent: "Add event listeners in the top level of your background
  page. Use the Storage API to save and restore state. **Use the Alarms API instead of setTimeout.**"
- Exception: keep it persistent on macOS if you use `webRequest`.
- `https://developer.apple.com/documentation/safariservices/assessing-your-safari-web-extension-s-browser-compatibility`:
  "Safari 15.4 and later supports manifest versions 2 and 3"; "In iOS, you need to set the
  `persistent` attribute to `false`. With manifest version 3, all background pages are nonpersistent."
- Safari prefers background *pages* over service workers, using `background.service_worker` only if
  `preferred_environment` is set to `"service_worker"`.
  Source: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background`
- **Safari's idle-timeout number is unverified.** Apple documents that unloading happens but
  publishes no value. The only "30 seconds" references found are Apple Developer *Forums* threads
  and a Safari 17.6 beta release note about a bug ("Fixed an issue where Safari Web Extension
  background pages would stop responding after about 30 seconds") — not a documented policy.

## OPFS and `crypto.subtle` in a non-secure context

### Both are secure-context only

- **OPFS / File System API — yes.** The WHATWG File System IDL is unambiguous: `[SecureContext]
  partial interface StorageManager { Promise<FileSystemDirectoryHandle> getDirectory(); };`, and
  `FileSystemHandle`, `FileSystemFileHandle`, `FileSystemDirectoryHandle` and
  `FileSystemWritableFileStream` are each `[Exposed=(Window,Worker), SecureContext]`.
  `FileSystemSyncAccessHandle` is narrower still: `[Exposed=DedicatedWorker, SecureContext]`.
  Sources: `https://fs.spec.whatwg.org/`,
  `https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/getDirectory`,
  `https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts/Features_restricted_to_secure_contexts`
- **`crypto.subtle` — yes, and note the asymmetry.** Web Cryptography API Level 2 (W3C Editor's
  Draft, 2026-08-11) declares `[SecureContext] readonly attribute SubtleCrypto subtle;` and
  `[SecureContext] DOMString randomUUID();` — but `getRandomValues()` carries **no** `SecureContext`.
  `SubtleCrypto` and `CryptoKey` are both `[SecureContext, Exposed=(Window,Worker)]`. So on plain
  `http://` you keep a CSPRNG and lose every primitive built on it.
  Sources: `https://w3c.github.io/webcrypto/`,
  `https://developer.mozilla.org/en-US/docs/Web/API/Crypto/subtle`

### What counts as a secure context

The algorithm lives in HTML §8.1.3.5 (`https://html.spec.whatwg.org/multipage/webappapis.html#secure-contexts`)
and turns on "Is url potentially trustworthy?" applied to the environment's **top-level creation
URL** — which is why an HTTPS iframe inside an HTTP page is *not* a secure context. Secure Contexts
states it directly: "Framed documents can be secure contexts if they are delivered from potentially
trustworthy origins, **and if they're embedded in a secure context**."
Source: `https://w3c.github.io/webappsec-secure-contexts/` (W3C Editor's Draft, 2023-11-10)

The normative "Is origin potentially trustworthy?" steps, in order, from the same source:

1. Opaque origin → Not Trustworthy.
2. Scheme `https` or `wss` → Potentially Trustworthy.
3. "If origin's host matches one of the CIDR notations **127.0.0.0/8 or ::1/128**… return
   'Potentially Trustworthy'."
4. Host is `localhost`, `localhost.`, or ends with `.localhost` / `.localhost.` → Potentially
   Trustworthy (conditional on the user agent honouring the localhost name-resolution rules).
5. Scheme `file` → Potentially Trustworthy.
6. A vendor scheme the user agent considers authenticated → Potentially Trustworthy.
7. "If origin has been configured as a trustworthy origin" → Potentially Trustworthy.
8. Otherwise → Not Trustworthy.

Applied to the LAN cases:

| Origin | Secure context? | Why |
| --- | --- | --- |
| `http://localhost`, `http://*.localhost` | **Yes** | rule 4. MDN adds: "Firefox 84 and later support `http://localhost` and `http://*.localhost` URLs as trustworthy origins (earlier versions did not…)" |
| `http://127.0.0.1` | **Yes** | rule 3, whole 127.0.0.0/8 block |
| `http://192.168.1.50` | **No** | 192.168.0.0/16 is private but is not 127.0.0.0/8. The spec has **no private-network carve-out**; it falls through to Not Trustworthy |
| `http://myserver.local` | **No** | `.local` is not `.localhost`. mDNS/Bonjour names get no special treatment |
| `file://` | Yes, though a user agent "MAY choose to more strictly assign trust in a way which excludes `file`" | rule 5 |

Sources: `https://w3c.github.io/webappsec-secure-contexts/#is-origin-trustworthy`,
`https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts`. The Mixed Content spec now
defers to this definition: "An *a priori authenticated URL* is equivalent to a *potentially
trustworthy URL* [SECURE-CONTEXTS]" (`https://w3c.github.io/webappsec-mixed-content/`).

### What a LAN-only `http://` deployment loses

| API | Secure-context only? | Evidence |
| --- | --- | --- |
| OPFS / File System API | **Yes — lost** | `https://fs.spec.whatwg.org/` |
| `crypto.subtle`, `crypto.randomUUID()` | **Yes — lost** | `https://w3c.github.io/webcrypto/` |
| Service Workers | **Yes — lost** | `https://w3c.github.io/ServiceWorker/`; MDN: "Service workers are only available in secure contexts" |
| Cache API (`caches`) | **Yes — lost** | `[SecureContext, Exposed=(Window,Worker)] interface Cache`, `https://w3c.github.io/ServiceWorker/` |
| `navigator.storage` — `persist()`, `persisted()`, `estimate()`, `getDirectory()` | **Yes — lost** | Storage Standard (Living Standard, last updated 2026-03-15): `[SecureContext] interface mixin NavigatorStorage`, `https://storage.spec.whatwg.org/` |
| Web Locks | **Yes — lost** | `https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API` |
| `SharedArrayBuffer` | **Yes — lost** (needs secure context *plus* cross-origin isolation) | "To use shared memory your document must be in a secure context and cross-origin isolated", `https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer` |
| `crypto.getRandomValues()` | **No — kept** | no `SecureContext` on the member, `https://w3c.github.io/webcrypto/` |
| **IndexedDB** | **No — kept.** Verified, not assumed: the IndexedDB IDL contains zero occurrences of `SecureContext`; `IDBFactory` etc. are plain `[Exposed=(Window,Worker)]`. MDN's IndexedDB page carries no secure-context banner, and IndexedDB is absent from MDN's list of restricted features. | `https://w3c.github.io/IndexedDB/`, `https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API` |
| localStorage / sessionStorage | **No — kept** | `[SecureContext]` applies to `NavigatorStorage`/`StorageManager`, not to `Storage`, `https://storage.spec.whatwg.org/` |

Net effect: on a plain-`http://` LAN origin an app keeps IndexedDB and Web Storage and loses OPFS,
Web Crypto's `subtle`, service workers, the Cache API, all of `navigator.storage` (so it can neither
measure quota nor request persistence), Web Locks and `SharedArrayBuffer`.

### Escape hatches for `http://`, per engine

- **Chromium, command line / flag.** "You can use `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
  to run Chrome, or use the `--unsafely-treat-insecure-origin-as-secure="http://example.com"` flag…
  which will treat that origin as secure for this session. **Note that on Android and ChromeOS the
  command-line flag requires having a device with root access/dev mode.**"
  Source: `https://www.chromium.org/Home/chromium-security/deprecating-powerful-features-on-insecure-origins/`
- **Chromium, enterprise policy `OverrideSecurityRestrictionsOnInsecureOrigin`** (supported since
  Chrome 69 on desktop, ChromeOS and Android; `dynamic_refresh: false`, `per_profile: false`).
  "Setting the policy specifies a list of origins (URLs) or hostname patterns (such as
  `*.example.com`) for which security restrictions on insecure origins won't apply. **Patterns are
  only accepted for hostnames; URLs/origins with schemes must be exact strings.**… This policy also
  prevents the origin from being labeled 'Not Secure' in the address bar."
  Source: `https://chromium.googlesource.com/chromium/src/+/main/components/policy/resources/templates/policy_definitions/Miscellaneous/OverrideSecurityRestrictionsOnInsecureOrigin.yaml`
  The older `UnsafelyTreatInsecureOriginAsSecure` is deprecated since M69 and is overridden by the
  above. Source: `https://www.chromium.org/administrators/policy-list-3/deprecated-policies/`
- **Firefox, `dom.securecontext.allowlist`.** No Mozilla *documentation* page for this pref was
  found (searched firefox-source-docs.mozilla.org). It exists in current source — cited here as
  source code, not documentation. From `nsMixedContentBlocker::IsPotentiallyTrustworthyOrigin`:
  "We only apply this allowlist for network resources, i.e., those with scheme 'http' or 'ws'. The
  pref should contain a comma-separated list of hostnames." Exact-string hostname match; **no
  wildcards**. Source: `https://raw.githubusercontent.com/mozilla-firefox/firefox/main/dom/security/nsMixedContentBlocker.cpp`
  A related boolean `dom.securecontext.allowlist_onions` (default `false`) is in
  `https://raw.githubusercontent.com/mozilla-firefox/firefox/main/modules/libpref/init/StaticPrefList.yaml`.
- **Safari / WebKit — unverified, and nothing found.** No primary Apple or WebKit source documents
  any way to treat an `http://` origin as a secure context. Searched webkit.org,
  developer.apple.com documentation, and the Safari 26.x release notes.
- The spec sanctions such overrides: "In order to support developers who run staging servers on
  non-loopback hosts, the user agent MAY allow users to configure specific sets of origins as
  trustworthy". Source: `https://w3c.github.io/webappsec-secure-contexts/` §7.2.

## SQLite over OPFS in a Worker

### The official SQLite WASM build

- Current SQLite release at retrieval: **3.53.4, 2026-07-24**. There is no separate "wasm build
  version" — the WASM deliverable ships with the SQLite release, as `sqlite-wasm-3530400.zip`
  (703.78 KiB), "A precompiled bundle of `sqlite3.wasm` and its JavaScript APIs, ready for use in
  web applications." Sources: `https://sqlite.org/changes.html`, `https://sqlite.org/download.html`
- Note: `https://sqlite.org/wasm/doc/trunk/opfs.md` **returns 404**. All OPFS VFS documentation now
  lives in `https://sqlite.org/wasm/doc/trunk/persistence.md`.

**There are now three OPFS VFSes, not two.** `"opfs-wl"` was added in 3.53.0 (2026-04-09):

> "Add the 'opfs-wl' VFS, functionally identical to the 'opfs' VFS but using Web Locks for locking,
> which can promise fairer lock sharing than the 'opfs' bespoke protocol can. 'opfs-wl' requires
> `Atomics.waitAsync()`, so requires newer browsers than 'opfs' does."
> — `https://sqlite.org/changes.html`

| VFS | SharedArrayBuffer + COOP/COEP? | Context | Multiple connections / tabs |
| --- | --- | --- | --- |
| `"opfs"` | **Required** | dedicated Worker only | yes, with `SQLITE_BUSY` handling |
| `"opfs-wl"` (3.53.0+) | **Not required**; needs `Atomics.waitAsync()` | dedicated Worker only | yes, FIFO-fair Web Locks |
| `"opfs-sahpool"` | **Not required** | dedicated Worker only; explicit `installOpfsSAHPoolVfs()` | **no** |

SQLite's own selection guidance, verbatim: "clients which value performance more than concurrency,
or are unable to set the [COOP/COEP response headers], should use the ['opfs-sahpool' VFS]. Clients
which requires multi-tab concurrency should use either the ['opfs' VFS] or ['opfs-wl' VFS]."

The `"opfs"` VFS requirement, verbatim: "JavaScript's `SharedArrayBuffer` type is required for the
OPFS VFS, and that class is only available if the web server includes the so-called [COOP] and
[COEP] response headers… `Cross-Origin-Embedder-Policy: require-corp` /
`Cross-Origin-Opener-Policy: same-origin`… Without these headers, the `SharedArrayBuffer` will not
be available, so the OPFS VFS will not load." COEP `credentialless` is also accepted.

`"opfs-sahpool"` advantages, verbatim: "Should work on all major browsers released since March 2023.
— Does not require COOP/COEP HTTP headers… — *Easily* the highest OPFS performance of the options
described in this documentation."

All quotes: `https://sqlite.org/wasm/doc/trunk/persistence.md`

### Worker requirement, and the deprecated main-thread bridge

- "OPFS is only available in Worker-thread contexts, not the main UI thread." Installation of
  `opfs-sahpool` "will fail if… The proper OPFS APIs are not detected. They are only available in
  Worker threads, not the main UI thread." Source: `https://sqlite.org/wasm/doc/trunk/persistence.md`
- The non-OPFS `kvvfs` (localStorage/sessionStorage) is main-thread-only and capped at "typically
  5MB". Same source.
- **The official main-thread bridge is now deprecated**, verbatim: "The Worker1 and Promiser APIs
  are, as of 2026-04-15, deprecated. They will not be removed, but they also will not be extended
  further. It is their author's considered opinion that they are too fragile, too imperformant, and
  too limited for any non-toy software, and their use is actively discouraged. The 'correct' way to
  use this library is to load the module and interact with it as a library, just like any other
  library, rather than trying to 'remote control' it through this interface."
  Source: `https://sqlite.org/wasm/doc/trunk/api-worker1.md`

### `opfs-sahpool` concurrency, verbatim

> "Does not support multiple simultaneous connections (but see below)."
> "Because this VFS does not directly support concurrency…, initializing it twice, e.g. via two tabs
> to the same origin, will fail for the second and subsequent instances."
> "The `opfs-sahpool` VFS cannot offer any client-transparent concurrency support at the library
> level because it pre-allocates all potential SAHs, which immediately locks those files."
> "As of version 3.50, the `PoolUtil` interface… adds a 'pause' capability to help support
> cooperative concurrency… it is not currently possible to *start* the VFS in a paused state.
> Because of that, clients using this form of concurrency will need to coordinate not only the
> pausing/unpausing of the VFS, but also the timing of `installOpfsSAHPoolVfs()`, as two clients
> concurrently calling that for the same origin and VFS name will collide, causing one of them to
> fail."

And for the `"opfs"` VFS, the honest forewarning:

> "⚠️ **Forewarning:** desktop-grade concurrency is not a real thing in browser environments."
> "Keep in mind that ***reading locks OPFS files***, so there's no such thing as 'N concurrent
> readers' in OPFS-via-VFS."
> "…more detailed testing in 2026-03 was consistently able to handle 8-10 concurrent workers for
> long periods, provided (A) all keep their locking to a minimum and (B) the client specifically
> handles `SQLITE_BUSY`."

Source: `https://sqlite.org/wasm/doc/trunk/persistence.md`

### What durability SQLite-over-OPFS actually gives: `flush()`, and no more

Both official OPFS VFSes reduce `xSync` to `FileSystemSyncAccessHandle.flush()`. From the SQLite
sources (official mirror `https://raw.githubusercontent.com/sqlite/sqlite/master/ext/wasm/api/sqlite3-opfs-async-proxy.c-pp.js`):

```js
xSync: async function(fid, flags /*ignored*/){
  const fh = __openFiles[fid];
  let rc = 0;
  if(!fh.readOnly && fh.syncHandle){
    try { await fh.syncHandle.flush(); }
    catch(e){ state.s11n.storeException(2,e); rc = state.sq3Codes.SQLITE_IOERR_FSYNC; }
  }
  storeAndNotify('xSync',rc);
},
```

`flags` is **explicitly ignored** — so `PRAGMA synchronous=FULL` versus `NORMAL` makes no difference
to what the VFS does at sync time. `opfs-sahpool` is the same shape, calling `file.sah.flush()`
(`https://raw.githubusercontent.com/sqlite/sqlite/master/ext/wasm/api/sqlite3-vfs-opfs-sahpool.c-pp.js`).

And what `flush()` promises, from the WHATWG File System spec §2.6.5
(`https://fs.spec.whatwg.org/`), verbatim:

> "**Attempt to transfer** all cached modifications of the file's content to the file system's
> underlying storage device.
> Note: This is also known as flushing. **This can be a no-op on some file systems, such as
> in-memory file systems, which do not have a 'disk' to flush to.**"

So `flush()` is an *attempt*, explicitly permitted to be a no-op. It is a weaker contract than POSIX
`fsync()`. Two more spec notes compound this:

- `close()`: "This method does not guarantee that all file modifications will be immediately
  reflected in the underlying storage device. Call the `flush()` method first if you require this
  guarantee." (§2.6.6)
- `write()`: "It is likely that implementations will choose to focus on performance by issuing
  direct write calls to the host operating system (instead of creating a copy of buffer), **which
  prevents a detailed specification of the write order and the results of partial writes.**" (§2.6.2)

Unspecified write ordering is precisely what a rollback journal depends on. MDN's softer phrasing
("persists any changes made to the file… to disk",
`https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle/flush`) overstates the
spec. **No sqlite.org prose was found stating what durability level the OPFS VFSes claim.** Searched
`persistence.md` for "durab", "crash", "corrupt", "synchronous" — no relevant hits. Treat
SQLite-over-OPFS durability as best-effort and implementation-dependent, not as the D in ACID.

### WAL in the browser build

Supported since 3.47, with a caveat that removes the point of it, verbatim:

> "As of version 3.47, it is possible to activate WAL mode for OPFS-hosted databases with the
> following caveats: — Because the WASM build does not have shared memory APIs, activating WAL
> requires that a client specifically activate exclusive-locking mode for a db handle immediately
> after opening it… `pragma locking_mode=exclusive` — WAL mode *does not* provide any concurrency
> benefits in this environment. On the contrary, the requirement for exclusive locking *eliminates
> all concurrency support* from the ['opfs' VFS]."

Source: `https://sqlite.org/wasm/doc/trunk/persistence.md`

### The npm package lags the C release

- `@sqlite.org/sqlite-wasm` latest is **`3.53.0-build1`, published 2026-04-21**, while SQLite itself
  is at 3.53.4 (2026-07-24) — four bugfix releases behind. Source: `https://registry.npmjs.org/@sqlite.org/sqlite-wasm`
- The repo `sqlite/sqlite-wasm` is not archived (`pushed_at` 2026-07-13, 1040 stars); latest release
  tag `3.53.0-build1`. Sources: `https://api.github.com/repos/sqlite/sqlite-wasm`,
  `https://api.github.com/repos/sqlite/sqlite-wasm/releases`
- Its status, verbatim: "a community-maintained npm-based distribution… Despite being
  'community-maintained,' it is an official sub-project of the SQLite project. It is maintained by
  third-party volunteers for the simple reason that none of the SQLite maintainers use npm-based
  tools, so cannot reasonably claim to offer support for them."
  Source: `https://sqlite.org/wasm/doc/trunk/npm.md`

### wa-sqlite

- **Active, MIT-licensed, not archived.** 1404 stars, 11 open issues; last push **2026-08-16**, last
  master commit **2026-08-10**. Releases: **v1.1.2 (2026-08-11)**, v1.1.1 (2026-04-23), v1.1.0
  (2026-04-12), v1.0.9 (2025-09-24). Licence MIT since 2023-02-10 ("Existing licensees may continue
  under the GPLv3 or switch to the new license"). Sources:
  `https://api.github.com/repos/rhashimoto/wa-sqlite`,
  `https://api.github.com/repos/rhashimoto/wa-sqlite/releases`,
  `https://raw.githubusercontent.com/rhashimoto/wa-sqlite/master/README.md`
- **npm is a trap.** `https://registry.npmjs.org/wa-sqlite` has exactly one version, **`1.0.0`,
  published 2024-01-05**, and that is `latest`. `npm install wa-sqlite` gets you a package roughly
  two and a half years behind the repo, missing `OPFSWriteAheadVFS` and `OPFSPermutedVFS` entirely.
- VFSes now in `src/examples` (`https://api.github.com/repos/rhashimoto/wa-sqlite/contents/src/examples?ref=master`):
  `AccessHandlePoolVFS`, `IDBBatchAtomicVFS`, `IDBMirrorVFS`, `MemoryVFS`, `MemoryAsyncVFS`,
  `OPFSAdaptiveVFS`, `OPFSAnyContextVFS`, `OPFSCoopSyncVFS`, **`OPFSPermutedVFS`**,
  **`OPFSWriteAheadVFS`**.
- **No wa-sqlite VFS requires SharedArrayBuffer or cross-origin isolation.** The project's own
  comparison table marks "No COOP/COEP requirements" ✅ for every row. It also marks "Full
  durability" ✅ for every row, with "Relaxed durability" available only on `IDBBatchAtomicVFS`,
  `IDBMirrorVFS` and `OPFSWriteAheadVFS`. That is the project's claim; over OPFS it inherits the
  same `flush()` weakness described above.
  Source: `https://raw.githubusercontent.com/rhashimoto/wa-sqlite/master/src/examples/README.md`
- Notable per-VFS facts from the same README:
  - `IDBBatchAtomicVFS` — "IndexedDB works on all contexts - Window, Worker, SharedWorker, service
    worker, extension - which makes IDBBatchAtomicVFS a good general purpose VFS."
  - `AccessHandlePoolVFS` — single connection only, but "there is no drawback to using `PRAGMA
    locking_mode=exclusive`. This in turn allows `PRAGMA journal_mode=wal`". Not filesystem
    transparent.
  - `OPFSAnyContextVFS` — runs anywhere but "Write performance… will be very bad and will be
    increasingly worse as the file grows. It is recommended to use it only for read-only or nearly
    read-only databases."
  - `OPFSWriteAheadVFS` — "**It requires the proposed 'readwrite-unsafe' locking mode for OPFS access
    handles (only on Chromium browsers as of June 2024).**" and "Write-ahead logging is implemented
    entirely within the VFS and is always on. It does not use the WAL feature built in to SQLite."
- The author's own framing of the examples: they "are intended to help developers get started with
  writing extensions, and to experiment with interesting approaches and techniques. **Using them
  as-is in production is not prohibited but that isn't their primary purpose.**" Same source.

### Cross-origin isolation and `SharedArrayBuffer`

- Requirement: "you will need to set the COEP header with a value of `require-corp` or
  `credentialless`, and the `Cross-Origin-Opener-Policy` header to `same-origin`."
  Source: `https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy`
  MDN adds: "To use shared memory your document must be in a secure context and cross-origin
  isolated." Chrome: "Starting in Desktop Chrome 92 it will only be available to cross-origin
  isolated pages." (`https://developer.chrome.com/blog/enabling-shared-array-buffer`)
- **Available in all three engines under those headers.** MDN compat data
  (`javascript.builtins.SharedArrayBuffer`): Chrome 68, Chrome Android 89, Edge 79, Firefox 79,
  Safari 15.2, Safari iOS 15.2. WebKit confirms: "Safari 15.2 adds support for
  `Cross-Origin-Opener-Policy` (COOP) and `Cross-Origin-Embedder-Policy` (COEP) HTTP response
  headers." (`https://webkit.org/blog/12140/new-webkit-features-in-safari-15-2/`)
- **Extensions are the sharp edge.**
  - Chrome exposes `cross_origin_embedder_policy` and `cross_origin_opener_policy` manifest keys
    (Chrome 93+), which "allows the extension to opt into cross-origin isolation" and "to use
    powerful APIs like SharedArrayBuffers in its cross-origin isolated contexts". But, verbatim:
    "Even if an extension opts into cross-origin isolation, not all extension contexts will be
    cross-origin isolated. For example, **cross-origin isolation is not fully implemented for
    service and shared workers currently.**" Caveat on the caveat: that page reports last updated
    **2021-08-03**, so its current accuracy is **unverified**; no newer Chrome doc revising it was
    found. Sources: `https://developer.chrome.com/docs/extensions/develop/concepts/cross-origin-isolation`,
    `https://developer.chrome.com/docs/extensions/reference/manifest/cross-origin-embedder-policy`
  - Firefox: **no.** Bugzilla 1673477, "Enable crossOriginIsolated and use of SharedArrayBuffer for
    Extension pages", is **REOPENED and unresolved**; the blocker is that Firefox runs all extensions
    in one process, so full support needs per-extension process isolation (bug 1827085), described
    as "a heavy lift". No MDN documentation of COOP/COEP manifest keys for Firefox extensions was
    found. Source: `https://bugzilla.mozilla.org/show_bug.cgi?id=1673477` (bug tracker).
  - Whether `SharedArrayBuffer` is available in a Chrome extension context *without* the manifest
    keys is **unverified** — no Chrome doc states it either way.

### `FileSystemSyncAccessHandle` availability

MDN compat data (`api.FileSystemSyncAccessHandle`). The column that matters is the **synchronous**
method signatures — the original API returned Promises.

| Engine | Interface first available | Synchronous methods |
| --- | --- | --- |
| Chrome | 102 | **108** |
| Chrome Android | 109 | 109 |
| Firefox / Firefox Android | 111 | 111 |
| Safari / Safari iOS | 15.2 | **16.4** |

SQLite's docs agree: "Chromium-derived browsers released since approximately mid-2022. As of v108
(November 2022) some OPFS APIs changed from asynchronous to synchronous… Firefox v111 (March 2023)
and later. Safari 16.4 (March 2023) and later."
Sources: `https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle`,
`https://sqlite.org/wasm/doc/trunk/persistence.md`

The handle's locking rules matter for a single-writer outbox
(`https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle`):
creating one "takes an exclusive lock… This prevents the creation of further
`FileSystemSyncAccessHandle`s or `FileSystemWritableFileStream`s for the file until the existing
access handle is closed", and a second `readwrite` handle throws `NoModificationAllowedError`.

**`readwrite-unsafe` is Chromium-only and non-standard.** MDN compat data for the `mode` option on
`createSyncAccessHandle`: `chrome: 121`, `chrome_android: 121`, **`firefox: false`, `safari: false`,
`safari_ios: false`**. Searching `https://fs.spec.whatwg.org/` for "readwrite-unsafe",
"FileSystemCreateSyncAccessHandleOptions" and "mode" returns **no matches** — the published spec
still describes only the exclusive lock. Consequence: wa-sqlite's `OPFSWriteAheadVFS`, its only true
WAL OPFS VFS, is Chromium-only.

### Documented OPFS data-loss and corruption caveats

From `https://sqlite.org/wasm/doc/trunk/persistence.md`:

- Databases can just vanish: "Users sometimes report that their OPFS databases randomly disappear.
  There is no code in this project which will delete a database without an explicit request from a
  client, but databases nonetheless sometimes disappear for environment-specific reasons outside of
  this library's control, including, but not limited to: — Virus scanners — 'Computer Cleaner'
  software — Browser-level storage permissions — A browser-internal decision to clean up on its own."
- Private/guest browsing: "storage capabilities might be adversely affected, e.g. with lower quotas
  or a complete lack of persistence", and detection is deliberately hard — "browser makers
  intentionally make it difficult to detect such modes… so we cannot offer any advice on how to
  circumvent them."
- Quota exhaustion: "If the limits are exceeded, SQLite will respond with generic I/O errors."
- Lock failures are inconsistent: "explicit lock attempts will consistently fail with `SQLITE_BUSY`
  when applicable, but many cases must *implicitly* acquire OPFS locks… and *those* lock acquisition
  failures *might*, depending on the precise nature of the failure, bubble up as generic I/O errors
  instead of `SQLITE_BUSY`."
- A recovery hatch exists: the `delete-before-open=1` URI flag (3.46+) on the `"opfs"` VFS, "to
  recover from a corrupted database without having to reach into OPFS-specific JS APIs to eliminate
  it."
- `pauseVfs()` — "If the OPFS API throws while closing handles then the VFS is left in an undefined
  state."
- `https://sqlite.org/changes.html` records past OPFS corruption bugs since fixed, e.g. "Fix a
  corruption-causing bug in the JavaScript 'opfs' VFS" (in two separate releases).

**Crash safety over OPFS is undocumented.** No statement was found in sqlite.org, MDN or the WHATWG
FS spec about what happens to an OPFS-hosted SQLite database when a tab is killed mid-transaction,
and there is no browser-build equivalent of SQLite's usual "power loss cannot corrupt the database"
claim. Searched `persistence.md` for "crash", "durab", "corrupt", "synchronous"; searched the FS
spec for durability language; read both `xSync` implementations.

## `chrome.storage.local` / `browser.storage.local` versus IndexedDB inside an extension

### `chrome.storage.local` quota

Source: `https://developer.chrome.com/docs/extensions/reference/api/storage`

- `QUOTA_BYTES` = **10485760 (10 MB)**, "as measured by the JSON stringification of every value plus
  every key's length". The page states it explicitly: "The storage limit is 10 MB (5 MB in Chrome
  113 and earlier)." The raise landed in **Chrome 114**
  (`https://developer.chrome.com/docs/extensions/whats-new`) and is confirmed in Chromium source
  (`https://chromium.googlesource.com/chromium/src/+/main/extensions/common/api/storage.json`).
- "This value will be ignored if the extension has the `unlimitedStorage` permission."
- Over-quota writes fail loudly, not silently: they "fail immediately and set `runtime.lastError`
  when using a callback, or a rejected Promise if using async/await."
- `unlimitedStorage` "Provides an unlimited quota for `chrome.storage.local`, `IndexedDB`, `Cache
  Storage`, and `Origin Private File System`"
  (`https://developer.chrome.com/docs/extensions/reference/permissions-list`) and "exempts extensions
  from both quota restrictions **and eviction**"
  (`https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies`).

### Backing store: LevelDB, not IndexedDB — source-verified, undocumented

The developer docs never say. The Chromium source does:

- `https://chromium.googlesource.com/chromium/src/+/main/extensions/browser/api/storage/local_value_store_cache.cc`
  builds the local area via `value_store_util::CreateSettingsStore(settings_namespace::LOCAL, …)`
  with quota `api::storage::local::QUOTA_BYTES`.
- `https://chromium.googlesource.com/chromium/src/+/main/components/value_store/value_store_factory_impl.cc`
  returns `std::make_unique<LeveldbValueStore>(uma_client_name, GetDBPath(directory))`.

So: **LevelDB.** Treat this as source-verified but undocumented, and therefore not a stability
contract.

### Eviction, clearing, and durability of `chrome.storage.local`

Source: `https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies` unless noted.

- "Extension storage is not cleared when a user clears browsing data." The storage reference adds:
  "Even if the user clears the cache and browsing history, the data persists."
- "Extensions are subject to the normal quota restrictions on storage, which can be checked by
  calling `navigator.storage.estimate()`."
- "Storage can also be evicted under heavy memory pressure, although this is rare."
- "Call `navigator.storage.persist()` for protection against eviction."
- "Extension storage is shared across the extension's origin including the extension service worker,
  any extension pages (including popups and the side panel), and offscreen documents."
- "The IndexedDB and Cache Storage APIs are accessible in service workers" — Local Storage and
  Session Storage are not.
- `storage.local` is cleared when the extension is removed (storage reference).

**Atomicity and fsync: unverified — the docs are silent.** Reading
`https://developer.chrome.com/docs/extensions/reference/api/storage` and the `StorageArea` method
reference finds:

- no statement about atomicity across a multi-key `set()`,
- no statement about transactions,
- no statement about fsync or about whether a resolved Promise means the bytes reached disk.

The only durability-adjacent guarantee Chrome documents anywhere is the quota-exceeded failure path.
**A resolved `storage.local.set()` Promise must not be assumed to mean durable-on-disk.**

### `chrome.storage.session`

Source: `https://developer.chrome.com/docs/extensions/reference/api/storage`

- `QUOTA_BYTES` = **10485760 (10 MB)**, but measured differently — "as measured by estimating the
  dynamically allocated memory usage of every value and key", not by JSON stringification. Raised to
  10 MB in **Chrome 112** (`https://developer.chrome.com/docs/extensions/whats-new`).
- "Items in the `session` storage area are stored in-memory and will not be persisted to disk."
- Cleared "if the extension is disabled, reloaded, updated, and when the browser restarts."
- Not exposed to content scripts by default; changeable via `chrome.storage.session.setAccessLevel()`.

### IndexedDB inside a Chrome extension

- It uses the **`chrome-extension://` origin's shared quota**, the same one reported by
  `navigator.storage.estimate()`, and shared across the service worker, extension pages and
  offscreen documents.
  Source: `https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies`
- `unlimitedStorage` does cover it, and exempts it from eviction.
  Source: `https://developer.chrome.com/docs/extensions/reference/permissions-list`
- Otherwise it is subject to **the same LRU, all-or-nothing eviction as web-page IndexedDB**, with
  the same 60%-of-disk Chromium quota and the same `persist()` exemption. Source: MDN storage-quotas
  page cited in the first section.

The practical contrast inside an extension:

| | `chrome.storage.local` | Extension IndexedDB |
| --- | --- | --- |
| Default size limit | 10 MB (Chrome 114+) | share of the 60%-of-disk origin quota |
| Raised by `unlimitedStorage` | yes | yes |
| Survives "clear browsing data" | **yes, documented** | yes — extension storage as a whole is documented as not cleared |
| Evictable under storage pressure | yes, "rare"; removed by `unlimitedStorage` or `persist()` | yes, LRU, all-or-nothing; removed by `unlimitedStorage` or `persist()` |
| Transactions / atomicity | **unverified — undocumented** | yes, per the IndexedDB spec |
| Per-write durability control | **none documented** | `{durability: "strict"}`, honoured by Chromium |
| Available in an MV3 service worker | yes | yes |
| Backing store | LevelDB (source-verified, undocumented) | LevelDB via Chromium's IDB backend |

### `browser.storage.local` in Firefox

Source: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/local`

- Firefox's `storage.local` is "subjected to the same storage limits as applied to IndexedDB
  databases" — an inherited quota, not a fixed byte count. MDN says the *limits* match; it does not
  say IndexedDB is the backing store, so **the Firefox backing store is unverified.**
- `unlimitedStorage` is required to exceed the standard limit, and MDN warns that even with it an
  extension "may receive a quota exceeded error if disk space usage exceeds the global limit."
- Durability against user clearing, verbatim: "Firefox clears data stored by extensions using the
  `localStorage` API in various scenarios where users clear their browsing history and data for
  privacy reasons. **Data saved using the `storage.local` API is correctly persisted in these
  scenarios.**"
- Uninstall clears it; the `about:config` prefs `keepUuidOnUninstall` and `keepStorageOnUninstall`
  can preserve it but are "intended for testing purposes only" and extensions cannot change them.
- **No atomicity, transactional or fsync guarantee is documented. Unverified.**
- Doc-accuracy warning: this MDN page still states Chrome's limit is 5 MB. That is out of date —
  Chrome's own reference and Chromium source both say 10 MB since Chrome 114.

### Safari web-extension storage

Source: `https://developer.apple.com/documentation/safariservices/assessing-your-safari-web-extension-s-browser-compatibility`

- "Local storage limit is 5 MB. In Safari 15 or earlier, setting this to `unlimited` increases the
  extension's storage limit to 10 MB. **In Safari 16 or later, setting this to `unlimited` grants
  unlimited storage.**"
- `storage.session`: "Supported in Safari 16.4 or later."
- `storage.sync`: "Storage mechanism implemented, but syncing not supported" — on Safari,
  `storage.sync` is local storage wearing a sync name.
- Whether Safari extension storage is in scope of the ITP seven-day cap is **unverified** (see the
  Safari section above).

### Documented data-loss risks

- **Chrome does not document `storage.local` loss, corruption, or silent write failure.
  Unverified.** Searched the storage reference, the storage-and-cookies concept page and the
  permissions list. Chrome documents the *opposite* of silent failure for the quota case.
- The loss vectors Chrome *does* state: eviction "under heavy memory pressure, although this is
  rare"; clearing on extension removal; `storage.session` loss on disable, reload, update or browser
  restart.
- Bug-tracker hints, marked as such and **not verifiable today** (issues.chromium.org returned a
  sign-in wall): issue 432503402 "`chrome.storage.local` LevelDB never compacts after key…" and
  issue 40182034 "Extension origins should be protected from web storage eviction".

## Bottom line for Bittery

Implications that follow directly from the sources above. No recommendation is made here; the
decision belongs to the ticket that consumes this evidence.

- **No engine offers a documented "this write is on disk" acknowledgement to a web app.** The
  strongest primitive is the IndexedDB `durability: "strict"` hint, and Chrome itself qualifies it:
  "`strict` does not ensure that changes are *actually* written immediately to disk." Over OPFS the
  contract is weaker still — `FileSystemSyncAccessHandle.flush()` is spec'd as an *attempt* that
  "can be a no-op", and write ordering is deliberately unspecified. A browser-hosted outbox cannot
  obtain an fsync-grade acknowledgement; it can only obtain a best-effort one.
- **All three engines now default to `relaxed` durability for IndexedDB.** Chromium switched last
  (Chrome 121/122, per two disagreeing first-party sources); Gecko has been non-durable by default
  since Firefox 40 and only implemented the standard `durability` option in Firefox 126. So an app
  that does not pass `{durability: "strict"}` explicitly is choosing a "few seconds of OS buffer"
  loss window on every engine.
- **Eviction is all-or-nothing per origin, and the only lever is `persist()`.** When an origin is
  evicted, "all of its data, not parts of it, is deleted at the same time" — IndexedDB and OPFS go
  together. `persist()` is granted without a prompt on Chromium and Safari by heuristics the app
  cannot query in advance, and with a user prompt on Firefox. `persist()` is `[Exposed=Window]`, so
  a worker that owns the database cannot request it.
- **Safari's seven-day cap is unchanged as of Safari 26.6 and names IndexedDB explicitly.** The only
  documented exemption is a Home Screen web app. Whether `persist()` exempts an ordinary Safari tab
  is not stated by any WebKit source; whether OPFS is in scope is implied but never stated; whether
  Safari *extension* storage is in scope is undocumented in either direction. Three unverified gaps,
  all on the same engine, all in the path of an offline edit surviving a quiet week.
- **A LAN-only `http://` origin loses most of the durability toolkit.** IndexedDB and Web Storage
  survive; OPFS, `crypto.subtle`, service workers, the Cache API, Web Locks and all of
  `navigator.storage` — including `persist()` and `estimate()` — do not. `http://192.168.x.x` and
  `http://*.local` are not potentially trustworthy under the spec; only loopback and `*.localhost`
  are. Chromium and Firefox each expose an override (enterprise policy / hidden pref); no Safari
  equivalent was found.
- **An MV3 extension service worker is a hostile host for a write in flight.** It dies after 30
  seconds of inactivity, IndexedDB activity is not a documented keep-alive, there is no `waitUntil`
  for `chrome.*` events (the WECG proposal is still open), and no Chrome document promises the
  browser waits for a pending transaction. The spec's behaviour for an unfinished transaction is
  rollback. A worker also cannot spawn a dedicated worker, so it cannot use an OPFS sync access
  handle at all — that requires an offscreen document with the `WORKERS` reason.
- **`chrome.storage.local` trades transactions for survivability.** It is documented as not cleared
  when the user clears browsing data, but it has no documented atomicity, no transaction, no fsync
  statement, and a 10 MB cap unless `unlimitedStorage` is taken. Extension IndexedDB has real
  transactions and a durability hint but shares the origin quota and the ordinary eviction path
  unless `unlimitedStorage` or `persist()` is used.
- **SQLite over OPFS is viable without cross-origin isolation, but not with concurrency and
  durability at once.** `opfs-sahpool` and the new 3.53.0 `opfs-wl` need no `SharedArrayBuffer`;
  `opfs-sahpool` is single-connection; WAL in the official build requires
  `locking_mode=exclusive`, which "eliminates all concurrency support". Both official OPFS VFSes
  reduce `xSync` to `flush()` and ignore the sync flags, so `PRAGMA synchronous` has no effect.
  Crash safety over OPFS is undocumented everywhere that was searched.

### Strongest durability guarantee obtainable, per engine

Read "guarantee" narrowly: what a primary source actually promises.

| | Chromium | Firefox | WebKit / Safari |
| --- | --- | --- | --- |
| **Strongest documented write acknowledgement** | IndexedDB `durability: "strict"` — "explicitly instructs the OS to flush changes to disk before issuing the `complete` event", with the explicit caveat that it "does not ensure that changes are *actually* written immediately to disk" | `durability` option exists from Firefox 126; **what `strict` does at the fsync level is unverified** — no Mozilla source found | IndexedDB `durability: "strict"` (Safari 15+) triggers a full SQLite checkpoint (`CheckpointMode::Full`), per WebKit changeset 280415 |
| **Default durability if you say nothing** | `relaxed` since Chrome 121/122 | `relaxed` since Firefox 40 | `relaxed` |
| **Strongest anti-eviction guarantee** | `persist()`, auto-granted by heuristics (engagement / installed or bookmarked / notifications permission); then "the browser won't evict data stored in" IndexedDB, OPFS, Cache, Service Workers | `persist()`, granted by explicit user prompt; also raises quota to 50% of disk / 8 TiB. Strongest *user-visible* consent of the three | `persist()`, auto-granted by heuristics "like whether the website is opened as a Home Screen Web App". An origin with an active page is also excluded from eviction |
| **Time-based deletion floor** | none documented | none documented | **7 days of Safari use without a click, tap or keyboard entry** deletes IndexedDB, localStorage, sessionStorage, SW registrations and cache. Only Home Screen web apps are documented as exempt |
| **Per-bucket durability / eviction priority** | Storage Buckets, Chrome 122+, IndexedDB only | not supported (bug 1594740) | not supported |
| **OPFS durability primitive** | `FileSystemSyncAccessHandle.flush()` — spec'd as an "attempt", may be a no-op | same | same |
| **`SharedArrayBuffer` for the SAB-dependent SQLite `"opfs"` VFS** | yes, with COOP+COEP (Chrome 68+); in extensions, manifest keys exist but service workers are documented as "not fully implemented" | yes on the web (Firefox 79+); **not in extensions** — bug 1673477 REOPENED | yes, with COOP+COEP (Safari 15.2+); in extensions, unverified |
| **Extension background context** | MV3 service worker, 30 s idle timeout, no hard lifetime cap since Chrome 110 | MV3 event page; 30 s default via `extensions.background.idle.timeout` (bug tracker, not docs) | nonpersistent background page (mandatory on iOS); **timeout value unverified** |
