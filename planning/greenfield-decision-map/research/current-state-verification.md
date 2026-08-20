# Verification of the current-state catalog

Produced by a subagent during the Wayfinder charting session, 2026-08-20.
Target: `docs/greenfield/current-state/` checked against the frozen tree under `legacy/`.
Status: evidence. Every path below is relative to `legacy/`.

## Verdict

The catalog is directionally sound and its cited paths all exist: no invented file, symbol, or ADR. Roughly four out of five claims hold as written. It is not yet trustworthy as evidence, for two reasons.

First, its dominant failure mode is **status inflation**: whole blocks are marked Observed while the only cited evidence is documentation, which `AUTHORING.md` explicitly forbids. The "Strong concepts" list in `client-architecture.md` is the worst case, seven Observed bullets backed by four ADRs and one `CONTEXT.md`.

Second, it contains three substantive factual errors: Qubit is described as a live transport being replaced when it was fully removed before the frozen commit; email is listed as an existing integration when no email provider exists at all; and Android's plaintext master-unlock-key export is described as historical when it is current.

Coverage gaps matter more than the errors. The catalog never mentions the server's outbound favicon fetch keyed by item domain, the 30-day sync-event and 90-day trash retention windows, or that Chrome is the only shipped extension target and iOS is an empty scaffold.

## Claims that are wrong or overstated

### Qubit is described as a live transport in transition
**File:** `product-capabilities.md` Commercial and operational behavior; `server-sync-security.md` Transport. **Stated as:** Proposed / Observed.

Qubit is gone. Repo-wide, only two references survive, both doc-comment links to the ADR: `apps/server/src/http/error_code.rs:3` and `apps/server/src/shared/shapes.rs:3`. `apps/server/src/app/router.rs:236-245` is a test asserting `POST /rpc` returns **404**. `packages/api-contract/openapi.v1.json` carries 90 paths and 104 operations, and `apps/server/src/http/openapi.rs:177-178` asserts those exact counts. ADR 0011's own context paragraph ("Bittery exposes 113 Qubit procedures through `/rpc`") is stale relative to the code it governs.

**Verdict:** wrong. Only the ADR's status line is still Proposed; the migration is complete.

### "Email, object storage, Redis/pub-sub, Stripe, and other external integrations exist"
**File:** `server-sync-security.md` Server; repeated in `product-capabilities.md`. **Stated as:** Observed.

There is no email integration. `apps/server/src/integrations/mod.rs` declares exactly three: `favicon`, `storage`, `stripe`. The single email sink is `apps/server/src/domains/auth/email.rs:20-40`, which returns `AppError::internal("Auth email delivery is not configured... configure a real email provider")` unless `dev_stubs_enabled`. `apps/server/src/config/mod.rs:260-264` **hard-refuses** `BITTERY_ENABLE_DEV_AUTH_STUBS` when `NODE_ENV=production`. In production, signup verification, account recovery, and email-restricted share access all fail closed. Team invitations were never emailed: `apps/server/src/domains/teams/invitations.rs` only mints a token.

**Verdict:** wrong. The correct status for production email flows is Unreachable or Defect.

### "Server authentication currently includes SRP-era behavior"
**File:** `product-capabilities.md` Identity, authentication, and devices. **Stated as:** Observed.

"SRP-era behavior" reads as vestigial. SRP-6a is the live, only login protocol on both ends. Server: `apps/server/src/domains/auth/login.rs:88` and `:196` construct `SrpServer::new(HashAlgorithm::Sha256, PrimeGroup::G4096)`; `:98` reads `srp_salt`/`srp_verifier`; `:164-206` verifies the client proof. Client: `packages/core/src/services/auth-service.ts:398-460` (`performSRPLogin`), with mutual auth at `:460`. Anti-enumeration uses a deterministic fake salt (`login.rs:44-49`) and a constant `FAKE_SRP_VERIFIER` (`login.rs:18-23`). Implementation at `packages/crypto/core/crates/bittery-crypto-core/src/srp6a/`.

**Verdict:** understated.

### "Master password plus a generated Secret Key", cited to CONTEXT.md and ADR 0001
**File:** `product-capabilities.md`. **Stated as:** Observed.

The claim is true, but both cited sources are documentation, which `AUTHORING.md` forbids as sole backing. The code is one grep away: `packages/crypto/core/crates/bittery-crypto-core/src/key_derivation.rs:88-99` (length-prefixed `[len][password][len][secret_key]`, PBKDF2-HMAC-SHA256), `:124-137` (HKDF split into `bittery-auth-key` / `bittery-unlock-key`). The catalog also never names the algorithm anywhere.

**Verdict:** status-unjustified as cited.

### The "Strong concepts" block
**File:** `client-architecture.md`. **Stated as:** Observed, seven bullets.

Every bullet is true, and most are provable by test, but the block's stated evidence is four ADRs plus `packages/storage/CONTEXT.md`, all documentation. The real backing exists and should have been cited: `apps/server/Cargo.toml:49` links `bittery-crypto-core` directly (proving the shared-core claim); `packages/crypto/port/src/key-ref.ts:38-98` plus `packages/storage/src/account-store.test.ts:458,473,487` prove KeyRef destruction; `packages/storage/src/tiers.ts:20-32` is the classification table; `apps/extension/src/background/vault-session/transitions.ts:6-14` has only type-imports, proving reducer purity.

**Verdict:** status-unjustified.

### "Favorite is explicitly unencrypted metadata in the current glossary"
**File:** `product-capabilities.md`. **Stated as:** Observed.

True and code-provable, but cited to the glossary. `apps/server/migrations/0000_fresh_pandemic.sql` gives `item.favorite boolean`; `apps/server/src/domains/vaults/items.rs:525-563` (`toggle_vault_favorite`) mutates it server-side; `PATCH /items/{itemId}/favorite` is a real route (`apps/server/src/domains/vaults/http/items.rs:386`).

**Verdict:** status-unjustified, claim correct.

### "The extension implements popup/options/content/page scripts"
**File:** `client-architecture.md`. **Stated as:** Observed.

There is no options page. `apps/extension/manifest.config.js` declares no `options_page` or `options_ui`; no `options.html` exists; `chrome.runtime.openOptionsPage` appears nowhere. Settings is a route inside the popup router: `apps/extension/src/pages/settings.tsx`, registered in `apps/extension/src/routeTree.ts`.

**Verdict:** wrong, minor.

### "The Android credential path historically exported master-unlock-key material"
**File:** `client-architecture.md`. **Stated as:** Observed.

It is current, not historical, and it flows both ways. `apps/mobile/src/lib/credential-provider-master-unlock-key.ts:52-58` calls `crypto.exportKey(masterUnlockKey)`, base64-encodes it, and passes it to `CredentialProvider.setMasterUnlockKey(...)`. Callers: `credential-provider-password-unlock.ts:59`, `routes/unlock.tsx:85`, `credential-replica.ts:1055`. The reverse direction exists too: `get_master_unlock_key_base64` and `borrow_live_master_unlock_key_base64` at `apps/mobile/src-tauri/plugins/credential-provider/src/commands.rs:70,83`. Inside Kotlin the KeyRef discipline is dropped entirely: `.../credentialprovider/crypto/NativeCrypto.kt:63-82` exports both derived keys as base64.

**Verdict:** understated. This is a live security property, not a legacy scar.

### "Sentinel computes password-security posture locally"
**File:** `product-capabilities.md`. **Stated as:** Observed.

True, and properly Observed (`packages/shared/src/password-analysis.ts`, `packages/core/src/hooks/use-password-security.ts`, e2e at `apps/web/tests/e2e/sentinel.spec.ts`). But it is **web-only**: no route exists under `apps/desktop/src/routes/` or `apps/mobile/src/routes/`, and it is plan-gated in cloud mode (`packages/shared/src/pricing.ts`).

**Verdict:** overstated. Should be Partial.

### "Import/export implementations and plans cover several formats"
**File:** `product-capabilities.md`. **Stated as:** Observed.

Six providers exist under `apps/web/src/lib/import/providers/`: 1Password `.1pux`, Bitwarden, Chrome, Firefox, KeePassXC, and round-trip `.bttrx`. All web-only. `docs/plans/exports.md:3` is marked "Status: Complete". Mixing shipped code with plan docs under one Observed status is the conflation the rules forbid.

**Verdict:** overstated, status hygiene.

### "Administrative surfaces" / "administrative functionality exists"
**File:** `product-capabilities.md`. **Stated as:** Observed.

There is no operator or superuser admin. The only privileged surface is a **team** admin console: `authorize_team_admin` at `apps/server/src/domains/teams/admin/mod.rs:23`, gating `GET /api/v1/audit-events` and `GET /api/v1/teams/{teamId}/members/{userId}/access`. Web UI at `apps/web/src/routes/_app/admin/index.tsx`. Health is `/` and `/healthz` only; no metrics endpoint.

**Verdict:** overstated. A greenfield planner would over-scope removal work.

### "Cross-cutting write mechanics are not uniformly expressed through one atomic internal interface"
**File:** `server-sync-security.md`. **Stated as:** Partial.

Half-right. Audit does have a single writer: `insert_audit_event` at `apps/server/src/db/events.rs:27-70`. Idempotency has dedicated middleware plus a table: `apps/server/src/http/idempotency.rs`, `apps/server/src/shared/idempotency.rs`, migration `20260810194520_idempotency_records.sql`. What is genuinely scattered is the transaction-plus-sync-event pairing inside each domain module.

**Verdict:** overstated in the negative direction.

### Claims verified as accurate

Identity/session/device operation list; vault and item CRUD including personal-to-team conversion (`apps/server/src/domains/vaults/http/mod.rs:648`); five item categories (`apps/server/src/db/enums.rs:415-426`); per-attachment keys wrapped under the vault key (`apps/server/migrations/20260812130646_attachment_key_envelope.sql`, `packages/core/src/services/attachment-crypto.ts:1-12`); implicit personal team (`apps/server/src/domains/teams/service.rs:534`); share access modes, one-time and expiry (`apps/server/src/domains/shares/shape.rs:33-40`); token digests (`apps/server/src/db/events.rs:20-22`); travel mode as a server-held policy that erases local keys (`packages/core/src/services/travel-mode-enforcer.ts`); SSE as a hint only (`packages/sync/src/sync-manager.ts:269`, `sync-orchestrator.ts:116`); sealed-ciphertext conflicts preserved as copies (`packages/sync/src/outbound-queue.ts:174-212, 639-674`); real-Postgres integration tests (221 `#[tokio::test]`, `DATABASE_URL`-backed via `apps/server/src/test_support.rs:865`); rotation plans (`apps/server/src/domains/vaults/rotation/plans.rs`, three tables); `exportKey` as a total escape hatch (`packages/crypto/port/src/crypto-port.ts:125`); storage tiers (`packages/storage/src/tiers.ts`); `PlatformProvider` scope; the seven architectural-pressure module paths; Redis as a production correctness dependency (`apps/server/src/shared/redis.rs:6-15`).

## Cited evidence that does not check out

| Cited path | Exists? | Supports the claim? | Note |
| --- | --- | --- | --- |
| `apps/server/src/domains/auth/` | Yes | Yes | 22 routes at `http.rs:785-806`, plus `regenerate_secret_key` and `rename_session` |
| `apps/server/src/domains/sessions/` | Yes | Yes | `service.rs` 1334 LOC; digest-stored bearer tokens, per-platform TTLs at `:1169-1176` |
| `packages/core/src/services/auth-service.ts` | Yes | Yes | `performSRPLogin` at `:398` |
| `packages/sync/src/outbound-queue.ts` | Yes | Yes | conflict-copy path at `:174-212` |
| `packages/storage/src/item-cache.ts` | Yes | Yes | sibling of `account-store.ts` as described |
| `packages/core/src/services/{account-vault-replica,vault-repository,vault-crypto}.ts` | Yes | Yes | all three present |
| `packages/storage/CONTEXT.md` | Yes | Partly | Documentation only, used to justify Observed |
| `CONTEXT.md` (glossary) | Yes | Partly | Documentation only, used to justify three Observed claims |
| `docs/adr/0001, 0003, 0005, 0009, 0012, 0013` | Yes | Partly | All real, all documentation, cited as sole evidence for Observed claims |
| `docs/adr/0011-axum-rest-openapi-replaces-qubit.md` | Yes | **No** | Status still "Proposed", but its premise (113 Qubit procedures) is false at the frozen commit |
| `apps/web/src/lib/import/` | Yes | Yes | six providers, web-only |
| `docs/research/password-manager-import-formats.md` | Yes | Partly | Research doc, not implementation |
| `docs/plans/exports.md` | Yes | Partly | Marked "Status: Complete", cited alongside code under one Observed status |
| `docs/mobile-migration-*`, `docs/research/mobile-*` | Yes | Yes | Supports only the Partial status it carries |
| `packages/crypto/port/CONTEXT.md` | Yes | **No** | `:108-111` says the Android provider "runs in its own process". Contradicted by `apps/mobile/src-tauri/plugins/credential-provider/android/PROCESS-MODEL.md:5-24, 45-52`, which states it runs in-process and warns against adding one. An Inconsistent the catalog never records |

## Significant omissions

### The KDF is PBKDF2-SHA256, and recovery uses a weaker one
**Found at:** `packages/crypto/core/crates/bittery-crypto-core/src/key_derivation.rs:19,99`; policy at `packages/crypto/kdf-policy.json`; server copy at `apps/server/src/domains/auth/mod.rs:20-22`; recovery at `.../src/recovery.rs:20,87-92`

The catalog says only "password derivation." The actual suite is PBKDF2-HMAC-SHA256 at 600,000 iterations, with `argon2` present solely as a "reserved for a future schema" comment (`key_derivation.rs:71`) and a rejection test. Recovery-key derivation runs at **100,000** iterations and is **not** governed by the KDF profile: a 6x weaker path to the same master key. There is no ECDH, no X25519, no Ed25519 anywhere; RSA-4096-OAEP is the only asymmetric wrap.

### No email delivery exists, so three production flows are unreachable
**Found at:** `apps/server/src/domains/auth/email.rs:20-40`; `apps/server/src/config/mod.rs:255-264`

Signup verification, account recovery, and email-restricted share access all terminate in a dev-only stub refused in production. The greenfield product is not replacing SMTP; it is building email for the first time, or designing these flows to not need it.

### The server fetches favicons from the open internet, keyed by item domain
**Found at:** `apps/server/src/integrations/favicon.rs:21-40`; `apps/server/src/domains/vaults/favicon.rs`; public unauthenticated route `GET /favicon/{domain}` at `apps/server/src/http/public.rs:33,130`; cache table from migration `0005_big_vector.sql`; weekly refresh job at `apps/server/src/jobs/runner.rs:100`

A zero-knowledge server holds a Postgres table of every domain its users have items for, and makes outbound requests to those domains. This is the single largest metadata leak in the frozen product, the catalog does not mention favicons at all, and it directly contradicts the target's opt-in rule for external requests.

### Server-side retention and garbage collection bound sync and trash
**Found at:** `apps/server/src/jobs/sql.rs:13,18-19,53-68,153-230`; schedules at `apps/server/src/jobs/runner.rs:53-103`

Sync events are pruned after **30 days**, so a device offline longer must fall back to a full bootstrap: a hard constraint on any offline design. Trashed items are hard-deleted after **90 days**, emitting `item_permanently_deleted` sync events. Neither appears in the catalog's Sync section nor as a disposition row. Seven cron jobs exist in total (sessions, sync events, rate-limit state, tombstones, pending uploads, rotation plans, favicons).

### DeploymentMode already switches cloud vs self-hosted
**Found at:** `apps/server/src/config/mod.rs:123-135,181-187`; `apps/server/src/domains/billing/entitlements.rs:54-56,120-125`; flags at `config/mod.rs:299,304`; installer `deploy/install.sh`, `deploy/docker/`, `deploy/railway/`

"Remove hosted cloud" is not a from-scratch job. A self-hosted mode, a dedicated signup form (`apps/web/src/components/self-hosted-sign-up-form.tsx`), an e2e suite (`apps/web/tests/e2e/self-hosted.spec.ts`), and a working Docker/Caddy installer already ship.

### Rate limiting is a first-class subsystem; CSP and HSTS are absent
**Found at:** `apps/server/src/shared/rate_limit.rs:34-52` (19 scopes), Postgres and Redis backends at `:289,511`, `RATE_LIMIT_ADAPTER` at `config/mod.rs:242-253`; headers at `apps/server/src/http/middleware.rs:229-255`; desktop `security.csp: null` in `apps/desktop/src-tauri/tauri.conf.json`

Nineteen named limiter scopes with lockout are real product behavior nobody has classified. The server sets six security headers and **neither** a Content-Security-Policy nor HSTS, and the desktop webview disables CSP outright. There is no CAPTCHA.

### HTTP concurrency and idempotency contracts are already persisted format
**Found at:** `apps/server/src/http/idempotency.rs:90,124`; migrations `20260810194520` and `20260810213225`; `If-Match`/`ETag` on item writes; body caps at `apps/server/src/http/limits.rs:17-23`

The server stores **replayed response bodies** (up to 2 MiB, 24 h) keyed by principal, method, route and key, with a 32-byte request fingerprint, and `createShareLink` explicitly rejects `Idempotency-Key` as a one-time secret. This is a durable protocol decision, absent from both the catalog and the disposition table.

### Client feature parity is far narrower than "four React-family clients" implies
**Found at:** route trees under `apps/web/src/routes/`, `apps/desktop/src/routes/`, `apps/mobile/src/routes/`

Signup, team management, invitation acceptance, billing, the admin/audit console, Sentinel, share-link viewing, and account recovery exist **only on web**. Desktop and mobile are vault-browsing shells with login and unlock. Test coverage matches: 18 web e2e specs, 1 extension spec, **zero** for desktop or mobile (`apps/desktop` has 4 unit tests; `apps/mobile` has 11).

### The extension ships for Chrome only; iOS is an empty scaffold
**Found at:** `apps/extension/manifest.config.js:11` (MV3, no `browser_specific_settings`); `apps/mobile/src-tauri/gen/apple/` (one 4-line `main.mm`, zero `.swift` files, empty entitlements dict); `apps/mobile/README.md:93-96`

Also absent from the extension: `chrome.commands` keyboard shortcuts, context menus, offscreen documents, and `chrome.idle`.

### The desktop-to-extension IPC has a hand-rolled peer-identity model and one documented gap
**Found at:** `apps/desktop/src-tauri/src/ipc_security.rs` (1291 lines, compiled into both binaries, threat model at `:18-43`); policy asymmetry at `apps/desktop/src-tauri/src/lib.rs:1136-1147` (app: `Required`) vs `native_host.rs:141-153` (host: `BestEffort`); unwired origin check at `apps/desktop/src-tauri/src/native_messaging_installer.rs:52-86`

The specifics are the interesting part: 0700 socket dirs, `SO_PEERCRED` plus executable-path verification, an explicit Windows SDDL because the NPFS default DACL grants `Everyone`, and a known dead extension-origin allowlist. Also note `apps/extension/src/background/biometric-transfer.ts:277-282`: the "signature" on a biometric material transfer is `btoa(challenge:boundTo)`, a binding tag rather than a cryptographic signature.

### The password generator lives in TypeScript and is modulo-biased
**Found at:** `packages/shared/src/password.ts:73,80,85-89`

`charSet[val % charSet.length]` over a `Uint8Array`, with 26-, 62-, and 88-element alphabets that do not divide 256. The Fisher-Yates shuffle reuses the same random buffer. `CryptoPort` deliberately has no `generatePassword` member, so this sits outside the audited Rust core entirely. This is a Defect, and password generation appears in neither the catalog nor the disposition table.

### Android keeps a full second data model with destructive migration
**Found at:** `apps/mobile/src-tauri/plugins/credential-provider/android/.../storage/CredentialDatabase.kt:11-51`

A Room database at `version = 8` with `fallbackToDestructiveMigration(true)`, six entities mirroring server item rows including `encryptionAlgorithm = "AES-GCM-AAD-V1"`. Plus a biometric-gated MUK escrow in the Android Keystore with a legacy RSA path (`crypto/MukEscrowManager.kt:51,108,135`).

### Other unrecorded facts

Localization ships **en and de only** (`packages/i18n/messages/`). A `beta_waitlist` table and unauthenticated `POST /waitlist` exist. `GET /cdn/{*key}` is a server-side proxy of presigned S3 URLs (`apps/server/src/http/public.rs:32,94,113`). Attachments require optional S3 and are entitlement-gated (`apps/server/src/domains/billing/entitlements.rs:49-69`). A server-side bulk import endpoint accepts 16 MiB / 200 items. `audit_log` stores raw IP and user-agent, masked only on read (`apps/server/src/domains/teams/audit/mod.rs:596,616`), with no pruning job. Concurrent SSE devices are capped per plan (`apps/server/src/shared/connection_registry.rs`). Migrations `20260811112051` and `20260811180338` refuse to run against populated data. `scripts/check-architecture.mjs` encodes package dependency rules the target should inherit. A TypeScript `ClientRuntime` already exists at `packages/core/src/services/client-runtime.ts`, 35 lines, which the "greenfield lesson" section names as if it were new.

## Disposition-table corrections

| Row | Problem | Correction |
| --- | --- | --- |
| `Qubit/RPC -> Remove` | Already removed. `/rpc` is asserted 404 | Delete the row, or restate as "keep the existing versioned Axum/OpenAPI surface" |
| `Generic repository tier -> Remove` | No generic repository tier exists; ADR 0002 was already applied | Delete the row. Retain only the positive half |
| `SMTP requirement -> Replace` | There is no SMTP; `email.rs:20-40` is a dev stub refused in production | Restate: current state is no email delivery at all. This is new work, not a replacement |
| `Firefox extension -> Keep` | No Firefox extension exists. MV3-only manifest, no `browser_specific_settings`. "Firefox" appears only as a CSV import provider | Change to a new-capability row |
| `Safari extension -> Defer` | No Safari extension or target exists anywhere | Change to a new-capability row |
| `Tauri/WebView mobile -> Remove` | Android is real; iOS is a scaffold with zero Swift and no autofill extension | Split the row. Android = Replace; iOS = new build |
| `Sentinel -> Keep` | Web-only today, plan-gated in cloud mode. No desktop, mobile, or extension surface | Note current scope so "All Accounts" reads as new work |
| `Attachments -> Defer` | Omits that attachments require optional S3 and an active billing entitlement, and that orphaned uploads are GC'd every 15 min | Add the storage dependency and entitlement gate |
| `Master password plus Secret Key -> Keep` | Hides the parameters: PBKDF2-SHA256 at 600k, recovery at 100k outside the profile | Add a separate KDF row so the recovery weakness is not inherited silently |
| `External service requests by default -> Remove` | Abstract. The concrete offenders are the favicon fetcher and the `/cdn` proxy | Name them |
| `Hosted cloud -> Remove` / `Billing -> Remove` | Understates existing help: `BITTERY_MODE=self-hosted` already bypasses all entitlements, and an installer ships | Scope as deletion, not construction |
| **Missing entirely** | Rate limiting and lockout (19 scopes); idempotency records with stored response bodies; `ETag`/`If-Match` optimistic concurrency; 30-day sync-event retention; 90-day trash auto-purge; password generation and its modulo bias; KDF profile versioning and anti-downgrade; vault type conversion; server-side bulk import; beta waitlist; the `/cdn` proxy; CSP/HSTS absence; the desktop-extension IPC peer-identity model | Add rows or Unclassified entries for each |
| `Unclassified: breach detection and favicon acquisition` | Breach detection does not exist. Only `docs/plans/breach-detection.md` and a `security_breach` value in `key_rotation_reason` (`apps/server/src/db/enums.rs:441`) | Move breach detection out of current-capability framing |
