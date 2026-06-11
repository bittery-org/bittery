# Deploy and Host bittery on Railway

**Bittery** is a source-available, zero-knowledge password manager. Passwords, notes, cards, and TOTP secrets are encrypted on your device before they reach the server—so plaintext vault data never leaves client devices. It supports web, desktop, mobile, and browser extension clients, with optional self-hosting or Bittery Cloud.

## About Hosting bittery

Hosting Bittery means running a **Caddy reverse proxy**, a **Rust API server**, and a **web vault** (static SPA behind nginx), backed by **PostgreSQL**. Railway terminates TLS at the edge; Caddy listens on `$PORT` and routes API traffic (`/rpc`, `/sync`, `/cdn`, etc.) to the server and everything else to the web app over **private networking** (`server.railway.internal`, `web.railway.internal`). The server handles authentication (SRP), encrypted vault sync, teams, and share links; it does not decrypt user data. Database migrations run automatically on server startup. The Railway template pre-wires `DATABASE_URL`, object-storage bucket variables, and Caddy upstream reference variables—only **caddy** needs a public domain. **Redis/Valkey** is optional for cross-instance SSE sync and distributed rate limiting. Official images: `ghcr.io/bittery-org/bittery-server:latest`, `ghcr.io/bittery-org/bittery-web:latest`, and a custom Caddy build from [`deploy/railway`](https://github.com/bittery-org/bittery/tree/main/deploy/railway).

## Common Use Cases

- **Personal or family vault** — Run your own password manager without relying on a third-party cloud.
- **Team or org data sovereignty** — Keep encrypted vault metadata and auth on infrastructure you control, with vault sharing and share links in self-hosted mode.
- **Quick self-hosted trial** — One-click Railway deploy with managed Postgres and storage instead of setting up Docker Compose on a VPS.

## Dependencies for bittery Hosting

- **PostgreSQL 15+** (required) — Primary datastore for users, sessions, and encrypted vault blobs. Provisioned and linked by the template.
- **Caddy** (required) — Public entry point. Proxies to server/web over Railway private networking (`*.railway.internal`). Railway handles HTTPS at the edge.
- **bittery-server** — Rust/Axum API (`PORT` defaults to `3000`, health check at `/healthz`).
- **bittery-web** — Vite-built SPA served on port `8080` (health check at `/nginx-health`).
- **Object storage** (included in template) — S3-compatible bucket for file attachments; credentials are pre-filled by the template.

### Deployment Dependencies

- [Bittery GitHub repository](https://github.com/bittery-org/bittery)
- [Railway Caddyfile](https://github.com/bittery-org/bittery/blob/main/deploy/railway/Caddyfile)
- [Railway private networking](https://docs.railway.com/networking/private-networking)
- [Self-hosting overview](https://bittery.com/docs/self-hosting/overview)
- [Configuration reference](https://bittery.com/docs/self-hosting/configuration)
- [Railway Quick Start (Bittery docs)](https://bittery.com/docs/self-hosting/railway)
- [Railway PostgreSQL](https://docs.railway.com/databases/postgresql)
- [Caddy environment variable docs](https://caddyserver.com/docs/conventions#environment-variables)
- Container images: [`ghcr.io/bittery-org/bittery-server`](https://github.com/bittery-org/bittery/pkgs/container/bittery-server), [`ghcr.io/bittery-org/bittery-web`](https://github.com/bittery-org/bittery/pkgs/container/bittery-web)

### Implementation Details

**Private networking (caddy → server/web)**

Docker Compose uses short hostnames like `server:3000` because Compose provides internal DNS. Railway uses `servicename.railway.internal` instead. The Railway Caddyfile proxies to:

```text
server.railway.internal:3000   # API (RPC, sync, CDN, …)
web.railway.internal:8080      # web vault SPA
```

Wire these on the **caddy** service with reference variables:

```env
SERVER_PRIVATE_DOMAIN=${{server.RAILWAY_PRIVATE_DOMAIN}}
SERVER_PORT=${{server.PORT}}
WEB_PRIVATE_DOMAIN=${{web.RAILWAY_PRIVATE_DOMAIN}}
WEB_PORT=8080
```

Only **caddy** should have public networking enabled. **server** and **web** stay private.

**Template pre-fills (no manual setup needed)**

- `DATABASE_URL` — wired from the Railway Postgres plugin
- `BITTERY_STORAGE_*` — wired from the template's object-storage bucket
- Caddy upstream reference variables (above)

**What you may customize after deploy**

```env
# Server service
JWT_SECRET=<openssl rand -hex 32>
CORS_ORIGIN=https://your-app.up.railway.app
BITTERY_MODE=self-hosted
```

`VITE_SERVER_URL` is **not** required. With Caddy serving both the web app and API on the same domain, the web app uses the current page origin for RPC and sync requests.

**Optional server vars:** `REDIS_URL` (cross-instance sync), `SHARE_LINK_DAILY_LIMIT` (default `50`).

Updates: redeploy each service to pull the latest `latest` image tags; migrations apply on server boot.

## Why Deploy bittery on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying bittery on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.
