# Ticket 34: Web platform and deployment audit

Independent audit for [ticket 34](issues/34-web-sqlite-opfs-prototype.md), performed 2026-09-08.
This is feasibility evidence, not a production engine or supported-browser decision.
[Ticket 39](issues/39-web-sqlite-deployment-decision.md) still owns deployment selection.

## Available browser evidence

| Platform | Available here | Evidence and limit |
| --- | --- | --- |
| Chromium on Linux | Playwright Chromium 151.0.7922.34 | Dedicated-Worker OPFS write/flush/read and isolation probes pass. This is one current automation build, not all Chrome/Edge versions. |
| Firefox on Linux | Playwright Firefox 153.0, downloaded build 1538 | Same capability and isolation probes pass. No older Firefox, macOS, or mobile Firefox claim. |
| Safari on macOS | No macOS host, `safaridriver`, or hosted-device connector | **Unproved**, including supported minimum versions, sub-workers, private mode, and storage lifetime. |
| Safari on iOS/iPadOS | No Apple device, Xcode/device tooling, or hosted-device connector | **Unproved**. Desktop mobile emulation and generic WebKit would not satisfy this gate. |
| Generic WebKit | Not installed; not used as Safari evidence | Installing it would not close either Apple-device gap. |

The environment is Linux x86_64. Searches found no explicit minimum-version matrix for the Web app in
README, Web package configuration, or getting-started docs. Extension documentation names Chromium
browsers and separately puts Firefox/Safari on its roadmap; that is not a Web support declaration.

## Current upstream constraints

The current [official SQLite persistence documentation](https://sqlite.org/wasm/doc/trunk/persistence.md)
still requires isolation/SAB for `opfs`; its proxy-sub-worker implementation excludes Safari before
17. `opfs-wl` additionally needs `Atomics.waitAsync`. Header-free `opfs-sahpool` cannot transparently
serve simultaneous contexts. Its pause/unpause support, added in 3.50, requires closed SQLite files
and application coordination of both installation and ownership transfer. It does not remove the
multi-tab gate. WAL requires exclusive locking and supplies no browser concurrency benefit. VFSes
can map identical logical names to different physical files; silent fallback would not reopen the
same Replica. Private/guest persistence varies and cannot be inferred from ordinary capability
checks. These facts constrain the prototype; they do not establish Bittery compatibility.

WebKit documents origin storage as best-effort by default, eviction under pressure/inactivity, and
heuristic persistence grants. SQLite files do not escape that policy. See
[WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/).

## Bounded isolation probe

A throwaway Node server pair and actual Chromium/Firefox browsers exercised local loopback origins,
without starting Bittery, changing headers in the repository, or rebuilding its WASM. Source was
`packages/client-runtime/prototype-sqlite-audit/probe.mjs`; the adjacent `results.jsonl` records
the observations. Both are explicitly temporary and removed after the prototype verdict.
Each browser used a fresh ephemeral context and tested the page and dedicated Worker both without
isolation and with `COOP: same-origin` plus `COEP: require-corp`.

Both browsers produced the same results:

| Probe | No isolation | Isolation |
| --- | --- | --- |
| Dedicated-Worker OPFS create/write/flush/read/remove | Pass | Pass |
| `SharedArrayBuffer` in Worker | Unavailable | Available |
| `Atomics.waitAsync` in Worker | Available | Available |
| Cross-origin CORS fetch | HTTP 200 | HTTP 200 |
| Cross-origin image, no opt-in | Loaded | Blocked |
| Cross-origin image with ACAO but no `crossorigin` attribute | Loaded | Blocked |
| Image with CORP cross-origin | Loaded | Loaded |
| Image with CORS request and ACAO | Loaded | Loaded |
| Cross-origin popup retains `window.opener` | Yes | No |

Chromium returned `false` from `storage.persist()`. Firefox's request remained unanswered during the
bounded 1.5-second observation; this proves neither denial nor grant. These ephemeral-context probes
do **not** prove durable restart, browser private-mode policy across versions, SQLite correctness,
quota exhaustion, the exact history corpus, or ticket 32's application scenario. The candidate reports
provide those separate results in the [final feasibility verdict](web-sqlite-prototype-verdict.md).

The observed image and opener behavior agrees with browser-vendor guidance on
[cross-origin isolation](https://developer.chrome.com/blog/enabling-shared-array-buffer/).
`credentialless` is a distinct resource-credential policy, not an assumed interchangeable fix;
its effect on deployed resources would need its own acceptance evidence.

## Repository deployment and flow audit

| Surface | Source evidence | Consequence of adding isolation |
| --- | --- | --- |
| Auth | [sign-in-form.tsx](../../apps/web/src/components/sign-in-form.tsx) calls Runtime SignIn/QuickUnlock; [HTTP executor](../../packages/client-runtime/src/web-http-transport-executor.ts) uses CORS and omits browser credentials. No opener-dependent auth ceremony found. | CORS API access can work; isolated production SignIn/QuickUnlock remains an application acceptance gate, not proved by the generic fetch probe. |
| Share links | [share.$token.tsx](../../apps/web/src/routes/share.$token.tsx) reads its own URL fragment and performs API access/email verification; external Item URLs may open a new window. | Top-level fragment access does not require an opener. Cross-origin opener references are severed; isolated actual recipient verification/decryption and external-link navigation remain unproved. |
| Billing | [billing.tsx](../../apps/web/src/routes/_app/billing.tsx) navigates `window.location.href` to checkout/portal. | No popup/opener protocol found. External redirects and return navigation still need deployment acceptance. No live payment action was performed. |
| Favicons and images | [favicon.ts](../../packages/shared/src/favicon.ts) uses the Account's Server URL; [favicon.tsx](../../packages/ui/src/components/vault/favicon.tsx) renders an image without `crossorigin`. [Server middleware](../../apps/server/src/http/middleware.rs) gives `/favicon/` ACAO, but no CORP. | **Concrete split-origin incompatibility:** ACAO alone does not authorize the existing no-CORS image under `require-corp`, as both browser probes demonstrate. Same-origin proxying avoids this particular cross-origin case. Production CSP already restricts images to self/data/blob; the probe demonstrates an additional isolation requirement, not that arbitrary remote images currently pass production CSP. Uploaded/Account imagery requires equivalent auditing of actual resolved URLs. |
| Iframes/embedding | [nginx.conf](../../apps/web/nginx.conf) has `frame-src 'none'`, `frame-ancestors 'none'`; Caddy and nginx send X-Frame-Options DENY. No Web iframe element found. | Embedding is already rejected by the checked-in production policy. Isolation must not be sold as supporting a newly embedded deployment. |
| Scripts, fonts, Worker/WASM | [nginx.conf](../../apps/web/nginx.conf) allows same-origin scripts/workers/fonts and WASM execution; [Vite](../../apps/web/vite.config.ts) builds the Runtime Worker as a module. | Package SQLite JS/WASM/proxy-worker resources under the permitted origin; a CDN injection is not compatible with the existing policy. Test document and Worker response policies, not only index.html. |
| Development | [Vite](../../apps/web/vite.config.ts) has no isolation headers and exposes localhost plus `bittery.test`. | `opfs` cannot be selected under the current development header configuration. Loopback HTTP is secure-context capable; ordinary non-loopback HTTP is not made secure by COOP/COEP. |
| Docker/Railway | [Docker Caddy](../../deploy/docker/Caddyfile), [Railway Caddy](../../deploy/railway/Caddyfile), and [nginx](../../apps/web/nginx.conf) currently emit no COOP/COEP. Both Caddy shapes proxy API/CDN/favicon paths through the Web origin. | Current deployment is not isolated. Future changes must cover HTML, Worker/sub-worker, assets, and error responses; nginx child `add_header` blocks do not inherit parent headers automatically. |
| Custom/self-hosted edge | [self-hosting overview](../../apps/marketing/src/content/docs/self-hosting/overview.mdx) requires HTTPS; custom proxies and explicit insecure transport modes exist. | HTTPS and both policies must survive the actual edge. Plain non-loopback HTTP cannot satisfy OPFS secure-context requirements. No production hostname, custom proxy, or insecure LAN deployment was exercised. |

## Review disposition

The temporary ticket 32 application wiring exposed a concrete header-coverage failure: the flagged
Vite server's actual `/login` response was HTTP 200 HTML with neither isolation header, despite
`server.headers` being configured. An isolated Vite middleware probe also showed that an early
responder does not inherit that later header handling. The application attempt was stopped before
assigning any failure to SQLite. The corrected, experiment-only middleware sets both headers before
either serving a prototype asset or calling `next()`, so TanStack HTML follows the same policy.
Actual HTML, Runtime Worker, and SQLite proxy-worker response headers must be checked at startup;
configuration presence alone does not prove isolation. This is a deployment prerequisite, not an
authorization to add production headers.

After that correction, the actual flagged application returned HTTP 200 with both expected policies
for `/login`, `/src/lib/runtime.worker.ts`, `/official/sqlite3-opfs-async-proxy.js`, and
`/__prototype-sqlite-inspector.js`. This startup check is distinct from the isolated capability probe;
it establishes response coverage for the temporary application experiment, not production deployment
or a passing ticket 32 scenario.

Do not enable isolation or select SQLite from these capability results. The exact conformance and
application scenario, contention/crash/corruption evidence, and real Safari/macOS+iOS matrix remain
separate gates. The existing closed Replica interface should contain engine mechanics; a tab-leader,
shared Runtime, dynamic VFS fallback, or auth/header workaround is not justified by this audit.
The temporary source and results are captured on local branch
`prototype/ticket34-sqlite-20260908`; production source and headers are restored after capture.
The [final verdict](web-sqlite-prototype-verdict.md) records passing unchanged ticket-32 scenarios in
Chromium and Firefox, plus their limits. No production engine selection follows from this audit.
