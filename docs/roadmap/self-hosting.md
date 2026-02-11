# Feature: Easy Self-Hosting

## Overview

Make Bittery trivially easy to self-host. Multiple deployment paths — from a one-click Railway template to a full Docker Compose stack — so users can choose what fits their setup. The server and web images are standalone, environment-driven, and work with any external PostgreSQL database.

Desktop, extension, and mobile apps are distributed separately (website downloads / app stores) and just need to be pointed at the self-hosted server URL.

## Goals

- **Multiple deployment paths**: Railway template (clicks), Docker Compose (VPS), standalone Docker images (BYO infra)
- **Zero build step**: Users pull pre-built Docker images or deploy from a template, never source code
- **Environment-driven**: Everything configured via env vars — works identically on Railway, Fly.io, Render, or a VPS
- **BYO database**: Users can use Neon, Supabase, Railway Postgres, any hosted PostgreSQL — or run one locally
- **Upgradeable**: Pull new images and restart, migrations run automatically on startup

## Deployment Options

### Option 1: Railway Template (Recommended)

One-click deploy from the Bittery website or Railway marketplace. Lowest friction — no CLI, no server, no Docker knowledge needed.

A Railway template already exists and is running, but currently builds from source which is slow and complex. Once the Docker images are published, the template switches to pulling pre-built images — faster deploys, simpler config, no build step on Railway's side.

**What the template provisions:**
- Bittery Server (from `ghcr.io/bittery/server`)
- Bittery Web (from `ghcr.io/bittery/web`)
- PostgreSQL (Railway managed)
- Automatic internal networking between services

**User steps:**
1. Click "Deploy on Railway" from bittery.app or the Railway marketplace
2. Railway provisions all three services with pre-configured env vars
3. User adds a custom domain (or uses the Railway-provided `*.up.railway.app` URL)
4. Done — server auto-migrates the database on first boot

**Revenue**: Railway's template kickback program gives a percentage of spend from users who deploy via the template. Since Bittery Cloud also runs on Railway, the template doubles as the production deployment config.

---

### Option 2: Docker Compose (VPS)

Full stack on a single machine with automatic TLS. For users who want to own their infrastructure.

```
curl -fsSL https://get.bittery.app | sh
```

Brings up: Caddy (reverse proxy + auto TLS) + Server + Web + PostgreSQL.

See [Docker Compose](#docker-compose-vps-1) section below for full details.

---

### Option 3: Standalone Docker Images (BYO Everything)

For users who already have infrastructure — a managed database, their own reverse proxy, an existing Docker host, or a PaaS like Fly.io / Render / Coolify.

**Server:**
```bash
docker run -d \
  -e DATABASE_URL=postgresql://user:pass@your-db-host:5432/bittery \
  -e JWT_SECRET=$(openssl rand -hex 32) \
  -e CORS_ORIGIN=https://vault.example.com \
  -e WEB_APP_URL=https://vault.example.com \
  -p 3000:3000 \
  ghcr.io/bittery/server:latest
```

**Web:**
```bash
docker run -d -p 8080:8080 ghcr.io/bittery/web:latest
```

The server just needs a `DATABASE_URL` pointing at any PostgreSQL 15+ instance — Neon, Supabase, PlanetScale Postgres, Railway Postgres, Amazon RDS, a $0 Neon free tier, or a local install. Migrations run automatically on startup.

The web image is a static SPA — it can also be deployed to Vercel, Netlify, Cloudflare Pages, or any static host without Docker at all. The built assets are available as a GitHub release artifact.

---

## Docker Images

Both images are the foundation for all deployment options.

### Server Image (`ghcr.io/bittery/server`)

Multi-stage build:

1. **Build stage**: `oven/bun` base, install deps, run `tsdown` to produce `dist/index.mjs`
2. **Runtime stage**: `oven/bun:slim`, copy `dist/` + `packages/db/src/migrations/`, run `bun dist/index.mjs`

Migrations run automatically on startup (existing behavior in `packages/db/src/migrate.ts`), so no separate migration step is needed.

The image should include a healthcheck (`/trpc/auth.heartbeat` or a dedicated `/healthz` endpoint).

**Environment variables:**

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `JWT_SECRET` | Yes | — | Min 32 chars, used for session tokens |
| `CORS_ORIGIN` | Yes | — | Comma-separated allowed origins |
| `WEB_APP_URL` | Yes | — | Public URL of the web frontend |
| `BITTERY_MODE` | No | `cloud` | Set to `self-hosted` for single-team, invite-only mode |
| `PORT` | No | `3000` | Server listen port |
| `HOST` | No | `0.0.0.0` | Server listen host |
| `REDIS_URL` | No | — | Enables Redis pub/sub (multi-instance). Falls back to in-memory |
| `BITTERY_STORAGE_ENDPOINT` | No | — | S3-compatible endpoint for image uploads |
| `BITTERY_STORAGE_BUCKET` | No | — | S3 bucket name |
| `BITTERY_STORAGE_ACCESS_KEY_ID` | No | — | S3 access key |
| `BITTERY_STORAGE_SECRET_ACCESS_KEY` | No | — | S3 secret key |
| `BITTERY_STORAGE_REGION` | No | `auto` | S3 region |
| `BITTERY_STORAGE_CDN_URL` | No | — | Public URL for stored files |

Without the `BITTERY_STORAGE_*` variables, image uploads (vault/team icons) are disabled. Everything else works.

### Web Image (`ghcr.io/bittery/web`)

Multi-stage build:

1. **Build stage**: `node:22-alpine`, install deps, `pnpm run build` in `apps/web`
2. **Runtime stage**: `nginx:alpine`, copy `apps/web/dist/client/` to `/usr/share/nginx/html/`, include an nginx config that serves the SPA with `try_files $uri /index.html`

The web image is purely static — no server-side rendering needed for self-hosted deployments.

**Alternative**: The built `dist/client/` folder is also published as a GitHub release tarball so users can deploy to any static host (Vercel, Netlify, Cloudflare Pages, S3 + CloudFront) without Docker.

### Build Automation

- GitHub Actions workflow builds and pushes both images on each release tag
- Multi-arch builds (`linux/amd64`, `linux/arm64`) for VPS and Raspberry Pi support
- Images tagged with semver (`v1.0.0`) and `latest`
- Web static assets also published as a release artifact (`bittery-web-v1.0.0.tar.gz`)

---

## Railway Template

The template already exists and is running. The main improvement is switching from building from source to pulling pre-built Docker images once they're published.

### Current State

- Template builds from the monorepo source on every deploy — slow, complex, and fragile
- Works, but build times are long and the template config is harder to maintain

### Target State

Switch services to reference pre-built images:

```
┌──────────────────────────────────────┐
│          Railway Project             │
│                                      │
│  ┌──────────┐  ┌──────────┐         │
│  │  Server   │  │   Web    │         │
│  │ (image)   │  │ (image)  │         │
│  └─────┬─────┘  └──────────┘         │
│        │ private network              │
│  ┌─────▼─────┐                       │
│  │ PostgreSQL │                       │
│  │ (plugin)   │                       │
│  └───────────┘                       │
└──────────────────────────────────────┘
```

- Server and Web pull from `ghcr.io/bittery/server` and `ghcr.io/bittery/web`
- No build step on Railway — deploys in seconds instead of minutes
- Template config becomes minimal: just image references + env var wiring

### Template Variables

- `JWT_SECRET` — `${{ secret(64) }}`
- `DATABASE_URL` — `${{ Postgres.DATABASE_URL }}` (auto-injected by Railway's Postgres plugin)
- `CORS_ORIGIN` — `${{ Web.RAILWAY_PUBLIC_DOMAIN }}` (with `https://` prefix)
- `WEB_APP_URL` — same as `CORS_ORIGIN`

### Why Railway

- **Same platform as Bittery Cloud**: The self-hosted template uses the same deployment config as our production cloud instance. One config to maintain.
- **Template kickback program**: Revenue share on compute spend from users who deploy via the template.
- **Low friction**: Deploy button on the website, no CLI or Docker knowledge needed.
- **Managed Postgres**: Railway handles database backups, no user action required.
- **Scales if needed**: Users can add more resources or a Redis instance directly from the dashboard.

---

## Docker Compose (VPS)

For users who want the full stack on their own server.

### Architecture

```
┌─────────────────────────────────────────────┐
│                   Caddy                      │
│          (reverse proxy + auto TLS)          │
│                                              │
│   vault.example.com/* ──► web:8080           │
│   vault.example.com/trpc/* ──► server:3000   │
│   vault.example.com/sync/* ──► server:3000   │
│   vault.example.com/cdn/*  ──► server:3000   │
└─────────────────────────────────────────────┘
         │                    │
    ┌────▼────┐         ┌────▼────┐
    │   Web   │         │ Server  │
    │ (nginx) │         │  (Bun)  │
    │ :8080   │         │  :3000  │
    └─────────┘         └────┬────┘
                             │
                  ┌──────────┼──────────┐
                  │          │          │
             ┌────▼───┐ ┌───▼───┐ ┌───▼────┐
             │ Postgres│ │ MinIO │ │ Redis  │
             │  :5432  │ │ :9000 │ │ :6379  │
             └────────┘ └───────┘ └────────┘
                          (opt)     (opt)
```

### Compose File

```yaml
# docker-compose.yml (simplified, actual will have more comments)
services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

  server:
    image: ghcr.io/bittery/server:latest
    restart: unless-stopped
    environment:
      DATABASE_URL: ${DATABASE_URL:-postgresql://bittery:${DB_PASSWORD}@postgres:5432/bittery}
      JWT_SECRET: ${JWT_SECRET}
      CORS_ORIGIN: https://${DOMAIN}
      WEB_APP_URL: https://${DOMAIN}
      HOST: 0.0.0.0
      PORT: 3000
    depends_on:
      postgres:
        condition: service_healthy

  web:
    image: ghcr.io/bittery/web:latest
    restart: unless-stopped

  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: bittery
      POSTGRES_USER: bittery
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U bittery"]
      interval: 5s
      timeout: 5s
      retries: 5

  minio:
    image: coollabsio/minio:latest
    container_name: minio
    restart: unless-stopped
    command: server /data --console-address ":9001"
    ports:
      - "9000:9000"
      - "9001:9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER:-bittery}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
    volumes:
      - minio_data:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 30s
      timeout: 20s
      retries: 3
    profiles:
      - storage

volumes:
  caddy_data:
  caddy_config:
  postgres_data:
  minio_data:
```

**BYO database**: If `DATABASE_URL` is set in `.env`, the compose file uses it directly and the `postgres` service can be removed or left stopped. This lets users point at Neon, Supabase, or any external PostgreSQL.

### Installer Script

```
curl -fsSL https://get.bittery.app | sh
```

**What it does:**

1. **Check prerequisites**: Docker and Docker Compose installed, ports 80/443 available
2. **Prompt for domain**: `Enter your domain (e.g., vault.example.com):`
3. **Ask about database**: `Use built-in PostgreSQL or connect to an external database?`
   - Built-in: generates `DB_PASSWORD`, uses the compose Postgres service
   - External: prompts for `DATABASE_URL`
4. **Generate secrets**: Random `JWT_SECRET` (64 chars) via `openssl rand`
5. **Create install directory**: `/opt/bittery/` (or user-chosen)
6. **Write files**: `docker-compose.yml`, `.env`, `Caddyfile`
7. **Pull images and start**: `docker compose pull && docker compose up -d`
8. **Wait for health**: Poll the server healthcheck
9. **Print summary**: URL, next steps, DNS instructions

**Non-interactive mode** for automation:

```bash
curl -fsSL https://get.bittery.app | sh -s -- \
  --domain vault.example.com \
  --database-url postgresql://user:pass@db.example.com:5432/bittery
```

### Caddyfile (generated)

```
{DOMAIN} {
    handle /trpc/* {
        reverse_proxy server:3000
    }
    handle /sync/* {
        reverse_proxy server:3000
    }
    handle /cdn/* {
        reverse_proxy server:3000
    }
    handle {
        reverse_proxy web:8080
    }
}
```

Caddy automatically provisions and renews TLS certificates from Let's Encrypt.

---

## Configuration Reference

### `.env` file (Docker Compose)

Generated by the installer with safe defaults:

```env
# Required
DOMAIN=vault.example.com

# Auto-generated by installer (override if needed)
JWT_SECRET=<random-64-chars>

# Database — choose one:
# Built-in PostgreSQL (default)
DB_PASSWORD=<random-32-chars>
# External PostgreSQL (overrides built-in)
# DATABASE_URL=postgresql://user:pass@host:5432/bittery

# Optional: S3 storage for image uploads
# Use built-in MinIO (enable with: docker compose --profile storage up -d)
# MINIO_ROOT_PASSWORD=<random-32-chars>
# Or external S3-compatible provider:
# BITTERY_STORAGE_ENDPOINT=https://s3.amazonaws.com
# BITTERY_STORAGE_BUCKET=my-bittery-bucket
# BITTERY_STORAGE_ACCESS_KEY_ID=AKIA...
# BITTERY_STORAGE_SECRET_ACCESS_KEY=...
# BITTERY_STORAGE_REGION=us-east-1
```

### Backup (Docker Compose)

```bash
docker compose exec postgres pg_dump -U bittery bittery > backup.sql
```

For external databases, users handle backups through their provider (Neon snapshots, RDS automated backups, etc.).

### Update Flow

```bash
# Docker Compose
cd /opt/bittery
docker compose pull && docker compose up -d

# Railway
# Automatic — new image tags trigger re-deploys, or click "Redeploy" in dashboard

# Standalone
docker pull ghcr.io/bittery/server:latest
docker pull ghcr.io/bittery/web:latest
# restart containers
```

Migrations run automatically on server startup in all cases.

---

## Implementation Plan

### Phase 1: Docker Images & Server Prep

1. **Add healthcheck endpoint** to the server (`GET /healthz` returning 200)
2. **Create `Dockerfile`** for server (`apps/server/Dockerfile`)
   - Multi-stage: build with `oven/bun`, runtime with `oven/bun:slim`
   - Copy migration files alongside the built server
3. **Create `Dockerfile`** for web (`apps/web/Dockerfile`)
   - Multi-stage: build with `node:22-alpine` + pnpm, runtime with `nginx:alpine`
   - Include nginx config for SPA routing
4. **GitHub Actions workflow** to build and push images on release tags
   - Multi-arch: `linux/amd64` + `linux/arm64`
   - Push to `ghcr.io/bittery/server` and `ghcr.io/bittery/web`
   - Publish web static assets as release artifact

### Phase 2: Simplify Railway Template

5. **Update existing Railway template** to pull pre-built images instead of building from source
   - Remove build config, reference `ghcr.io/bittery/server` and `ghcr.io/bittery/web`
   - Keep existing env var wiring (`DATABASE_URL`, `JWT_SECRET`, etc.)
6. **Test deploy cycle**: one-click deploy, image updates, custom domain

### Phase 3: Docker Compose + Installer

9. **Create `docker-compose.yml`** under `deploy/docker/`
   - Support both built-in and external PostgreSQL via `DATABASE_URL` override
10. **Create `Caddyfile` template** and `.env.example`
11. **Write `install.sh`** — prerequisite checks, prompts (domain + database choice), file generation, compose up
12. **Host at `get.bittery.app`**
13. **Test locally**: full stack up/down, external DB, migrations, TLS (with local CA)

### Phase 4: Documentation & Polish

14. **Self-hosting docs on the website** — guides for Railway, Docker Compose, and standalone
15. **SMTP configuration** for email notifications (share links, device alerts)
16. **ARM64 testing** on Raspberry Pi / Oracle Cloud free tier
17. **Automatic backups** via a cron job in a sidecar container (optional compose profile)
18. **Upgrade migration testing** — ensure version bumps work across all deployment methods

---

## Non-Goals (for now)

- Kubernetes / Helm chart (Docker Compose + Railway cover the common cases)
- Built-in DDNS or tunnel (users manage their own DNS; could suggest Cloudflare Tunnel in docs)
- Web-based admin panel for server configuration
- Multi-node / high-availability setup (single instance is the target)
- Windows host support for the installer (Docker Desktop on Windows works manually)
