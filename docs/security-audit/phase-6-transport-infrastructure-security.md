# Bittery Security Audit — Phase 6: Transport & Infrastructure Security

Date: 2026-03-11
Scope: TLS and transport security, CORS, CSP, HTTP headers, error handling, rate limiting, Docker/self-hosted deployment defaults, logging/monitoring, and dependency/supply-chain posture.

> Note: `apps/server`, `packages/api`, `packages/auth`, and `packages/rate-limit` were removed after the Rust server cutover. Any references to those paths or `/trpc` in this document are historical audit context, not current implementation guidance.

## 1. Summary

Bittery's self-hosted Docker path has a solid baseline in a few important areas: the default installer fronts the app with Caddy on ports 80/443, HSTS is enabled there, CORS is allowlist-based by default, SSE requires a bearer token and enforces a per-user concurrent connection cap, internal services are not exposed to the host by default, lockfiles are committed, and the Docker builders use `pnpm install --ignore-scripts`.

The main weaknesses are at the boundaries where those defaults are bypassed or relaxed:

- The application itself does not enforce HTTPS, and clients still accept non-local `http://` server URLs. If a self-hoster exposes the Bun server directly or points clients/storage at plaintext endpoints, SRP, session tokens, SSE, and encrypted vault traffic can still travel over cleartext transport.
- API hardening is inconsistent. Most sensitive API responses lack `Cache-Control: no-store`, and the Bun/Hono server does not set core hardening headers itself, relying on Caddy/nginx being present in front of it.
- The web CSP is far too permissive for a password manager: it allows `'unsafe-inline'`, `'unsafe-eval'`, broad `http:`/`https:`/`ws:`/`wss:` outbound connections, and Cloudflare third-party script origins.
- Self-hosting hardening is incomplete: runtime containers run as root, optional MinIO ships with a known default password, and direct deployments outside the bundled Docker+Caddy path are not constrained enough.
- Dependency hygiene needs attention. `pnpm audit --audit-level high --json` on March 11, 2026 reported 1 critical and 19 high vulnerabilities in the current dependency tree.

Severity overview for this phase:

- High: 1
- Medium: 6
- Low: 3

## 2. Header Audit Table

| Header | Current value | Recommended value | Status |
| --- | --- | --- | --- |
| `Strict-Transport-Security` | Self-hosted Caddy only: `max-age=31536000; includeSubDomains; preload`; direct Bun API: missing | `max-age>=31536000; includeSubDomains; preload` on every HTTPS entry point | ⚠️ |
| `Content-Security-Policy` | Web only via nginx; currently allows `'unsafe-inline'`, `'unsafe-eval'`, `http:`, `ws:`, and Cloudflare domains; API: missing | Strict CSP with no third-party script origins and no `unsafe-eval`; `connect-src` narrowed to Bittery origins only | ❌ |
| `X-Frame-Options` | Caddy/nginx: `SAMEORIGIN`; direct Bun API: missing | `DENY` or rely on `frame-ancestors 'none'` consistently | ⚠️ |
| `X-Content-Type-Options` | Caddy/nginx: `nosniff`; direct Bun API: missing | `nosniff` everywhere | ⚠️ |
| `Referrer-Policy` | Caddy/nginx: `strict-origin-when-cross-origin`; direct Bun API: missing | `no-referrer` or `strict-origin-when-cross-origin` everywhere | ⚠️ |
| `Permissions-Policy` | Web nginx only; API/Caddy: missing | Disable unnecessary features consistently on all browser-facing responses | ⚠️ |
| `X-XSS-Protection` | Missing | `0` | ❌ |
| `Cache-Control` on sensitive API responses | Missing on `/trpc/*`, `/sync/*`, `/healthz`, `/`; CDN intentionally uses `public, max-age=3600` | `no-store` on auth/session/sync/API responses carrying sensitive data | ❌ |
| `Access-Control-Allow-Origin` | Allowlist from `CORS_ORIGIN`; docker default is `https://${DOMAIN}`; absent on disallowed origins | Explicit validated allowlist only; reject `*` at startup | ⚠️ |
| `Access-Control-Allow-Credentials` | `true` for all CORS-enabled routes | Keep only if strictly needed; never allow wildcard origins when credentials are enabled | ⚠️ |
| `Access-Control-Allow-Methods` | `GET, POST, OPTIONS` | `GET, POST, OPTIONS` | ✅ |
| `Access-Control-Allow-Headers` | `Content-Type, Authorization, X-Client-Id, X-App-Platform` | Keep explicit allowlist | ✅ |
| `Access-Control-Expose-Headers` | `X-Session-Expires` | Keep explicit and minimal | ✅ |
| `X-Session-Expires` | ISO-8601 session expiry on authenticated responses | Keep minimal, authenticated-only exposure | ✅ |
| `Server` | Not explicitly removed; direct Bun responses currently omit it, but Caddy/nginx defaults are not stripped | Remove or normalize at the edge | ⚠️ |

## 3. Findings

### Finding 1: HTTPS is not enforced end-to-end; clients and storage endpoints still permit plaintext transport

**Severity:** Medium

**Location:**
- `apps/server/src/index.ts:117-123`
- `packages/shared/src/server-url.ts:3-25`
- `packages/sync/src/sync-manager.ts:155-183`
- `packages/api/src/storage/s3.ts:36-68`

**Description:**

The default self-hosted Docker stack uses Caddy for TLS termination, but the application itself has no HTTPS redirect or HTTPS-only enforcement. The Bun server binds directly on `0.0.0.0` and will happily serve plaintext HTTP if exposed directly. Client URL normalization also accepts explicit `http://` origins, and the SSE client uses whatever scheme is present in `serverUrl`. Object-storage endpoints are accepted verbatim with no `https://` requirement, so presigned upload/download URLs can also be generated against plaintext storage endpoints.

For a password manager this matters even though SRP resists passive password disclosure: active MITM can still tamper with the login challenge, strip or alter responses, harvest bearer tokens after login, tamper with sync traffic, and observe timing/metadata. The current design is therefore only safe when operators correctly place Bittery behind a TLS-terminating reverse proxy and configure every storage/public URL as HTTPS.

**Attack scenario:**

1. A self-hoster exposes `apps/server` directly on port `3000` or configures a public server URL as `http://vault.example.com`.
2. A user connects with the web, desktop, mobile, or extension client, which accepts the plaintext URL.
3. The client performs `startLogin`, `finishLogin`, session refresh, and `/sync/events` over plaintext HTTP because neither the client nor server rejects it.
4. An active network attacker tampers with responses, harvests session tokens after authentication, or modifies sync/error traffic.
5. If `BITTERY_STORAGE_ENDPOINT` or `BITTERY_STORAGE_PUBLIC_URL` is also configured as HTTP, attachment/image upload and download URLs are likewise downgraded to plaintext transport.

**Recommended fix:**

- Enforce HTTPS in the application for all non-localhost requests.
- Reject non-local `http://` server URLs in shared client URL normalization.
- Reject or warn on non-HTTPS storage/public endpoints unless they are explicitly marked as internal-only.
- Document clearly that direct Bun exposure is unsupported for production.

Example direction:

```ts
// packages/shared/src/server-url.ts
if (parsed.protocol === "http:" && !LOCAL_HOST_PATTERN.test(parsed.host)) {
  return null;
}
```

```ts
// apps/server/src/index.ts
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  const host = c.req.header("Host") ?? url.host;
  const forwardedProto = c.req.header("X-Forwarded-Proto");
  const proto = forwardedProto?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  const isLocal = /^(localhost|127\.|0\.0\.0\.0|\[::1\])(?::|$)/i.test(host);

  if (process.env.NODE_ENV === "production" && !isLocal && proto !== "https") {
    return c.redirect(`https://${host}${url.pathname}${url.search}`, 308);
  }

  await next();
});
```

### Finding 2: Sensitive API responses lack a hardened header baseline and are cacheable by default

**Severity:** Medium

**Location:**
- `apps/server/src/index.ts:26-42`
- `packages/api/src/context.ts:42-60`
- `apps/server/src/cdn.ts:24-37`
- `deploy/docker/Caddyfile:27-33`

**Description:**

The Bun/Hono API sets CORS headers and `X-Session-Expires`, but it does not set `Cache-Control: no-store`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-XSS-Protection: 0`, or clickjacking protection itself. Those protections only appear if the service is deployed behind the provided Caddy/nginx setup, and even there the API path still lacks a complete set. As a result, direct deployments lose most hardening immediately, and even proxied API responses remain cacheable unless an intermediary chooses otherwise.

For a password manager, even encrypted vault data, session metadata, and auth responses should be treated as sensitive and non-cacheable. The current header posture leaves too much to proxy defaults and browser heuristics.

**Attack scenario:**

1. A self-hoster deploys the server directly or places it behind a reverse proxy that does not inject the missing headers.
2. Browsers and intermediary caches receive auth, sync, and vault responses without `Cache-Control: no-store`.
3. Sensitive API responses are retained in browser cache, shared proxies, crash dumps, or “back/forward cache” style state longer than intended.
4. A local attacker, shared-machine user, or misconfigured proxy can recover session-related or encrypted vault responses from cache/history.

**Recommended fix:**

- Add an application-level header middleware for API routes so direct deployments are still safe.
- Set `Cache-Control: no-store` on `/trpc/*`, `/sync/*`, auth/session responses, and any response containing account/vault/session data.
- Keep the CDN path as the only explicitly cacheable path.

Example direction:

```ts
app.use("*", async (c, next) => {
  await next();

  const path = c.req.path;
  const isSensitive =
    path.startsWith("/trpc/") ||
    path.startsWith("/sync/") ||
    path === "/healthz" ||
    path === "/";

  if (isSensitive) {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header(
      "Permissions-Policy",
      "accelerometer=(), autoplay=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    );
    c.header("X-XSS-Protection", "0");
  }
});
```

### Finding 3: The web CSP is too permissive for a password manager

**Severity:** High

**Location:**
- `apps/web/nginx.conf:7-12`
- `apps/web/nginx.conf:25-32`
- `apps/web/nginx.conf:34-46`

**Description:**

The shipped CSP allows:

- `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' 'unsafe-eval' https://static.cloudflareinsights.com`
- `connect-src 'self' https: http: wss: ws: ...`
- `img-src` and `connect-src` to Cloudflare analytics domains

That policy is far weaker than is appropriate for a password manager. `unsafe-inline` and `unsafe-eval` materially reduce CSP's usefulness as an XSS mitigation. Broad `connect-src https: http: wss: ws:` means any XSS or compromised script can exfiltrate to arbitrary origins, which defeats the point of a restrictive CSP. The third-party Cloudflare script origin adds extra supply-chain risk that is hard to justify for a zero-knowledge vault product.

**Attack scenario:**

1. An attacker lands any DOM XSS, framework injection bug, or compromised third-party analytics script in the web app.
2. The current CSP still allows inline/eval-driven script execution paths and outbound requests to arbitrary `http:`/`https:`/`ws:`/`wss:` destinations.
3. The injected code can read decrypted in-browser state, session tokens, or vault metadata and exfiltrate them cross-origin without CSP blocking it.
4. Because the CSP already trusts a third-party script origin, compromise of that third party also becomes a direct execution path inside the vault UI.

**Recommended fix:**

- Remove third-party analytics from the password-manager origin entirely.
- Eliminate `'unsafe-eval'`.
- Eliminate `'unsafe-inline'` by hashing or nonceing the small bootstrap script, or move that script into a static file.
- Narrow `connect-src` to `'self'` and any exact API/SSE origin if different.
- Keep `frame-ancestors 'none'`, `object-src 'none'`, and `form-action 'self'`.

Example baseline:

```nginx
set $csp_policy "default-src 'self'; \
  base-uri 'self'; \
  object-src 'none'; \
  frame-ancestors 'none'; \
  form-action 'self'; \
  script-src 'self'; \
  worker-src 'self'; \
  connect-src 'self'; \
  img-src 'self' data:; \
  style-src 'self' 'unsafe-inline'; \
  font-src 'self' data:; \
  manifest-src 'self'; \
  frame-src 'none';";
```

### Finding 4: Forwarded-header trust and rate limiting remain weak for hostile reverse-proxy environments

**Severity:** Medium

**Location:**
- `packages/api/src/context.ts:14-39`
- `packages/auth/src/index.ts:139-143`
- `packages/auth/src/index.ts:742-786`
- `packages/auth/src/index.ts:984-1024`
- `packages/api/src/routers/auth.ts:262-288`
- `packages/api/src/routers/auth.ts:787-823`
- `packages/api/src/routers/auth.ts:1172-1197`

**Description:**

`TRUST_PROXY_MODE=forwarded` trusts `X-Forwarded-For` and `X-Real-IP` without any source validation. That means the server has no way to distinguish a genuine reverse proxy from an attacker sending spoofed headers directly. Rate limiting also remains uneven: login has per-account plus source-window controls, recovery is keyed by email+IP, refresh is keyed to `sessionId` rather than source IP, and there is no server-wide/global circuit breaker in the application.

This was already a concern in Phase 2, but it remains directly relevant to transport and infrastructure hardening because the server still depends on headers that are only trustworthy when the edge is tightly controlled.

**Attack scenario:**

1. A self-hoster enables `TRUST_PROXY_MODE=forwarded` behind a proxy that does not strip client-supplied forwarding headers, or exposes the server directly.
2. An attacker sends login and recovery traffic while rotating arbitrary `X-Forwarded-For` values.
3. Source-window rate limits key off the attacker-chosen address rather than the real source.
4. The attacker distributes attempts across spoofed headers and avoids meaningful throttling, or churns authenticated refresh traffic because refresh is limited per session instead of per source.
5. Brute force, enumeration, and auth-path DoS become materially easier.

**Recommended fix:**

- Only trust forwarded headers from known reverse proxies or private network hops.
- Add explicit configuration for trusted proxy CIDRs or a mandatory proxy secret/header.
- Add per-source throttles to refresh and SSE connect attempts.
- Consider a simple global circuit breaker for auth routes and SSE handshakes.

Example direction:

```ts
function resolveTrustedSourceIp(context: HonoContext): string | null {
  const remoteAddr = context.env?.incomingRemoteAddress;
  if (!isKnownReverseProxy(remoteAddr)) {
    return null;
  }

  return (
    context.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
    context.req.header("X-Real-IP")?.trim() ||
    null
  );
}
```

### Finding 5: Runtime containers run as root

**Severity:** Medium

**Location:**
- `apps/server/Dockerfile:45-70`
- `apps/web/Dockerfile:51-62`

**Description:**

Neither runtime Docker image sets a non-root `USER`. The Bun server and nginx web container therefore run as root inside the container. If an attacker gains code execution through the app, a vulnerable dependency, or the web server, they start from root inside the container. That increases the impact of container escape bugs, mis-mounted volumes, Docker socket mistakes, or lateral movement into adjacent services.

**Attack scenario:**

1. An attacker exploits an application bug or vulnerable dependency to gain command execution in the container.
2. Because the runtime process is root, the attacker has full control of the container filesystem and any writable mounts.
3. The attacker modifies app code, tampers with mounted secrets, or abuses the elevated position for container breakout techniques.
4. A single app compromise becomes much more damaging than it needs to be.

**Recommended fix:**

- Create an unprivileged runtime user in both images.
- Use `nginxinc/nginx-unprivileged` or equivalent for the web image, or explicitly set `USER nginx`.
- Ensure writable directories are owned by the non-root user before switching.

Example direction:

```dockerfile
FROM oven/bun:1-slim
RUN addgroup --system bittery && adduser --system --ingroup bittery bittery
WORKDIR /app
# copy files and chown as needed
USER bittery
CMD ["bun", "run", "dist/index.mjs"]
```

### Finding 6: Optional MinIO storage uses a known default administrator password

**Severity:** Medium

**Location:**
- `deploy/docker/docker-compose.yml:78-94`

**Description:**

The optional `minio` profile sets `MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD:-minioadmin}`. `minioadmin` is a universally known default. Even though the compose file does not publish MinIO ports to the host by default, this is still a weak out-of-the-box secret for a service that may later be exposed, joined to a wider Docker network, or accessed by a compromised sibling container.

**Attack scenario:**

1. A self-hoster enables the `storage` profile and leaves `MINIO_ROOT_PASSWORD` unset.
2. MinIO starts with `minioadmin`.
3. The operator later publishes MinIO, attaches it to a shared network, or an attacker compromises another container on the same Docker network.
4. The attacker authenticates with the well-known default credential and gains full object-store administration.

**Recommended fix:**

- Make `MINIO_ROOT_PASSWORD` mandatory instead of defaulting it.
- Generate it automatically in the installer when the storage profile is selected.
- Document that storage admin credentials must be high-entropy secrets.

Safer compose pattern:

```yaml
environment:
  - MINIO_ROOT_USER=bittery
  - MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}
```

### Finding 7: The CORS policy is only as strong as `CORS_ORIGIN`, and the application does not validate unsafe values

**Severity:** Low

**Location:**
- `apps/server/src/index.ts:28-42`
- `deploy/docker/docker-compose.yml:24-38`

**Description:**

The current CORS implementation is allowlist-based, which is good, but it trusts `CORS_ORIGIN` verbatim and enables `credentials: true` unconditionally. There is no startup validation preventing unsafe values such as `*`, malformed origins, or overly broad comma-separated lists. On disallowed-origin preflights the server still emits `Access-Control-Allow-Credentials`, `Access-Control-Allow-Methods`, and `Access-Control-Allow-Headers`, which is not a browser break by itself but is a sign the policy is not tightly fail-closed.

The default Docker config sets `CORS_ORIGIN=https://${DOMAIN}`, which is strong. The risk is operator footgun: self-hosters can weaken the policy substantially without the app objecting.

**Attack scenario:**

1. A self-hoster sets `CORS_ORIGIN=*` or adds broad origins while troubleshooting.
2. The server accepts the value and serves CORS headers accordingly.
3. Browser protections are weakened for every API route, and future auth changes such as cookies would become especially dangerous under the same config.
4. The operator believes CORS is still safely restricted because the application did not reject the misconfiguration.

**Recommended fix:**

- Parse and validate every configured origin as a concrete `https://` origin.
- Reject `*` and empty origins in production.
- Consider disabling `credentials` for bearer-token APIs unless there is a concrete browser-cookie use case.

Example direction:

```ts
const origins = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (process.env.NODE_ENV === "production" && origins.some((value) => value === "*")) {
  throw new Error("CORS_ORIGIN must not contain '*'");
}
```

### Finding 8: A public sync health endpoint leaks live usage telemetry

**Severity:** Low

**Location:**
- `apps/server/src/sync/sse-handler.ts:597-601`

**Description:**

`GET /sync/health` is unauthenticated and returns `totalUsers` and `totalConnections`. That exposes live operational telemetry about how many users are currently connected and how many SSE streams are open. This is not catastrophic, but it gives an external observer free insight into service activity patterns, incident spikes, and rough concurrency.

**Attack scenario:**

1. An attacker polls `/sync/health` repeatedly.
2. The attacker records `totalUsers` and `totalConnections` over time.
3. The resulting dataset reveals usage peaks, outage recovery patterns, and maintenance windows.
4. The attacker uses that information to time abuse or infer operational incidents.

**Recommended fix:**

- Restrict the endpoint to localhost/orchestrator probes, or remove the connection counters from the public response.
- Keep public health endpoints minimal: `200 {"status":"ok"}` only.

### Finding 9: Error redaction depends on environment; there is no explicit production-safe error formatter/handler

**Severity:** Low

**Location:**
- `packages/api/src/index.ts:1-24`
- `apps/server/src/index.ts:70-80`

**Description:**

The API does not define a custom tRPC `errorFormatter` or Hono `app.onError` handler. In local testing on March 11, 2026, `/trpc/privateData`, validation failures, and unknown procedures returned full stack traces and absolute filesystem paths. The bundled Docker server sets `NODE_ENV=production`, so production may avoid this through framework defaults, but the application itself does not enforce redaction. Direct Bun/self-host deployments outside Docker therefore remain one configuration mistake away from leaking internals.

**Attack scenario:**

1. A self-hoster starts the server outside the provided Docker image, forgets to set `NODE_ENV=production`, or uses a runtime where the framework default changes.
2. An attacker triggers a validation error, unauthorized access, or unexpected exception.
3. The API response includes stack traces, package paths, and internal function names.
4. The attacker uses that information to map the codebase, dependencies, and reachable handlers for follow-on attacks.

**Recommended fix:**

- Add an explicit tRPC `errorFormatter` that strips stack traces outside test/dev.
- Add a global Hono `app.onError` that returns a generic `500` body while logging details server-side.
- Keep detailed error context in structured logs only.

Example direction:

```ts
export const t = initTRPC.context<Context>().create({
  errorFormatter({ shape }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        stack: process.env.NODE_ENV === "development" ? shape.data.stack : undefined,
      },
    };
  },
});

app.onError((err, c) => {
  console.error("Unhandled server error", err);
  return c.json({ error: "Internal Server Error" }, 500);
});
```

### Finding 10: Dependency audit shows unresolved high/critical advisories in the current tree

**Severity:** Medium

**Location:**
- `apps/server/package.json:12-26`
- `packages/api/package.json:29-41`
- `pnpm-lock.yaml`
- `package.json:12-57`

**Description:**

`pnpm audit --audit-level high --json` on March 11, 2026 reported:

- 1 critical vulnerability
- 19 high vulnerabilities
- 9 moderate vulnerabilities
- 2 low vulnerabilities
- 1781 total dependencies in the resolved tree

The most important entries for Bittery's transport/infrastructure surface were:

- `fast-xml-parser` via `@aws-sdk/client-s3 -> @aws-sdk/core -> @aws-sdk/xml-builder`, including one critical advisory (`GHSA-m7jm-9gc2-mpf2`) and multiple high advisories.
- Multiple `hono` advisories while the server depends on Hono and uses `streamSSE()`. Not every advisory is necessarily reachable in Bittery's current code, but the server is behind the current patched line.
- Several `tar`, `rollup`, and `minimatch` advisories in the mobile/extension build tree.

Some of these are development/build-path issues rather than direct production exploits, and some Hono advisories appear non-reachable in Bittery's current usage. They still represent stale security debt in a security-critical product.

**Attack scenario:**

1. A publicly disclosed framework or transitive dependency bug becomes easier to weaponize once exploit conditions are understood.
2. Operators assume the dependency tree is current because the application itself is new.
3. A reachable advisory in Hono, AWS SDK transitive code, or build/update tooling gets used against production, CI, or a developer workstation.
4. The team must respond under time pressure instead of from a clean patch baseline.

**Recommended fix:**

- Upgrade Hono to the latest patched minor immediately.
- Upgrade the AWS SDK chain until the `fast-xml-parser` advisories clear.
- Re-run `pnpm audit --audit-level high` after each upgrade and document reachability for anything that remains.
- Add dependency review as a release gate for server/web images.

## 4. Positive Findings

- The default self-hosted installer puts Bittery behind Caddy on ports `80/443`, generates fresh `JWT_SECRET` and `DB_PASSWORD` values, and clearly assumes HTTPS at the edge.
  - `deploy/install.sh:131-159`
  - `deploy/install.sh:211-215`

- The self-hosted Caddy config enables HSTS with a one-year max-age, `includeSubDomains`, and `preload`.
  - `deploy/docker/Caddyfile:27-33`

- The default Docker CORS origin is a concrete allowlisted origin, `https://${DOMAIN}`, not a wildcard.
  - `deploy/docker/docker-compose.yml:24-38`

- Browser CORS handling is explicit rather than reflective: `Access-Control-Allow-Origin` comes from configured origins and is not blindly copied from the request `Origin`.
  - `apps/server/src/index.ts:28-42`

- The browser extension does not need special permissive server-side CORS handling because it relies on `host_permissions` and background fetches instead of ordinary page-origin CORS.
  - `apps/extension/manifest.config.js:8-18`
  - `apps/extension/manifest.config.js:58-60`

- The extension CSP is reasonably tight for extension pages: only `script-src 'self' 'wasm-unsafe-eval'` and `object-src 'self'`.
  - `apps/extension/manifest.config.js:58-60`

- SSE connections are authenticated with bearer tokens and capped at 10 concurrent connections per user.
  - `packages/sync/src/sync-manager.ts:155-183`
  - `apps/server/src/sync/sse-handler.ts:157-158`

- The default Docker compose file does not publish PostgreSQL, MinIO, or Valkey ports to the host, which is the correct secure default.
  - `deploy/docker/docker-compose.yml:60-107`

- The Docker builders use `pnpm install --frozen-lockfile --ignore-scripts`, which materially reduces install-time script risk during image builds.
  - `apps/server/Dockerfile:34`
  - `apps/web/Dockerfile:33`

- Deterministic lockfiles are present for both JavaScript and Rust dependency trees.
  - `pnpm-lock.yaml`
  - `packages/crypto/core/Cargo.lock`
  - `packages/crypto/napi/Cargo.lock`
  - `apps/desktop/src-tauri/Cargo.lock`

## 5. Open Questions

- The Railway one-click production template is not present in this repository. I could verify only the Docker/Caddy self-hosted path and the Dockerfiles' Railway-oriented build args. Railway-specific TLS policy, header behavior, and rate-limit defaults still need direct review.
- Production error redaction was not validated against a real `NODE_ENV=production` deployment response. Local dev responses did expose stacks and absolute paths.
- TLS minimum version, ciphers, and certificate-policy pinning are not explicitly configured in the repo. For the Docker path this is delegated to Caddy defaults; for any other reverse proxy, the repo does not define the policy.
- It is unclear whether allowing non-local `http://` server URLs is intentional for any supported production scenario, or only a development convenience that should now be removed.
- If Cloudflare Web Analytics is intentionally retained on the vault origin, the threat model should explicitly justify that third-party script exception.

## 6. Cross-References

- **Phase 2, Finding 5**: The forwarded-header trust problem identified there is still relevant here. Phase 6 confirms `TRUST_PROXY_MODE=forwarded` still trusts client-supplied forwarding headers without source validation.
  - `docs/security-audit/phase-2-authentication-session-security.md`

- **Phase 2, Finding 1**: The SRP server-secret exposure was previously the major authentication break. That issue appears remediated, but Phase 6 shows the transport layer still needs strict HTTPS enforcement because SRP alone does not protect against active MITM.
  - `docs/security-audit/phase-2-authentication-session-security.md`

- **Phase 4, Finding 3**: The previous SSE revocation-race issue appears remediated. In this phase, the remaining SSE concern is operational telemetry leakage from `/sync/health`, not cross-vault data fan-out.
  - `docs/security-audit/phase-4-data-isolation-multi-tenancy.md`

- **Phase 5 Summary**: Phase 5 already noted that the SSE endpoint now authenticates bearer tokens, derives membership server-side, and caps concurrent connections. Phase 6 confirms those are meaningful positive transport controls and shifts focus to TLS, headers, and deployment hardening around that channel.
  - `docs/security-audit/phase-5-input-validation-injection.md`
