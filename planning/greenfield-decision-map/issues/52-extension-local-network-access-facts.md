# Extension Local Network Access and private-address classification

Type: research
Status: resolved
Blocked by: —

## Question

Chrome 142 and later, and Firefox from 149 (strict mode) rolling out generally from 151, require a
user permission prompt before a page on a public origin reaches an RFC 1918 address, a loopback
address, or a `.local` hostname. Firefox 154 extended the gate to WebSocket connections on
2026-08-17. If the user denies or dismisses, the request fails.

`HOST-001` makes LAN-only and private-overlay deployment first-class, so an Extension that cannot
reach a LAN Server without a permission prompt is a product problem, not a detail.

Establish, against primary sources:

- Whether an MV3 extension background context (service worker on Chromium, event page on Firefox) is
  subject to the Local Network Access gate at all, and whether a host permission in the manifest
  exempts it.
- Whether `100.64.0.0/10` (carrier-grade NAT, the range overlay networks use) is inside the gated
  private address space. The older Private Network Access specification lists it; the Local Network
  Access explainer Chromium ships names only RFC 1918, RFC 4193 and `.local`.
- Whether a granted permission is persistent per origin or per session, and what a denial looks like
  to the calling code.
- Whether an HTTPS target, an installed PWA, or an enterprise policy changes any of the above.
- The same questions for the Desktop client's webview, which is not a browser tab.

Produces: facts ticket 41 needs before it decides how the Extension reaches a LAN Server, and a check
on whether `HOST-008`'s recommended overlay route is prompt-free in practice.

## Answer

Findings: [`research/extension-local-network-access.md`](../research/extension-local-network-access.md),
3,487 lines across three engine families, every claim carrying a fetched URL and a 2026-08-20
retrieval date.

**The Extension reaches a LAN Server without a prompt on both engines today, and on neither engine is
that guaranteed.** The exemption is a mechanism, not a promise, and it has already broken once in
shipping Chrome. Ticket 41 owns what to do about that.

- **Chromium exempts extensions deliberately but informally.** Every `chrome-extension://` URL is
  mapped to the **loopback** address space, and the gate fires only on a move to a *less public*
  space, so the check is never reached. Chrome's Local Network Access Adoption Guide states: "We do
  not currently have plans to apply LNA restrictions to extensions." The exemption is one line in
  `ChromeContentBrowserClient::DetermineAddressSpaceFromURL`. It failed twice already: extension
  service workers were classed public in Chrome 138 and 139 (crbug 435246545, fixed in M140), and a
  worker registered before that fix stayed broken until M142 or M143 (crbug 456078996).
- **Firefox exempts extensions by accident.** The gate fires only when the initiator's address space
  is `Public` or `Private`. That value is set in exactly two places, both in `nsHttpChannel`, from a
  document load's peer address. A `moz-extension://` document never passes through `nsHttpChannel`,
  so it stays `Unknown` forever. The specification says it should initialise to *public*, so Firefox
  diverges, and **no test in mozilla-central covers a `moz-extension://` initiator.** Bug 2032778
  records a Mozilla engineer saying the fix "would be to actually check request is coming from
  extension and exempt them", which confirms no such check exists. Bug 1984359 is a
  Bitwarden-over-Tailscale report, still open, with that necko fix unwritten.
- **Content scripts are gated on both engines.** They inherit the host page's client security state,
  so a content script on a public page is gated exactly like the page. Source-derived on Chromium,
  stated by a Mozilla engineer on Bugzilla for Firefox, and documented by neither vendor. Autofill
  runs in content scripts, so any content script that talks to the Server directly is exposed. A
  background context that owns all network I/O is not.
- **`host_permissions` is not an exemption, and no local-network extension permission exists** on
  either engine. Host permissions decide whether the request is attempted; they play no part in the
  address-space check.
- **`100.64.0.0/10` is classified `local`, contradicting this ticket's premise.** Confirmed in the
  WICG specification table, in Chromium's `ip_address_space_util.cc` with a dedicated unit test, in
  Firefox's `NetAddr::IsIPAddrShared()` with a gtest, and in WebKit's `IPAddressSpace.cpp`.
  Tailscale's `fd7a:115c:a1e0::/48` sits inside `fc00::/7`, also local. Classification uses the
  resolved connection IP, never the host string, so a `*.ts.net` MagicDNS name and a publicly-trusted
  Tailscale certificate buy nothing against this gate. They still buy the secure context `HOST-007`
  requires, which is why `HOST-008` recommends the overlay route.
- **`HOST-008`'s overlay route is prompt-free, and so is every other `HOST-001` shape**, for both the
  Extension and the Web client. This follows from the cited rule rather than from a vendor statement.
  The Web client is served by the Server itself, so its own page inherits that Server's address space,
  and a request back to the same Server is never a move to a less public space. `connect-src 'self'`
  means it makes no other kind.
- **`.local` gets no special handling in Firefox at all.** Firefox classifies the resolved IP only.
- **A denial is invisible to calling code.** `fetch` rejects with a bare `TypeError` on both engines;
  a WebSocket gives close code 1006 with `wasClean: false`, indistinguishable from a dead port. The
  only in-page discriminator is `navigator.permissions.query({name: "local-network"})`, which does
  work on both engines. MDN browser compatibility data says Firefox lacks it and is wrong.
- **Grant lifetime differs sharply.** Chromium persists a per-top-level-origin grant, with no "allow
  once" and a 7-day embargo after three dismissals. Firefox defaults to **24 hours and per-tab**;
  only "Remember my choice for this site" makes it permanent. Firefox shared and service workers
  never prompt and need an already-stored *persistent* grant, so the temporary grant does not satisfy
  them.
- **The Desktop webview is not gated today, and its origin is the latent risk.** Microsoft holds the
  feature off for WebView2 and has published a breaking-change notice
  (`MicrosoftEdge/WebView2Announcements#126`, open). `CoreWebView2PermissionKind` has no local-network
  value, so a WebView2 host cannot yet answer the prompt through `PermissionRequested` even if it
  wanted to. WebKit has the flag at `status: unstable` and `default: false`, with the check algorithm
  itself unlanded, so WKWebView and WebKitGTK do not gate. The risk: Tauri serves the page from
  `tauri://localhost` or `http://tauri.localhost`, and Chromium's documented rule is that an unhandled
  scheme gets `kUnknown`, "which is equivalent to public". If WebView2 turns the feature on before
  adding a permission kind, the Desktop client is a public origin reaching a LAN Server with no way to
  answer. Tauri's `plugin-http` routes through Rust `reqwest` and bypasses the webview network stack
  entirely, which is one available escape.
- **The macOS app-level local network prompt does not apply.** Apple's TN3179 states that traffic
  from `WKWebView` does not require local network access, so a Tauri window on macOS 15 or later does
  not trip it. That gate is defined by broadcast-capable interface and explicitly excludes VPN
  traffic, so an overlay network does not trip it either. Linux has no OS-level gate.
- **Firefox ESR 140 has no gate at all**; ESR-next 153 has it. Relevant when the support matrix in
  Not-yet-specified is drawn.

**Two claims in this ticket's own question were wrong.** Firefox shipped Local Network Access
user-visible in **147**, not 149, and it became default-on for everyone in **153**, not 151. The
WebSocket extension in 154 is correct; its release date is 2026-08-18. Chromium enabled the feature
by default at **M142**, which the question stated correctly.

This ticket surfaced facts and decided nothing. Ticket 41 owns the Extension consequence, in
particular whether content scripts may ever hold a Server connection and how the product behaves if
either engine withdraws its exemption. Ticket 42 owns the Tauri origin question.
