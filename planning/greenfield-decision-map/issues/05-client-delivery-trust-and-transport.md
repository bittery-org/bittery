# Client delivery trust and transport requirements

Type: grilling
Status: resolved
Blocked by: 04

## Question

`HOST-003` has the Server ship the Web client, so for that client `ADMIN-001`'s "cannot decrypt" is false by construction: the operator ships the code that touches the master password. `ACCOUNT-001` widens it, since that page may hold keys for other Servers. No requirement in the corpus mandates TLS or a secure context, and `HOST-001` makes LAN-only `http://` deployments first-class, which withholds `crypto.subtle`, OPFS, and WebAuthn. See [corpus review, Critical #2](../research/corpus-review.md) and [browser storage durability facts](01-browser-storage-durability-facts.md).

Decide:

- Whether an authenticated transport is a `MUST` precondition for the Web client, and what an operator on a LAN is told to do instead of plain `http://`.
- Whether the Web client's weaker guarantee is stated in requirements and surfaced in the UI, in the same honest register as `TRAVEL-001` and `AUTH-008`.
- Whether a Web client served by Server A may hold Accounts from Server B, or whether multi-Server is restricted to installed clients.
- Whether subresource integrity, a pinned build hash, or any code-transparency mechanism is in scope, or explicitly ruled out.
- CSP and HSTS as requirements. The frozen server sets neither, and the desktop webview sets `csp: null`.

Produces: `HOST-*` and `PRIVACY-*` requirement changes, and a decision on `ACCOUNT-001`'s scope.

## Answer

Promoted to `HOST-007` through `HOST-009`, `PRIVACY-015` and `PRIVACY-016`, amendments to
`PRIVACY-004`, `PRIVACY-005`, `PRIVACY-012`, `ADMIN-001`, `ACCOUNT-001` and `ACCOUNT-003`, two new
`ARCH-HOST-*` requirements, two ADRs, and three glossary terms.

**A secure context is a `MUST`, and the operator supplies the certificate.** `HOST-007` has a Server
refuse to serve the Web client over a non-secure origin. The corpus review was right that this was
unstated, and ticket 01 showed the cost of leaving it so: a non-secure origin withholds
`crypto.subtle`, OPFS, Service Workers, the Cache API and `StorageManager.persist()`, and only
`localhost` and `127.0.0.0/8` escape, never RFC 1918 addresses or `*.local` names. `HOST-008` rules
out shipping any certificate authority or certificate tooling, because self-hosting has to stay easy
and distributing a private certificate authority is not easy. Documentation carries four routes
instead, with a private overlay network the recommended one for a LAN: it gives a real name and a
publicly-trusted certificate with nothing to install.

**No HSTS.** `HOST-007` already makes the client refuse a non-secure origin, which is stronger; the
header would only cover the first typed `http://` navigation. Set against that, a browser arms the
header only over a validating certificate, so an operator who later moves to a distrusted certificate
locks every user out for the header's lifetime with the warning bypass deliberately removed. With
certificate management entirely in operator hands under `HOST-008`, that trade is not worth taking.
Recorded in [ADR 0004](../../../docs/adr/0004-the-web-client-requires-a-secure-context-and-the-operator-supplies-the-certificate.md).

**The Web client is bound to the Server that served it.** `ACCOUNT-001` now restricts multi-Server to
installed clients, defined as released, signed Desktop and Extension builds. A page served by Server A
must never hold Server B's Vault keys, and a warning would not undo that. All Accounts, cross-Server
Collections and cross-Server copy become installed-client features, which is a real product cost on
the Web surface and is stated rather than hidden. Two simplifications follow and both are
load-bearing: no Server ever sends CORS headers and no deployment configures an origin allowlist
(`ARCH-HOST-002`), and `HOST-009` can pin `connect-src` to `'self'`.
[ADR 0005](../../../docs/adr/0005-the-web-client-is-bound-to-the-server-that-served-it.md).

**A project-operated Web client origin was considered and rejected.** It solves the cross-operator
problem by moving trust to one party, but it makes the project an operator with more reach than any
Server operator has, contradicts `PROD-FOUNDATION-001` and `HOST-006`, breaks air-gapped deployment,
collides with the Local Network Access permission prompt Chrome 142+ and Firefox 149+ now show before
a public origin reaches a private address, and turns a lapsed domain into a mass-compromise event.
Recorded under Considered options in ADR 0005 so it is not re-proposed.

**The weaker guarantee is stated in requirements and documentation only.** `PRIVACY-015` names it as
per-load trust in the serving operator, and amends `ADMIN-001` so its Prevented verbs describe
installed clients while the same operator attack on the Web client is Acknowledged. Consistent with
ticket 04's disclosure ruling, no in-app screen and no signup interstitial carries it.

**SRI is useless here and was not adopted.** Subresource integrity hashes live inside `index.html`,
which the operator also serves, so an operator rewrites them along with the bundle. It defends against
a compromised third-party CDN, which a self-hosted product does not have. `PRIVACY-016` uses the
mechanism that does work: each release publishes its Web bundle's content hash beside the
`PRIVACY-012` signatures, a Server serves the byte-exact published bundle for the version it declares,
and exposes the served hash at a documented well-known path. A fleet-wide substitution is Detectable
by any third party; a substitution targeted at one User stays Acknowledged. `PRIVACY-004` and
`PRIVACY-005` were amended to carry both, and each now names five attacks rather than four.

**CSP is normative and exact, and it binds the Desktop webview too.** `HOST-009` fixes the policy
string rather than the principles, because the corpus review's standing complaint is untestable
predicates. `'wasm-unsafe-eval'` is mandatory: without it a browser blocks WebAssembly outright and
the Rust engine cannot instantiate. `ARCH-HOST-001` extends the same policy to the Desktop webview,
making the frozen tree's `csp: null` a defect, and has Extension pages declare
`script-src 'self' 'wasm-unsafe-eval'`, which is the strictest policy Chromium and Firefox permit for
MV3 and the minimum the engine runs under.

Notes appended to tickets 16, 23, 25, 36, 37, 40, 41, 42 and 48.

### Verified facts this session

- Chrome 142 and later, and Firefox from 149 (strict mode) rolling out generally from 151, require a
  user permission prompt before a public origin reaches an RFC 1918 address, a loopback address, or a
  `.local` name. Firefox 154 extended it to WebSockets on 2026-08-17. Denial fails the request.
  Sources: `https://developer.chrome.com/blog/local-network-access`,
  `https://github.com/WICG/local-network-access/blob/main/explainer.md`,
  `https://support.mozilla.org/en-US/kb/control-personal-device-local-network-permissions-firefox`.
- Whether `100.64.0.0/10` (carrier-grade NAT, used by overlay networks) is inside that private space
  is **unresolved**: the older Private Network Access specification lists it, the Local Network Access
  explainer Chrome ships names only RFC 1918, RFC 4193 and `.local`. It does not affect this ticket,
  because the Web client is now same-origin with its Server, but it affects ticket 41.
- WebAssembly is blocked under any CSP unless `script-src` carries `'wasm-unsafe-eval'`.
  `'unsafe-eval'` also permits it and overrides the narrower keyword. Source:
  `https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src`.
- Chromium and Firefox both cap MV3 `content_security_policy.extension_pages` `script-src` and
  `worker-src` at `'none'`, `'self'` and `'wasm-unsafe-eval'`, and impose
  `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` as the floor. Source:
  `https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy`.
