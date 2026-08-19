# Foundation candidate decisions

Status: **Candidate**. Source: first greenfield grilling session, August 2026.

This record summarizes the session without upgrading its outcomes to Accepted. The consistency review
may supersede individual candidates.

## Product and deployment

- Optimize for the best user experience, not current parity.
- Specify the complete long-term product and an explicit first release.
- Fully open source and self-hosted; no Bittery-operated cloud product.
- Server-backed Accounts with offline-first clients; no separate local-only product mode.
- Multi-User and Team deployments.
- Remove billing, plans, Stripe, subscriptions, and commercial entitlements entirely.
- Administrators operate infrastructure but cannot decrypt, impersonate, reset cryptographic secrets,
  or silently enroll Devices.
- Registration supports open, invitation-only, and closed configuration.
- Email is optional.
- LAN, internet, and overlay-network deployments are equally supported.
- Official simple and scalable deployment profiles; no correctness dependency on Redis.
- Public protocol and third-party clients are supported.
- No external requests by default.
- Clean reset: no current data, ciphertext, protocol, or migration compatibility requirement.

## Identity and recovery

- Clients support several Accounts across several Servers and an All Accounts mode.
- User, Account, Device, and Session use the simplified definitions in target product requirements.
- Retain master password plus Secret Key.
- Target OPAQUE for Server password authentication, subject to a format/conformance gate.
- Prefer trusted-device QR enrollment; also support direct Secret Key and Emergency Kit paths.
- Administrators cannot recover a Vault after all user-held material is lost.
- Retain optional user-held Recovery Keys.
- Retain Device-local quick unlock; biometrics authorize local key release only.
- Offline revocation cannot promise remote erasure.
- Servers have stable identities separate from URLs.
- No federated cross-Server Teams or Vault sharing.

## Vault, Team, and Item behavior

- All Accounts follows the 1Password interaction model, with explicit Server provenance and honest
  copy/delete semantics.
- Local Collections may span Accounts and Servers.
- Teams are explicit, not implicit Teams of one.
- Personal and Team Vault ownership are distinct; personal-to-Team conversion is one-way.
- Ongoing sharing is Vault-scoped; Share links disclose one encrypted Item snapshot.
- Team and Vault roles are separate. Administrators can govern visible metadata without automatic
  decryption access.
- Member departure blocks affected Vault writes until rotation, not unrelated Vaults.
- Built-in Item categories plus encrypted custom fields; no user-authored schemas.
- TOTP and Passkeys are stored Item capabilities, not initial Bittery login methods.
- Encrypt Favorite and all sensitive Item metadata.
- Attachments remain in the architecture and may be deferred from first-release UX.

## Offline and Sync

- Ordinary Vault behavior works offline after initial synchronization.
- Default finite Server revalidation is operator-configurable, including indefinite offline use.
- Enabled Vault ciphertext is locally available; Attachment blobs are on-demand/pinnable.
- Locked UI reveals as little as possible, similar to the current product.
- Incompatible concurrent ciphertext edits create Conflict copies.
- Keep bounded encrypted revision history.
- Trash uses synchronized tombstones and explicit permanent deletion.
- Promise eventual convergence, not immediacy.
- SSE is optional notification only.
- Keep privacy-conscious audit history and a simplified honest Travel mode.
- Ship a supported, tested Server backup/restore command.

## Architecture and technology

- One deep Rust engine owns session, commands, crypto policy, replica, outbox, Sync, and read models.
- One runtime owner per process; UI surfaces are clients.
- Domain commands and purpose-built immutable projections cross the interface.
- Versioned snapshots/invalidation observations and closed typed outcomes.
- Durable accepted work survives cancellation of caller interest.
- Few deep Rust crates, not a crate per noun.
- Vertical Server domain modules and atomic command writer.
- Executable architecture rules and one cross-platform conformance corpus.
- Tauri v2/React Desktop. GPUI is excluded and may be reconsidered only in a future session if it
  matures.
- React/TypeScript Web with Effect v4 restricted to host/platform effects. Stable Effect v4 is a
  release gate.
- Native SwiftUI iOS and Kotlin/Compose Android.
- Chromium and Firefox required; Safari deferred but architecture-compatible.
- Server serves matching Web client by default.
- Rust/Axum/Postgres/SQLx modular monolith. Explicit checked SQL, no generic repository/ORM entity
  layer, and pinned dependency governance.
- Bounded Server protocol compatibility; bundled Web always matches its Server.

## Specification governance

- Current-state baseline is the frozen commit named in the root README.
- Existing Bittery receives no changes after rebuild work starts.
- Evidence hierarchy and explicit incomplete/defective statuses are mandatory.
- Catalog current capabilities and journeys, including screenshots in later audit passes.
- Stable requirement IDs and normative language.
- Every current feature receives one disposition.
- Critical scenarios carry replica, keys, Server, operations, cursor, clock, connectivity, failures,
  durable results, and visible results.
- Grilling outcomes remain Candidate until consistency review.
- Agents stop only affected work on a specification contradiction and never infer security behavior.

