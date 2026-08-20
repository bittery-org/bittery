# Extension Local Network Access and private-address classification

Research for [ticket 52](../issues/52-extension-local-network-access-facts.md). Retrieved
2026-08-20. Facts only, from primary sources: the WICG specification, Chromium and Mozilla and
WebKit source and bug trackers, first-party browser and vendor documentation. This file decides
nothing. Ticket 41 owns the Extension consequence, ticket 42 the Desktop one.

Three subagents produced the three parts below, one per engine family. Each claim in a part carries
its own source URL and retrieval date.

## Cross-engine summary

**The Extension is not gated on either engine today, and on neither engine is that a promise.**

- **Chromium exempts extensions on purpose, but not by contract.** Chromium maps every
  `chrome-extension://` URL to the **loopback** address space, and the gate only fires on a move to a
  *less public* space. Nothing is less public than loopback, so the check is never reached. Chrome's
  own Local Network Access Adoption Guide says: "We do not currently have plans to apply LNA
  restrictions to extensions." The word is *currently*. The exemption is one line in
  `ChromeContentBrowserClient::DetermineAddressSpaceFromURL`, and it has already failed twice in
  shipping Chrome: extension service workers were classed public in Chrome 138 and 139
  (crbug 435246545, fixed in M140), and a service worker registered before that fix stayed broken
  until M142 or M143 (crbug 456078996).
- **Firefox exempts extensions by accident.** The gate fires only when the initiator's address space
  is `Public` or `Private`. A browsing context starts at `Unknown`, and the value is set in exactly
  two places, both in `nsHttpChannel`, from the peer address of a document load. A `moz-extension://`
  document never goes through `nsHttpChannel`, so it stays `Unknown` and the gate never fires. The
  specification says that value should initialise to *public*; Firefox diverges. No test in
  mozilla-central covers a `moz-extension://` initiator. A Mozilla engineer wrote on bug 2032778 that
  the fix "would be to actually check request is coming from extension and exempt them", which
  confirms no such check exists.
- **Content scripts are gated on both engines.** A content script inherits the host page's client
  security state, so a content script running on a public page is gated exactly like that page. This
  is source-derived on Chromium and stated by a Mozilla engineer on Bugzilla for Firefox. No
  first-party documentation says it.
- **`host_permissions` is not an exemption on either engine.** It decides whether the request is
  attempted. It plays no part in the address-space check. Neither engine defines any extension
  permission for local network access.
- **`100.64.0.0/10` is classified `local`, not public.** This contradicts the assumption in the
  ticket body. It is confirmed in the WICG specification table, in Chromium's
  `ip_address_space_util.cc` with a dedicated unit test, in Firefox's `NetAddr::IsIPAddrShared()`
  with a gtest, and in WebKit's `IPAddressSpace.cpp`. Tailscale's IPv6 prefix
  `fd7a:115c:a1e0::/48` sits inside `fc00::/7`, also local. Classification uses the resolved
  connection IP, not the host string, so a `*.ts.net` MagicDNS name and a publicly-trusted Tailscale
  certificate buy nothing against the gate. They still buy the secure context `HOST-007` needs.
- **`.local` is not special-cased in Firefox at all.** Firefox classifies the resolved IP only.
- **A denial is invisible to calling code.** `fetch` rejects with a plain `TypeError` on both
  engines, and a WebSocket gives close code 1006 with `wasClean: false`, indistinguishable from a
  dead port. The only in-page discriminator is
  `navigator.permissions.query({name: "local-network"})`, which works on both engines. MDN browser
  compatibility data says Firefox does not support that query and is wrong.
- **Grant lifetime differs sharply.** Chromium stores a persistent per-top-level-origin grant, with
  no "allow once" and a 7-day embargo after three dismissals. Firefox defaults to **24 hours and
  per-tab**; only ticking "Remember my choice for this site" makes it permanent. Firefox shared and
  service workers never prompt and require an already-stored *persistent* grant, so the 24-hour
  temporary grant does not satisfy them.
- **The Desktop webview is not gated today.** Chromium enabled `LocalNetworkAccessChecks` by default
  at M142, but Microsoft holds it off for WebView2 and has published a breaking-change notice saying
  so. `CoreWebView2PermissionKind` has no local-network value, so a WebView2 host application cannot
  yet answer the prompt through `PermissionRequested`. WebKit has the feature flag with
  `status: unstable` and `default: false`, and the check algorithm itself is still unlanded, so
  WKWebView and WebKitGTK do not gate. Tauri's own `plugin-http` routes through Rust `reqwest` and
  bypasses the webview network stack entirely.
- **The macOS app-level local network prompt does not apply.** Apple's TN3179 states that traffic
  from `WKWebView` does not require local network access. A Tauri window on macOS 15 or later does
  not trip it. That gate is defined by broadcast-capable interface and explicitly excludes VPN
  traffic, so an overlay network does not trip it either.
- **Firefox ESR 140 has no gate at all.** No prefs, no error code, no prompt. ESR-next 153 has it.
- **Two of the ticket body's version claims were wrong.** Firefox shipped Local Network Access
  user-visible in **147**, not 149, and it became default-on for everyone in **153**, not 151. The
  WebSocket extension in 154 is right; the release date is 2026-08-18, not 2026-08-17.

### Known live defects worth watching

- Firefox bug 2023758 (NEW): an extension page inside an iframe on a public page does trigger the
  prompt.
- Firefox bug 2032778 (NEW, unassigned): an aborted navigation flips an extension page to public.
- Firefox bug 1984359: a Bitwarden-over-Tailscale report, open, with the necko fix unwritten.
- Chromium's M142 workaround that rewrites stale service-worker registrations to `kLoopback` is
  still in `main`.

## Local Network Access in Chromium

Produced by a subagent resolving ticket 52
(`planning/greenfield-decision-map/issues/52-extension-local-network-access-facts.md`). This part
covers **Chromium only**. Firefox and desktop webviews are other parts.

Every source below was retrieved **2026-08-20**. Status: evidence. Facts only; this file makes no
decision and gives no recommendation.

Where a primary source could not be found, the text says **unverified** and names what was searched.

Chrome Stable at retrieval is **151.0.7922.171**, with **152.0.7977.54** starting to roll out on
2026-08-19. Source: `https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Windows&num=5`

### The short version

An MV3 extension is **not** gated. Chromium maps every `chrome-extension://` URL to the `loopback`
address space, and Local Network Access (LNA) only blocks requests that move to a *less public*
address space. Nothing is less public than loopback, so extension service workers, extension pages
and offscreen documents never trip the check. This is stated in Chrome's own adoption guide and is
verifiable in the source. Content scripts are the exception: they inherit the host page's address
space and are gated exactly like the page.

Two things still bite. First, `100.64.0.0/10`, the CGNAT range Tailscale uses, is classified
**`local`**, not public. That does not matter for the extension, but it does matter for any *page*
on a public origin. Second, extension service workers were genuinely broken by LNA between Chrome
138 and 140, and extensions with a service worker registered before the fix stayed broken until
Chrome 142/143.

### 1. What shipped, and when

#### Milestones

Source: `https://chromestatus.com/api/v0/features/5152728072060928` (feature "Local network access
restrictions", created 2025-03-06 by cthomp@chromium.org, last updated 2026-07-15). Stable dates
from `https://chromiumdash.appspot.com/fetch_milestone_schedule?mstone=<N>`.

| Chrome | Stable date | What happened |
| --- | --- | --- |
| 138 (desktop) / 139 (Android) | 2025-06-24 | Developer trial. Opt in at `chrome://flags/#local-network-access-check`, set to "Enabled (Blocking)" |
| 141 | 2025-09-30 | Reverse origin trial "Local Network Access from Non-Secure Contexts" opens |
| **142** | **2025-10-28** | **Shipped on by default, desktop and Android**, for subresource requests, `fetch()`, and subframe navigation |
| 145 | 2026-02-10 | Single `local-network-access` permission splits into `local-network` and `loopback-network` |
| 146 | 2026-03-10 | `LocalNetworkAccessIpAddressSpaceOverrides` and `LocalNetworkAccessPermissionsPolicyDefaultEnabled` policies land. Reverse origin trial's original end |
| 147 | 2026-04-07 | LNA extended to **WebSocket and WebTransport** |
| 152 | 2026-08-25 (scheduled) | Reverse origin trial's extended end |
| 156 | 2026-10-20 (scheduled) | `LocalNetworkAccessRestrictionsTemporaryOptOut` policy is removed |

Chrome Platform Status still lists the feature's overall status as "In development" because WebRTC
coverage has not landed. The `desktop`/`android` ship milestone is 142.

The reverse origin trial is a **deprecation trial**: `ot_is_deprecation_trial: true`, Chromium trial
name `LocalNetworkAccessNonSecureContextAllowed`, origin trial id `3826370833404657665`. Its
description: "Temporarily allows for access to resources on local networks to originate from
non-secure contexts… This origin trial can only be enabled through HTTP header provided origin
tokens." It ran M141–M146, then was extended to M152 because "Launch of Local Network Access
restrictions for WebSockets has been delayed from M144 to M147 due to holidays and enterprise
concerns." Same source.

#### Feature flags in current `main`

Source: `https://raw.githubusercontent.com/chromium/chromium/main/services/network/public/cpp/features.cc`

```cpp
BASE_FEATURE(kLocalNetworkAccessChecks, base::FEATURE_ENABLED_BY_DEFAULT);
BASE_FEATURE_PARAM(bool, kLocalNetworkAccessChecksWarn,
                   &kLocalNetworkAccessChecks,
                   /*name=*/"LocalNetworkAccessChecksWarn",
                   /*default_value=*/false);
BASE_FEATURE(kLocalNetworkAccessChecksWebSockets, base::FEATURE_ENABLED_BY_DEFAULT);
BASE_FEATURE(kLocalNetworkAccessChecksWebTransport, base::FEATURE_ENABLED_BY_DEFAULT);
BASE_FEATURE(kLocalNetworkAccessChecksWebRTC, base::FEATURE_DISABLED_BY_DEFAULT);
```

#### What LNA replaced

Chrome's blog states it plainly (`https://developer.chrome.com/blog/local-network-access`, published
2025-06-09, updated 2025-09-29):

> "Chrome previously experimented with restricting access to local network devices with Private
> Network Access, which required CORS preflights where the target device opted in to being connected
> to, instead of gating all local network accesses behind a permission prompt. Local Network Access
> replaces that effort, after PNA was put on hold."

The WICG repository says the same: the Local Network Access specification "supersedes Private
Network Access, which was previously hosted at https://github.com/WICG/private-network-access/".
Source: `https://github.com/WICG/local-network-access`

Chrome Platform Status repeats it: "This work supersedes a prior effort called Private Network
Access, which used preflight requests to have local devices opt in."

The taxonomy was renamed, not redesigned. PNA's `local`/`private`/`public` became LNA's
`loopback`/`local`/`public`. The parser still accepts the old word:

```cpp
  // Keep 'private' as an alias for 'local' until usages of 'private' are
  // removed from Web Platform Test code base.
  if (str == "private") { return IPAddressSpace::kLocal; }
```

Source: `https://raw.githubusercontent.com/chromium/chromium/main/services/network/public/cpp/ip_address_space_util.cc`

#### Specification and explainer

- Specification: `https://wicg.github.io/local-network-access`, source
  `https://raw.githubusercontent.com/WICG/local-network-access/main/index.bs`
- Explainer: `https://raw.githubusercontent.com/WICG/local-network-access/main/explainer.md`
- Chrome's adoption guide, "LNA Adoption Guide: Adapting your website for new Local Network Access
  restrictions in Chrome", last updated **2026-05-18**, linked from both the Chrome blog and Chrome
  Platform Status:
  `https://docs.google.com/document/d/1QQkqehw8umtAgz5z0um7THx-aoU251p705FbIQjDuGs/edit`
  (plain-text export: append `/export?format=txt` to the document id path)

Other engines, per Chrome Platform Status: Firefox "Shipped/Shipping"; Safari "No signal"; Brave
ships its own "localhost access" permission.

### 2. Does the gate apply to an MV3 extension? No.

#### Chrome says so in writing

LNA Adoption Guide, section "What is the current scope of LNA restrictions in Chrome?", verbatim:

> "We do not currently have plans to apply LNA restrictions to extensions. Currently, extensions that
> have the necessary host permissions are allowed to make local network requests."

Source: `https://docs.google.com/document/d/1QQkqehw8umtAgz5z0um7THx-aoU251p705FbIQjDuGs/`
(retrieved 2026-08-20; document dated 2026-05-18)

The same guide lists what *is* in scope: subresource requests, `fetch()`, subframe navigations
(M142); WebSockets and WebTransport (M147); WebRTC not yet. It adds: "We do not currently have plans
to apply LNA restrictions to main frame navigations."

A Chrome engineer on the LNA team gave the mechanism publicly, answering a question titled "Question
about this affect on extensions" on the specification repository:

> "(Chrome-only answer)
> An extension URL is considered to be in the `loopback` address space…
> If you're making the `fetch` call from a service worker within the extension, it should just work
> (assuming the extension has `host_permission` to make the call)."

Source: `https://github.com/WICG/local-network-access/issues/41#issuecomment-3249630309`
(hubertchao, 2025-09-03; issue closed 2025-09-12)

#### The mechanism, in source

**Step 1. The extension scheme maps to `loopback`.**

`https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/chrome_content_browser_client.cc`

```cpp
ChromeContentBrowserClient::DetermineAddressSpaceFromURL(const GURL& url) {
  if (url.SchemeIs(chrome::kChromeSearchScheme)) {
    return network::mojom::IPAddressSpace::kLoopback;
  }
  if (url.SchemeIs(dom_distiller::kDomDistillerScheme)) {
    return network::mojom::IPAddressSpace::kPublic;
  }
#if BUILDFLAG(ENABLE_EXTENSIONS_CORE)
  if (url.SchemeIs(extensions::kExtensionScheme)) {
    return network::mojom::IPAddressSpace::kLoopback;
  }
#endif

  return network::mojom::IPAddressSpace::kUnknown;
}
```

This is reached from `content`'s `CalculateIPAddressSpace()`, which falls back to
`IPAddressSpaceForSpecialScheme(url, client)` whenever the network layer returns `kUnknown`, which
is what happens for a non-network scheme, since there is no remote endpoint. The comment above that
function explains why the list exists:

> "Special chrome schemes cannot directly be categorized in public/private/loopback address spaces
> using information from the network or the PolicyContainer. We have to classify them manually. In
> its default state an unhandled scheme will have an IPAddressSpace of kUnknown, which is equivalent
> to public."

Source: `https://raw.githubusercontent.com/chromium/chromium/main/content/browser/renderer_host/local_network_access_util.cc`

**Step 2. Nothing is less public than `loopback`.**

`https://raw.githubusercontent.com/chromium/chromium/main/services/network/local_network_access_checker.cc`

```cpp
  // Currently for LNA we are only blocking public -> local/private/loopback
  // requests. Requests from local -> loopback are not blocked at present.
  if (base::FeatureList::IsEnabled(features::kLocalNetworkAccessChecks)) {
    if (!IsLessPublicAddressSpaceLNA(
            resource_address_space, client_security_state_->ip_address_space)) {
      return Result::kAllowedNoLessPublic;
    }
  }
```

and, in `ip_address_space_util.cc`:

```cpp
// For comparison purposes, we treat kLocal and kLoopback as equivalent
// (kLocal arbitrarily chosen over kLoopback).
IPAddressSpace CollapseLocalAndLoopback(IPAddressSpace space) {
  if (space == IPAddressSpace::kLoopback) { return IPAddressSpace::kLocal; }
  return space;
}

bool IsLessPublicAddressSpaceLNA(IPAddressSpace lhs, IPAddressSpace rhs) {
  return CollapseLocalAndLoopback(CollapseUnknown(lhs)) <
         CollapseLocalAndLoopback(CollapseUnknown(rhs));
}
```

Client space `kLoopback` collapses to `kLocal`, the minimum. No target can be strictly less, so the
checker returns `kAllowedNoLessPublic` and the request proceeds.

**Step 3. The early, URL-only prompt does not fire either.** Chromium also pokes the permission
prompt before connecting when the address space is readable from the URL alone. That path is guarded
by the same check:

```cpp
      LocalNetworkAccessChecker lna_checker(request, client_security_state, options_);
      if (lna_checker.CheckAddressSpace(*url_address_space) ==
          LocalNetworkAccessCheckResult::kLNAPermissionRequired) {
        ...
        url_loader_network_observer_->OnLocalNetworkAccessPermissionRequired(...)
```

Source: `https://raw.githubusercontent.com/chromium/chromium/main/services/network/url_loader.cc`

For an extension client the result is `kAllowedNoLessPublic`, so no prompt is requested.

#### Which origin the check uses, per extension context

| Context | Client `IPAddressSpace` | Gated by LNA? | Evidence |
| --- | --- | --- | --- |
| Background service worker | `kLoopback` | **No** | `service_worker_context_wrapper.cc` calls `content::CalculateIPAddressSpace(options.scope, nullptr, GetContentClient()->browser())`, and the scope is a `chrome-extension://` URL |
| Extension page (popup, options, tab) | `kLoopback` | **No** | `NavigationRequest` sets the policy container's space with `CalculateIPAddressSpace(url, response_head_.get(), GetContentClient()->browser())` |
| Offscreen document | `kLoopback` | **No** | An offscreen document is a `chrome-extension://` document, so the same navigation path applies. Chrome documents no separate LNA rule for it. **No offscreen-specific primary statement was found** |
| Dedicated worker inside an extension page | `kLoopback` (inherited) | **No** | worker inherits the creator's policy container |
| **Content script** | the **host page's** space | **Yes, like the page** | see below |

For the service worker, the relevant code is:

```cpp
  // TODO(crbug.com/435246545): Add browser test to test extensions and LNA.
  policies.ip_address_space = content::CalculateIPAddressSpace(
      options.scope, nullptr, GetContentClient()->browser());
```

Source: `https://raw.githubusercontent.com/chromium/chromium/main/content/browser/service_worker/service_worker_context_wrapper.cc`

WebSockets from an extension service worker follow the same client security state:
`ServiceWorkerHost::CreateWebSocketConnector` passes `version_->BuildClientSecurityState()->Clone()`.
Source: `https://raw.githubusercontent.com/chromium/chromium/main/content/browser/service_worker/service_worker_host.cc`

#### Content scripts differ, and this is the one real gap

A content script's network requests go through a separate URLLoaderFactory created for the isolated
world, but that factory is handed the **host frame's** client security state:

```cpp
    network::mojom::URLLoaderFactoryParamsPtr factory_params =
        URLLoaderFactoryParamsHelper::CreateForIsolatedWorld(
            this, isolated_world_origin, config.origin(),
            config.isolation_info(), config.GetClientSecurityState(), ...
```

Source: `https://raw.githubusercontent.com/chromium/chromium/main/content/browser/renderer_host/render_frame_host_impl.cc`
(`RenderFrameHostImpl::CreateURLLoaderFactoriesForIsolatedWorlds`), with
`https://raw.githubusercontent.com/chromium/chromium/main/content/browser/url_loader_factory_params_helper.cc`

The extension-side override of those factory params touches only CORS and ORB, never the client
security state:

```cpp
  if (ShouldRelaxCors(extension, factory_user)) {
    params->is_orb_enabled = false;
    if (factory_user == FactoryUser::kContentScript) {
      params->ignore_isolated_world_origin = false;
    }
  }
```

Source: `https://raw.githubusercontent.com/chromium/chromium/main/extensions/browser/url_loader_factory_manager.cc`

So a content script injected into `https://example.com` fetching `http://192.168.1.10` carries
`example.com`'s address space (`public`) and is gated. **No Chrome document states this in words;
the conclusion is read off the code above.** Treat it as source-derived, not documented.

#### Host permissions do not exempt anything, and there is no LNA extension permission

- `host_permissions` is the ordinary extension network permission. Chrome's adoption guide phrases
  the extension carve-out as conditional on it: "extensions that have the necessary host
  permissions are allowed to make local network requests". But the LNA checker never reads
  extension permissions. The exemption comes entirely from the `loopback` address space. Host
  permissions decide whether the request is allowed *at all*, before LNA is reached.
- **Chromium defines no `"localNetworkAccess"` extension permission.** The full API permission enum
  `https://raw.githubusercontent.com/chromium/chromium/main/extensions/common/mojom/api_permission_id.mojom`
  contains no local-network entry; the only `*Network*` ids are `kNetworkingPrivate`,
  `kSystemNetwork`, `kNetworkState`, `kNetworkingOnc`, `kEnterpriseNetworkingAttributes` and
  ChromeOS telemetry ids.
- `https://developer.chrome.com/docs/extensions/reference/permissions-list` and
  `https://developer.chrome.com/docs/extensions/whats-new` were both fetched and searched for "local
  network". **Zero hits in either.** There is no manifest key and no `chrome.permissions` request
  that pre-grants LNA to an extension, because there is nothing to pre-grant.

#### `chrome-extension://` is a secure context, and does not restrict mixed content

Two adjacent facts that matter for a LAN-only `http://` server.

- The extension scheme is registered as secure:
  ```cpp
  // Treat extensions as secure because communication with them is entirely in
  // the browser, so there is no danger of manipulation or eavesdropping on
  // communication with them by third parties.
  schemes->secure_schemes.push_back(extensions::kExtensionScheme);
  ```
  Source: `https://raw.githubusercontent.com/chromium/chromium/main/chrome/common/chrome_content_client.cc`
- Only `https` restricts mixed content, so an extension context is not subject to mixed-content
  blocking:
  ```cpp
  bool SchemeRegistry::ShouldTreatURLSchemeAsRestrictingMixedContent(
      const String& scheme) {
    DCHECK_EQ(scheme, scheme.ToAsciiLower());
    return scheme == "https";
  }
  ```
  Source: `https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/platform/weborigin/scheme_registry.cc`,
  with `MixedContentChecker::IsMixedContent` in
  `https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/loader/mixed_content_checker.cc`

#### It was broken twice, and the scars are still in the tree

**Bug 1. Extension service workers got `kUnknown`, which means public.**
Chromium issue `https://issues.chromium.org/issues/435246545`, "Local Network Access breaks requests
from extension service workers to localhost", component `Blink>SecurityFeature>LocalNetworkAccess`,
reported against 138.0.7204.168, milestone 140.

Fix CL, merged 2025-08-06, cherry-picked to the M140 branch 2025-08-07:

> "[LNA] fix extensions LNA requests on service workers
>
> The client IP address space was not being set on service workers created by extension, so it was
> defaulting to kUnknown. Call content::CalculateIPAddressSpace, which should set the address space
> correctly for for chrome_extension:// urls to kLoopback"

Sources: `https://chromium-review.googlesource.com/c/chromium/src/+/6819257`,
`https://chromium-review.googlesource.com/c/chromium/src/+/6827048`

**Bug 2. Already-registered service workers kept the wrong value on disk.**
Chromium issue 456078996. Fix CL merged 2025-11-05, cherry-picked to M142 and M143 on 2025-11-07:

> "crbug.com/435246545 fixed an issue where service workers from extensions were getting the kUnknown
> address space, but the bug didn't fix extensions with service workers already installed. Those
> installations would have service workers saved in the service worker database with IP address
> spaces of kUnknown, which made all LNA request fail with those service workers.
>
> This 'fixes' the issue by hardcoding the ip address space of extension service workers read from
> the service worker database to kLoopback. This code will likely need to be in there for a while;
> hopefully we can remove this in a year or so when the old service worker registrations are all
> fixed."

Source: `https://chromium-review.googlesource.com/c/chromium/src/+/7106704`
(also `/7133478` for M142, `/7133459` for M143)

The workaround is live in current `main`:

```cpp
  // There was a bug fixed in M141 where extension service workers had the wrong
  // IP address space assigned (crbug.com/435246545). However, extensions that
  // had service workers previously installed before the fix were persisted to
  // the service worker database with the wrong IP address space. ...
  bool is_chrome_extension_scope = scope_url.SchemeIs("chrome-extension");
  ...
    if (is_chrome_extension_scope) {
      if ((*out)->policy_container_policies->ip_address_space !=
          network::mojom::IPAddressSpace::kLoopback) {
        ...
        base::UmaHistogramEnumeration(
            "ServiceWorker.ChromeExtensionUpdateIPAddressSpace", histogram_value);
        (*out)->policy_container_policies->ip_address_space =
            network::mojom::IPAddressSpace::kLoopback;
      }
    }
```

Source: `https://raw.githubusercontent.com/chromium/chromium/main/components/services/storage/service_worker/service_worker_database.cc`

Practical reading: the extension exemption is **behaviour, not contract**. It rests on one line in
`ChromeContentBrowserClient` and on plumbing that has already failed twice. Chrome's own wording is
"we do not *currently* have plans", not a guarantee.

### 3. Address classification

#### The shipped table, verbatim

Source: `https://raw.githubusercontent.com/chromium/chromium/main/services/network/public/cpp/ip_address_space_util.cc`

```cpp
// Returns a map containing all default-non-public subnets.
const AddressSpaceMap& NonPublicAddressSpaceMap() {
  using Entry = AddressSpaceMapEntry;
  static const base::NoDestructor<AddressSpaceMap> kMap(AddressSpaceMap({
      // IPv6 Loopback (RFC 4291): ::1/128
      Entry(IPAddress::IPv6Localhost(), 128, IPAddressSpace::kLoopback),
      // IPv6 Unique-local (RFC 4193, RFC 8190): fc00::/7
      Entry(IPAddress(0xfc, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0), 7, IPAddressSpace::kLocal),
      // IPv6 Link-local unicast (RFC 4291): fe80::/10
      Entry(IPAddress(0xfe, 0x80, 0,0,0,0,0,0,0,0,0,0,0,0,0,0), 10, IPAddressSpace::kLocal),
      // IPv4 Loopback (RFC 1122): 127.0.0.0/8
      Entry(IPAddress(127, 0, 0, 0), 8, IPAddressSpace::kLoopback),
      // IPv4 Private use (RFC 1918): 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
      Entry(IPAddress(10, 0, 0, 0), 8, IPAddressSpace::kLocal),
      Entry(IPAddress(172, 16, 0, 0), 12, IPAddressSpace::kLocal),
      Entry(IPAddress(192, 168, 0, 0), 16, IPAddressSpace::kLocal),
      // IPv4 Link-local (RFC 3927): 169.254.0.0/16
      Entry(IPAddress(169, 254, 0, 0), 16, IPAddressSpace::kLocal),
      // IPv4 Null IP (RFC 5735) ...
      Entry(IPAddress(0, 0, 0, 0), 32, IPAddressSpace::kLoopback),
      Entry(IPAddress(0, 0, 0, 0), 8, IPAddressSpace::kLocal),
      // IPv6 Null IP (RFC 1884): ::/128 ...
      Entry(IPAddress(0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0), 128, IPAddressSpace::kLoopback),
      // Carrier Grade NAT (RFC 6598): 100.64.0.0/10
      Entry(IPAddress(100, 64, 0, 0), 10, IPAddressSpace::kLocal),
      // IPv6 Documentation Address Prefixes (RFC 3849, RFC 9637): 2001:db8::/32 and 3fff::/20
      Entry(IPAddress(0x20,0x01,0x0d,0xb8,0,0,0,0,0,0,0,0,0,0,0,0), 32, IPAddressSpace::kLocal),
      Entry(IPAddress(0x3f,0xff,0,0,0,0,0,0,0,0,0,0,0,0,0,0), 20, IPAddressSpace::kLocal),
      // IPv6 Site Local Unicast (RFC 3513): fec0::/10
      Entry(IPAddress(0xfe,0xc0,0,0,0,0,0,0,0,0,0,0,0,0,0,0), 10, IPAddressSpace::kLocal),
  }));
  return *kMap;
}

IPAddressSpace IPAddressToIPAddressSpace(const IPAddress& address) {
  return NonPublicAddressSpaceMap().Apply(address).value_or(
      IPAddressSpace::kPublic);
}
```

Matching is first-match-wins in list order, which is why `0.0.0.0/32` precedes `0.0.0.0/8`. Anything
not in the table is `public`.

#### `100.64.0.0/10` is `local`. This is the Tailscale answer.

Three independent confirmations.

1. **The specification's table** (`https://raw.githubusercontent.com/WICG/local-network-access/main/index.bs`):
   ```
   <tr>
     <td>`100.64.0.0/10`</td>
     <td>Carrier-Grade NAT</td>
     <td>[[RFC6598]]</td>
     <td>[=IP address space/local=]</td>
   </tr>
   ```
2. **The implementation**: the `Entry(IPAddress(100, 64, 0, 0), 10, IPAddressSpace::kLocal)` line above.
3. **A unit test**
   (`https://raw.githubusercontent.com/chromium/chromium/main/services/network/public/cpp/ip_address_space_util_unittest.cc`):
   ```cpp
   // Verifies that the address space of IP addresses belonging to the
   // "Carrier Grade NAT" 100.64.0.0/10 block are `local`.
   TEST(IPAddressSpaceTest, IPEndPointToIPAddressSpaceV4CarrierGradeNat) {
     EXPECT_EQ(IPAddressToIPAddressSpace(IPAddress(100, 63, 255, 255)), IPAddressSpace::kPublic);
     EXPECT_EQ(IPAddressToIPAddressSpace(IPAddress(100, 64, 0, 0)),   IPAddressSpace::kLocal);
     EXPECT_EQ(IPAddressToIPAddressSpace(IPAddress(100, 127, 255, 255)), IPAddressSpace::kLocal);
     EXPECT_EQ(IPAddressToIPAddressSpace(IPAddress(100, 128, 0, 0)),  IPAddressSpace::kPublic);
   }
   ```

The entry is present in the release branches for every milestone in which LNA has shipped: M142
(`branch-heads/7444`), M145 (`7626`), M148 (`7746`) and M151 (`7900`), each read directly from
`https://chromium.googlesource.com/chromium/src/+/refs/branch-heads/<N>/services/network/public/cpp/ip_address_space_util.cc`.

The old PNA specification listed the same block, under the older name `private`. The name changed;
the classification did not. Source: `https://wicg.github.io/private-network-access/`

Chrome treats CGNAT-in-LNA as a known operational problem, and its documented answer is an
enterprise policy, not a code change. From the LNA Adoption Guide:

> "there are some enterprise zero-trust network access (ZTNA) devices that will route some traffic to
> public sites over the 100.64.0.0/10 address block (CG-NAT), which can cause Local Network Access
> permission prompts to trigger on public web sites. LocalNetworkAccessIpAddressSpaceOverrides can be
> used to change the 100.64.0.0/10 block to be in the public IP address space."

Chrome Platform Status says the same: "For example, CGNAT `100.64.0.0/10` can be marked as public.
This is useful for certain VPN and proxy setups."

#### Per-range verdicts

| Range | LNA verdict |
| --- | --- |
| `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (RFC 1918) | **local** |
| `100.64.0.0/10` (RFC 6598 CGNAT, Tailscale) | **local** |
| `127.0.0.0/8` (RFC 1122) | **loopback** |
| `::1/128` (RFC 4291) | **loopback** |
| `fc00::/7` (RFC 4193 ULA) | **local** |
| `fe80::/10` (IPv6 link-local) | **local** |
| `fec0::/10` (deprecated site-local, RFC 3513) | **local** |
| `169.254.0.0/16` (RFC 3927) | **local** |
| `0.0.0.0/32` | **loopback** |
| `0.0.0.0/8` (rest) | **local** |
| `::/128` | **loopback** |
| `2001:db8::/32`, `3fff::/20` (documentation) | **local** |
| `::ffff:0:0/96` (IPv4-mapped) | verdict of the mapped IPv4 address |
| `192.0.0.0/24`, `198.18.0.0/15`, `240.0.0.0/4` | **public**, absent from the LNA table |
| `.local`, `local`, `local.` hostnames | **local** |
| `localhost`, `localhost.`, `*.localhost` | **loopback** |
| proxied connections | **unknown**, which is treated as public |
| `file://` | **loopback** |

Hostname handling, verbatim:

```cpp
std::optional<mojom::IPAddressSpace> GetAddressSpaceFromUrl(const GURL& url) {
  if (url.DomainIs("local")) {
    return mojom::IPAddressSpace::kLocal;
  }
  if (url.DomainIs("localhost")) {
    // Check IP address space mapping for 127.0.0.1, on the off chance that
    // there is an override remapping this to something else.
    net::IPEndPoint endpoint(net::IPAddress::IPv4Localhost(), url.EffectiveIntPort());
    return IPEndPointToIPAddressSpace(endpoint);
  }
  net::IPAddress address;
  if (!address.AssignFromIPLiteral(url.HostNoBracketsPiece())) {
    return std::nullopt;
  }
  net::IPEndPoint endpoint(address, url.EffectiveIntPort());
  return IPEndPointToIPAddressSpace(endpoint);
}
```

Two divergences worth naming.

- The specification's table lists `198.18.0.0/15` (RFC 2544 benchmarking) as `loopback`. Chromium's
  table has **no `198.18` entry at all**, checked in `main` and in `branch-heads/7900`. Chromium
  therefore returns `public` for that block.
- LNA does **not** reuse `net::IPAddress::IsPubliclyRoutable`. That function's
  `kReservedIPv4Ranges` table is wider. It also covers `192.0.0.0/24`, `198.18.0.0/15` and
  `224.0.0.0/3`, and grepping `ip_address_space_util.{h,cc}` finds no reference to it. Do not
  conflate the two tables. Source:
  `https://raw.githubusercontent.com/chromium/chromium/main/net/base/ip_address.cc`

#### Classification happens after connection, not from the hostname

The explainer is explicit
(`https://raw.githubusercontent.com/WICG/local-network-access/main/explainer.md`):

> "The Fetch spec does not integrate the details of DNS resolution, only defining an obtain a
> connection algorithm, thus Local Network Access checks are applied to the newly-obtained
> connection. Given complexities such as Happy Eyeballs (RFC6555, RFC8305), these checks might pass
> or fail non-deterministically for hosts with multiple IP addresses that straddle IP address space
> boundaries."

and:

> "a request may eventually end up being considered a local network request if the request's hostname
> resolves to a private or loopback IP address. (We do not know this a priori however, and so cannot
> exempt these requests from mixed content blocking…)"

The specification re-runs "determine the IP address space" on each connection: "This intentionally
re-computes the IP address space each time as the mapping can be dynamically updated by the user
agent." Chromium matches:

```cpp
LocalNetworkAccessCheckResult LocalNetworkAccessChecker::Check(
    const net::TransportInfo& transport_info) {
  mojom::IPAddressSpace resource_address_space =
      TransportInfoToIPAddressSpace(transport_info);
  auto result = CheckAddressSpace(resource_address_space);
```

**So a public DNS name that resolves to `192.168.x.x` or `100.64.x.x` is still a local network
request.** A Tailscale MagicDNS name (`*.ts.net`) is neither an IP literal nor `.local`, so
`GetAddressSpaceFromUrl` returns `nullopt` and no early prompt fires. But the post-connection check
still classifies the `100.x` peer as `local`.

#### The taxonomy is still tri-state

`https://raw.githubusercontent.com/chromium/chromium/main/services/network/public/mojom/ip_address_space.mojom`

```
// Represents AddressSpace from the "Local Network Access" spec. The ordering
// is important, as it's used to determine whether a request is a Local Network
// Access requests.  See: https://wicg.github.io/local-network-access/
enum IPAddressSpace {
  kLoopback, // contains the loopback device only.
  kLocal,    // contains addresses that have meaning only within the current network...
  kPublic,   // contains all other addresses...
  kUnknown,  // For security checks, "unknown" will be treated as "public", as
             // that's the lowest-privilege value.
};
```

For the *gating* decision only, `local` and `loopback` collapse into one bucket
(`IsLessPublicAddressSpaceLNA`). The permissions stayed separate from Chrome 145.

#### Requests from loopback are exempt; requests to loopback are not

The specification exempts the *initiator*:

> "Requests originating from the loopback address should not be considered local network requests,
> and should not be subject to local network access checks, since any software running on the user's
> device is already in the most privileged vantage point on the user's network."

And it records the shipped subset:

> "NOTE: Currently, Chromium only implements Local Network Access restrictions for public to local or
> loopback requests, and does not enforce the permission for cross-origin local requests."

The explainer names three request shapes as local network requests: `public -> local`,
`public -> loopback` and `local -> loopback`. It notes "`local -> local` is not a local network
request, as well as `loopback -> anything`". Chromium does **not** enforce `local -> loopback`
today, because of the collapse above. Chrome's adoption guide confirms: "LNA restrictions do not yet
apply to local→local or local→loopback requests".

Two further exemptions live in the checker itself:

```cpp
  if (is_potentially_trustworthy_same_origin_) {
    return Result::kAllowedPotentiallyTrustworthySameOrigin;
  }
  if (!client_security_state_) {
    return Result::kAllowedMissingClientSecurityState;
  }
```

### 4. Permission lifecycle and failure surface

#### Lifecycle: persistent, per top-level origin, per profile, unsynced

The specification leaves the scope open: "The exact scope of the permission is implementation-defined…
A user agent may persist this decision to reduce permission fatigue."
(`https://raw.githubusercontent.com/WICG/local-network-access/main/index.bs`)

Chromium registers it as an ordinary persistent content setting:

```cpp
  Register(ContentSettingsType::LOCAL_NETWORK, "local-network",
           CONTENT_SETTING_ASK, WebsiteSettingsInfo::UNSYNCABLE,
           /*allowlisted_primary_schemes=*/{},
           /*valid_settings=*/
           {CONTENT_SETTING_ALLOW, CONTENT_SETTING_BLOCK, CONTENT_SETTING_ASK},
           WebsiteSettingsInfo::TOP_ORIGIN_ONLY_SCOPE,
           WebsiteSettingsRegistry::DESKTOP | WebsiteSettingsRegistry::PLATFORM_ANDROID,
           ContentSettingsInfo::INHERIT_IF_LESS_PERMISSIVE,
           PermissionSettingsInfo::EXCEPTIONS_ON_SECURE_ORIGINS_ONLY);
```

Source: `https://raw.githubusercontent.com/chromium/chromium/main/components/content_settings/core/browser/content_settings_registry.cc`
(`LOOPBACK_NETWORK` is registered identically.)

- Default `ASK`; scope `TOP_ORIGIN_ONLY_SCOPE`; not synced across devices.
- **No "allow this time" option.** LNA appears in neither `GetTypesWithTemporaryGrants()` nor
  `GetTypesWithTemporaryGrantsInHcsm()` in
  `https://raw.githubusercontent.com/chromium/chromium/main/components/content_settings/core/browser/content_settings_utils.cc`.
- **Dismissal is not denial. It embargoes.** `kDefaultDismissalsBeforeBlock = 3`,
  `kDefaultEmbargoDays = 7`. Three dismissals produce a 7-day embargo that reads as denied without a
  prompt. Source:
  `https://raw.githubusercontent.com/chromium/chromium/main/components/permissions/permission_decision_auto_blocker.cc`
- **Incognito: an ALLOW does not carry over.** The setting is `INHERIT_IF_LESS_PERMISSIVE`, whose own
  comment reads: "A setting with an initial value of ASK will be inherited if it is set to BLOCK or
  ASK but ALLOW will become ASK in incognito mode." A BLOCK does carry over. Grants made inside
  incognito are written only to `off_the_record_value_map_`, never to prefs, so they die with the
  session. Sources: `content_settings_info.h`, `content_settings_pref.cc`. **No Chrome documentation
  states incognito behaviour in words**; this is read off the code. Searched
  `developer.chrome.com/blog/local-network-access`, `index.bs` and `explainer.md` for "incognito" and
  "private browsing". Zero hits.

Permission enum entries, from
`https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/public/mojom/permissions/permission.mojom`:

```
  LOCAL_NETWORK_ACCESS,
  LOCAL_NETWORK,
  LOOPBACK_NETWORK,
```

and `components/content_settings/core/common/content_settings_types.mojom`:

```
  // Content settings for whether the site is allowed to make local network
  // requests. Migration from LOCAL_NETWORK_ACCESS to the split setting of
  // LOCAL_NETWORK AND LOOPBACK_NETWORK is in progress. See crbug.com/465491626
  LOCAL_NETWORK_ACCESS,
  LOCAL_NETWORK,
  LOOPBACK_NETWORK,
```

Only the split pair has a `RequestType`, so only the split pair prompts
(`components/permissions/request_type.h`: `kLocalNetwork`, `kLoopbackNetwork`).

#### Where it appears in the UI

Two site-settings pages, **`chrome://settings/content/localNetwork`** and
**`chrome://settings/content/loopbackNetwork`**, created behind a load-time flag:

```ts
  if (loadTimeData.getBoolean('enableLocalNetworkAccessSetting')) {
    r.SITE_SETTINGS_LOCAL_NETWORK = r.SITE_SETTINGS.createChild('localNetwork');
    r.SITE_SETTINGS_LOOPBACK_NETWORK = r.SITE_SETTINGS.createChild('loopbackNetwork');
  }
```

Source: `https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/resources/settings/route.ts`

Strings (`https://raw.githubusercontent.com/chromium/chromium/main/chrome/app/settings_strings.grdp`):

- "Sites can use this feature to access other devices on your local network"
- "Sites can ask to access other devices on your local network"
- "Sites can use this feature to access other apps and services on this device"

Prompt strings
(`https://raw.githubusercontent.com/chromium/chromium/main/components/permissions_strings.grdp`):

- "Access other devices on your local network" / "*URL* wants to access other devices on your local network"
- "Access other apps and services on this device" / "*URL* wants to access other apps and services on this device"

Chrome's blog quotes an earlier, pre-split prompt string: "Look for and connect to any device on your
local network." Source: `https://developer.chrome.com/blog/local-network-access`

Both types appear in the page-info (padlock) bubble; the legacy combined type is filtered out:

```cpp
  // Filter Local Network Access permissions.
  // Show LOCAL_NETWORK and LOOPBACK_NETWORK.
  // Hide the legacy LOCAL_NETWORK_ACCESS permission.
  if (info.type == ContentSettingsType::LOCAL_NETWORK_ACCESS) {
    return false;
  }
```

Source: `https://raw.githubusercontent.com/chromium/chromium/main/components/page_info/page_info.cc`

**The short category title used in the site-settings list is unverified.** Searched
`settings_strings.grdp` and `shared_settings_strings.grdp` for `LOCAL_NETWORK`, `LOOPBACK` and "local
network".

#### Failure surface: a denial is indistinguishable from a network error

The specification returns a network error:

```
1.  Let |error| be a [=network error=].
...
    11. If |permissionState| is [=permission/denied=], then return |error|.
    12. If |permissionState| is [=permission/granted=], then return null.
    13. [=Prompt the user to choose=] whether to grant |permissionName| for |global|:
        1.  If the user grants permission, then return null.
        2.  If the user denies permission, then return |error|.
```

Fetch turns a network error into a plain `TypeError`
(`https://fetch.spec.whatwg.org/`), and Blink's message is fixed:

```cpp
  v8::Local<v8::Value> exception =
      V8ThrowException::CreateTypeError(isolate, "Failed to fetch");
```

Source: `https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/fetch/fetch_manager.cc`

| Surface | On denial or embargo | Distinguishable from an ordinary network failure? |
| --- | --- | --- |
| `fetch()` | rejects `TypeError: Failed to fetch` | **No** |
| `XMLHttpRequest` async | `error` event, `status === 0` | **No** |
| `XMLHttpRequest` sync | throws `NetworkError` `DOMException` | **No** |
| WebSocket | `error` event, then `close` with `code 1006`, `wasClean false`, `reason ""` | **No** |
| Console | `…has been blocked by CORS policy: Permission was denied for this request to access the \`local\` address space.` | Yes, but not readable from JavaScript |
| DevTools Issues panel | a `CorsIssue` with `corsError: LocalNetworkAccessPermissionDenied` | Yes, via CDP only |
| `navigator.permissions.query()` | `"denied"` | **Yes. The only in-page discriminator** |

So a WebSocket denial and a fetch denial are equally opaque; neither differs from a refused
connection. The only way a page can tell "the user said no" from "the server is off" is to pair the
failure with a Permissions API query.

Net error codes
(`https://raw.githubusercontent.com/chromium/chromium/main/net/base/net_error_list.h`):

```cpp
// The request was blocked because the local network permission is missing.
NET_ERROR(LOCAL_NETWORK_PERMISSION_MISSING, -36)
// The IP address space of the cached remote endpoint is blocked by private
// network access check.
NET_ERROR(CACHED_IP_ADDRESS_SPACE_BLOCKED_BY_LOCAL_NETWORK_ACCESS_POLICY, -384)
// The connection is blocked by private network access checks.
NET_ERROR(BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS, -385)
```

`ERR_BLOCKED_BY_PRIVATE_NETWORK_ACCESS_CHECKS` no longer exists under that name; it is now
`ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS` (-385).

CORS error values (`services/network/public/mojom/cors.mojom`):

```
  // Request client is not secure and less private than the request target.
  kInsecureLocalNetwork,
  // The request carried a `target_ip_address_space` which turned out to
  // be different from the IP address space of the remote endpoint.
  kInvalidLocalNetworkAccess,
  // User did not grant permission to access the local network.
  kLocalNetworkAccessPermissionDenied,
```

Console text (`third_party/blink/renderer/platform/loader/cors/cors_error_string.cc`):

- denial: "Permission was denied for this request to access the \`local\` address space."
- non-secure initiator: "The request client is not a secure context and the resource is in
  more-private address space \`local\`."
- mismatch: "Request had a target IP address space of \`local\` yet the resource is in address space
  \`public\`."

There is **no dedicated LNA DevTools issue type**. The `Audits.InspectorIssueCode` enum contains no
`LocalNetworkAccessIssue`; LNA surfaces as a `CorsIssue`. Sources:
`https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/public/devtools_protocol/domains/Audits.pdl`,
`https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/public/devtools_protocol/domains/Network.pdl`,
`https://raw.githubusercontent.com/ChromeDevTools/devtools-frontend/main/front_end/models/issues_manager/CorsIssue.ts`

WebSocket failure text, for the record:
`WebSocket connection to 'ws://192.168.0.1/' failed: Error in connection establishment:
net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`, from
`net/websockets/websocket_stream.cc` plus
`third_party/blink/renderer/modules/websockets/websocket_channel_impl.cc`.

#### The Permissions API: three query names

`third_party/blink/renderer/modules/permissions/permission_descriptor.idl`:

```
    "local-network-access",
    "local-network",
    "loopback-network",
```

with no `[RuntimeEnabled]` gating, and matching cases in `permission_utils.cc`. The specification
registers the two new names and keeps the old one as an alias:

> "Previously, this was specified as a single default powerful feature that covered both local and
> loopback cases, `"local-network-access"`. Chromium still supports this as an alias for the new
> fine-grained permission names, and for use as a policy-controlled feature name."

`navigator.permissions.query()` never prompts. Chrome's adoption guide adds one trap: "The
Permissions API will always return 'denied' when called from an HTTP page." It also gives the exact
merge table for querying the legacy `local-network-access` name in Chrome 145+: the result is
`denied` if either split permission is denied, `allowed` if at least one is allowed and neither is
denied, otherwise `prompt`.

#### The Permissions-Policy names

`services/network/public/cpp/permissions_policy/permissions_policy_features.json5`:

```json5
    { name: "LocalNetwork",       permissions_policy_name: "local-network", ... },
    { name: "LocalNetworkAccess", permissions_policy_name: "local-network-access", ... },
    { name: "LoopbackNetwork",    permissions_policy_name: "loopback-network", ... },
```

Default allowlist is `'self'`, per `index.bs`. So a cross-origin iframe cannot make local network
requests unless the embedder delegates, for example
`<iframe src="domainB.example" allow="local-network"></iframe>`. Chrome's adoption guide adds that
the permission decision "will be tied to the embedding document's origin", that nested iframes each
need the flag, and that "Permission policy must be set on iframes that make local network requests,
even if you are bypassing the permission prompt via enterprise policy."

#### When the prompt fires, and who can fire it

The prompt fires at request time and the request waits. From the explainer:

> "When a site makes a local network request, the UA should check if the origin has already been
> granted the 'local network access' permission. If not, the request should be blocked while the UA
> displays a prompt to the user asking whether they want to allow the origin to make requests to
> their local network. If the user denies the permission prompt, the request fails."

There is **no proactive JavaScript request API**. There is no `requestPermission()`, and `query()` does not
prompt. Chrome's documented trick is a throwaway fetch to a hostname whose address space is readable
from the URL:

> "if you are triggering a permission prompt for connections to localhost, then in Javascript trigger
> a fetch() call as follows: `fetch("http://localhost")` … This works in Chrome 144 or higher."

Source: LNA Adoption Guide.

Workers cannot raise the prompt. Chrome's blog:

> "Local network requests from Service Workers and Shared Workers require that the worker's origin has
> previously been granted the Local Network Access permission. If your application makes local network
> requests from a service worker, you will need to separately trigger a local network request from
> your application in order to trigger the permission prompt. (We are working on a way for workers to
> trigger the permission prompt if there is an active document available — see crbug.com/404887282.)"

The specification agrees: fetch step 8 is "If |document| is null, then return |error|." A dedicated
worker is different: the adoption guide says its request "will trigger the LNA permission prompt in
the owning window."

**None of this applies to an extension service worker**, which is exempt by address space and never
reaches the permission check at all.

### 5. What changes the outcome

#### What does not exempt a request

| Candidate | Exempts? | Evidence |
| --- | --- | --- |
| Target is HTTPS with a valid publicly-trusted certificate | **No** | HTTPS is irrelevant to the gate. It only affects mixed content. See below |
| Initiator is an installed PWA | **No evidence of any exemption; unverified** | See below |
| Initiator is a secure context | **No**. A secure context is a *precondition* for the prompt, not an exemption | `DerivePolicyForSecureContext` returns `kPermissionBlock` |
| Initiator is a **non**-secure context | **No**. Worse: it is blocked outright with no prompt | `DerivePolicyForNonSecureContext` returns `kBlock` |
| `targetAddressSpace` fetch option | **No**. It relaxes mixed content and makes the gate stricter | see below |
| PNA CORS preflight headers | **Dead** since Chrome 138 | see below |
| Same address space, or `local` -> `loopback` | **Yes** | `IsLessPublicAddressSpaceLNA` |
| Top-level navigation | **Yes, not gated** | `kLocalNetworkAccessForNavigations` is disabled by default |
| Subframe navigation | **No, gated** | `kLocalNetworkAccessForSubframeNavigations` is enabled by default |
| Browser-initiated request (no policy container) | **Yes** | `kAllowedMissingClientSecurityState` |
| Extension-initiated request | **Yes** | section 2 |
| Android WebView | **Yes, entirely out of scope** | see below |
| HTTP cache hit | **No** | specification §4.3 worked example: a cached local subresource re-triggers the prompt after a permission reset |

#### HTTPS does not help

The only trust-based bypass is potentially-trustworthy **and** same-origin. Specification:

> "If request's origin is a potentially trustworthy origin and request's current URL's origin is same
> origin with request's origin, then return null."

Code:

```cpp
  is_potentially_trustworthy_same_origin_ =
      IsUrlPotentiallyTrustworthy(url) && request_initiator_.has_value() &&
      request_initiator_.value().IsSameOriginWith(url);
```

A public site fetching `https://device.example` with a real certificate that resolves to
`192.168.x.x` is cross-origin, so it prompts. The explainer names this as a deliberate regression
from PNA:

> "PNA met a lot of different developer and user needs, and in the 'good case' (secure website talking
> to a local network device that had a publicly trusted TLS certificate and a 'PNA-aware' server)
> could be quite seamless, since it required no user intervention."

and

> "Even if the local device has opted in to connections from a top level site, we believe there is
> value in user awareness and control over this exchange."

What HTTPS *does* buy: the permission relaxes mixed-content blocking so an HTTPS page can reach an
HTTP local endpoint. Chrome Platform Status: "If granted, the permissions additionally relax mixed
content blocking for local network requests (since many local devices are not able to obtain publicly
trusted TLS certificates for various reasons)." Chrome's blog lists the three cases Chrome can
recognise in advance: a private IP literal, a `.local` domain, or `targetAddressSpace`.

#### Installed PWA: no exemption found, and none in the code

**Unverified as a documented statement, but the code shows no hook.** Searched the explainer, the
specification, the Chrome blog, the LNA Adoption Guide, all LNA policy YAML files, and the Chrome
Platform Status entries. No mention of PWAs, installed web apps, or display mode. At code level,
`local_network_access_request_policy` is derived only from `PolicyContainerPolicies`
(`ip_address_space` plus `is_web_secure_context`) and the request context. The single embedder
override, `ChromeContentBrowserClient::ShouldOverrideLocalNetworkAccessRequestPolicy`, branches on
exactly two conditions:

```cpp
#if BUILDFLAG(IS_ANDROID)
  if (base::android::device_info::is_automotive()) {
    return ...LocalNetworkAccessRequestPolicyOverride::kBlockInsteadOfWarn;
  }
#endif
  if (profile->GetPrefs()->GetBoolean(
          prefs::kManagedLocalNetworkAccessRestrictionsTemporaryOptOut)) {
    return ...LocalNetworkAccessRequestPolicyOverride::kWarnInsteadOfBlock;
  }
  return ...LocalNetworkAccessRequestPolicyOverride::kDefault;
```

Source: `https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/chrome_content_browser_client.cc`

An installed PWA simply shares its origin's content setting.

#### Non-secure contexts are blocked, not prompted

Specification: "If request's client is not a secure context (including if it is null), then return
error." Checked before the permission lookup. Code:

```cpp
  if (local_network_access_checks_enabled) {
    // LNA blocks all local network access requests coming from non-secure
    // contexts.
    if (network::features::kLocalNetworkAccessChecksWarn.Get()) {
      return Policy::kPermissionWarn;
    }
    return Policy::kBlock;
  }
```

`kBlock` means "Block the requests with a CORS error"; `kPermissionBlock` means "Block requests unless
the user explicitly grants permission". Source:
`https://raw.githubusercontent.com/chromium/chromium/main/services/network/public/mojom/client_security_state.mojom`

The escape hatch was the reverse origin trial, header-token only, which ended at M146 and was
extended to M152.

#### `targetAddressSpace` still exists, and cuts both ways

IDL: `[RuntimeEnabled=LocalNetworkAccessPermissionPolicy] IPAddressSpace targetAddressSpace;`
(`third_party/blink/renderer/core/fetch/request_init.idl`). Blink's enum is
`{"loopback", "local", "private", "public", "unknown"}`. It still carries PNA's `"private"` and
`"unknown"`. The specification's enum is only `{"public", "local", "loopback"}`. Chrome documents
`"local"` and `"loopback"` as the useful values.

What it does: it lets an HTTPS page reach an HTTP local endpoint whose hostname is neither a private
IP literal nor a `.local` name, by declaring the destination up front, so mixed content does not
block it. What it also does: makes the check *stricter*. A declared space that does not match the
connected peer is a hard failure.

```cpp
  // Note: This check must occur before the check for Policy::kAllow below, as
  // otherwise sites could use targetAddressSpace to bypass mixed content
  // blocking in embedders with a kAllow policy.
  if (base::FeatureList::IsEnabled(features::kLocalNetworkAccessChecks) &&
      required_address_space_ != mojom::IPAddressSpace::kUnknown &&
      resource_address_space != required_address_space_) {
    return Result::kBlockedByRequiredIpAddressSpaceMismatch;
  }
```

Limits: HTML subresource fetches and subframe navigations cannot specify it. WebSockets cannot
either. Chrome Platform Status 4779920606756864, "Support targetAddressSpace option for WebSockets",
is Proposed for M154 (`https://chromestatus.com/api/v0/features?q=local+network+access`).

#### The PNA preflight is dead

Explainer: the LNA proposal "differs by gating access on a permission rather than via preflight
requests… Unlike the previous Private Network Access proposal, which required changes to devices on
local networks, this approach should only require changes to sites." And: "Compared to the original
PNA proposal, there are no preflights (and thus no risk of timing/probing attacks from them)."

Grep counts for `private-network|PrivateNetwork` in current `main` are **zero** in
`services/network/public/cpp/cors/cors.cc`, `services/network/cors/preflight_controller.cc`,
`services/network/cors/cors_url_loader.cc`, `services/network/public/cpp/header_util.cc` and
`third_party/blink/public/devtools_protocol/browser_protocol.pdl`.
`services/network/private_network_access_checker.cc` returns 404. The file was renamed, in CL
`https://chromium-review.googlesource.com/c/chromium/src/+/7510286` ("[LNA] Rename
private_network_access_util.h/cc file/methods to use LNA naming", merged 2026-01-23, reverted, then
relanded 2026-01-27 as `/7514248`).

The milestone is **138**: every PNA enterprise policy's `supported_on` ends at 137, and
`LocalNetworkAccessRestrictionsEnabled` starts at 138.

The old PNA specification at `https://wicg.github.io/private-network-access/` is still dated "Draft
Community Group Report, 26 September 2024" and carries no supersession banner. The repository
`https://github.com/WICG/private-network-access` is not archived, last pushed 2025-02-12. Only the
LNA repository states the relationship.

Some PNA Chrome Platform Status entries were never marked removed; they went stale. Examples:
5737414355058688 "PNA preflight requests for subresources: warning-only mode" still reads "Enabled by
default, 104"; 5954091755241472 "PNA permission to relax mixed content" still reads "Enabled by
default, 124". Do not read those as current.

#### Android WebView is out of scope

LNA Adoption Guide, verbatim:

> "LNA restrictions do not apply to Android WebView. Android apps that embed WebViews that make local
> network requests are instead subject to Android's new local network permission."

Chrome Platform Status lists `webview: null` for the feature.

### 6. Enterprise policy

All policy definitions read from
`https://chromium.googlesource.com/chromium/src/+/main/components/policy/resources/templates/policy_definitions/LocalNetworkAccessSettings/<NAME>.yaml?format=TEXT`
(and `.../PrivateNetworkRequestSettings/` for the dead ones). The published list is
`https://chromeenterprise.google/policies/`.

#### Live policies

| Policy | Type | Since | Dynamic refresh | Per profile |
| --- | --- | --- | --- | --- |
| `LocalNetworkAccessAllowedForUrls` | list of URL patterns | Chrome 139 (Android 140) | yes | yes |
| `LocalNetworkAccessBlockedForUrls` | list of URL patterns | Chrome 139 (Android 140) | yes | yes |
| `LocalNetworkAllowedForUrls` | list | Chrome 146 | yes | yes |
| `LocalNetworkBlockedForUrls` | list | Chrome 146 | yes | yes |
| `LoopbackNetworkAllowedForUrls` | list | Chrome 146 | yes | yes |
| `LoopbackNetworkBlockedForUrls` | list | Chrome 146 | yes | yes |
| `LocalNetworkAccessIpAddressSpaceOverrides` | list of strings | Chrome 146 | **no** | **no** |
| `LocalNetworkAccessPermissionsPolicyDefaultEnabled` | boolean, default false | Chrome 146 | **no** | **no** |
| `LocalNetworkAccessRestrictionsTemporaryOptOut` | boolean, default false | Chrome 142 | yes | yes |

ChromeOS device-scoped, all `per_profile: false`: `DeviceLocalNetworkAccessBlockedForUrls` (146),
`DeviceLocalNetworkAccessIpAddressSpaceOverrides` (146), `DeviceLocalNetworkAccessAllowedForUrls`
(153).

`LocalNetworkAccessAllowedForUrls`, verbatim: "List of URL patterns. Network requests initiated from
websites served by matching origins are not subject to Local Network Access checks. For origins not
covered by the patterns specified here, the user's personal configuration will apply."

Precedence, verbatim from the YAML, most specific first:

```
LocalNetworkBlockedForUrls
LocalNetworkAllowedForUrls
LoopbackNetworkBlockedForUrls
LoopbackNetworkAllowedForUrls
LocalNetworkAccessBlockedForUrls
LocalNetworkAccessAllowedForUrls
DeviceLocalNetworkAccessBlockedForUrls
DeviceLocalNetworkAccessAllowedForUrls
```

`LocalNetworkAccessIpAddressSpaceOverrides` is the one that matters for CGNAT. Grammar:
`[cidr]=[public|local|loopback]` or `[ip-address]:[port]=[public|local|loopback]`. Documented example
values include `100.64.0.0/10=public`, `[2001:db8::]/32=local`, `192.168.0.1:8000=public`. Verbatim:
"Overrides from the command-line switch `--ip-address-space-overrides` take precedence over overrides
set by policies." Chrome Platform Status adds: "Marking `0.0.0.0/0` and `::/0` as public is equivalent
to disabling the local network access restrictions."

`LocalNetworkAccessPermissionsPolicyDefaultEnabled`, verbatim: "By default, the permissions for Local
Network Access (LNA) are only allowed to be requested in cross-origin subframes if they are explicitly
delegated. This policy can be used to override this default behavior so that LNA permissions are
default inherited into subframes… This policy applies to the permissions policy features
`local-network-access`, `loopback-network`, and `local-network`."

`LocalNetworkAccessRestrictionsTemporaryOptOut`, verbatim: "When this policy is set to Enabled, Local
Network Access requests will only display warnings in Chrome DevTools due to Local Network Access
checks failing… This enterprise policy is temporary, and will be removed after M156."

The LNA Adoption Guide notes an Admin Console gap: "If you are using Google Admin Console, you will
need to configure these using custom configurations until these policies make it into the main Admin
Console UI."

#### Policies that do not exist

- **`DefaultLocalNetworkAccessSetting` does not exist.** No YAML file in any `policy_definitions`
  subdirectory, and `https://chromeenterprise.google/policies/default-local-network-access-setting/`
  returns HTTP 404 while
  `https://chromeenterprise.google/policies/local-network-access-allowed-for-urls/` returns 200.

#### Deprecated and removed

| Policy | Status | `supported_on` |
| --- | --- | --- |
| `LocalNetworkAccessRestrictionsEnabled` | deprecated | Chrome 138-144 (Android 139-144) |
| `InsecurePrivateNetworkRequestsAllowed` | deprecated | Chrome 92-137 |
| `InsecurePrivateNetworkRequestsAllowedForUrls` | deprecated | Chrome 92-137 |
| `PrivateNetworkAccessRestrictionsEnabled` | deprecated | Chrome 120-137 |

`LocalNetworkAccessRestrictionsEnabled` was superseded by
`LocalNetworkAccessRestrictionsTemporaryOptOut`, with the sense inverted.

### 7. Flags and command-line switches

Flag ids from `https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/about_flags.cc`
and `.../chrome/browser/flag_descriptions.h`.

| `chrome://flags` | `base::Feature` | `--enable-features` string | Default in `main` |
| --- | --- | --- | --- |
| `#local-network-access-check` | `kLocalNetworkAccessChecks` | `LocalNetworkAccessChecks` | **enabled** |
| `#local-network-access-check-websockets` | `kLocalNetworkAccessChecksWebSockets` | `LocalNetworkAccessChecksWebSockets` | **enabled** |
| `#local-network-access-check-webtransport` | `kLocalNetworkAccessChecksWebTransport` | `LocalNetworkAccessChecksWebTransport` | **enabled** |
| `#local-network-access-check-webrtc` | `kLocalNetworkAccessChecksWebRTC` | `LocalNetworkAccessChecksWebRTC` | disabled |

Feature parameters (`services/network/public/cpp/features.cc`):
`LocalNetworkAccessChecksWarn` (bool, default false; "If true, local network access checks will only
be warnings") and `LocalNetworkAccessChecksWebRTCLoopbackOnly` (bool, default false).

Context sub-features (`https://raw.githubusercontent.com/chromium/chromium/main/content/common/features.cc`):
`LocalNetworkAccessForWorkers` **enabled**; `LocalNetworkAccessForSubframeNavigations` **enabled**;
`LocalNetworkAccessForFencedFrameNavigations` **enabled** and blocks without a prompt;
`LocalNetworkAccessForNavigations` (main frame) **disabled**. Every `...WarningOnly` twin is disabled.

Command-line switches
(`https://raw.githubusercontent.com/chromium/chromium/main/services/network/public/cpp/network_switches.cc`):

```
// Specifies manual overrides to the IP endpoint -> IP address space mapping.
//   override := (ip-endpoint | ip_range) "=" address-space
//   address-space := "public" | "private" | "local" | "loopback"
//   ip-endpoint := ip-address ":" port
//   ip-range := ip-address "/" bitmask
const char kIpAddressSpaceOverrides[] = "ip-address-space-overrides";
```

- `--ip-address-space-overrides=<ip>:<port>=<space>[,...]`; port `0` means all ports. Chrome's
  adoption guide gives the worked examples, for example
  `--ip-address-space-overrides=192.168.0.1:8080=public,10.0.1.20:0=loopback`.
- `--local-network-access-permissions-policy-default-enabled`
- `--disable-web-security` turns LNA off entirely:
  ```cpp
    // Disable LNA checks entirely when running with `--disable-web-security`.
    if (base::CommandLine::ForCurrentProcess()->HasSwitch(
            switches::kDisableWebSecurity)) {
      return Policy::kAllow;
    }
  ```
  Source: `https://raw.githubusercontent.com/chromium/chromium/main/content/browser/renderer_host/local_network_access_util.cc`

Blink runtime flags (`third_party/blink/renderer/platform/runtime_enabled_features.json5`):
`LocalNetworkAccessPermissionPolicy` (gates the `targetAddressSpace` IDL member),
`LocalNetworkAccessWebRTC`, `LocalNetworkAccessWebSocketsTargetAddressSpace` (experimental), and a
reverse origin trial `LocalNetworkAccessForWebRTCOptOut` with `origin_trial_allows_insecure: true`.

WebDriver: "The `local-network` and `loopback-network` permissions (and the previous
`local-network-access` permission) can be managed via the WebDriver/ChromeDriver" using
ChromeDriver's `setPermission()` or the newer WebDriver `setPermissions()` command. Source: LNA
Adoption Guide.

### 8. Conflicts and unverified items

#### Sources that disagree

- **When `LocalNetworkAccessRestrictionsTemporaryOptOut` is removed.** The LNA Adoption Guide (dated
  2026-05-18) says "removed after M152". The policy YAML in current `main` and Chrome Platform Status
  both say **M156**. The change is traceable: CL
  `https://chromium-review.googlesource.com/c/chromium/src/+/8132482`, "Update
  LocalNetworkAccessRestrictionsTemporaryOptOut removal milestone", merged 2026-07-23, after the
  guide's last update. Read M156.
- **When `LocalNetworkAccessAllowedForUrls` became available.** The policy YAML says `chrome.*:139-`;
  the LNA Adoption Guide says "available in Chrome 140+". The Android entry is 140. The YAML is the
  primary artefact for desktop.
- **`198.18.0.0/15`.** The specification's table says `loopback`; Chromium's table omits the block
  entirely, so Chromium says `public`.
- **`local` -> `loopback`.** The specification and explainer call it a local network request;
  Chromium does not enforce it. Anything that relies on "our local page can always reach localhost"
  works today by an exemption Chrome describes as temporary. Specification §4.4: "exploiting such
  fetches requires attackers to already have a foothold in the private network… Chromium is exempting
  these fetches from restrictions temporarily."
- **`IPAddressSpace` enum.** Blink's IDL accepts five values including PNA's `"private"` and
  `"unknown"`; the specification defines three.

#### Unverified

- **Offscreen documents.** No Chrome document names them in an LNA context. The conclusion that they
  behave like any other `chrome-extension://` page follows from `DetermineAddressSpaceFromURL` and the
  navigation path, not from a statement. Searched the LNA Adoption Guide, the Chrome blog, the
  explainer, the specification, and `https://developer.chrome.com/docs/extensions/reference/api/offscreen`.
- **Content scripts.** Same status: derived from `CreateForIsolatedWorld` passing the frame's client
  security state, not from any Chrome document. Chrome's only extension statement is the one-line
  carve-out in the adoption guide, which does not distinguish contexts.
- **Installed PWAs.** No exemption found in documents or code; see section 5. Absence of evidence, not
  a documented "no".
- **The short site-settings category title** (the row label in the settings list). Searched
  `chrome/app/settings_strings.grdp` and `shared_settings_strings.grdp` for `LOCAL_NETWORK`,
  `LOOPBACK` and "local network".
- **Incognito behaviour** is read off `INHERIT_IF_LESS_PERMISSIVE` and `content_settings_pref.cc`, not
  from documentation. Searched the blog, `index.bs` and `explainer.md` for "incognito" and "private
  browsing". Zero hits.
- **The DevTools issue description body** (`corsLocalNetworkAccessPermissionDenied.md`). Both the
  GitHub mirror path and a gitiles listing of
  `front_end/panels/issues/descriptions/` came back empty or 404.
- **The exact commit that first added the CGNAT entry.** `chromium.googlesource.com/+log/...?format=JSON`
  returns "403: Forbidden — Please sign in to view the history pages". Presence was established
  instead by reading the file in the M142, M145, M148 and M151 branch heads, which covers every
  milestone in which LNA has shipped.

#### A note on one source

The **LNA Adoption Guide** is a Google Doc, not a `developer.chrome.com` page. It is cited here
because it is authored by the Chrome LNA team, linked from both
`https://developer.chrome.com/blog/local-network-access` and the Chrome Platform Status entry, and it
is the **only** primary source that states the extension carve-out, the Android WebView carve-out, the
main-frame-navigation carve-out and the iframe delegation rules. Where it conflicts with the Chromium
tree, the tree wins; both are given above.

---

## Firefox Local Network Access (LNA), for an extension that talks to a self-hosted LAN server

Produced by a subagent resolving the LNA research ticket. Scope: **Firefox only**. Chromium and
desktop webviews are covered elsewhere.

Every source below was fetched and read on **2026-08-20**. Status: evidence. Facts only. This file
makes no decision and gives no recommendation.

Where a primary source could not be found, the text says **unverified** and names what was searched.

Primary sources used: `mozilla-central`, `mozilla-release`, `mozilla-beta` and `mozilla-esr140`
source on `hg.mozilla.org` and `searchfox.org`; Bugzilla REST; Firefox release notes on
`mozilla.org` (they redirect to `firefox.com`); `product-details.mozilla.org`; the Firefox
administrator reference at `firefox-admin-docs.mozilla.org`; MDN and MDN `browser-compat-data`
(BCD); the WICG Local Network Access specification.

---

### Version state on 2026-08-20

| Channel | Version |
| --- | --- |
| Release | **154.0**, first offered 2026-08-18 |
| Beta | 155.0b2 |
| Nightly | 156.0a1 |
| ESR | **140.14.0esr** |
| ESR next | 153.1.0esr |

Source: `https://product-details.mozilla.org/1.0/firefox_versions.json`. Release dates from
`https://product-details.mozilla.org/1.0/firefox.json`: 147.0 = 2026-01-13, 149.0 = 2026-03-24,
151.0 = 2026-05-19, 153.0 = 2026-07-21, 154.0 = 2026-08-18.

**ESR 140 has no LNA gate.** Searching the `mozilla-esr140` tree on searchfox for
`network.lna`, `LNAPermission` and `NS_ERROR_LOCAL_NETWORK_ACCESS_DENIED` returns zero hits. The
`nsILoadInfo::ipAddressSpace` plumbing exists there, but no enforcement, no prefs and no prompt.
Sources: `https://searchfox.org/mozilla-esr140/search?q=network.lna`,
`https://searchfox.org/mozilla-esr140/search?q=LNAPermission`,
`https://searchfox.org/mozilla-esr140/search?q=LOCAL_NETWORK_ACCESS_DENIED`

---

### The three ticket claims, checked

#### Claim (a): "strict mode from Firefox 149". **REFUTED. The version is 147.**

Firefox 147 release notes, section "New", carry the first LNA entry Firefox ever shipped:

> "Users with Enhanced Tracking Protection (ETP) set to Strict will have local network access
> restrictions enabled by default. Firefox will now require users to explicitly allow public
> websites to access local network resources. This feature is part of a progressive roll out."

Source: `https://www.mozilla.org/en-US/firefox/147.0/releasenotes/`

The code rode Firefox 146 with the pref off. Bug 1991917, "Enable LNA for ETP strict in release",
is `RESOLVED FIXED`, target milestone `146 Branch`. Comment 8 (2025-11-03): "We dont need to mention
this in the release note as it is default prefed off. We will do a nimbus rollout of this in 147."
Source: `https://bugzilla.mozilla.org/rest/bug?id=1991917`

Firefox 148, 149 and 150 release notes contain **no** LNA text at all. The full text of each was
fetched and searched for "local network" and "LNA": zero hits. Versions 140 to 146 were also checked:
zero hits.
Sources: `https://www.mozilla.org/en-US/firefox/148.0/releasenotes/`,
`https://www.mozilla.org/en-US/firefox/149.0/releasenotes/`,
`https://www.mozilla.org/en-US/firefox/150.0/releasenotes/`

Firefox 149 is where the *pref default flip* for ETP-strict landed, after the feature had already
shipped to those users. Bug 2017249, "[LNA] Enable LNA for ETP strict users by default",
`RESOLVED FIXED`, target milestone `149 Branch`, resolved 2026-02-17. Comment 0: "For 147 release we
conducted rolled out LNA for ETP strict via nimbus. Given the smooth deployment, we plan to release
it to all ETP strict users by default for 148. 149, we will start with gradual rollout to all our
users." No `relnote-firefox` flag was ever set on that bug.
Source: `https://bugzilla.mozilla.org/rest/bug?id=2017249`

#### Claim (b): "general rollout from 151". **CONFIRMED, with a later default-on step.**

Firefox 151 release notes, section "Web Platform":

> "Local network access restrictions are now rolling out to all users. Firefox requires websites to
> request permission before connecting to devices on your local network or to apps and services on
> your device. Previously, this protection was limited to users with Enhanced Tracking Protection set
> to Strict. This feature is part of a progressive roll out."

Source: `https://www.mozilla.org/en-US/firefox/151.0/releasenotes/`

151 started a staged Nimbus rollout. The default-on flip came in **Firefox 153**. Release notes,
section "Changed":

> "Local Network Access restrictions are now enabled by default for all users. Firefox requires
> websites to request permission before connecting to devices on your local network or to apps and
> services on your device."

Source: `https://www.mozilla.org/en-US/firefox/153.0/releasenotes/`

That entry maps to bug 2033733, "[LNA] Enable LNA for all desktop users by default.",
`RESOLVED FIXED`, `cf_status_firefox153: fixed`. Comment 5 (2026-07-10): "The is feature is rolled
out via nimbus, and now we enable it by default via the pref. 151-152 we did the gradual rollout and
reached 100% last week."
Source: `https://bugzilla.mozilla.org/rest/bug?id=2033733`

Firefox 152 release notes contain no LNA text.

#### Claim (c): "Firefox 154 extended the gate to WebSockets on 2026-08-17". **VERSION RIGHT, DATE WRONG.**

Firefox 154.0 shipped **2026-08-18**, not 2026-08-17. The release-notes header reads: "154.0 Firefox
Release August 18, 2026 - Version 154.0, first offered to Release channel users on August 18, 2026".
No Firefox release exists on 2026-08-17 in `firefox.json`.

Firefox 154 release notes, section "New":

> "Firefox's Local Network Access protections now extend to WebSocket connections. Websites that try
> to open a WebSocket to a device on the local network will now ask for permission first."

Source: `https://www.mozilla.org/en-US/firefox/154.0/releasenotes/`

Bug 2042339, "[LNA] Enable LNA Restrictions for Websockets", `RESOLVED FIXED`, target milestone
`154 Branch`, `cf_status_firefox154: fixed`, `cf_status_firefox153: wontfix`, resolved 2026-07-02.
Comment 0: "We need to enable LNA restrictions for websockets. We just to flip the pref
`network.lna.websocket.enabled`". Comment 4: "Flip `network.lna.websocket.enabled` to true so
WebSocket connections follow the normal Local Network Access rules instead of being skipped in
`nsHttpTransaction::AllowedToConnectToIpAddressSpace`."
Source: `https://bugzilla.mozilla.org/rest/bug?id=2042339` and
`https://bugzilla.mozilla.org/rest/bug/2042339/comment`

---

### The meta bug

Bug 1481298, "[meta] Local Network Access". Product Core, component DOM: Networking. Status `NEW`,
resolution empty. Created 2018-08-06. Keywords `meta`, `parity-chrome`, `web-feature`.
`last_change_time: 2026-08-14`. It has **83** entries in `depends_on`.
Source: `https://bugzilla.mozilla.org/rest/bug?id=1481298`

Sub-meta bugs under it: 1944548 (core framework in Necko), 1960616 (permissions and prompt UI),
1960630 (rollout), 1960640 (future tasks), 1969837 (block trackers, `RESOLVED FIXED`, 141 Branch),
1971096 (advanced blocking), 1971290 (Android), 1989912 (allow list).

**No first-party Mozilla blog post announces LNA.** Bug 1960634, "LNA - Write a connect post and a
blogpost for the feature", is still `NEW` and unassigned, and has not been touched since it was filed
on 2025-04-15. Searches of `blog.mozilla.org/security`, `hacks.mozilla.org`, `blog.mozilla.org/en`,
`blog.mozilla.org/futurereleases` and `blog.nightly.mozilla.org` for "local network access" returned
nothing. `connect.mozilla.org` returned HTTP 403, so it is **unverified**.
Sources: `https://bugzilla.mozilla.org/rest/bug?id=1960634`, the search URLs above.

The support article `https://support.mozilla.org/en-US/kb/control-personal-device-local-network-permissions-firefox`
exists (it is the target of `browser.lna.warning.infoURL`, and bug 2034030 tracks its content), but a
direct fetch returns a JavaScript challenge page, so its text is **unverified**.

---

### The prefs

All prefs live in `modules/libpref/init/StaticPrefList.yaml` unless stated. Comments below are quoted
from that file.
Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/modules/libpref/init/StaticPrefList.yaml`
Release values from `https://hg.mozilla.org/releases/mozilla-release/raw-file/default/modules/libpref/init/StaticPrefList.yaml`,
beta values from `https://hg.mozilla.org/releases/mozilla-beta/raw-file/default/modules/libpref/init/StaticPrefList.yaml`

| Pref | Meaning (quoted from source) | Release 154 | Beta 155 | Central 156 |
| --- | --- | --- | --- | --- |
| `network.lna.enabled` | "controls Local Network Access (LNA) feature" | `true` | `true` | `true` |
| `network.lna.blocking` | "controls if we need to fail transactions for Local Network Access (LNA) failures". This is the prompt switch. | `true` | `true` | `true` |
| `network.lna.block_trackers` | "loads triggered by scripts classified as trackers will automatically be blocked" | `false` | `false` | `false` |
| `network.lna.allow_top_level_navigation` | "top-level document navigation to local network addresses will bypass LNA permission checks" | `true` | `true` | `true` |
| `network.lna.skip-domains` | "Comma-separated list of domains to skip LNA checks for. Supports suffix wildcard patterns (`*.example.com`)" | `""` | `""` | `""` |
| `network.lna.websocket.enabled` | "When this pref is false, skip all LNA checks for WebSocket connections. When true, WebSocket connections follow normal LNA rules." | `true` | `true` | `true` |
| `network.lna.local-network-to-localhost.skip-checks` | "skip LNA checks for requests from private network to localhost" | `true` | `true` | `true` |
| `network.lna.defer_https_check` | "defer the LNA check for private IP address space targets on HTTPS connections until after the TLS handshake succeeds" | `true` | `true` | `true` |
| `network.lna.benchmarking-is-local` | "benchmarking IP addresses 198.18.X.X is treated as local ... disabled to match Chrome LNA behaviour" | `false` | `false` | `false` |
| `network.lna.block_insecure_contexts` | "block LNA requests from insecure contexts (`http://` origins that are not localhost or `.local`)" | **`true`** | **`false`** | **`false`** |
| `network.lna.address_space.public.override` | "comma seperated list of URL/IPAddress:Port that will be treated as public IPAddressSpace" | `""` | `""` | `""` |
| `network.lna.address_space.private.override` | same, for private | `""` | `""` | `""` |
| `network.lna.address_space.local.override` | same, for local | `""` | `""` | `""` |

`network.lna.block_insecure_contexts` is the one pref whose default differs across channels at
retrieval. It is `true` in release 154 and `false` in beta 155 and Nightly 156. The Nightly file
carries an extra comment that release 154 does not have: "The spec requires this, but it is disabled
by default until Chrome ships the same restriction, to avoid breaking sites that only work in
Firefox." No Bugzilla bug for this reversal was found; searches for `block_insecure_contexts`,
"LNA insecure context" and a `short_desc` search of Core / DOM: Networking for "insecure" returned
nothing matching. The reversal itself is verified from the two source files; **the reason and the
bug number are unverified**.

Two more prefs are set outside `StaticPrefList.yaml`:

- `browser/app/profile/firefox.js`: `pref("network.lna.prompt.timeout", 300000); // 5 minutes` and
  `pref("network.lna.temporary_permission_expire_time_ms", 86400000); // 24 hours`. Also
  `pref("permissions.default.local-network", 0);`, `pref("permissions.default.loopback-network", 0);`
  and `pref("browser.lna.warning.infoURL", "https://support.mozilla.org/%LOCALE%/kb/control-personal-device-local-network-permissions-firefox")`.
  Source: `https://searchfox.org/mozilla-central/search?q=network.lna`
- `modules/libpref/init/all.js`: `pref("network.lna.etp.enabled", true);`. This is the ETP-strict gate,
  driven by Nimbus. `ContentBlockingPrefs.sys.mjs` comments: "turn on LNA for etp strict only if
  `network.lna.etp.enabled`" and "`network.lna.etp.enabled` is controlled by nimbus".
  Source: same search.

`network.lna.enabled`, `network.lna.blocking`, `network.lna.block_trackers` and
`network.lna.block_insecure_contexts` are all exposed as Nimbus variables in
`toolkit/components/nimbus/FeatureManifest.yaml`, so Mozilla can change them remotely without a
release.

LNA is also a token in the ETP strict preset. `firefox.js` documents `"lna": LNA enabled` /
`"-lna": LNA disabled`, and `browser.contentblocking.features.strict` ends with `...,btp,lna`.
`ContentBlockingPrefs.sys.mjs` turns `network.lna.blocking` on for ETP strict only when
`network.lna.etp.enabled` is true.
Source: `https://searchfox.org/mozilla-central/search?q=network.lna`

---

### Address classification

Firefox classifies the **resolved peer IP address**, not the hostname. The classifier is
`NetAddr::GetIpAddressSpace()` in `netwerk/dns/DNS.cpp`.
Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/netwerk/dns/DNS.cpp`

```
nsILoadInfo::IPAddressSpace NetAddr::GetIpAddressSpace() const {
  ...
  if (addr->IsLoopbackAddr() || addr->IsIPAddrAny()) {
    return nsILoadInfo::IPAddressSpace::Local;
  }
  if (addr->IsIPAddrLocal() || addr->IsIPAddrShared()) {
    return nsILoadInfo::IPAddressSpace::Private;
  }
  return nsILoadInfo::IPAddressSpace::Public;
}
```

The three enum values come from `netwerk/base/nsILoadInfo.idl`:
`Unknown = 0, Local = 1, Private = 2, Public = 3, Invalid`. Firefox's `Local` is the spec's
`loopback`; Firefox's `Private` is the spec's `local`.
Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/netwerk/base/nsILoadInfo.idl`

The range tests, quoted from `DNS.cpp`:

```
static bool isLocalIPv4(uint32_t networkEndianIP) {
  uint32_t addr32 = ntohl(networkEndianIP);
  return addr32 >> 24 == 0x00 ||    // 0/8 prefix (RFC 1122).
         addr32 >> 24 == 0x0A ||    // 10/8 prefix (RFC 1918).
         addr32 >> 20 == 0x0AC1 ||  // 172.16/12 prefix (RFC 1918).
         addr32 >> 16 == 0xC0A8 ||  // 192.168/16 prefix (RFC 1918).
         addr32 >> 16 == 0xA9FE;    // 169.254/16 prefix (Link Local).
}
```

```
    if (addr16 >> 9 == 0xfc >> 1 ||    // fc00::/7 Unique Local Address.
        addr16 >> 6 == 0xfe80 >> 6) {  // fe80::/10 Link Local Address.
```

```
bool NetAddr::IsIPAddrShared() const {
  // IPv4 RFC6598.
  if (addr->raw.family == AF_INET) {
    uint32_t addr32 = ntohl(addr->inet.ip);
    if (addr32 >> 22 == 0x644 >> 2) {  // 100.64/10 prefix (RFC 6598).
      return true;
    }
  }
  return false;
}
```

`IsLoopbackAddr()` covers `127.0.0.0/8` ("Consider 127.0.0.1/8 as loopback"), `::1`, and
IPv4-mapped loopback. `IsBenchMarkingAddress()` covers `198.18.0.0/15`.

The in-tree gtest states the whole table and asserts it.
Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/netwerk/test/gtest/TestLocalNetworkAccess.cpp`

| Range | Firefox space | Gated by LNA from a public page? |
| --- | --- | --- |
| `127.0.0.0/8` | Local | Yes |
| `::1` | Local | Yes |
| `0.0.0.0` / `::` (any) | Local | Yes |
| `10.0.0.0/8` | Private | Yes |
| `172.16.0.0/12` | Private | Yes |
| `192.168.0.0/16` | Private | Yes |
| **`100.64.0.0/10` (RFC 6598 CGNAT, Tailscale)** | **Private** | **Yes** |
| `169.254.0.0/16` | Private | Yes |
| `0.0.0.0/8` | Private | Yes |
| `fc00::/7` ULA | Private | Yes |
| `fe80::/10` | Private | Yes |
| `198.18.0.0/15` | Public by default (`network.lna.benchmarking-is-local` is `false`) | No |
| `fec0::/10` site-local | Public (no code path matches it) | No |
| `2001:db8::/32`, `3fff::/20` | Public (no code path matches it) | No |
| everything else | Public | No |

The gtest asserts `{"100.64.0.1", Private}` and `{"100.127.255.254", Private}` explicitly.

**So a Tailscale-style overlay on 100.64.0.0/10 is treated exactly like an RFC 1918 LAN address.**
It is not exempt.

**Hostnames get no special treatment.** There is no `.local`, `localhost` or mDNS branch anywhere in
the LNA path. Searching mozilla-central for the literal `.local"` returns hits only in WebRTC mDNS
code, reputation service, sandbox paths and unrelated places. Firefox resolves the name first, then
classifies the address. A `.local` name that resolves to `192.168.1.10` is Private. A `.local` name
that resolves to a public address is Public. The only place `.local` appears in an LNA comment is the
`network.lna.block_insecure_contexts` description, and that comment describes
`IsPotentiallyTrustworthyOrigin`, not the address classifier.
Source: `https://searchfox.org/mozilla-central/search?q=%5C.local%22&regexp=true`

The spec handles `.local` outside the address table, by public suffix. Its Fetch integration says:
"If request's URL's host's public suffix is `"local"`, then set request's target IP address space to
`local`." It also declines to special-case `localhost`: "we do not need special handling for the
loopback case as it is already considered to be potentially trustworthy". Firefox implements neither
rule, because it classifies only the resolved address.
Source: `https://wicg.github.io/local-network-access/` sections 2.5 and 3.1.1

**Firefox diverges from the spec in three places.** The WICG table lists `198.18.0.0/15` as
`loopback`, `fec0::/10` as `local`, and `2001:db8::/32` and `3fff::/20` as `local`. Firefox treats
all four as public. The `198.18.0.0/15` divergence is deliberate: the source comment says "for now
it's disabled to match Chrome LNA behaviour". The other three are simply absent from the code.
Source: `https://wicg.github.io/local-network-access/` section 2.1, "Non-public IP address blocks"

Administrators and users can move any address into any space with the three
`network.lna.address_space.*.override` prefs. Each takes a comma-separated list of
`URL` or `IPAddress:Port` entries. The gtest exercises every transition, including
`127.0.0.1:4444` reclassified as Public and `8.8.8.8:80` reclassified as Private.

---

### Does the gate apply to a WebExtension background context?

**Read from the implementation: no. An extension page's requests are not gated, because the gate
never fires when the initiator's address space is `Unknown`.** This is an accident of the address
model, not an explicit extension check. Mozilla says as much in Bugzilla, and two known bugs make the
exemption leak.

#### The gate, in code

The whole gate is one function, `nsHttpTransaction::AllowedToConnectToIpAddressSpace`. It runs at the
transaction layer, after DNS, before or just after connect.
Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/netwerk/protocol/http/nsHttpTransaction.cpp` (lines 4060-4137)

Its order of checks:

1. `network.lna.enabled` false, return true.
2. `gIOService->ShouldSkipDomainForLNA(mConnInfo->GetOrigin())`, return true.
3. `network.lna.websocket.enabled` false and this is a WebSocket upgrade, return true.
4. Parent is Private and target is Local, and `network.lna.local-network-to-localhost.skip-checks`
   is true, return true.
5. `IsLocalOrPrivateNetworkAccess(mParentIPAddressSpace, aTargetIpAddressSpace)`. Only if that is
   true does anything get blocked.

The decisive predicate is in `netwerk/base/nsNetUtil.cpp`:
Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/netwerk/base/nsNetUtil.cpp` (lines 4281-4315)

```
bool IsLocalHostAccess(parent, target) {
  return ((target == Local) && (parent == Public || parent == Private));
}
bool IsPrivateNetworkAccess(parent, target) {
  return ((target == Private) && (parent == Public));
}
bool IsLocalOrPrivateNetworkAccess(parent, target) {
  return IsPrivateNetworkAccess(parent, target) || IsLocalHostAccess(parent, target);
}
```

**Both predicates require the parent space to be `Public` or `Private`. `Unknown` and `Local` match
neither.** An initiator whose address space is `Unknown` or `Local` is never gated, whatever it
targets.

#### What principal or origin Firefox uses

Firefox does **not** use the principal to decide whether the gate fires. It uses
`nsILoadInfo::parentIpAddressSpace`, set by `LoadInfo::UpdateParentAddressSpaceInfo()`:
Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/netwerk/base/LoadInfo.cpp` (lines 2079-2119)

- No browsing context, and the client is a worker: read the IP address space from the policy
  container, which the parent document propagated.
- No browsing context at all: `mParentIpAddressSpace = nsILoadInfo::Local`.
- Document or subdocument load: take the parent or opener browsing context's value.
- Everything else: `bc->GetCurrentIPAddressSpace()`.

The principal enters only *after* the gate has already fired, to look up a stored permission.
`nsHttpChannel::UpdateLocalNetworkAccessPermissions` calls
`nsContentUtils::IsExactSitePermAllow(mLoadInfo->TriggeringPrincipal(), aPermissionType)` and the
matching `IsExactSitePermDeny`. So the permission is keyed to the triggering principal's origin,
which for an extension request is `moz-extension://«UUID»`.
Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/netwerk/protocol/http/nsHttpChannel.cpp` (lines 2042-2143)

#### Why an extension page lands on `Unknown`

`BrowsingContext::IPAddressSpace` is a synced field. It is initialised as:

```
fields.Get<IDX_IPAddressSpace>() = inherit ? inherit->GetIPAddressSpace()
                                           : nsILoadInfo::IPAddressSpace::Unknown;
```
Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/docshell/base/BrowsingContext.cpp` (line 492)

`BrowsingContext::SetCurrentIPAddressSpace` has exactly **two** callers in the whole tree, both in
`nsHttpChannel.cpp` (lines 9336 and 9598), and both only for `TYPE_DOCUMENT` and `TYPE_SUBDOCUMENT`
loads, using the HTTP peer address:

```
nsILoadInfo::IPAddressSpace docAddressSpace = mPeerAddr.GetIpAddressSpace();
mLoadInfo->SetIpAddressSpace(docAddressSpace);
... if (type == TYPE_DOCUMENT || type == TYPE_SUBDOCUMENT) { bc->SetCurrentIPAddressSpace(...); }
```
Source: `https://searchfox.org/mozilla-central/search?q=SetCurrentIPAddressSpace` and
`https://hg.mozilla.org/mozilla-central/raw-file/tip/netwerk/protocol/http/nsHttpChannel.cpp` (lines 9314-9350)

A `moz-extension://` document is served by the extension protocol handler, not by `nsHttpChannel`.
Nothing ever sets its browsing context's address space. It stays `Unknown`.

This is where Firefox diverges from the specification, which says the policy container's IP address
space "is initially **public**".
Source: `https://wicg.github.io/local-network-access/` section 3.5, "Integration with HTML"

#### Mozilla's own words

Bug 2032778, "LNA prompt appears despite extension origin being allowed to, when a navigation
elsewhere is triggered (and aborted)". Status `NEW`, unassigned, created 2026-04-17 by Rob Wu,
last changed 2026-08-04.
Source: `https://bugzilla.mozilla.org/rest/bug?id=2032778`, `https://bugzilla.mozilla.org/rest/bug/2032778/comment`

- Comment 0, Rob Wu (Mozilla, WebExtensions): "Extensions should be exempt from LNA prompts, at least
  when they have host permissions for localhost. **This works already.** But I found that the LNA
  prompt is unexpectedly triggered for extension pages when a navigation is triggered and aborted."
- Comment 1, Sunil Mayya (the LNA implementer): "I think, this works by default becasue extensions
  page have ip address space set to local. When the user navigates, we set the ip address of the page
  of public and thus triggerring LNA prompt when making the request. **The fix would be to actually
  check request is coming from extension and exempt them.**"

Bug 1984359, "Wrong origin of Local Network Access warning from addons running against a self-hosted
service". `RESOLVED WORKSFORME`. Filed 2025-08-21 against Bitwarden / vaultwarden reached over
Tailscale, which is the same shape as this product.
Source: `https://bugzilla.mozilla.org/rest/bug?id=1984359`, `https://bugzilla.mozilla.org/rest/bug/1984359/comment`

- Comment 4, Sunil Mayya (2025-09-22): "If the request is coming from extension, it should be given
  access to the local host resources without prompting. Chrome is implementing it in a similar way.
  **I need to add check for this in the necko code** to allow requests coming from extensions to skip
  LNA checks."

That check does not exist yet. Searching mozilla-central for `moz-extension` inside any LNA-pathed
file returns nothing, and no file under `toolkit/components/extensions` appears in a search for LNA
symbols.
Sources: `https://searchfox.org/mozilla-central/search?q=moz-extension&path=lna`,
`https://searchfox.org/mozilla-central/search?q=localNetwork&path=toolkit/components/extensions`

#### Does `host_permissions` exempt the request?

**No, not as a mechanism.** No code in the LNA path reads `AddonPolicy()`, `host_permissions`, or any
extension permission. `nsHttpChannel.cpp` mentions add-on policy only in unrelated code (CORS-ish
checks near line 11895 and stream filters). Rob Wu's phrase "at least when they have host permissions
for localhost" describes the observed outcome, not the code path. The outcome comes from the address
space being `Unknown`, and it holds whether or not the extension declares
`http://192.168.*/*` or `*://*/*`.

#### Is there a WebExtension permission for local network access?

**No.** BCD's `webextensions/manifest/permissions.json` lists 52 permission names. None relates to
local network access. The only network-shaped names are `declarativeNetRequest`,
`declarativeNetRequestFeedback` and `declarativeNetRequestWithHostAccess`.
Source: `https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/manifest/permissions.json`

Searching mozilla-central for `localNetwork` restricted to `toolkit/components/extensions` returns
zero hits, so no such permission exists in the Firefox schemas either.
Source: `https://searchfox.org/mozilla-central/search?q=localNetwork&path=toolkit/components/extensions`

#### Do content scripts differ from the background context?

**Yes, and this is the sharp edge.** A content script runs in a sandbox whose window and browsing
context belong to the page. `LoadInfo::UpdateParentAddressSpaceInfo` therefore reads the *page's*
browsing context, which an ordinary `https://` document has already set to `Public`. A LAN or
Tailscale target is `Private`, so `IsPrivateNetworkAccess(Public, Private)` is true and the gate
fires.

Mozilla states the same thing for the page-injected case. Bug 1984359, comment 2, Rob Wu: "the
extension intentionally executes code in the context of the web page that calls `fetch()`. **This is
indistinguishable from other code from the web page itself, and therefore runs with web page
privileges, not extension privileges.**"
Source: `https://bugzilla.mozilla.org/rest/bug/1984359/comment`

And bug 2023758, comment 3, Rob Wu: "**Content scripts should indeed be consistent with the page's
LNA behavior.** With Fission, extension documents are loaded in a separate extension process, so in
theory it should be possible for the parent to distinguish `fetch` calls from extension documents."
Source: `https://bugzilla.mozilla.org/rest/bug/2023758/comment`

#### Two known leaks in the extension exemption

1. **Extension pages in iframes are gated.** Bug 2023758, "Extension pages loaded in iframes trigger
   LNA check". Status `NEW`, created 2026-03-17, last changed 2026-07-27. The reporter's console
   line, quoted verbatim from comment 0:
   > `Local Network Access detected: top-level site "https://example.com/", initiator
   > "moz-extension://b818d629-.../embed.html", accessing target "http://127.0.0.1:3000/"
   > (127.0.0.1:3000) via fetch. Secure context: True, prompt action: prompt_allow`

   Comment 2, Sunil Mayya: "The thing is in the parent process it is not possible to distinguish
   between a content script loaded from extension and script from the page. Hence, the existing
   checks for extension fails."
   Source: `https://bugzilla.mozilla.org/rest/bug?id=2023758`

   The mechanism matches the code: a subdocument load takes
   `bc->GetParent()->GetCurrentIPAddressSpace()`, which is the public page's `Public`.

2. **An aborted navigation flips an extension page to public.** Bug 2032778, quoted above. After the
   flip, later requests from that extension page are gated.

#### What is verified and what is inference

Verified from source: the gate predicate, the parent-address-space plumbing, the two and only two
callers that set a browsing context's address space, the absence of any extension check in the LNA
path, and the absence of any LNA WebExtension permission.

Corroborated by Mozilla engineers in Bugzilla: that extension pages are exempt today, that the
exemption is incidental rather than explicit, and that content scripts follow the page.

**Not verified:** no Mozilla document, MDN page or test states the extension exemption as a supported
guarantee. Searched MDN WebExtensions docs, the MDN Local Network Access page, mozilla-central tests
under `netwerk/test/browser` and `netwerk/test/unit`, and Bugzilla. **There is no test in
mozilla-central covering LNA behaviour for a `moz-extension://` initiator.** The behaviour is
therefore undefended by CI and could change without a release note.

---

### Permission lifecycle and failure surface

#### The two permission types

`loopback-network` for the spec's loopback space (Firefox `Local`), and `local-network` for the
spec's local space (Firefox `Private`). Both are declared in `SitePermissions.sys.mjs`
`gPermissionObject` with `exactHostMatch: true`, and both are hidden from the UI when
`network.lna.blocking` is false:

```
    "loopback-network": {
      exactHostMatch: true,
      labelID: "localhost",
      get disabled() { return !SitePermissions.localNetworkAccessPermissionsEnabled; },
    },
    "local-network": {
      exactHostMatch: true,
      get disabled() { return !SitePermissions.localNetworkAccessPermissionsEnabled; },
    },
```
Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/browser/modules/SitePermissions.sys.mjs` (lines 939-952 and 1142-1147)

`exactHostMatch: true` means the grant is stored per exact host. It does not extend to subdomains.

An older permission type named `localhost` was renamed. `ProfileDataUpgrader.sys.mjs` migrates
`"localhost"` entries to `"loopback-network"` and the matching `permissions.default.*` pref.
Source: `https://searchfox.org/mozilla-central/search?q=loopback-network`

#### Grant scope: temporary by default, permanent only if the user ticks the box

The prompt carries a checkbox, and its label is "Remember my choice for this site". The checkbox is
hidden in private browsing:

```
    options.checkbox = {
      show: !lazy.PrivateBrowsingUtils.isWindowPrivate(this.browser.documentGlobal),
    };
    if (options.checkbox.show) {
      options.checkbox.label = lazy.gBrowserBundle.GetStringFromName("localNetwork.remember2");
    }
```
Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/browser/modules/PermissionUI.sys.mjs` (lines 1770-1836)

The generic prompt callback then decides the scope:

```
            if ((state && state.checkboxChecked && state.source != "esc-press") ||
                promptAction.scope == lazy.SitePermissions.SCOPE_PERSISTENT) {
              let scope = lazy.SitePermissions.SCOPE_PERSISTENT;
              if (lazy.PrivateBrowsingUtils.isBrowserPrivate(this.browser)) {
                scope = lazy.SitePermissions.SCOPE_SESSION;
              }
              lazy.SitePermissions.setForPrincipal(this.principal, this.permissionKey,
                                                   promptAction.action, scope);
            } else {
              lazy.SitePermissions.setForPrincipal(this.principal, this.permissionKey,
                                                   promptAction.action,
                                                   lazy.SitePermissions.SCOPE_TEMPORARY,
                                                   this.browser,
                                                   this.temporaryPermissionExpireTimeMS);
            }
```
Source: same file, lines 540-570

So:

| User action | Scope stored |
| --- | --- |
| Allow with checkbox ticked, normal window | `SCOPE_PERSISTENT` (survives restart) |
| Allow with checkbox ticked, private window | `SCOPE_SESSION` |
| Allow without ticking | `SCOPE_TEMPORARY`, tied to that `browser` (tab), expiring after `network.lna.temporary_permission_expire_time_ms` = 24 hours |
| Block | same scope rules, stored as a deny |

The LNA prompt overrides the temporary expiry: "LNA temporary permissions have a custom expiration
time (default 24 hours)". Every other permission uses the shorter default.
Source: same file, lines 1155-1158

Because `SCOPE_TEMPORARY` is per-tab, users see repeated prompts. Bug 2041492, "[LNA] local network
access LNA does not remember users answer", status `NEW`. Sunil Mayya, comment 3: "The problem is in
the Private Browsing session, the decision is persisted only for the current tab. Hence you are
seeing multiple prompts. ... If you click the checkbox, the decision should be persisted across
various sessions in a non-private browsing session." Bug 2042332, "[LNA] Widen the scope of LNA
temproary permission", status `NEW`, wants to "increase the expiry of LNA temproary permission and
also ensure the widen its scope, i.e. persisted across multiple browsing session".
Sources: `https://bugzilla.mozilla.org/rest/bug/2041492/comment`, `https://bugzilla.mozilla.org/rest/bug/2042332/comment`

#### The prompt times out

`LNAPermissionPromptBase` starts a timer when the prompt is shown. On expiry it logs a console
warning, removes the prompt, and cancels the request:

```
  static DEFAULT_PROMPT_TIMEOUT_MS = 300000;
  ...
      scriptError.initWithWindowID(
        `LNA permission prompt timed out after ${lazy.lnaPromptTimeoutMs / 1000} seconds`, ...)
      this.#removePrompt();
      this.cancel();
```
Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/browser/modules/PermissionUI.sys.mjs` (lines 1120-1195)

The timeout is `network.lna.prompt.timeout`, default 300000 ms (5 minutes). A prompt the user ignores
becomes a denial after five minutes. The request is suspended for that whole time
(`nsHttpChannel::ProcessLNAActions` calls `Suspend()` before prompting).

#### Shared workers and service workers never prompt

`LNAPermissionRequest::RequestPermission` short-circuits for two client types:

```
  // For shared and service workers, do not show a permission prompt.
  // Only grant access if the origin already has a persistent LNA permission.
  Maybe<dom::ClientInfo> clientInfo = mLoadInfo->GetClientInfo();
  if (clientInfo.isSome() &&
      (clientInfo->Type() == dom::ClientType::Sharedworker ||
       clientInfo->Type() == dom::ClientType::Serviceworker)) {
    ...
    permMgr->TestPermissionFromPrincipal(mPrincipal, mType, &permission);
    if (NS_SUCCEEDED(rv) && permission == nsIPermissionManager::ALLOW_ACTION) {
      return Allow(JS::UndefinedHandleValue);
    }
```

On failure it logs: "Local Network Access blocked: worker from origin `<origin>` attempted `<type>`
access but no persistent permission was granted."
Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/netwerk/base/LNAPermissionRequest.cpp` (lines 216-250)

`TestPermissionFromPrincipal` reads the persistent permission store. The 24-hour temporary grant is
attached to a browser element, not to the principal, so it does **not** satisfy this check. A shared
worker or service worker therefore works only after the user has ticked "Remember my choice for this
site" on a foreground prompt. Dedicated workers are not in this branch and follow the normal path.

#### Iframe feature policy can deny before the prompt

The same function enforces the `local-network` and `loopback-network` policy-controlled features
(bug 1978550):

```
      if (fpInfo->mInheritedDeniedFeatureNames.Contains(featureName)) {
        NS_WARNING("Feature policy denying the request");
        return Cancel();
      }
```

The comment explains the scope: the policy comes from
`HTMLIFrameElement::MaybeStoreCrossOriginFeaturePolicy()` for `<iframe>` and the matching
`nsObjectLoadingContent` path for `<object>`/`<embed>`, and "it's safe to ignore feature policy when
it's missing as that would only mean the request is from a top-level document".
Source: same file, lines 150-192

Firefox also registers `local-network` in `dom/security/featurepolicy/FeaturePolicyUtils.cpp` with a
default allowlist of `eSelf`. So the `allow` attribute on an iframe works, while BCD still reports the
`Permissions-Policy` **header** directives as unsupported in Firefox. Whether Firefox parses the
header itself is **unverified**; BCD says no, the feature table says the feature name exists.
Source: `https://searchfox.org/mozilla-central/search?q=loopback-network`

#### Where the grant appears in the UI

- The URL bar anchors: `local-network-notification-icon` and `loopback-network-notification-icon`,
  plus blocked-permission icons with `data-permission-id="local-network"` and
  `data-permission-id="loopback-network"` in `navigator-toolbox.inc.xhtml`.
- `about:preferences#privacy` lists them as **two separate rows**. `permissions-data.mjs` has
  `loopbackNetworkSettingsButton` with `l10nId: "permissions-localhost2"` and icon
  `chrome://global/skin/icons/local-host.svg`, and `localNetworkSettingsButton` with
  `l10nId: "permissions-local-network2"` and icon
  `chrome://browser/skin/notification-icons/local-network.svg`. `preferences.ftl` gives the labels:
  `permissions-localhost2 = .label = Device apps and services` and
  `permissions-local-network2 = .label = Local network devices`. `privacy.js` has `// LOCAL-NETWORK`
  and `// LOOPBACK-NETWORK` sections and a `showLocalNetworkExceptions()` method.
- The exceptions dialogs come from `browser/locales/en-US/browser/preferences/permissions.ftl`:
  `permissions-site-localhost-window = .title = Settings - Device apps and services` and
  `permissions-site-local-network-window = .title = Settings - Local Network Devices`. The local
  network description reads: "These websites have requested access to apps and services on devices
  connected to your Wi-Fi or local network. You can choose to allow or block sites from doing this."
- URL bar tooltips from `browser/browser.ftl`:
  `urlbar-local-network-blocked = .tooltiptext = You have blocked local network connections for this
  website.` and `urlbar-localhost-blocked = .tooltiptext = You have blocked local device connections
  for this website.`
- Page Info shows the permission with the label from `sitePermissions.properties`:
  `permission.localhost.label = Access this device` and
  `permission.local-network.label = Access local network devices`.

Sources: `https://searchfox.org/mozilla-central/search?q=local-network`,
`https://hg.mozilla.org/mozilla-central/raw-file/tip/browser/locales/en-US/chrome/browser/sitePermissions.properties`

#### The prompt text

From `browser/locales/en-US/chrome/browser/browser.properties`:

```
# loopback-network and local-network permission UI
# %S is replaced by the origin of the website
localhost.allowWithSite2=%S wants to access other apps and services on this device.
localhost.remember2=Remember my choice for this site
localhost.allowlabel=Allow
localhost.blocklabel=Block

# local-network permission UI
# %S is replaced by the origin of the website
localNetwork.allowWithSite2=%S wants to access apps and services on devices connected to your local network.
localNetwork.remember2=Remember my choice for this site
localNetwork.allowLabel=Allow
localNetwork.blockLabel=Block
```
Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/browser/locales/en-US/chrome/browser/browser.properties` (lines 204-220)

The prompt uses `displayURI: false` and `name: this.getPrincipalName()`, so it names the initiator.
For an extension the reporter of bug 1984359 confirmed it "yielded a popup which mention the addon
name".

#### What a denial looks like to JavaScript

The necko error is `NS_ERROR_LOCAL_NETWORK_ACCESS_DENIED`, defined in `xpcom/base/ErrorList.py` as
`errors["NS_ERROR_LOCAL_NETWORK_ACCESS_DENIED"] = FAILURE(93)`, numeric value `0x804b005d`. Its
XPConnect message is "The access to local network is denied".
Sources: `https://hg.mozilla.org/mozilla-central/raw-file/tip/xpcom/base/ErrorList.py` (lines 364-375),
`https://searchfox.org/mozilla-central/search?q=NS_ERROR_LOCAL_NETWORK_ACCESS_DENIED`

A second, separate error sits next to it. `NS_ERROR_OS_LOCAL_NETWORK_ACCESS_DENIED` = `FAILURE(95)`.
The in-tree comment: "The connection was blocked by the OS itself because this app lacks the
platform-level local-network permission (e.g. Android 16+'s Local Network Protection, gated on
`ACCESS_LOCAL_NETWORK`/`NEARBY_DEVICES`). Distinct from `NS_ERROR_LOCAL_NETWORK_ACCESS_DENIED`, which
is Firefox's own site-permission decision made after a successful connect." Android has a second gate
below Firefox's. Bugs 2053432 and 2061658 track it, both `FIXED` for 155 Branch.
Source: same `ErrorList.py`

**That error does not reach content JavaScript.** `NS_ERROR_LOCAL_NETWORK_ACCESS_DENIED` appears
nowhere under `dom/`. A search of `dom` for the symbol returns zero hits.
Source: `https://searchfox.org/mozilla-central/search?q=LOCAL_NETWORK_ACCESS_DENIED&path=dom`

- **`fetch()`** rejects with a plain `TypeError`. Every fetch failure in Gecko uses one message,
  `MSG_FETCH_FAILED`, defined in `dom/bindings/Errors.msg` as
  `"{0}NetworkError when attempting to fetch resource."`, thrown as `JSEXN_TYPEERR`. There is no LNA
  variant. A denied LNA fetch is **indistinguishable in JavaScript from any other network failure**.
  Source: `https://searchfox.org/mozilla-central/search?q=MSG_FETCH_FAILED`
- **XHR** takes the same channel status. The browser test table treats `fetch`, `xhr`, `img`,
  `video`, `audio`, `iframe`, `script` and `font` identically, all with
  `denyStatus: Cr.NS_ERROR_LOCAL_NETWORK_ACCESS_DENIED` at the channel layer.
  Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/netwerk/test/browser/head_local_network_access.js` (lines 55-103)
- **WebSocket** differs only in the allow case. The same test table gives WebSocket
  `allowStatus: Cr.NS_ERROR_WEBSOCKET_CONNECTION_REFUSED` and
  `denyStatus: Cr.NS_ERROR_LOCAL_NETWORK_ACCESS_DENIED`. At the DOM layer a WebSocket cannot throw a
  distinguishing exception at all. `dom/websocket/WebSocket.cpp` contains **no** LNA handling: a
  case-insensitive search of that file for `local_network`, `localnetwork` and `lna` returns zero
  hits. The denial therefore takes the generic failure path. `WebSocket` is constructed with
  `mCloseEventWasClean(false)` and `mCloseEventCode(nsIWebSocketChannel::CLOSE_ABNORMAL)`, that is
  **1006**, and `ConsoleError()` logs the generic `connectionFailure` string from
  `appstrings.properties`. **A denied WebSocket is indistinguishable from "nothing is listening on
  that port".**
  Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/dom/websocket/WebSocket.cpp` (lines 140-141, 555, 585, 875-884)
- **The only signal is the console.** `netwerk/locales/en-US/necko.properties` defines two messages
  that `nsHttpChannel` sends to the child process for logging:
  ```
  LocalNetworkAccessDetected=Local Network Access detected: top-level site "%1$S", initiator "%2$S",
    accessing target "%3$S" (%4$S:%5$S) via %6$S. Secure context: %7$S, prompt action: %8$S
  LocalNetworkAccessPermissionRequired=Local Network Access permission required: top-level site
    "%1$S", initiator "%2$S", attempting to access target "%3$S" (%4$S:%5$S) via %6$S.
    Secure context: %7$S
  ```
  The localisation note names the mechanism values: "fetch, xhr, websocket". These go to the web
  console. Page JavaScript cannot read them.
  Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/netwerk/locales/en-US/necko.properties` (lines 109-112)

#### `navigator.permissions.query()`

**Firefox does support it, and BCD is wrong about this.** `dom/webidl/Permissions.webidl` lists both
names in the `PermissionName` enum:

```
  "loopback-network", // Defined in https://wicg.github.io/local-network-access/#integration-with-permissions
  "local-network" // Same as loopback-network
```
Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/dom/webidl/Permissions.webidl`

`dom/permission/Permissions.cpp` gates them on `network.lna.blocking`. When that pref is false, the
query throws a `TypeError` that pretends the name is unknown:

```
    case PermissionName::Local_network:
      if (!StaticPrefs::network_lna_blocking()) {
        aRv.ThrowTypeError(
            "'local-network' (value of 'name' member of PermissionDescriptor) "
            "is not a valid value for enumeration PermissionName.");
        return nullptr;
      }
      return MakeRefPtr<PermissionStatus>(aGlobal, rootDesc.mName);
```
Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/dom/permission/Permissions.cpp` (lines 105-122)

Since `network.lna.blocking` defaults to `true` from Firefox 153, the query works on current release.
Bug 2050333, "[LNA] inconsistent permissions.query error", `NEW`, notes only that the thrown message
gains a `Permissions.query: ` prefix that other permission names do not have.
Source: `https://bugzilla.mozilla.org/rest/bug/2050333/comment`

The generated type definition agrees:
`type PermissionName = "camera" | "geolocation" | "local-network" | "loopback-network" | "microphone"
| "midi" | "notifications" | "persistent-storage" | "push" | "screen-wake-lock" | "storage-access";`
**`"local-network-access"`, the legacy Chromium alias, is not in the Firefox enum.**
Source: `https://searchfox.org/mozilla-central/search?q=loopback-network`

BCD records `api.Permissions.permission_local-network` and `permission_loopback-network` as
`firefox: false`, `chrome: 145`. **That BCD entry contradicts the Firefox source read above.**
Source: `https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Permissions.json`

Two related surfaces Firefox does **not** have, per BCD:

| Feature | Chrome | Firefox |
| --- | --- | --- |
| `Permissions-Policy: local-network` / `loopback-network` | 145 | `false` |
| `Permissions-Policy: local-network-access` | 142 (alias) | `false` |
| `Request.targetAddressSpace` and the `targetAddressSpace` fetch option | 142 | `false` |

Sources: `https://raw.githubusercontent.com/mdn/browser-compat-data/main/http/headers/Permissions-Policy.json`,
`https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Request.json`

Firefox does have `loopback-network` in `dom/security/featurepolicy/FeaturePolicyUtils.cpp` with a
default allowlist of `eSelf`, so some plumbing exists even though BCD reports no support.
Source: `https://searchfox.org/mozilla-central/search?q=loopback-network`

---

### What changes the outcome

#### Enterprise policy: `LocalNetworkAccess`

**There is no LNA sub-key under the `Permissions` policy, so there is no per-origin enterprise
allowlist.** The `Permissions` object in `policies-schema.json` has exactly these properties:
`Camera`, `Microphone`, `Autoplay`, `Location`, `Notifications`, `VirtualReality`, `ScreenShare`. Its
own description is "Set permissions associated with camera, microphone, location, notifications,
autoplay, and virtual reality." The affected prefs it lists do not include
`permissions.default.local-network` or `permissions.default.loopback-network`. The Windows ADMX
carries `Camera_*`, `Microphone_*`, `Location_*`, `Notifications_*`, `Autoplay_*`,
`VirtualReality_*` and `ScreenShare_*` families of Allow / Block / BlockNewRequests / Locked, and no
LNA equivalent.
Sources: `https://hg.mozilla.org/mozilla-central/raw-file/tip/browser/components/enterprisepolicies/schemas/policies-schema.json`,
`https://raw.githubusercontent.com/mozilla/policy-templates/master/windows/firefox.admx`,
`https://raw.githubusercontent.com/mozilla/enterprise-admin-reference/main/src/content/docs/reference/policies/Permissions.mdx`

`SkipDomains` is therefore the only per-domain enterprise lever, and it turns the check off rather
than granting a permission.

**The `mozilla/policy-templates` README is now a stub.** It says: "Documentation for policy behavior
and syntax is moving to Firefox Admin Docs ... The new docs repository is public and open to
contributions ... https://github.com/mozilla/enterprise-admin-reference". There is no `main` branch;
the default branch is `master`, and its README no longer carries the old "(Firefox NN, Firefox ESR
NN)" version table. The ADMX and ADML files are still there and current.
Source: `https://raw.githubusercontent.com/mozilla/policy-templates/master/README.md`

Mozilla's administrator reference documents the policy in full.
Sources: `https://firefox-admin-docs.mozilla.org/reference/policies/localnetworkaccess/`,
`https://raw.githubusercontent.com/mozilla/enterprise-admin-reference/main/src/content/docs/reference/policies/LocalNetworkAccess.mdx`

Availability, from `x-compatibility` in `policies-schema.json`: `firefox: 145`, `firefox_esr: 153`,
`firefox_enterprise: 149`. `x-restart-required: true`. Preferences affected: `network.lna.enabled`,
`network.lna.block_trackers`, `network.lna.blocking`, `network.lna.skip-domains`.

**One discrepancy.** The Windows ADMX marks all five LNA policies
`<supportedOn ref="SUPPORTED_FF151_ONLY"/>`, and the ADML defines that as "Firefox 151 or later".
The in-tree schema says 145. Both files are current on `master`. Which is right is **unverified**;
the commit history for the ADMX entry was not fetched. Treat 145 as the earliest possible and 151 as
the version the GPO template vouches for.
Sources: `https://raw.githubusercontent.com/mozilla/policy-templates/master/windows/firefox.admx`,
`https://raw.githubusercontent.com/mozilla/policy-templates/master/windows/en-US/firefox.adml`

The example from that page, verbatim:

```json
{
  "policies": {
    "LocalNetworkAccess": {
      "Enabled": true,
      "BlockTrackers": true,
      "EnablePrompting": true,
      "SkipDomains": ["example.org", "*.example.com"],
      "Locked": true
    }
  }
}
```

The published JSON schema, verbatim:

```json
{
  "type": "object",
  "properties": {
    "Enabled": { "type": "boolean" },
    "BlockTrackers": { "type": "boolean" },
    "EnablePrompting": { "type": "boolean" },
    "SkipDomains": { "type": "array", "items": { "type": "string" } },
    "Locked": { "type": "boolean" }
  }
}
```

The Windows registry shape, verbatim from `LocalNetworkAccess.mdx`:

```
Software\Policies\Mozilla\Firefox\LocalNetworkAccess\Enabled = 0x1 | 0x0
Software\Policies\Mozilla\Firefox\LocalNetworkAccess\BlockTrackers = 0x1 | 0x0
Software\Policies\Mozilla\Firefox\LocalNetworkAccess\EnablePrompting = 0x1 | 0x0
Software\Policies\Mozilla\Firefox\LocalNetworkAccess\SkipDomains\1 = "intranet.company.com"
Software\Policies\Mozilla\Firefox\LocalNetworkAccess\SkipDomains\2 = "*.devices.local"
Software\Policies\Mozilla\Firefox\LocalNetworkAccess\Locked = 0x1 | 0x0
```

The macOS plist uses the same keys, with `SkipDomains` as an `<array>` of `<string>`.

Value semantics, quoted from the same page:

- `Enabled`: "When `true` (default), Firefox enforces local network access security checks. ...
  When `false`, all local network access checks are disabled and websites can freely access local
  network resources."
- `EnablePrompting`: "When `true`, access to local network resources will be explicitly gated via
  user permission prompts."
- `SkipDomains`: "an array of domain names for which local network access checks should be skipped."
- `Locked`: "if set to true, users cannot change any local network access settings set by the policy."
- Note: "`BlockTrackers` and `EnablePrompting` only apply when `Enabled` is explicitly set to `true`,
  and both default to `true` if they are not defined."

**`SkipDomains` accepts both ends of the connection.** Quoted: "the `SkipDomains` array can contain
both **source domains** (the website making the request) and **target domains** (the local resource
being accessed). ... For example, if `"printer.local"` is listed, all websites can access the printer
device." Wildcards: "Suffix wildcard patterns are supported using the `*.` prefix"; "A `*.` prefix
pattern includes the domain itself"; "An entry without the `*.` prefix matches the host only, so
`"microsoft.com"` will not match `login.microsoft.com`."

The implementation matches. `Policies.sys.mjs` maps the keys onto the prefs, joining `SkipDomains`
with commas.
Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/browser/components/enterprisepolicies/Policies.sys.mjs` (lines 2338-2390)

The matcher in `nsIOService::ShouldSkipDomainForLNA` supports a bare `*` that matches everything, a
`*.suffix` pattern that matches the suffix itself and anything ending in `.suffix`, and exact match.
Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/netwerk/base/nsIOService.cpp`

**Both ends really are matched, by two separate call sites.**

1. Target host: `nsHttpTransaction::AllowedToConnectToIpAddressSpace` calls
   `gIOService->ShouldSkipDomainForLNA(mConnInfo->GetOrigin())`, the connection's host.
2. Source host: `LNAPermissionRequest::RequestPermission` calls `mPrincipal->GetAsciiHost(origin)`
   and then `gIOService->ShouldSkipDomainForLNA(origin)`, granting outright on a match.

Sources: `https://hg.mozilla.org/mozilla-central/raw-file/tip/netwerk/protocol/http/nsHttpTransaction.cpp` (lines 4073-4077),
`https://hg.mozilla.org/mozilla-central/raw-file/tip/netwerk/base/LNAPermissionRequest.cpp` (lines 193-204)

Bug 2058449, "network.lna.skip-domains not working as expected", is `UNCONFIRMED`, and bug 2057026,
"Firefox Beta 154: LNA SkipDomains source-domain exemption not applied to SharedWorker loopback
WebSocket", is also `UNCONFIRMED`. Treat `SkipDomains` as usable but not fully reliable.
Source: `https://bugzilla.mozilla.org/rest/bug?id=2058449,2057026`

#### about:config prefs

Any of the prefs in the table above changes the outcome. The blunt ones:
`network.lna.enabled=false` disables the whole feature; `network.lna.blocking=false` stops the
prompting and blocking while leaving the classification and telemetry alive;
`network.lna.skip-domains` allowlists hosts; `network.lna.address_space.public.override` reclassifies
a specific `IP:port` as public so it is never a target.

`browser/components/preferences/config/permissions-data.mjs` exposes `network.lna.blocking` as a
bool in the preferences UI.

#### Remote Settings can grant or deny per origin without a release

`extensions/permissions/RemotePermissionService.sys.mjs` imports default permissions from the
Remote Settings collection `remote-permissions`. Its allowlist of permission types includes both LNA
types with `"*"`, meaning any capability value can be pushed:

```
const ALLOWED_PERMISSION_VALUES = {
  "https-only-load-insecure": [ ... ],
  "loopback-network": ["*"],
  "local-network": ["*"],
};
```
Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/extensions/permissions/RemotePermissionService.sys.mjs`

It runs only when `permissions.manager.remote.enabled` is true. Mozilla can therefore allowlist or
blocklist a named origin for LNA server-side.

#### Secure context

The spec requires a secure context: "The capability to make local network requests is a powerful
feature and must only be allowed from secure contexts." MDN repeats it: "The permissions are
restricted to secure contexts. On non-secure contexts, all requests will fail."
Sources: `https://wicg.github.io/local-network-access/` section 2.4,
`https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Local_network_access`

Firefox does not enforce it on beta or Nightly. `network.lna.block_insecure_contexts` is `false`
there, and the check is skipped:

```
  if (StaticPrefs::network_lna_block_insecure_contexts() &&
      !triggeringPrincipalIsPotentiallyTrustworthy) { ... userPerms = LNAPermission::Denied; }
```
Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/netwerk/protocol/http/nsHttpChannel.cpp` (lines 2124-2135)

It is `true` on release 154. `moz-extension://` is a potentially-trustworthy scheme
(`URI_IS_POTENTIALLY_TRUSTWORTHY` is set on the protocol handler in `netwerk/build/components.conf`),
so an extension page passes this check either way.
Source: `https://searchfox.org/mozilla-central/search?q=moz-extension&path=components.conf`

#### Same-origin, HTTPS and Alt-Svc

`UpdateLocalNetworkAccessPermissions` grants automatically when the triggering principal and the
target are same-origin, the connection was not rerouted by Alt-Svc, and the triggering principal is
potentially trustworthy. Quoted comment: "This exemption (same origin) should apply only to secure
contexts." So an `https://vault.example.internal` page reaching its own origin is exempt. A page on a
different origin is not.
Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/netwerk/protocol/http/nsHttpChannel.cpp` (lines 2061-2087)

An HTTPS target does **not** exempt the request, but it changes the timing.
`network.lna.defer_https_check` (default `true`) defers the check for Private targets until after the
TLS handshake succeeds. Quoted comment: "This avoids prompting the user when DNS transiently
misdirects a public hostname to a private address and the server cannot present a valid certificate.
Local (loopback) addresses and plaintext HTTP requests are unaffected and are still checked
pre-connect."

Two more automatic grants exist. A locked captive portal grants `local-network` outright. Trackers
are denied outright when `network.lna.block_trackers` is on, which it is not by default.

Top-level navigation is exempt while `network.lna.allow_top_level_navigation` is `true`: "top-level
document navigation to local network addresses will bypass LNA permission checks."

Private-to-loopback is exempt while `network.lna.local-network-to-localhost.skip-checks` is `true`.

#### An installed PWA does not change anything

No PWA, app-scope or installed-web-app branch exists in the LNA path. Searched
`nsHttpTransaction.cpp`, `nsHttpChannel.cpp`, `LoadInfo.cpp` and `nsIOService.cpp`. **Unverified as a
positive statement**, but nothing in the fetched code refers to installation state.

---

### Firefox coverage against the spec's request list

MDN's LNA page lists the affected request types: "Subresource requests; `fetch()` requests;
Navigating subframes; Service Workers, including requests made via `WindowClient.navigate()` when the
navigated WindowClient is a subframe; WebSockets; WebTransport; WebRTC".
Source: `https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Local_network_access` (last
modified 2026-08-12)

Firefox does not yet cover all of it. Bug 2042527, "[LNA] Enable LNA Restrictions for Webtransport",
is `NEW`. Bug 1969916, "Local network access restrictions for webrtc", is `NEW`. Both are still open
on 2026-08-20.
Source: `https://bugzilla.mozilla.org/rest/bug?id=1481298` dependency list

Worker enforcement relies on the policy container carrying the parent document's address space
(`Document::InitPolicyContainer` propagates it: "Propagate the document's IP address space to the
policy container so that workers inheriting this container can perform Local Network Access checks
(workers don't have a browsing context to read this from)").
Source: `https://hg.mozilla.org/mozilla-central/raw-file/tip/dom/base/Document.cpp` (lines 3903-3925)

---

### Open bugs that bear on a self-hosted LAN or overlay deployment

All fetched from `https://bugzilla.mozilla.org/rest/bug?id=...` on 2026-08-20.

| Bug | Summary | Status |
| --- | --- | --- |
| 2023758 | Extension pages loaded in iframes trigger LNA check | NEW |
| 2032778 | LNA prompt appears despite extension origin being allowed to, when a navigation elsewhere is triggered (and aborted) | NEW, unassigned |
| 1984359 | Wrong origin of Local Network Access warning from addons running against a self-hosted service (filed against Bitwarden over Tailscale) | RESOLVED WORKSFORME |
| 2041492 | LNA does not remember users answer | NEW |
| 2042332 | Widen the scope of LNA temporary permission | NEW |
| 2030990 | Permission prompt every time the same iframe is embedded | NEW |
| 2033408 | Concurrent requests hang but only the last prompt callback fires | NEW |
| 2058449 | `network.lna.skip-domains` not working as expected | UNCONFIRMED |
| 2057026 | Firefox Beta 154: LNA SkipDomains source-domain exemption not applied to SharedWorker loopback WebSocket | UNCONFIRMED |
| 2061353 | Firefox LNA intermittently terminates automatically allowed XHR POST connections to an HTTPS host | UNCONFIRMED |
| 2050333 | Inconsistent `permissions.query` error | NEW |
| 2042527 | Enable LNA restrictions for WebTransport | NEW |
| 1969916 | Local network access restrictions for WebRTC | NEW |
| 2049121 | OpenSearch engine installation can bypass LNA | NEW |
| 1971290 | [meta] LNA permissions on Android | ASSIGNED |

---

### Summary table

| Question | Firefox answer on 2026-08-20 |
| --- | --- |
| Does LNA exist in current release? | Yes, Firefox 154. Default on for all users since 153. |
| Does LNA exist in ESR? | Not in ESR 140.14.0esr. Yes in ESR-next 153.1.0esr. |
| Master switch | `network.lna.enabled` (true), `network.lna.blocking` (true) |
| Is `100.64.0.0/10` gated? | Yes. `IsIPAddrShared()` returns Private for RFC 6598. |
| Is `.local` special-cased? | No. Firefox classifies the resolved IP address only. |
| Is an extension background page gated? | No, because its browsing context's address space stays `Unknown` and the gate needs `Public` or `Private`. Incidental, not an explicit check, and untested in CI. |
| Do `host_permissions` exempt a request? | No. No LNA code reads extension permissions. |
| Is there a WebExtension LNA permission? | No. |
| Are content scripts gated? | Yes. They inherit the page's browsing context, so a public page's `Public` space applies. |
| Are extension iframes on a public page gated? | Yes, bug 2023758. |
| Grant scope | Per exact host, per principal. Permanent only if the user ticks "Remember my choice for this site". Otherwise temporary, per tab, 24 hours. |
| Prompt timeout | 300000 ms, then auto-deny plus a console warning. |
| JS failure surface, fetch | `TypeError: NetworkError when attempting to fetch resource.` Identical to any network error. |
| JS failure surface, WebSocket | `error` event, then close with code **1006** and `wasClean: false`, plus the generic `connectionFailure` console string. Indistinguishable from a dead port. |
| Shared and service workers | Never prompt. They need an already-stored **persistent** grant, so the default 24-hour temporary grant does not help them. Dedicated workers are unaffected. |
| Iframe `allow` attribute | Enforced. `local-network` and `loopback-network` are policy-controlled features with a default allowlist of `self`. A denied feature cancels the request before any prompt. |
| `navigator.permissions.query` | Works with `local-network` and `loopback-network` when `network.lna.blocking` is true. BCD says unsupported and is wrong. |
| `Permissions-Policy` LNA directives | Not supported. |
| `targetAddressSpace` fetch option | Not supported. |
| Per-origin enterprise allowlist | **None.** The `Permissions` policy has no LNA sub-key. |
| Enterprise escape hatch | `LocalNetworkAccess` policy with `Enabled`, `BlockTrackers`, `EnablePrompting`, `SkipDomains`, `Locked`. Firefox 145 per the schema, 151 per the ADMX. `SkipDomains` is matched against the target host in necko and against the initiator's host in the permission request, and accepts `*.suffix` wildcards. |
| Mozilla-side escape hatch | Remote Settings collection `remote-permissions` can push `local-network` and `loopback-network` grants per origin. |

---

## Local Network Access in embedded webviews, and overlay-network addresses

Produced by a subagent resolving ticket 52
(`planning/greenfield-decision-map/issues/52-extension-local-network-access-facts.md`). This part
covers **embedded webviews** (WebView2, WKWebView, WebKitGTK), **Tauri v2 origins**, and
**overlay-network address facts** only. Browser-tab behaviour in Chrome and Firefox is other parts.

Every source below was retrieved **2026-08-20**. Status: evidence. Facts only; this file makes no
decision and gives no recommendation.

Where a primary source could not be found, the text says **unverified** and names what was searched.

Chrome Stable at retrieval is **152.0.7977.54** (milestone 152). Source:
`https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Windows&num=3`

### The short version

- **WebView2 ships the Chromium LNA code but Microsoft holds it off.** The `LocalNetworkAccessChecks`
  feature is enabled by default in Chromium from milestone 142. In WebView2 it is disabled, and a
  second WebView2-only flag, `msWebViewAllowLocalNetworkAccessChecks`, is "Disabled by default".
  Microsoft published this as a planned breaking change with no enablement date.
- **`CoreWebView2PermissionKind` has no local-network value.** The enum stops at `PersistentStorage`
  (`0xd`) in both the newest release SDK and the newest prerelease SDK. Microsoft says it plans to
  add values later.
- **WebKit has a Local Network Access feature flag, and it is off on every port.**
  `LocalNetworkAccessEnabled` is `status: unstable` with `default: false` for WebKit, WebKitLegacy
  and WebCore. Implementation work is live in WebKit bugzilla through July and August 2026.
- **macOS has a second, separate gate at the app level.** It arrived in macOS 15. Apple states
  plainly that traffic from `WKWebView` does **not** require local network access. Traffic from the
  Rust side of a Tauri app is not covered by that exemption.
- **Linux has no OS-level equivalent that could be found.** WebKitGTK's permission-request class list
  contains no local-network kind.
- **A Tauri v2 page origin is `tauri://localhost` on macOS and Linux, and `http://tauri.localhost`
  (or `https://`) on Windows.**
- **`100.64.0.0/10` is classified `local`, not public**, by the Local Network Access specification, by
  Chromium source and by WebKit source. Tailscale assigns node addresses from that range.

---

### 1. WebView2 on Windows

#### 1.1 The Chromium check is in the code, and on by default upstream

Chromium's network service declares the feature and describes it:

```
// Enables Local Network Access checks.
// Blocks local network requests without user permission to prevent exploitation
// of vulnerable local devices.
//
// Spec: https://wicg.github.io/local-network-access/
BASE_FEATURE(kLocalNetworkAccessChecks, base::FEATURE_ENABLED_BY_DEFAULT);
```

Source: `https://chromium.googlesource.com/chromium/src/+/main/services/network/public/cpp/features.cc`

Companion features in the same file, with the same comment text:

| Feature | Default on `main` |
| --- | --- |
| `LocalNetworkAccessChecks` | enabled |
| `LocalNetworkAccessChecksWarn` (bool param) | `false` |
| `LocalNetworkAccessChecksWebRTC` | disabled |
| `LocalNetworkAccessChecksWebRTCLoopbackOnly` (bool param) | `false` |
| `LocalNetworkAccessChecksWebSockets` | enabled |
| `LocalNetworkAccessChecksWebTransport` | enabled |

Source: `https://chromium.googlesource.com/chromium/src/+/main/services/network/public/cpp/features.cc`

The default flipped at milestone 142. Read per release branch:

| Milestone | Branch | `kLocalNetworkAccessChecks` default |
| --- | --- | --- |
| 137 | 7151 | `FEATURE_DISABLED_BY_DEFAULT` |
| 138 | 7204 | `FEATURE_DISABLED_BY_DEFAULT` |
| 139 | 7258 | `FEATURE_DISABLED_BY_DEFAULT` |
| 140 | 7339 | `FEATURE_DISABLED_BY_DEFAULT` |
| 141 | 7390 | `FEATURE_DISABLED_BY_DEFAULT` |
| 142 | 7444 | `FEATURE_ENABLED_BY_DEFAULT` |
| 143, 144, 145, 146, 148, 150, 152 | 7499 … 7977 | `FEATURE_ENABLED_BY_DEFAULT` |

Sources: `https://chromiumdash.appspot.com/fetch_milestones?mstone=<N>` for the branch number, then
`https://chromium.googlesource.com/chromium/src/+/refs/branch-heads/<branch>/services/network/public/cpp/features.cc`

#### 1.2 Microsoft keeps it off for WebView2

Microsoft's own announcement repository carries a breaking-change notice, opened 2026-02-12 and last
edited 2026-05-08. It is still open. Verbatim:

> Chromium's Local Network Access (LNA) restricts web pages from accessing private/local network
> resources (e.g., localhost, 192.168.x.x, 10.x.x.x) without explicit permission, potentially
> blocking requests or triggering prompts. This change can affect WebView2 apps that depend on local
> network communication.

> **Feature flag name:** `LocalNetworkAccessChecks`, `msWebViewAllowLocalNetworkAccessChecks`

> **WebView2 Timeline:**
> **143-144 (Current): Off (kill switch)** — LNA disabled via ECS kill switch; pre-LNA behavior
> preserved
> **145 (2026-02-12): Off (flag gated)** — Force-allow fallback added via
> `msWebViewAllowLocalNetworkAccessChecks` (disabled by default)
> **Future (TBD): API-controlled** — We plan to extend the CoreWebView2PermissionKind enums with
> additional values to support LNA with the SetPermissionStateAsync. These new values will be
> honored by the WebView.PermissionRequested event, to give apps explicit control over LNA. Target
> release will be shared after the upstream Chromium code base for LNA stabilizes.

> **App Actions:** Code Changes: No action is required at this time, and your existing workflows will
> continue to work as before. LNA is currently disabled for WebView2 apps.

Source: `https://github.com/MicrosoftEdge/WebView2Announcements/issues/126`

The reason Microsoft gives for waiting:

> The LNA specification and implementation are still actively evolving, with a significant number of
> https://issues.chromium.org/issues?q=localnetworkaccess being addressed. Building WebView2 APIs
> against these shifting semantics would risk frequent breaking changes for partners.

Source: `https://github.com/MicrosoftEdge/WebView2Announcements/issues/126`

The WebView2 browser-flags reference, page updated 2026-08-14, lists the flag and repeats that it is
off:

> `msWebViewAllowLocalNetworkAccessChecks` — Enables Local Network Access security checks that
> restrict web content from public origins from accessing local and loopback network resources
> unless explicitly permitted. Disabled by default; must be enabled by the app to configure Local
> Network Access behavior in WebView2. Note: This feature flag will be applicable until the APIs are
> fully onboarded and their adoption reaches a stable state, after which this flag will be
> deprecated.

Source: `https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/webview-features-flags`

The same table still lists the older Private Network Access flag:

> `BlockInsecurePrivateNetworkRequests` — When this feature is enabled, private network requests that
> are initiated from non-secure contexts in the `public` address space are blocked.

Source: `https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/webview-features-flags`

**Announcement dates versus today.** The announcement text says "143-144 (Current)" and was last
edited 2026-05-08. Chromium Stable is 152 at retrieval. No Microsoft document was found that
re-states the status for runtime 146 and later, but the flags reference page (updated 2026-08-14)
still says the flag is disabled by default. Whether Microsoft has since flipped the ECS kill switch
for any runtime is **unverified**; the ECS (Experimentation and Configuration Service) state is not
published.

#### 1.3 How a permission request surfaces, and the permission-kind list

`CoreWebView2PermissionKind`, newest release moniker `webview2-winrt-1.0.4129.50` (page `ms.date`
2026-07-27):

| Name | Value |
| --- | --- |
| `UnknownPermission` | `0x0` |
| `Microphone` | `0x1` |
| `Camera` | `0x2` |
| `Geolocation` | `0x3` |
| `Notifications` | `0x4` |
| `OtherSensors` | `0x5` |
| `ClipboardRead` | `0x6` |
| `MultipleAutomaticDownloads` | `0x7` |
| `FileReadWrite` | `0x8` |
| `Autoplay` | `0x9` |
| `LocalFonts` | `0xa` |
| `MidiSystemExclusiveMessages` | `0xb` |
| `WindowManagement` | `0xc` |
| `PersistentStorage` | `0xd` |

There is no local-network kind. Source:
`https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2permissionkind`

The newest prerelease moniker, `webview2-winrt-1.0.4181-prerelease`, carries the identical table.
Source:
`https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2permissionkind?view=webview2-winrt-1.0.4181-prerelease`

WebView2 does have a default permission UI. The state enum says so:

> `Default` | `0x0` | Specifies that the default browser behavior is used, which normally prompts
> users for decision.

Source:
`https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2permissionstate`

The event args confirm `Default` is what an unhandled request gets:

> **State** — Gets or sets the status of a permission request. For example, whether the request is
> granted. The default value is CoreWebView2PermissionState.Default.

Source:
`https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2permissionrequestedeventargs`

Notifications are documented as the exception that shows no prompt, which implies the other kinds do
show one:

> Apps that would like to show notifications should handle CoreWebView2.PermissionRequested and/or
> CoreWebView2Frame.PermissionRequested events and no browser permission prompt will be shown for
> notification requests.

Source:
`https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2permissionkind`

The event blocks script while the handler runs:

> PermissionRequested is raised when content in a WebView requests permission to access some
> privileged resources. If a deferral is not taken on the event args, the subsequent scripts are
> blocked until the event handler returns. If a deferral is taken, the scripts are blocked until the
> deferral is completed.

Source:
`https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2#permissionrequested`

Upstream Chromium does have the permission plumbing that WebView2 has not yet exposed. The Blink
permission-name enum contains `LOCAL_NETWORK_ACCESS`, `LOCAL_NETWORK` and `LOOPBACK_NETWORK`. Source:
`https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/public/mojom/permissions/permission.mojom`

The browser-side permission machinery uses `RequestType::kLocalNetwork`, which maps to
`ContentSettingsType::LOCAL_NETWORK` and to the settings string `"local_network"`. Source:
`https://chromium.googlesource.com/chromium/src/+/main/components/permissions/request_type.cc`

**Unverified:** what a WebView2 host sees if a Chromium permission request has no matching
`CoreWebView2PermissionKind`. `UnknownPermission` (`0x0`) exists and is documented only as "Indicates
an unknown permission". No Microsoft document states that unmapped Chromium permission types are
raised as `UnknownPermission`, or that they are silently denied. Searched: the WinRT, Win32 and .NET
reference pages for `CoreWebView2PermissionKind`, `CoreWebView2PermissionRequestedEventArgs`,
`CoreWebView2.PermissionRequested`, and the WebView2 concepts documentation. Moot while LNA is off.

#### 1.4 Turning the feature on or off from the app

Two supported switch channels, both documented:

> To test forthcoming features or to diagnose issues, we recommend using browser flags in your local
> device environment, via setting the `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` environment variable or
> via registry keys.

> Elevated apps ignore flags that are set via the local device environment.

> Instead of setting browser flags in your local device environment, an alternative approach is to
> set browser flags programmatically, by passing the browser flags as the `AdditionalBrowserArguments`
> property of `CoreWebView2EnvironmentOptions`. If you set browser flags programmatically, be sure to
> remove the flags in code before shipping your app, to avoid accidentally shipping the flags in
> production.

> Elevated apps honor flags that are set via code.

Source: `https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/webview-features-flags`

Microsoft warns against shipping flags:

> Apps in production shouldn't use WebView2 browser flags, because these flags might be removed or
> altered at any time, and aren't necessarily supported long-term.

> Generally, the flags are owned by both Chromium and Microsoft Edge. Chromium flags are not owned or
> controlled by Microsoft Edge, so Microsoft Edge doesn't have control over when or how the flags are
> removed or altered in their behavior.

Source: `https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/webview-features-flags`

Microsoft's own test recipe, for turning the gate **on**:

> To opt in and identify workflows that may be affected when LNA is eventually enabled, launch with
> the following feature flags: `--enable-features=LocalNetworkAccessChecks,msWebViewAllowLocalNetworkAccessChecks`
> When testing, ensure any cross-origin iframes that need local network access include
> `allow="local-network-access"` in the iframe tag.

Source: `https://github.com/MicrosoftEdge/WebView2Announcements/issues/126`

The feature names to use in a `--disable-features=` list, if the default ever changes, are the
Chromium names in the table in 1.1. The exact string `--disable-features=LocalNetworkAccessChecks`
does not appear in any Microsoft or Chromium document that was found; the feature name does, and
`--enable-features=LocalNetworkAccessChecks` does. Treat the disable form as **unverified in
writing** but mechanically the inverse of a documented switch.

#### 1.5 Runtime version and Chromium milestone

The WebView2 Runtime is evergreen and self-updating:

> In the Evergreen distribution approach, the client's WebView2 Runtime automatically updates to the
> latest version available. However, a user or IT admin might choose to prevent automatic updating of
> the WebView2 Runtime.

Source: `https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/versioning`

The Runtime version is a four-part Edge version. The first part is the Edge major, which is the
Chromium milestone:

> The build number is the third part of the four-part version number for the Webview2 SDK, and of the
> four-part version number for Microsoft Edge and the WebView2 Runtime.

> For example, if an API is introduced in SDK 1.0.**900**.0, that API would work with Runtime
> 94.0.**900+**.0, but not with Runtime 90.0.**700**.0.

> For the client to be able to create a WebView2 instance and use the set of APIs in the WebView2
> General Availability release (SDK build 616), the client must have WebView2 Runtime version
> 86.0.616.0 or higher.

Source: `https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/versioning`

The browser-flags reference uses the same convention, for example "legacy behavior of WebView2
Runtime version 124 and earlier". Source:
`https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/webview-features-flags`

So a WebView2 Runtime numbered `142.0.x.y` or higher contains the Chromium code that has LNA enabled
by default upstream. Microsoft's own note says the WebView2 product layer overrides that.

---

### 2. WKWebView and WebKitGTK: what the engine does

#### 2.1 WebKit has a Local Network Access preference, and it is off everywhere

From WebKit's unified preference definition file, verbatim:

```yaml
LocalNetworkAccessEnabled:
  type: bool
  status: unstable
  category: networking
  humanReadableName: "Local Network Access"
  humanReadableDescription: "Enable Local Network Access"
  webKitLegacyPreferenceKey: WebKitLocalNetworkAccessEnabledPreferenceKey
  defaultValue:
    WebKitLegacy:
      default: false
    WebKit:
      default: false
    WebCore:
      default: false
```

Source: `https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml`

The entry carries no `exposed:` restriction, so it is not limited to the Cocoa ports. Compare
`LockdownFontParserEnabled` in the same file, which does carry `exposed: [ WebKit ]`.

#### 2.2 Implementation status in WebKit bugzilla

Search by title substring "local network access", all statuses:

| Bug | Status | Title | Last changed |
| --- | --- | --- | --- |
| 250607 | NEW | Implement Local Network Access (meta) | 2026-07-21 |
| 250330 | NEW | Local Network Access: Implement the Secure Context Restriction | 2023-01-18 |
| 250339 | NEW | Local Network Access: Apply Secure Context Restriction to private IPv6 address space | 2023-01-18 |
| 295047 | NEW | Enable Local Network Access by default | 2025-06-26 |
| 295048 | RESOLVED FIXED | Create Feature Flag for Local Network Access | 2025-06-26 |
| 295049 | RESOLVED FIXED | Import wpt local-network-access tests | 2025-08-12 |
| 295935 | RESOLVED FIXED | Add Local Network Access IDL files | 2025-07-16 |
| 316157 | RESOLVED FIXED | Crash in FetchRequest::initializeWith() when LocalNetworkAccess is enabled | 2026-06-03 |
| 319906 | RESOLVED FIXED | Classify the real resolved connection IP for Local Network Access on Cocoa | 2026-07-23 |
| 319907 | NEW | Add the Local Network Access check algorithm and a NetworkProcess-resident permission stub | 2026-07-28 |
| 319908 | NEW | Wire the Local Network Access check into NetworkResourceLoader for both final responses and redirects | 2026-07-31 |
| 321725 | NEW | Classify address spaces beyond the ranges in the Local Network Access spec | 2026-08-13 |
| 319050 | NEW | [GTK][WPE] imported/w3c/web-platform-tests/fetch/local-network-access/iframe.tentative.https.window.html fails in Debug | 2026-07-10 |

Source:
`https://bugs.webkit.org/buglist.cgi?ctype=csv&bug_status=__all__&short_desc_type=allwordssubstr&short_desc=local+network+access`
and per-bug metadata from `https://bugs.webkit.org/rest/bug/<id>`

"Enable Local Network Access by default" (295047) is still NEW. The two bugs that would make the
check actually block a request, 319907 and 319908, are still NEW as of 2026-07-31.

Bug 319906 comment, verbatim:

> Adds classifyIPAddressSpace(const IPAddress&) and wires it into NetworkDataTaskCocoa so the
> resolved connection address, not the request URL's host, is what gets classified for Local Network
> Access — the host string is attacker-controlled via DNS rebinding, so the policy decision needs to
> be based on what actually got connected to. Part of the Local Network Access enforcement work (meta
> bug 250607).

Source: `https://bugs.webkit.org/rest/bug/319906/comment`

Note the file name: `NetworkDataTaskCocoa`. The resolved-IP classification landed on the Cocoa ports
first.

#### 2.3 The classification table exists in WebKit source

`Source/WebCore/Modules/fetch/IPAddressSpace.cpp` on `main` classifies the address ranges. It cites
the specification and includes the CGNAT range:

```
// 100.64.0.0/10 - Carrier-Grade NAT - local
...
return IPAddressSpace::Local;
...
// Defined in https://wicg.github.io/local-network-access/#ip-address-space-section
```

Source: `https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/Modules/fetch/IPAddressSpace.cpp`

Bug 321725's pull request body describes the gap it closes:

> determineIPAddressSpace() treated anything outside the spec's table as public, including ranges
> that are not globally-routable unicast, and did not recognise localhost or .local by name. A public
> page could reach those addresses without a permission once Local Network Access is enabled.

Source: `https://github.com/WebKit/WebKit/pull/71581`

That pull request was still open at retrieval, created 2026-08-13.

#### 2.4 Private Network Access, the older name

No WebKit implementation of Private Network Access was found. A bugzilla title search for "private
network access" over all statuses returns only web-platform-test infrastructure bugs (248536, 262088,
247682) and bug 250339, which is itself a Local Network Access bug. Source:
`https://bugs.webkit.org/buglist.cgi?ctype=csv&bug_status=__all__&short_desc_type=allwordssubstr&short_desc=private+network+access`

`WebCore/features.json`, WebKit's own feature-status data file, contains no entry matching "private
network", "local network" or "network access". Source:
`https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/features.json`

#### 2.5 WebKitGTK specifically

The `LocalNetworkAccessEnabled` preference above is in the shared preference file, so it applies to
the GTK and WPE ports too, at `false`. GTK and WPE run the web-platform-tests for the feature; see
bugs 319050 and 248536 in the table above.

WebKitGTK's public API exposes these permission-request types, and no local-network one:

`ClipboardPermissionRequest`, `DeviceInfoPermissionRequest`, `GeolocationPermissionRequest`,
`MediaKeySystemPermissionRequest`, `NotificationPermissionRequest`, `PointerLockPermissionRequest`,
`UserMediaPermissionRequest`, `WebsiteDataAccessPermissionRequest`, `XRPermissionRequest`, plus the
`PermissionRequest` interface and `PermissionStateQuery`.

Source: `https://webkitgtk.org/reference/webkitgtk/stable/` (WebKitGTK 6.0 API index, directory
timestamp 2026-08-19)

---

### 3. The macOS app-level local network gate

This is a different mechanism from the web-platform one. It gates a whole application, not a web
origin. Everything in this section comes from Apple's technote TN3179, "Understanding local network
privacy". Source:
`https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy`

#### 3.1 What it is and where it applies

> Local network privacy puts people in control of which programs can interact with devices on their
> network. The first time a program accesses the local network, the system displays an alert asking
> the user to approve that access. The system records their decision, so future accesses don't
> prompt.

| Platform | Supported | Introduced |
| --- | --- | --- |
| iOS | yes | iOS 14 |
| iPadOS | yes | iPadOS 14 |
| macOS | yes | **macOS 15** |
| tvOS | no | - |
| visionOS | yes | visionOS 1 |
| watchOS | no | - |

> Users configure local network privacy in Settings > Privacy & Security > Local Network (System
> Settings on macOS). The OS adds an app to this list after it attempts to access a local network.

> Device managers aren't able to configure local network privacy using MDM.

The privilege has three states: Undetermined, Allowed, Denied.

#### 3.2 What counts as the local network

> A local network is an IP network associated with a broadcast-capable network interface. Such
> interfaces include Wi-Fi and Ethernet, but not cellular (WWAN) or VPN. A local network address is
> any address on a local network. Traffic to a local network address goes directly; it's not
> forwarded by a router.

> In addition, all multicast addresses (224.0.0.0/4, ff00::/8) and the IPv4 broadcast address
> (255.255.255.255) are local network addresses.

Operations that need the privilege:

| Operation | Required |
| --- | --- |
| Making an outgoing TCP connection | yes |
| Listening for and accepting incoming TCP connections | no |
| Sending a UDP unicast | yes |
| Receiving an incoming UDP unicast | no |
| Resolving a local DNS name (a name ending `.local` or `.local.`, per RFC 6762) | yes |
| Resolving a non-local DNS name with the system resolver | no |
| Any Bonjour operation | yes |

> The system implements these TCP and UDP checks deep in the networking stack, and thus they apply to
> all networking APIs. This includes Network framework, BSD Sockets, URLSession, and any APIs
> implemented on top of those.

#### 3.3 The exemption that matters most here

Apple lists three exceptions. The third is decisive for a Tauri app's webview:

> - If your device's DNS server is on a local network, traffic to it doesn't require local network
>   access.
> - If your device uses a network proxy and that proxy is on a local network, traffic to it doesn't
>   require local network access.
> - **Traffic originating from `WKWebView`, `SFSafariViewController`, and Safari doesn't require
>   local network access.**

So a Tauri v2 window on macOS, which renders in `WKWebView`, does not trip the macOS app gate for
requests the page itself makes. The exemption names the class, not a particular app.

The exemption does **not** name anything else. Requests made by the app's own native code go through
BSD sockets or `URLSession`, both of which Apple names as covered.

#### 3.4 `NSLocalNetworkUsageDescription`

> If your app accesses the local network, add the NSLocalNetworkUsageDescription property to its
> `Info.plist` to explain its behavior to the user.

Availability of the key: iOS 14.0+, iPadOS 14.0+, **macOS 11.0+**, tvOS 14.0+, visionOS 1.0+.
Description:

> A message that tells people why the app is requesting access to the local network.

> Any app that uses the local network, directly or indirectly, should include this description. This
> includes apps that use Bonjour and services implemented with Bonjour, as well as direct unicast or
> multicast connections to local hosts.

Source:
`https://developer.apple.com/documentation/bundleresources/information-property-list/nslocalnetworkusagedescription`

No entitlement is needed on macOS for unicast. The multicast entitlement is iOS-only:

> The multicast entitlement isn't required on macOS.

#### 3.5 macOS specifics

> macOS maintains separate local network privacy state for each user account.

> macOS automatically allows local network access by:
> - Any daemon started by `launchd`
> - Any program running as root
> - Command-line tools run from Terminal or over SSH, including any child processes they spawn

> If you're creating some other type of program, expect the system to block its local network
> operations until the user grants it the Local Network privilege.

> When a process performs a local network operation, macOS tries to track down the responsible code.
> For example, if your app spawns a helper tool and the helper tool performs a local network
> operation, macOS considers the app to be the responsible code.

Identity comes from the code signature:

> Local network privacy tracks the identity of your program using its code signature. This presents a
> challenge on macOS, which allows for unsigned code and ad hoc signed code (Xcode displays this as
> Sign to Run Locally). To ensure that local network privacy reliably tracks the identity of your
> macOS program, sign it with an Apple-issued code-signing identity.

> Local network privacy uses your main executable UUID as part of its implementation. If your main
> executable has no UUID, or shares a UUID with other programs, local network privacy may behave
> weirdly.

A system-wide escape hatch exists from macOS 15.5:

> macOS supports two user defaults (preferences) to configure local network privacy:
> - `AllowedEthernetLocalNetworkAddresses` applies to networks on wired Ethernet interfaces.
> - `AllowedWiFiLocalNetworkAddresses` applies to networks on Wi-Fi interfaces.
>
> Both are in the `com.apple.network.local-network` domain and expect an array of strings, with each
> string denoting an IPv4 or IPv6 network in CIDR format.

> When you add a network to one of these defaults, the system treats every address on that network as
> if it were not a local network address. Every program can access that address, regardless of its
> Local Network privilege state.

Both need `sudo` and a restart. Apple notes they are aimed at site administrators and CI operators.

On macOS there is no way to reset the privilege to Undetermined (FB14944392); Apple suggests a VM
snapshot or a new user account.

#### 3.6 How a denial surfaces

> If the system presents a local network alert in response to one of your local network operations,
> it may deny the operation immediately, before the user has responded to the alert.

> There's no general API that returns whether the current process has local network access
> (FB8711182).

For `NWConnection`:

> If your program doesn't have local network access, the connection enters the waiting state and the
> current path lists an unsatisfied reason of `localNetworkDenied`.

> If the user subsequently changes the Local Network privilege to grant your program local network
> access, the system automatically retries the connection.

> If your program successfully made a TCP connection to a local network address and then the user
> changed the Local Network privilege to deny it local network access, the connection closes.

For Bonjour, the error is `kDNSServiceErr_PolicyDenied` (-65570).

#### 3.7 Loopback

TN3179 never uses the words "loopback", "localhost" or "127.0.0.1". Its definition ties a local
network to a "broadcast-capable network interface", and the exception list does not mention loopback.
So a plain reading is that loopback is out of scope, but Apple does not say so. **Unverified.**
Searched: the whole of TN3179 and the `NSLocalNetworkUsageDescription` reference page.

#### 3.8 Tauri and the `Info.plist` key

Tauri does not add `NSLocalNetworkUsageDescription` to a bundle. A grep of the Tauri `dev` branch for
`NSLocalNetworkUsageDescription` and `NSBonjourServices` across all Rust and JSON files returns
nothing. Tauri offers a merge point instead:

> Path to a Info.plist file to merge with the default Info.plist.
> Note that Tauri also looks for a `Info.plist` file in the same directory as the Tauri configuration
> file.

That is `bundle.macOS.infoPlist` in `tauri.conf.json`. Source:
`https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-utils/src/config.rs` (field `info_plist`
on `MacConfig`)

---

### 4. Linux

No OS-level local-network permission gate was found for Linux. This is an unproven negative. What was
searched, all returning nothing relevant:

- WebKitGTK 6.0 API index for any local-network permission-request class
  (`https://webkitgtk.org/reference/webkitgtk/stable/`); the nine permission-request classes are
  listed in 2.5 above.
- The WebKit preference file for a GTK-or-WPE-specific local-network setting
  (`https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml`).
- WebKit bugzilla title search for "local network access", filtered by the GTK and WPE components;
  only web-platform-test bugs (319050, 248536) came back.

Status: **unverified as an explicit statement, supported by an enumerated API list that contains no
such permission.**

---

### 5. Tauri v2 page origins

#### 5.1 The origin, per platform

Tauri's own code comment:

```rust
/// The `tauri` custom protocol URL we use to serve the embedded assets.
/// Returns `tauri://localhost` or its `wry` workaround URL `http://tauri.localhost`/`https://tauri.localhost`
pub(crate) fn tauri_protocol_url(&self, https: bool) -> Cow<'_, Url> {
  if cfg!(windows) || cfg!(target_os = "android") {
    let scheme = if https { "https" } else { "http" };
    Cow::Owned(Url::parse(&format!("{scheme}://tauri.localhost")).unwrap())
  } else {
    Cow::Owned(Url::parse("tauri://localhost").unwrap())
  }
}
```

Source: `https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/manager/mod.rs`

wry, the webview layer Tauri sits on, documents the same split for any registered custom protocol:

> - macOS, iOS and Linux: `<scheme_name>://<path>` (so it will be `wry://path/to/page`).
> - Windows and Android: `http://<scheme_name>.<path>` by default (so it will be
>   `http://wry.path/to/page`). To use `https` instead of `http`, use
>   `WebViewBuilderExtWindows::with_https_scheme` and `WebViewBuilderExtAndroid::with_https_scheme`.

> **Windows and Android:** if the URL's scheme is a registered custom protocol, the URL is rewritten
> from `{protocol}://localhost/abc` to `{http_or_https}://{protocol}.localhost/abc`

Source: `https://github.com/tauri-apps/wry/blob/dev/src/lib.rs`

The scheme choice on Windows is a config option:

> Sets whether the custom protocols should use `https://<scheme>.localhost` instead of the default
> `http://<scheme>.localhost` on Windows and Android. Defaults to `false`.
>
> ## Note
> Using a `https` scheme will NOT allow mixed content when trying to fetch `http` endpoints and
> therefore will not match the behavior of the `<scheme>://localhost` protocols used on macOS and
> Linux.
>
> ## Warning
> Changing this value between releases will change the IndexedDB, cookies and localstorage location
> and your app will not be able to access the old data.

That is `app.windows[].useHttpsScheme`. Source:
`https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-utils/src/config.rs`

Summary:

| OS | Default page origin | Serving mechanism in wry |
| --- | --- | --- |
| Windows | `http://tauri.localhost` (`https://` with `useHttpsScheme`) | `AddWebResourceRequestedFilter` / `AddWebResourceRequestedFilterWithRequestSourceKinds` on the WebView2 control |
| macOS | `tauri://localhost` | `WKWebViewConfiguration.setURLSchemeHandler(_:forURLScheme:)` |
| Linux | `tauri://localhost` | `WebKitWebContext.register_uri_scheme`, plus `register_uri_scheme_as_secure` on the security manager |

Sources: `https://github.com/tauri-apps/wry/blob/dev/src/webview2/mod.rs`,
`https://github.com/tauri-apps/wry/blob/dev/src/wkwebview/mod.rs`,
`https://github.com/tauri-apps/wry/blob/dev/src/webkitgtk/web_context.rs`

On all three, the page bytes never traverse a network stack. They come from an in-process handler.

#### 5.2 Is that origin public or local, for LNA purposes?

Chromium decides a document's address space from the response that created it. For a URL with no
network response it falls through to a scheme table and then to an embedder hook. The code comment is
explicit about what happens if nothing matches:

```
// Special chrome schemes cannot directly be categorized in
// public/private/loopback address spaces using information from the network or
// the PolicyContainer. We have to classify them manually. In its default state
// an unhandled scheme will have an IPAddressSpace of kUnknown, which is
// equivalent to public.
// This means a couple of things:
// - They cannot embed anything private or loopback without being secure
// contexts
//   and triggering a permission prompt.
// - Local Network Access does not prevent them being embedded by less private
//   content.
```

The hardcoded loopback schemes are `chrome-devtools`, `chrome`, `chrome-untrusted` and, on ChromeOS,
`externalfile`. Anything else goes to `ContentBrowserClient::DetermineAddressSpaceFromURL(url)`.
Source:
`https://chromium.googlesource.com/chromium/src/+/main/content/browser/renderer_host/local_network_access_util.cc`

The base implementation of that hook returns `kUnknown`:

```cpp
ContentBrowserClient::DetermineAddressSpaceFromURL(const GURL& url) {
  return network::mojom::IPAddressSpace::kUnknown;
}
```

Source: `https://chromium.googlesource.com/chromium/src/+/main/content/public/browser/content_browser_client.cc`

And `kUnknown` is treated as public for comparison:

```cpp
// For comparison purposes, we treat kUnknown the same as kPublic.
IPAddressSpace CollapseUnknown(IPAddressSpace space) {
  if (space == IPAddressSpace::kUnknown) {
    return IPAddressSpace::kPublic;
  }
  return space;
}
```

Source: `https://chromium.googlesource.com/chromium/src/+/main/services/network/public/cpp/ip_address_space_util.cc`

Separately, Chromium can read an address space straight off a *request* URL. This helper maps
`.localhost` and `.local` names:

```
// Return the IP address space of the host if we can determine it from the URL,
// otherwise returns std::nullopt.
//
// Cases in which we can determine the IP address space:
//
// * host is an IP address literal
// * host is a .local domain (e.g. RFC6762), or 'local'/'local.'
// * host is 'localhost', 'localhost.' (or a .localhost domain).
```

and its body maps a `localhost` domain to whatever `127.0.0.1` maps to, which is `kLoopback`. Source:
`https://chromium.googlesource.com/chromium/src/+/main/services/network/public/cpp/ip_address_space_util.h`
and
`https://chromium.googlesource.com/chromium/src/+/main/services/network/public/cpp/ip_address_space_util.cc`

That helper is used in `URLLoader` to raise the LNA prompt early, based on the target URL alone:

```
// If the request is to a URL that we can determine is an LNA request from
// just the URL, then trigger the LNA prompt.
```

Source: `https://chromium.googlesource.com/chromium/src/+/main/services/network/url_loader.cc`

**Unverified:** what address space Edge assigns to a WebView2 document served at
`http://tauri.localhost` through `WebResourceRequested`. Two documented mechanisms point in opposite
directions. The `.localhost` host name maps to loopback in `GetAddressSpaceFromUrl`, which is used
for *target* classification. The *client* classification path uses the response's remote endpoint,
and a `WebResourceRequested` response has no real remote endpoint, so it may fall through to
`DetermineAddressSpaceFromURL`, which Edge may or may not override. Edge's `ContentBrowserClient`
subclass is not public. Searched: Chromium `content/`, `services/network/`, the WebView2 reference
documentation, and the WebView2 announcements repository. The point is currently moot because LNA is
off in WebView2 (section 1.2).

For WKWebView and WebKitGTK the question does not arise yet, because the engine feature is off
(section 2.1).

---

### 6. The Tauri HTTP plugin does not use the webview network stack

`@tauri-apps/plugin-http` sends its requests from Rust. The JavaScript module docstring:

> Make HTTP requests with the Rust backend.

Source: `https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/http/guest-js/index.ts`

The Rust crate docstring:

> Access the HTTP client written in Rust.

The crate depends on `reqwest` and re-exports it (`pub use reqwest;`). Its default features are
`rustls-tls`, `http2`, `charset`, `system-proxy`, `cookies`. Sources:
`https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/http/Cargo.toml`,
`https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/http/src/lib.rs`

Requests go through a scope check first:

> This API has a scope configuration that forces you to restrict the URLs that can be accessed using
> glob patterns. […] Trying to execute any API with a URL not configured on the scope results in a
> promise rejection due to denied access.

Source: `https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/http/guest-js/index.ts`

Two consequences follow from facts already cited:

- A request sent this way never enters the WebView2, WKWebView or WebKitGTK network stack, so no
  web-platform LNA check applies to it.
- On macOS 15 and later, nothing exempts it from the app-level gate in section 3. Apple's exemption
  names only `WKWebView`, `SFSafariViewController` and Safari, and Apple says the checks sit "deep in
  the networking stack, and thus they apply to all networking APIs", naming BSD Sockets and
  `URLSession`. That `reqwest` reaches the network through BSD sockets rather than one of the three
  exempt classes is an inference, not a quoted fact; no Apple or Tauri document states it.

---

### 7. `100.64.0.0/10`, Tailscale, and how the address space is classified

#### 7.1 What RFC 6598 says

> This document requests the allocation of an IPv4 /10 address block to be used as Shared Address
> Space to accommodate the needs of Carrier-Grade NAT (CGN) devices. It is anticipated that Service
> Providers will use this Shared Address Space to number the interfaces that connect CGN devices to
> Customer Premises Equipment (CPE).

> Shared Address Space is distinct from RFC 1918 private address space because it is intended for use
> on Service Provider networks. However, it may be used in a manner similar to RFC 1918 private
> address space on routing equipment that is able to do address translation across router interfaces
> when the addresses are identical on two different interfaces.

> Shared Address Space is similar to [RFC1918] private address space in that it is not globally
> routable address space and can be used by multiple pieces of equipment. However, Shared Address
> Space has limitations in its use that the current [RFC1918] private address space does not have. In
> particular, Shared Address Space can only be used in Service Provider networks or on routing
> equipment that is able to do address translation across router interfaces when the addresses are
> identical on two different interfaces.

Section 7, IANA Considerations:

> IANA has recorded the allocation of an IPv4 /10 for use as Shared Address Space.
>
> The Shared Address Space address range is 100.64.0.0/10.

RFC 6598 is BCP 153, April 2012. Source: `https://www.rfc-editor.org/rfc/rfc6598.txt`

#### 7.2 What Tailscale assigns

> Tailscale automatically assigns a unique IP address to each device in your Tailscale network (known
> as a tailnet). This IP address is known as a Tailscale IP address and comes from the shared address
> space defined in RFC6598, known as Carrier-Grade NAT (CGNAT).

> IP addresses from the CGNAT range are special-use IPv4 addresses from the 100.64.0.0/10 subnet
> (100.64.0.0 through 100.127.255.255).

> Tailscale IP addresses aren't exposed to the public internet.

Source: `https://tailscale.com/kb/1015/100.x-addresses` (page "Last validated: Jan 12, 2026")

IPv6:

> Tailscale IPv6 addresses are assigned from the unique local address prefix of `fd7a:115c:a1e0::/48`.

> Previously IPv6 addresses were assigned from `fd7a:115c:a1e0:ab12::/64`.

Source: `https://tailscale.com/docs/concepts/ip-and-dns-addresses` (page "Last validated: Jan 12, 2026")

The reserved-address table:

| Address or range | Purpose |
| --- | --- |
| `100.64.0.0/10` | The CGNAT range Tailscale uses for device IP addresses (100.64.0.0 through 100.127.255.255). |
| `100.100.0.0/24` | Tailscale internal use. |
| `100.100.100.0/24` | Tailscale internal use. |
| `100.100.100.100` | Quad100, a device-local service address. DNS resolver on port 53, device management on port 80. |
| `100.115.92.0/23` | Tailscale internal use. |
| `fd7a:115c:a1e0::/48` | The IPv6 unique local address prefix Tailscale uses for device IPv6 addresses. |
| `fd7a:115c:a1e0::53` | IPv6 equivalent of Quad100. |
| `100.101.102.103` | Reserved for the `tshello` example service. |

Source: `https://tailscale.com/docs/reference/reserved-ip-addresses` (page "Last validated: Jan 12, 2026")

#### 7.3 Names and publicly trusted certificates

> MagicDNS automatically registers DNS names for devices in your network.

> Tailnets created on or after October 20, 2022 have MagicDNS enabled by default.

> Under the hood, MagicDNS generates a fully qualified domain name for every device on your Tailscale
> network (known as a tailnet). The fully qualified domain name is made up of two parts: A machine
> name, which you can change. Your tailnet DNS name.

Source: `https://tailscale.com/docs/features/magicdns` (page "Last validated: Jan 5, 2026")

On certificates:

> To protect a website with an HTTPS URL, you need a TLS certificate from a public Certificate
> Authority (CA).

> Using `tailscale cert` (with `sudo` as needed), Tailscale will automatically request a certificate
> for this machine on this domain, using Let's Encrypt. Tailscale creates a `*.ts.net` DNS TXT record
> for your nodes to complete their DNS-01 challenges.

> Each tailnet has a tailnet DNS name like `tail*NNNN*.ts.net` or `tailnet-*NNNN*.ts.net`, but you can
> also generate and select a randomized tailnet DNS name generated by Tailscale, like
> `yak-bebop.ts.net`.

> You cannot obtain an HTTPS URL to go to a bare hostname, such as `https://machine-name`. If you
> obtain a TLS certificate for a node using MagicDNS, it will be accessible at both
> `https://machine-name.tailNNNN.ts.net`, using HTTPS, and also at `http://machine-name`, without
> HTTPS but using MagicDNS as a DNS nameserver.

> All TLS certificates on the web are recorded in the Certificate Transparency (CT) append-only
> public ledger, which anyone can access to verify the validity of public certificates. Notably, this
> includes the fully qualified domain name of your devices.

> Do not enable the HTTPS feature if any of your machine names contain sensitive information.

Enabling it needs MagicDNS on, plus HTTPS Certificates enabled in the admin console, plus
`tailscale cert` per machine.

Source: `https://tailscale.com/kb/1153/enabling-https`, which redirects to
`https://tailscale.com/docs/how-to/set-up-https-certificates` (page "Last validated: Dec 10, 2025")

So an `https://machine.tailNNNN.ts.net` URL carries a publicly trusted Let's Encrypt certificate.
Under the W3C Secure Contexts specification an origin delivered over authenticated HTTPS is
potentially trustworthy, which makes the page a secure context. Source:
`https://w3c.github.io/webappsec-secure-contexts/`

#### 7.4 Is a `100.64.0.0/10` address public or local, for LNA?

**Local.** Three independent primary sources agree.

**The specification.** The "Non-public IP address blocks" table:

| Address block | Name | Reference | Address space |
| --- | --- | --- | --- |
| `127.0.0.0/8` | IPv4 Loopback | RFC1122 | loopback |
| `10.0.0.0/8` | Private Use | RFC1918 | local |
| **`100.64.0.0/10`** | **Carrier-Grade NAT** | **RFC6598** | **local** |
| `172.16.0.0/12` | Private Use | RFC1918 | local |
| `192.168.0.0/16` | Private Use | RFC1918 | local |
| `198.18.0.0/15` | Benchmarking | RFC2544 | loopback |
| `169.254.0.0/16` | Link Local | RFC3927 | local |
| `::1/128` | IPv6 Loopback | RFC4291 | loopback |
| `fc00::/7` | Unique Local | RFC4193 | local |
| `fe80::/10` | Link-Local Unicast | RFC4291 | local |
| `fec0::/10` | Site-Local Unicast | RFC3513 | local |
| `0.0.0.0/32` | IPv4 null IP address | RFC1884 | loopback |

Source: `https://wicg.github.io/local-network-access/`

Note that `fd7a:115c:a1e0::/48`, Tailscale's IPv6 prefix, falls inside `fc00::/7`, so it is `local`
by the same table.

**Chromium.** The non-public address-space map, verbatim:

```cpp
      // Carrier Grade NAT (RFC 6598): 100.64.0.0/10
      Entry(IPAddress(100, 64, 0, 0), 10, IPAddressSpace::kLocal),
```

in a table that also contains `fc00::/7` as `kLocal`. Anything not in the map falls through to
`kPublic`. Source:
`https://chromium.googlesource.com/chromium/src/+/main/services/network/public/cpp/ip_address_space_util.cc`

**WebKit.** `IPAddressSpace.cpp` carries the same entry:

```
        // 100.64.0.0/10 - Carrier-Grade NAT - local
            return IPAddressSpace::Local;
```

Source: `https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/Modules/fetch/IPAddressSpace.cpp`

A hostname that resolves to a `100.64.0.0/10` address therefore lands in the `local` address space.
Chromium classifies the *connected* address, not the host string; WebKit bug 319906 made the same
change for the Cocoa ports, and gave DNS rebinding as the reason. Sources:
`https://chromium.googlesource.com/chromium/src/+/main/services/network/public/cpp/ip_address_space_util.cc`,
`https://bugs.webkit.org/rest/bug/319906/comment`

Chromium also spells out that `local` and `loopback` are equivalent for LNA comparisons, unlike the
older Private Network Access comparison:

```cpp
// For comparison purposes, we treat kLocal and kLoopback as equivalent
// (kLocal arbitrarily chosen over kLoopback).
```

Source: `https://chromium.googlesource.com/chromium/src/+/main/services/network/public/cpp/ip_address_space_util.cc`

#### 7.5 Apple's rule and an overlay interface

Apple's definition in section 3.2 excludes VPN interfaces from "local network": "Such interfaces
include Wi-Fi and Ethernet, but not cellular (WWAN) or VPN." Tailscale on macOS runs as a network
extension. Whether macOS classifies the Tailscale interface as a VPN for local-network-privacy
purposes is **unverified**. Searched: TN3179 in full, and Tailscale's macOS documentation
(`https://tailscale.com/docs/concepts/macos-variants`,
`https://tailscale.com/docs/concepts/macos-sysext`) via site-restricted search. Neither side states
it.

---

### 8. What could not be verified

| Question | Status | What was searched |
| --- | --- | --- |
| Does an unmapped Chromium permission kind reach a WebView2 host as `UnknownPermission`, or is it denied? | unverified | WinRT, Win32 and .NET WebView2 reference pages for permission kind, permission state, event args, `PermissionRequested`; WebView2 concepts docs |
| Is LNA still off in WebView2 runtimes 146 and later? | partly | Announcement text stops at "143-144 (Current)", edited 2026-05-08; the flags page (updated 2026-08-14) still says "Disabled by default". ECS kill-switch state is not published |
| Is `--disable-features=LocalNetworkAccessChecks` documented? | unverified in writing | The feature name and the `--enable-features=` form are documented; the disable form appears in no Microsoft or Chromium page found |
| What address space does Edge assign to a `WebResourceRequested`-served `http://tauri.localhost` document? | unverified | Chromium `content/`, `services/network/`; WebView2 reference and announcements. Edge's `ContentBrowserClient` subclass is closed source |
| Does Apple's macOS local network gate cover loopback? | unverified | TN3179 in full; the `NSLocalNetworkUsageDescription` page. Neither mentions loopback, localhost or 127.0.0.1 |
| Does macOS treat a Tailscale interface as VPN, and so exempt from the local-network gate? | unverified | TN3179; Tailscale macOS variant and system-extension docs |
| Does Linux have any OS-level local-network permission gate? | unverified negative | WebKitGTK 6.0 API index (nine permission-request classes, none local-network); WebKit preference file; WebKit bugzilla GTK and WPE components |
| Does any primary source state whether a `.ts.net` hostname is treated as public by browser LNA? | not needed | The classification is by resolved IP, not host name, in both Chromium and WebKit. See 7.4 |
