# Greenfield decision map

Label: `wayfinder:map`
Charted: 2026-08-20
Frozen baseline: `f021c85e1d3a9d3f3418ba67a9ff04f319987903`

## Destination

A decision-complete set of product, security, synchronization, platform, server, and architecture
decisions for greenfield Bittery: enough that a spec author can write implementation-ready
specifications without inferring any security, format, or scope behavior.

The map is done when nothing is left to decide. Writing the specifications is a separate effort that
starts after this one closes. No product code is written here.

## Notes

### Standing constraints

These were settled with the maintainer while charting. Every session treats them as binding, and
promotes the relevant ones into `docs/greenfield/target/` as its ticket resolves.

- **First release ships Web, Desktop, and Extension.** iOS and Android are deferred, but the engine
  and binding seams are designed so they drop in later without a rewrite.
- **The complete long-term product is specified from the start,** even though the first cut ships
  three surfaces.
- **Platform split.** Web owns signup, recovery, teams, invitations, audit and admin, plus the full
  vault. Desktop is the full vault client plus Sentinel, Share links, and import/export. Extension is
  autofill, reading Items, TOTP, and passkeys: whatever the user needs in the browser, with no
  import/export and no Sentinel.
- **Browsers: Chromium and Firefox in the first release.** Safari stays deferred and
  architecture-compatible.
- **Parity means user-facing capability parity** with the frozen product, minus hosted cloud,
  billing and Stripe, the implicit Team of one, and Qubit RPC.
- **Attachments are first-class in the first release,** with quotas removed entirely and as few
  configuration options as possible. Retention controls for audit, revisions, and Trash survive,
  because those are privacy controls rather than resource controls.
- **The engine is multi-Account and multi-Server from day one.** The All Accounts aggregation UI,
  Collections, and cross-Server copy ship in the second cut.
- **Design is modernized,** using the current app as reference for information architecture and flows
  rather than for styling. Primitives move to Base UI. Legacy UI code is not ported.
- **The server is a clean-room rewrite,** consulting the frozen implementation only when a specific
  decision needs prior art. The self-hosted mode switch is gone; the product is self-hosted only.
- **Licence is MIT** for the whole product, replacing the AGPL-3.0 and GPL-3.0 files in the frozen
  tree.
- **Build order is Rust core, then server and sync, then the clients around them.** The all-or-nothing
  implementation gate becomes per-slice; ticket 51 settles the exact form.

### Working discipline

- Every decision ticket is a live session with the maintainer. Nothing is decided AFK except
  `research` tickets, which surface facts rather than decisions.
- Depth: **format altitude** for cryptographic suites, persisted formats, and public protocol shapes,
  down to the actual bytes. **Policy altitude** everywhere else.
- Each session calls the Skill tool for `grilling` and `domain-modeling`, per `grill-with-docs`.
- Resolution promotes the outcome into committed files: normative requirements into
  `docs/greenfield/target/`, hard-to-reverse trade-offs into `docs/adr/`, terminology into
  `CONTEXT.md`. The ticket keeps the reasoning; the repository keeps the decision.
- `planning/` is committed to a public repository. No secrets, credentials, personal data, or
  unpublished vulnerability detail in a ticket.

### Evidence

Three subagent reports produced during charting. Tickets cite them; they are evidence, not decisions.

- [Adversarial review of the decision corpus](research/corpus-review.md) — ten findings against
  `docs/greenfield/`. Each is folded into the ticket that owns it; the two foundational ones became
  tickets 04 and 05.
- [Verification of the current-state catalog](research/current-state-verification.md) — the catalog
  checked claim by claim against the frozen tree. Roughly four in five claims hold; the dominant
  failure is status inflation, plus three substantive errors and several large omissions.
- [Maturity of four technology bets](research/library-maturity.md) — Base UI, Effect, OPAQUE in Rust,
  and UniFFI, verified against primary sources on 2026-08-20.

Existing material in `docs/greenfield/` is prior stakeholder input. A ticket may confirm, modify, or
reject any of it. `legacy/` is evidence about the previous product and governs nothing.

## Decisions so far

<!-- one line per closed ticket, linking the ticket that holds the detail -->

- [Browser storage durability facts](issues/01-browser-storage-durability-facts.md): no browser engine
  gives a web app a real on-disk acknowledgement, so `SYNC-001`'s durability MUST is unobtainable in a
  browser as written. Safari's seven-day cap is unchanged in 26.6; an MV3 service worker cannot host an
  OPFS database; a LAN `http://` origin loses OPFS, `crypto.subtle`, service workers and Web Locks.
  Full findings in [research/browser-storage-durability.md](research/browser-storage-durability.md).
- [Platform authenticator and PRF support matrix](issues/02-platform-authenticator-and-prf-support.md):
  WebAuthn PRF is confirmed only on Apple platforms, unproven on Android, and absent on Windows Hello,
  so it cannot be the browser quick-unlock baseline. PRF does not survive credential re-registration.
  Linux Secret Service mandates no access control at all. Full findings in
  [research/platform-authenticators.md](research/platform-authenticators.md).
- [Firefox MV3 parity and extension API gaps](issues/03-firefox-mv3-parity-facts.md): no service
  worker on Firefox (event page instead), `storage.session` is unreachable from content scripts so
  autofill secrets must travel by message, no passkey-provider API on any engine, and one manifest
  can serve both. Full findings in [research/firefox-mv3.md](research/firefox-mv3.md).
- [Threat model and server-visible plaintext](issues/04-threat-model-and-server-visible-plaintext.md):
  six adversary classes, and every operator attack classed Prevented, Detectable, or Acknowledged.
  Server-side authorization is an availability control, never a secrecy boundary. `PRIVACY-007` is a
  closed, CI-enforced plaintext list: Vault, Team and Device names, email, and the membership graph
  are readable; wall-clock timestamps are not stored at all; ciphertext is unpadded; Share links are
  unlinkable. Audit splits into an operator-readable log and a Security History encrypted to its
  User or Team. Per-Item revision chaining is a new obligation. ADRs
  [0001](../../docs/adr/0001-server-visible-plaintext-is-a-closed-allowlist.md),
  [0002](../../docs/adr/0002-the-server-stores-sequence-numbers-not-timestamps.md),
  [0003](../../docs/adr/0003-audit-splits-into-an-operator-log-and-a-security-history.md).
- [Client delivery trust and transport requirements](issues/05-client-delivery-trust-and-transport.md):
  a secure context is a `MUST` for the Web client (`HOST-007`) and the product ships no certificate
  tooling (`HOST-008`), with a private overlay network the recommended LAN route. No HSTS, because the
  client already refuses a non-secure origin and an operator certificate mistake would lock users out.
  `ACCOUNT-001` now restricts multi-Server to installed clients, so the Web client is bound to the
  Server that served it: no CORS anywhere, and `connect-src 'self'`. SRI was rejected as useless
  against a serving operator; `PRIVACY-016` publishes the bundle hash instead, making fleet-wide
  substitution Detectable and targeted substitution Acknowledged. `PRIVACY-015` states the Web client's
  per-load trust in requirements and documentation only. `HOST-009` fixes an exact Content Security
  Policy that also binds the Desktop webview. ADRs
  [0004](../../docs/adr/0004-the-web-client-requires-a-secure-context-and-the-operator-supplies-the-certificate.md),
  [0005](../../docs/adr/0005-the-web-client-is-bound-to-the-server-that-served-it.md).

- [Password authentication protocol and its fallback](issues/06-password-authentication-protocol.md):
  OPAQUE and SRP-6a both rejected. No augmented PAKE removes the offline dictionary attack, and the
  Secret Key already makes it cost ~128 bits, so OPAQUE's pre-computation resistance bought nothing for
  its dependency risk. The frozen SRP-6a is 1,703 lines of hand-written Rust with its own big-integer
  module whose modexp is documented as not constant-time. `AUTH-003` is now a signature
  challenge-response: Argon2id, HKDF, Ed25519, signing a canonical message that binds purpose, version,
  Server identity, Account, and a single-use challenge. The salt derives from the Secret Key, so there is
  no pre-login request and no enumeration oracle, at the price of Server-wide published KDF parameters.
  One protocol on every surface; it runs at enrolment and full sign-in only. A cryptographic construction
  review gates general availability, ahead of any pentest. ADRs
  [0006](../../docs/adr/0006-password-authentication-is-a-signature-challenge-response-not-a-pake.md),
  [0007](../../docs/adr/0007-the-authentication-salt-derives-from-the-secret-key.md).

## Not yet specified

In scope, but not yet sharp enough to phrase as a precise question. Graduates into tickets as the
frontier reaches it.

- **Operator observability beyond deployment basics.** Metrics, tracing, and log hygiene for a
  zero-knowledge server, once ticket 25 has settled what the deployment profiles actually are.
- **Documentation surface.** Self-hosting guide, security whitepaper, and the public protocol
  documentation `ARCH-SERVER-004` implies. Shape depends on ticket 23.
- **Second-cut scope.** All Accounts aggregation UI, Collections, and cross-Server copy have their
  engine model decided in ticket 36, but their product and UI decisions wait for the first release
  to close. Ticket 05 settled that these are installed-client features only, so the surface is Desktop
  and Extension.
- **Supported OS and browser version matrix.** Depends on tickets 41, 42, and 45.
- **Security review gate beyond authentication.** Ticket 06 settled the pattern for its own
  construction: a written design note, a cryptographic construction review before general availability,
  a penetration test after it. Whether one engagement covers the key hierarchy and envelope format too,
  and what artifact tickets 07 and 08 hand a reviewer, is still open.
- **Passkey-based Bittery login.** `ITEM-002` makes passkeys a stored capability rather than a login
  method. Whether that ever changes is a later question.
- **Server equivocation defence.** Ticket 04 classes it Acknowledged for the first release, because
  detecting a Server that tells one Device a different story from another needs a transparency-log
  construction. Whether a later release closes it is a separate question.
- **Post-quantum posture.** Nothing in the corpus mentions it. Whether the envelope format leaves
  room for it is a question ticket 08 may sharpen.

## Out of scope

Ruled beyond this destination. These never graduate; they would need the destination redrawn.

- **Writing the specifications themselves.** The map produces decisions; `to-spec` and `to-tickets`
  run afterwards as their own efforts.
- **Implementing any product code.** Two prototypes exist (tickets 16 and 39) and are throwaway
  artifacts answering a design question, not the start of the build.
- **iOS and Android UI, unlock experience, and platform product behaviour.** Only the engine-facing
  seams are decided here, in ticket 43.
- **Safari extension.** Deferred and architecture-compatible; not a first-release target.
- **Hosted cloud, billing, subscriptions, Stripe, and commercial entitlements.** Removed from the
  product by prior decision, and not revisited.
- **Compatibility with frozen Bittery data, ciphertext, protocol, or accounts.** `PROD-FOUNDATION-005`
  guarantees a clean reset. User-facing migration is handled as import in ticket 33.
- **Exhaustive current-state cataloguing.** Superseded by the verification report; individual tickets
  pull narrow legacy evidence when a decision genuinely hangs on current behavior.
- **Marketing application and documentation site as products.**

## Tickets

Child issues live in [`issues/`](issues/). Frontier is the open, unblocked, unclaimed set: lowest
number wins.

| # | Type | Title | Blocked by |
| --- | --- | --- | --- |
| [01](issues/01-browser-storage-durability-facts.md) | research | Browser storage durability facts | — |
| [02](issues/02-platform-authenticator-and-prf-support.md) | research | Platform authenticator and PRF support matrix | — |
| [03](issues/03-firefox-mv3-parity-facts.md) | research | Firefox MV3 parity and extension API gaps | — |
| [04](issues/04-threat-model-and-server-visible-plaintext.md) | grilling | Threat model and server-visible plaintext | — |
| [05](issues/05-client-delivery-trust-and-transport.md) | grilling | Client delivery trust and transport requirements | 04 |
| [06](issues/06-password-authentication-protocol.md) | grilling | Password authentication protocol and its fallback | 04 |
| [07](issues/07-key-derivation-profiles-and-downgrade-resistance.md) | grilling | Key derivation profiles and downgrade resistance | 04, 06 |
| [08](issues/08-key-hierarchy-and-envelope-format.md) | grilling | Key hierarchy and canonical envelope format | 04, 07 |
| [09](issues/09-recovery-model-and-single-artifact-paths.md) | grilling | Recovery model and single-artifact paths | 08 |
| [10](issues/10-device-enrollment-protocol.md) | grilling | Device enrollment protocol | 08, 09 |
| [11](issues/11-vault-key-rotation-and-epochs.md) | grilling | Vault key rotation and epochs | 08 |
| [12](issues/12-device-unlock-wrapper-and-quick-unlock.md) | grilling | Device Unlock Wrapper and quick unlock | 02, 08 |
| [13](issues/13-credential-provider-key-access.md) | grilling | Credential-provider process key access | 12 |
| [14](issues/14-abuse-defense-and-enumeration-resistance.md) | grilling | Abuse defense, rate limiting, and enumeration resistance | 06 |
| [15](issues/15-replica-schema-and-storage-interface.md) | grilling | Replica schema and transactional storage interface | 08 |
| [16](issues/16-browser-durability-floor.md) | prototype | Browser durability floor | 01, 15 |
| [17](issues/17-operation-state-machine-and-crash-safety.md) | grilling | Operation state machine and crash safety | 15 |
| [18](issues/18-sync-protocol-cursor-bootstrap-and-retention.md) | grilling | Sync protocol: cursor, bootstrap, and retention windows | 17 |
| [19](issues/19-conflicts-indeterminate-and-authorization-rejection.md) | grilling | Conflicts, indeterminate outcomes, and authorization rejection | 11, 18 |
| [20](issues/20-search-and-autofill-index.md) | grilling | Search and autofill index | 04, 15 |
| [21](issues/21-item-revision-history.md) | grilling | Item revision history and retention | 15 |
| [22](issues/22-server-domain-architecture-and-atomic-writer.md) | grilling | Server domain architecture and atomic command writer | 04 |
| [23](issues/23-server-identity-and-protocol-versioning.md) | grilling | Server identity, protocol versioning, and OpenAPI compatibility | 22 |
| [24](issues/24-backup-restore-and-rollback-detection.md) | grilling | Backup, restore, and rollback detection | 18, 23 |
| [25](issues/25-deployment-profiles-and-operations.md) | grilling | Deployment profiles and operations | 22 |
| [26](issues/26-administration-registration-and-retention.md) | grilling | Administration, registration, and retention | 04, 22 |
| [27](issues/27-audit-model-and-privacy.md) | grilling | Audit model and privacy | 04, 26 |
| [28](issues/28-email-dependency-and-flows-without-it.md) | grilling | Email: what needs it, and what must work without it | 26 |
| [29](issues/29-vault-team-authorization-and-departure.md) | grilling | Vault and Team authorization, and member departure | 11, 22 |
| [30](issues/30-share-links-and-external-recipients.md) | grilling | Share links and external recipients | 08, 29 |
| [31](issues/31-item-model-categories-and-capabilities.md) | grilling | Item model, categories, custom fields, TOTP, and Passkeys | 08 |
| [32](issues/32-attachments-keys-and-lifecycle.md) | grilling | Attachments: keys, chunking, and lifecycle | 08, 15 |
| [33](issues/33-import-export-and-portability.md) | grilling | Import, export, and portability | 31 |
| [34](issues/34-sentinel-and-password-generation.md) | grilling | Sentinel and password generation | 31 |
| [35](issues/35-travel-mode.md) | grilling | Travel mode | 11, 18 |
| [36](issues/36-multi-account-collections-and-cross-server.md) | grilling | Multi-Account, Collections, and cross-Server copy | 15, 18 |
| [37](issues/37-external-integrations-and-favicons.md) | grilling | External integrations, favicons, and the opt-in rule | 04, 26 |
| [38](issues/38-clientruntime-interface.md) | grilling | ClientRuntime interface | 15, 17 |
| [39](issues/39-binding-strategy-native-and-wasm.md) | prototype | Binding strategy across native and WASM | 38 |
| [40](issues/40-web-host-worker-and-effect.md) | grilling | Web host: Worker, adapters, and the Effect decision | 39 |
| [41](issues/41-extension-architecture.md) | grilling | Extension architecture for Chromium and Firefox | 03, 39, 40, 52 |
| [42](issues/42-desktop-architecture-and-ipc.md) | grilling | Desktop architecture and the extension IPC | 39, 41 |
| [43](issues/43-mobile-architecture-seams.md) | grilling | Mobile architecture seams | 13, 39 |
| [44](issues/44-design-system-on-base-ui.md) | prototype | Design system on Base UI | 40 |
| [45](issues/45-accessibility-conformance-target.md) | grilling | Accessibility conformance target | 44 |
| [46](issues/46-localization-architecture.md) | grilling | Localization architecture and string ownership | 38, 44 |
| [47](issues/47-user-journeys-per-surface.md) | grilling | User journeys per surface | 31, 44 |
| [48](issues/48-repository-foundation-and-enforcement.md) | grilling | Repository foundation and architecture enforcement | 38 |
| [49](issues/49-conformance-fixture-corpus.md) | grilling | Conformance fixture corpus | 08, 15, 39 |
| [50](issues/50-performance-budgets.md) | grilling | Performance budgets | 20, 38 |
| [51](issues/51-first-release-cut-and-implementation-gate.md) | grilling | First-release cut and the implementation gate | most of the map |
| [52](issues/52-extension-local-network-access-facts.md) | research | Extension Local Network Access and private-address classification | — |
