# Extension Local Network Access and private-address classification

Type: research
Status: ready-for-human
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
