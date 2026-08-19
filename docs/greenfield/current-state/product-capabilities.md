# Current product capabilities

All claims refer to the frozen snapshot. Statuses follow [../AUTHORING.md](../AUTHORING.md).

## Product identity

**Observed.** Bittery is a zero-knowledge, end-to-end encrypted password manager with Web, Desktop,
mobile, browser-extension, and shared-server surfaces. The canonical current vocabulary is
[`CONTEXT.md`](../../../legacy/CONTEXT.md).

**Observed.** The product distinguishes a server-side User from a device-local Account. Several
Accounts may exist on one Device, and one Active account controls the current UI scope.

**Observed.** Current deployment and product code includes hosted-cloud assumptions, self-hosted
server URLs, billing, plans, entitlements, Stripe integration, and administrative surfaces. The
greenfield target removes hosted-cloud and billing behavior.

## Identity, authentication, and devices

- **Observed:** signup, login, email verification, sessions, device/session listing and revocation,
  password change, email change, account deletion, account recovery, and multiple local Accounts.
  Evidence: `apps/server/src/domains/auth/`, `apps/server/src/domains/sessions/`, and
  `packages/core/src/services/auth-service.ts`.
- **Observed:** current encryption derives account material from a master password plus a generated
  Secret Key. The master password never leaves the Device. Evidence: [`CONTEXT.md`](../../../legacy/CONTEXT.md)
  and [`docs/adr/0001-single-rust-crypto-core-for-every-platform.md`](../../../legacy/docs/adr/0001-single-rust-crypto-core-for-every-platform.md).
- **Observed:** optional Recovery Key and Emergency Kit concepts provide user-held recovery material.
- **Observed:** lock, sign out, remove Account, wipe Device, delete account, full sign-in, quick unlock,
  biometric unlock, and master-password re-entry are distinct operations.
- **Observed:** server authentication currently includes SRP-era behavior in the Rust crypto core and
  authentication modules. The greenfield target has no protocol compatibility obligation.

## Vaults and Items

- **Observed:** personal and Team-owned/shared Vaults, Vault membership, Vault roles, creation,
  update, deletion, conversion, and key rotation.
- **Observed:** encrypted Items with Login, Secure Note, Credit Card, Identity, and Authenticator
  categories; custom fields; password history; tags; TOTP; stored Passkeys; Favorite; Trash; move,
  restore, and permanent deletion.
- **Observed:** Item contents, including tags, are encrypted. Favorite is explicitly unencrypted
  metadata in the current glossary. The greenfield candidate decision encrypts Favorite.
- **Observed:** Attachments use per-Attachment keys wrapped under the Vault key so Vault-key rotation
  can rewrap keys without rewriting blobs.
- **Observed:** Sentinel computes password-security posture locally over decrypted Vault data.
- **Observed:** import/export implementations and plans cover several password-manager formats.
  Evidence: `apps/web/src/lib/import/`, `docs/research/password-manager-import-formats.md`, and
  `docs/plans/exports.md`.

## Teams and sharing

- **Observed:** every current User belongs to a Team, including an implicit solo Team. Team roles and
  Vault roles are separate.
- **Observed:** Team invitations, membership management, Member departure, audit history, shared
  Vaults, and Vault-key rotation exist.
- **Observed:** Share links disclose an encrypted snapshot of one Item; the Share key is in the URL
  fragment and never reaches the Server. Access modes include bearer-link and email-restricted flows,
  plus expiry/one-time semantics.
- **Observed:** secret invitation, verification, session, and Share tokens are stored only as digests.
  Evidence: [`docs/adr/0003-secret-tokens-are-stored-only-as-digests.md`](../../../legacy/docs/adr/0003-secret-tokens-are-stored-only-as-digests.md).

## Travel mode

- **Observed:** Travel mode is a server-held policy that hides selected Vaults across Devices and
  removes their local keys/cache when synchronized. An offline Device cannot receive a new policy
  before reconnecting.

## Sync and offline behavior

- **Observed:** encrypted Item/Vault cache, optimistic local mutation projection, durable outbound
  operations, cursor catch-up, paginated bootstrap, Sync events, and SSE notifications exist.
- **Observed:** SSE is treated as a wake-up hint; authoritative state comes from bounded HTTP reads.
- **Observed:** encrypted edits that are sealed against a particular revision cannot be safely
  rebased; current queue behavior preserves conflicts as copies.
- **Partial:** offline and lifecycle composition differs among Web, Desktop, mobile, and extension.
  The shared behavior exists, but each host reconstructs part of its ownership and scheduling.

## Platform surfaces

- **Observed:** Web is React/TypeScript.
- **Observed:** Desktop is Tauri with a React renderer, Rust native host, OS keychain access, native
  messaging, and a desktop-extension protocol.
- **Observed:** the extension implements popup/options/content/page scripts, autofill, save prompts,
  Passkey mediation, background Sync, native messaging, and a pure Vault-session reducer.
- **Observed:** current mobile is Tauri/React/WebView, not native SwiftUI and Compose. Android
  credential-provider integration contains a significant native plugin and replica path.
- **Partial:** current mobile feature parity and process architecture have changed repeatedly and are
  documented in `docs/mobile-migration-*` and `docs/research/mobile-*`.

## Commercial and operational behavior

- **Observed:** billing, subscription, plan comparison, entitlement, Stripe webhook, quota, and
  administrative functionality exists.
- **Observed:** email, object storage, Redis, deployment configuration, and release/update concepts
  exist as integrations or operational dependencies.
- **Proposed:** the current repository contains a proposed coordinated REST/OpenAPI replacement for
  Qubit RPC. Evidence: [`docs/adr/0011-axum-rest-openapi-replaces-qubit.md`](../../../legacy/docs/adr/0011-axum-rest-openapi-replaces-qubit.md).
