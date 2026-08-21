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
- **Cryptography is being reopened before specifications begin.** Prefer, in order: constructions
  standardized in final RFCs and implemented by mature reviewed libraries; the smallest protocol,
  primitive, format, and migration surface that meets the threat model; and bespoke construction only
  where a recorded requirement cannot be met by a standard design. "More layers" is not treated as
  "more secure". Ticket 53 sharpens this into an acceptance policy before tickets 06 through 09 are
  decided again.

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
  precise content secrecy replaces "zero knowledge". The field-level plaintext registry stays closed
  but provisional until protocol/schema freeze. Names, email, membership and roles, sizes, addresses,
  operational timestamps and activity chronology are readable; ciphertext is unpadded. Detectable
  means the User's own client catches the attack. Web substitution and Compromised Endpoints are
  Acknowledged. One operator-readable log replaces encrypted Security History; clients remember
  accepted revisions instead of hash-chaining them. Initial recipient keys require out-of-band
  fingerprint verification, and Account signatures authenticate grants, roles and revisions. ADRs
  [0001](../../docs/adr/0001-server-visible-plaintext-is-a-closed-allowlist.md),
  [0015](../../docs/adr/0015-the-server-may-store-operational-timestamps.md), and
  [0016](../../docs/adr/0016-there-is-one-operator-readable-audit-log.md).
- [Client delivery trust and transport requirements](issues/05-client-delivery-trust-and-transport.md):
  a secure context is mandatory and the operator supplies certificates. Secure responses send one-year
  HSTS for the exact host, without subdomains or preload; the first HTTP visit remains unprotected. The
  Web client is same-origin and bound to its serving Server, so no CORS surface exists and multi-Server
  remains installed-client only. Exact CSP remains. Published bundle hashes verify releases and
  deployments but do not detect bytes a Malicious Operator served; all Web substitution is
  Acknowledged and the Web limitation appears in documentation and contextual UI. ADRs
  [0004](../../docs/adr/0004-the-web-client-requires-a-secure-context-and-the-operator-supplies-the-certificate.md),
  [0005](../../docs/adr/0005-the-web-client-is-bound-to-the-server-that-served-it.md).

- [Cryptographic design acceptance policy](issues/53-cryptographic-design-acceptance-policy.md):
  security properties are the hard filter; final RFC constructions with mature reviewed libraries
  then win, followed by global simplicity. Use one mechanism per job and complete registered modes.
  Bespoke, non-final-standard, export-only, and second-mechanism choices carry an exception burden.
  Dependencies must be maintained, conformant, WASM-capable, transparent about unsafe code, and
  reviewed or broadly interoperable; Bittery owns no arithmetic. Integrated design review,
  implementation review, and a penetration test block general availability. ADR
  [0017](../../docs/adr/0017-standard-cryptographic-constructions-and-global-simplicity-win.md).

- [Password authentication protocol and its fallback](issues/06-password-authentication-protocol.md):
  full sign-in is RFC 9807 OPAQUE-3DH with ristretto255/SHA-512 and Argon2id, initially on pinned
  `opaque-ke` 4.0.1. Both password inputs and stable Account/Server identities enter one canonical
  input; RFC bytes sit behind one-byte protocol and profile identifiers. The export key yields the
  Account Unlock Key and the session key confirms one Device-credential issuance. Version migration
  atomically replaces the registration and wrapper; no fallback protocol or operator bypass exists.
  Server setup is mandatory backup material. RFC and Bittery vectors run on Rust and WASM, and
  integrated external review blocks general availability. ADR
  [0006](../../docs/adr/0006-password-authentication-is-a-signature-challenge-response-not-a-pake.md).

- [Key derivation profiles and downgrade resistance](issues/07-key-derivation-profiles-and-downgrade-resistance.md):
  profile `0x01` is RFC 9106's memory-constrained Argon2id shape at 64 MiB, 3 passes, 4 lanes, zero
  16-byte salt, and a 64-byte OPAQUE output. The finite `0x01`–`0xFF` registry is immutable and
  monotonically ordered. Device state, trusted enrollment, or the Emergency Kit supplies the separate
  authoritative pin; no Server selection or registry walk exists. A reviewed stronger Server preference
  is a declinable post-sign-in upgrade, while a lower or unknown preference warns without changing the
  pin. Only routes containing a human-chosen secret pay memory-hard work. Master passwords require 15
  entered Unicode code points and a local blocking common/compromised-password list, plus advisory
  guidance. Capability, not elapsed time, gates the supported Rust/WASM baselines. Benchmark
  [evidence](research/key-derivation-profile-benchmark.md). ADRs
  [0008](../../docs/adr/0008-memory-hard-work-is-spent-once-and-only-on-human-secrets.md),
  [0009](../../docs/adr/0009-key-derivation-profiles-are-a-closed-append-only-registry.md).

- [Abuse defense, rate limiting, and enumeration resistance](issues/14-abuse-defense-and-enumeration-resistance.md):
  layered subject, source, and Server-capacity controls conceal public existence without hard-locking
  Accounts; PostgreSQL is the default authority and durable Redis is a selectable alternative.

- [Key hierarchy and canonical envelope format](issues/08-key-hierarchy-and-envelope-format.md): one
  fixed envelope grammar and one version byte name the whole standard suite. AES-256-GCM-SIV with
  random nonces protects symmetric state; complete RFC 9180 HPKE Base mode seals flat Vault grants;
  Ed25519 signs the exact grant body, Item revisions, and Account Private Objects. The stable random
  Account Key Set, direct Item encryption, per-Attachment keys, typed object binding, `u32` epochs, and
  full Account Fingerprint survive. Signed Item revisions now commit to Attachment manifests. The old
  XChaCha and export-only composition, Team History Key, speculative HKDF labels, and unauthenticated
  sealed-key body are gone. Targeted review of the pinned AES-GCM-SIV path blocks beta; integrated
  review and penetration testing block general availability. Format
  [specification](../../docs/greenfield/target/cryptographic-format.md); ADRs
  [0010](../../docs/adr/0010-one-envelope-one-suite-and-a-version-byte-that-names-the-whole-format.md),
  [0011](../../docs/adr/0011-vault-grants-are-flat-signed-and-sealed-to-an-account-key-set.md).

- [Extension Local Network Access and private-address classification](issues/52-extension-local-network-access-facts.md):
  the Extension reaches a LAN Server **without a prompt on both engines today**, and on neither engine is
  that a promise. Chromium maps `chrome-extension://` to the loopback address space on purpose but says
  only that it has no plans to gate extensions *currently*; Firefox leaves a `moz-extension://` initiator
  at `Unknown` by accident, diverging from the specification with no test covering it. **Content scripts
  are gated on both engines** and neither vendor documents it, so the background host should own all
  network I/O. `host_permissions` is not an exemption and no local-network extension permission exists.
  `100.64.0.0/10` is classified **local**, not public, contradicting the ticket's premise, so the overlay
  route earns its place by supplying `HOST-007`'s secure context rather than by dodging the gate.
  `HOST-008`'s recommended route is prompt-free, as is every other `HOST-001` shape. A denial is a bare
  `TypeError` indistinguishable from an unreachable Server. The Desktop webview is not gated today, but
  Tauri's `tauri://localhost` origin classifies as public and WebView2 has no permission kind to answer
  with. Firefox shipped the gate in **147**, not 149, and default-on in **153**, not 151. Full findings in
  [research/extension-local-network-access.md](research/extension-local-network-access.md).

- [Device credential patterns in established password managers](issues/54-device-credential-patterns.md):
  1Password binds ordinary requests to a fresh SRP-derived session key; Bitwarden uses one-hour Bearer
  access tokens backed by reusable sliding refresh tokens. Neither has an Account-signed Device Grant.
  The evidence separates Device admission, ordinary request authentication, Account-key release, and
  revocation into distinct jobs. Full findings in
  [research/device-credential-patterns.md](research/device-credential-patterns.md).

- [Recovery model and single-artifact paths](issues/09-recovery-model-and-single-artifact-paths.md):
  remote routes combine separately sourced secrets intended for separate storage; they are not
  mislabeled as different factor categories. The Emergency Kit and Recovery sheet are separate outputs.
  Independent `RK1` recovery derives wrapping and Ed25519 signing keys from both random secrets, uses a
  five-minute proof plus a thirty-minute directly signed atomic replacement, and remains usable when an
  old OPAQUE version is unsafe. Recovery revokes every old Device and session in the same commit that
  publishes the new Account Private Object; this constrains an honest Server but cannot stop a Malicious
  Operator serving the ciphertext to a Device that already holds the Account Key Set. Routine password
  change stays narrow, ordinary Secret Key rotation preserves trusted Devices by default, Recovery Key
  **removal** promises forward protection rather than erasure, and the route UI explains compromise
  conditions without strength scores. ADRs [0012](../../docs/adr/0012-every-route-to-the-account-keys-consumes-two-factors.md),
  [0013](../../docs/adr/0013-rotating-a-wrapping-secret-is-forward-protection-only.md),
  [0014](../../docs/adr/0014-the-current-secret-key-is-stored-sealed-to-the-account-key-set.md), and
  [0018](../../docs/adr/0018-recovery-authentication-is-independent-of-opaque.md).

- [Device enrollment protocol](issues/10-device-enrollment-protocol.md): every route commits one
  Account-signed Device Grant and proof of the new Device key. Trusted enrollment is a five-minute
  Server-relayed HPKE transfer with a six-digit display comparison, fresh local approval, signed roster
  checkpoint, and activation only after a decryption receipt. Device status is an Account-signed
  monotonic event sequence. Ordinary traffic uses a fixed RFC 9421 Ed25519 profile, short Sessions,
  replay counters, and authoritative status checks on every request; revocation stops the next honest-
  Server request but cannot erase keys already held locally. ADR
  [0019](../../docs/adr/0019-device-admission-is-account-signed-and-every-request-proves-the-device-key.md).

- [Vault key rotation and epochs](issues/11-vault-key-rotation-and-epochs.md): rotation is a
  forward-only, consecutive epoch cutover for new writes. Access loss and a fixed 2^24-envelope budget
  create a non-expiring write block; a client installs one complete Account-signed grant set atomically,
  with no bulk re-encryption or resumable plan. Still-authorized offline edits are re-sealed, historical
  grants live while referenced, and manual rotation changes nothing until its one command succeeds.
  ADR [0020](../../docs/adr/0020-vault-key-rotation-is-a-forward-atomic-epoch-cutover.md).

- [Device Unlock Wrapper and quick unlock](issues/12-device-unlock-wrapper-and-quick-unlock.md): every
  enrolled Device gets memory-hard password quick unlock without Server or Secret Key; copied local
  state permits only pinned-profile offline guessing. Explicit platform quick unlock is hardware-gated
  on Secure Enclave Macs or runtime-proven WebAuthn PRF, and unavailable on Windows and Linux. The core
  exports no Account keys, one ceremony may open independently wrapped matching Accounts, Extension
  keeps its own fallback beside narrow Desktop delegation, and Device-wide Lock has fixed triggers,
  minimal disclosure, a ten-minute default, and explicit invalidation and password-migration paths.
  ADR [0021](../../docs/adr/0021-password-quick-unlock-is-a-memory-hard-local-wrapper.md).

- [Credential-provider process key access](issues/13-credential-provider-key-access.md): iOS and
  Android use independent constrained Provider cores with separate wrappers and sessions but one
  enrolled Mobile Device identity. Full Account and Device-credential keys stay inside Rust so the
  Provider can fill, durably save, and resume Sync; a minimal locked Suggestion Index,
  shared/exclusive Replica Lease, guarded request counters, and an explicit Compromised Endpoint bound
  keep the reduced guarantee honest. ADR
  [0024](../../docs/adr/0024-credential-providers-use-full-account-keys-behind-a-closed-core-interface.md).

- [Replica schema and transactional storage interface](issues/15-replica-schema-and-storage-interface.md):
  one typed logical Replica per Account separates an immutable remote base from a durable local
  operation overlay. Snapshot reads and guarded Account-wide commits give every adapter one atomic,
  serializable contract; bootstrap promotes a complete generation and cursor together. Replica
  plaintext is a separate closed registry, decrypted data is volatile, durability classes remain
  honest about browsers, and migration, corruption, removal and wipe preserve unique local work.
  Schema [specification](../../docs/greenfield/target/replica.md); ADR
  [0022](../../docs/adr/0022-account-replicas-use-guarded-atomic-commits.md).

- [Browser durability floor](issues/16-browser-durability-floor.md): Web and Extension stay
  offline-first on IndexedDB `durability: "strict"` under the explicitly weaker
  `browser-transactional` class. Web requests persistence as best effort; Extension requires
  `unlimitedStorage`. Unsynced operation count and age stay visible, controlled deletion is guarded,
  and one semantic fixture core gains mandatory native and Browser Durability profiles. ADR
  [0023](../../docs/adr/0023-browser-transaction-completion-is-an-honest-weaker-durability-floor.md).

- [Operation state machine and crash safety](issues/17-operation-state-machine-and-crash-safety.md):
  local acceptance atomically creates a queued immutable command and overlay; every send first records
  an indeterminate intent, then retries the same canonical bytes indefinitely. Account-scoped random
  Operation IDs and Account-lifetime canonical Server outcomes provide exactly-once Domain writes;
  dependency-aware scheduling, locked byte-identical Sync, atomic result reconciliation, explicit
  discard, and task-oriented UI complete the seven-state lifecycle. State-machine
  [specification](../../docs/greenfield/target/operations.md); ADR
  [0025](../../docs/adr/0025-account-lifetime-operation-outcomes-provide-exactly-once-commands.md).

- [Search and autofill index](issues/20-search-and-autofill-index.md): each Account persists one
  opaque, chunked Search Snapshot behind a fresh Account-sealed key and combines scopes only in
  unlocked memory. A separate Device-only Suggestion Snapshot exposes the closed mobile preview
  before Account unlock. Complete Public Suffix matching, deterministic non-secret text search,
  fail-closed invalidation, progressive rebuild, asynchronous checkpoints, and Travel rekeying bound
  behavior and leakage. Index [specification](../../docs/greenfield/target/search-index.md); ADR
  [0026](../../docs/adr/0026-search-indexes-are-opaque-account-local-checkpoints.md).

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
- **Passkey-based Bittery login.** `ITEM-002` makes passkeys a stored capability rather than a login
  method. Whether that ever changes is a later question.
- **Server equivocation defence, and key transparency.** Ticket 04 classes equivocation Acknowledged
  for the first release, because detecting a Server that tells one Device a different story from
  another needs a transparency-log construction. Ticket 08 added the adjacent case: an operator can
  substitute the public keys it publishes for an Account, so a Vault grant can be sealed to the
  operator. `CRYPTO-014` gives out-of-band verification an Account Fingerprint to compare, which is a
  manual floor rather than a defence. Whether a later release ships a transparency log covering both is
  one question, not two.
- **Account Key Set rotation.** `AUTH-028` rules it out of the first release, because `CRYPTO-005` binds
  the Account Fingerprint into every grant signature so every granter would have to re-issue, and
  `CRYPTO-012` needs a retained history of signing keys or every past revision becomes unverifiable.
  A later release may want it, and it sits next to the transparency-log question above: both are about an
  operator who keeps or substitutes key material, and one construction may answer both.
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
- **Peer-held, delegated, and administrator-assisted recovery.** Ruled out in ticket 09 and stated in
  `AUTH-005`. The threat model makes the operator an adversary, so an administrator can never restore
  access, and a peer-held scheme is a separate feature with its own sharing, interface, and trust story.
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
| [20](issues/20-search-and-autofill-index.md) | grilling | Search and autofill index | 04, 13, 15 |
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
| [38](issues/38-clientruntime-interface.md) | grilling | ClientRuntime interface | 12, 15, 17 |
| [39](issues/39-binding-strategy-native-and-wasm.md) | prototype | Binding strategy across native and WASM | 38 |
| [40](issues/40-web-host-worker-and-effect.md) | grilling | Web host: Worker, adapters, and the Effect decision | 39 |
| [41](issues/41-extension-architecture.md) | grilling | Extension architecture for Chromium and Firefox | 03, 12, 39, 40, 52 |
| [42](issues/42-desktop-architecture-and-ipc.md) | grilling | Desktop architecture and the extension IPC | 12, 39, 41 |
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
| [53](issues/53-cryptographic-design-acceptance-policy.md) | grilling | Cryptographic design acceptance policy | 04 |
| [54](issues/54-device-credential-patterns.md) | research | Device credential patterns in established password managers | — |
