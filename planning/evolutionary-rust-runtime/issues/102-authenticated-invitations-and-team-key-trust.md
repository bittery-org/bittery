# 102 — Authenticated invitations and automatic Team key verification

Type: task
Status: needs-triage
Blocked by: 100

## Goal

Make secure onboarding feel like **send link → accept → confirm**, without routine fingerprint
comparison between every pair of Members or on every Device. Retain authenticated first contact;
do not replace mandatory verification with trust on first use or a "trust anyway" button.

The maintainer requested this direction on 2026-09-10. This ticket captures the proposed product
flow, not an approved cryptographic protocol or implementation-ready slice.

## Proposed experience

1. An authorized inviter creates a personal, expiring Invitation on their Device.
2. They send its secret-bearing link themselves through an existing private conversation, using
   Copy Link or the system share sheet. Bittery's email backend never receives the complete link.
3. The recipient opens the link, signs in or creates an Account, and accepts.
4. The inviter confirms membership. Core verifies the authenticated acceptance and exact recipient
   key before granting access; possession of a matching email address alone is not sufficient.
5. Authorized membership/key decisions are recorded in a signed Team directory. Clients verify it
   automatically for subsequent sharing and Key rotation, preserving existing per-Vault permissions.
6. Existing trusted Devices can authorize transfer of verified trust state to new Devices. Manual
   fingerprints remain available for advanced verification and explicitly designed recovery paths.

## Security and ownership requirements

- Generate the Invitation secret locally. Never disclose it through Server requests, server-sent
  email, analytics, crash reports or logs. A URL fragment alone is not sufficient: audit client
  handling, clipboard/share-sheet use, link previews and supported deep links.
- Authenticate both sides of onboarding and bind the complete transcript to the intended Server,
  Team, Invitation, inviter authority and recipient identity/public key. Do not let the Server
  replace a key, redirect acceptance to another Team or substitute the initial Team trust anchor.
- Treat the link as a secret capability, not proof of a human identity. Define expiry, cancellation,
  single-use consumption, concurrent acceptance and the consequences of theft or forwarding. Owner
  confirmation does not by itself defeat an attacker who has obtained the link.
- Require signatures from actors authorized by the verified Team history. Reject tampering,
  rollback, replay and unauthorized membership/key changes; specify fork detection and freshness
  limits rather than assuming signatures prove the latest state.
- Team key authenticity must not grant Vault access. Preserve existing Team and Vault role
  boundaries, removal, departure, rotation and recovery semantics.
- Core owns the protocol, trust state and lifecycle checks once for every host. Generate the
  cross-language contracts; hosts provide presentation and platform primitives only. Do not export
  session credentials or introduce a general-purpose authenticated HTTP proxy.
- Keep existing Vault/Item ciphertext and RSA wrapping formats. Any additional signing keys,
  derivation domains, storage or trust-transfer mechanism require an explicit reviewed decision;
  do not silently revive the superseded Greenfield key hierarchy.
- New Devices must obtain authentic trust state without silently trusting Server-provided initial
  history. Account removal/re-addition, lost Devices and recovery need explicit behavior.
- Assume authentic clients and a suitably private invitation-delivery channel. State that malicious
  delivered Web code, compromised endpoints and stolen invitation links remain outside that guarantee.

## Frontier to resolve before implementation

Produce a focused specification through the existing Wayfinder process and independent security
review. Resolve:

1. The authenticated Invitation exchange and bootstrap of Team trust, including how an inviter
   knows which acceptance they are confirming and when their Device must be online.
2. Signing authority, history format, key changes, revocation, recovery and freshness/rollback rules.
3. Trusted-device transfer and the case where no trusted Device remains.
4. Onboarding existing Teams and previously verified contacts without implicitly trusting existing
   Server directory contents; any change to [decision 100](100-recipient-key-verification-policy.md)
   must be explicit.
5. Exact Core/Server/host delivery dependencies and the smallest end-to-end implementation slice.
   Split delivery tickets as necessary and mark them ready only after these decisions are sealed.

## Acceptance for delivery

- Real two-Account onboarding through supported UI: create link, accept, confirm and decrypt a
  shared Item without fingerprint transcription. Test existing and newly created recipient Accounts.
- Subsequent sharing and rotation use the authenticated directory without pairwise prompts. Check
  a rotation initiated by another authorized Member, not only the original inviter.
- Reproducing tests for substituted keys/identities, wrong Team/Server, expired/cancelled/replayed
  links, simultaneous acceptances, altered history and revoked signers. No unapproved key receives
  a Vault-key wrapper; failures remain visible and fail closed.
- Verify Lock, Account switch/removal, process loss, storage failure and ambiguous network outcomes
  at each boundary. Restart cannot consume an Invitation twice or silently invent trust.
- Verify new-Device onboarding and recovery against substituted, missing and stale trust state.
- Preserve role restrictions and existing ciphertext compatibility. Audit the actual production
  callers, including Invitation provisioning and every rotation path.
- Independent protocol/security review, implementation review and simplification, generated-contract
  checks, affected host/Core/Server tests, real browser/native acceptance for claimed hosts, and
  `pnpm check:ci` / `pnpm check:ci:rust` before release acceptance.

## Relationship to existing work

[101](101-runtime-recipient-key-verification.md) remains the mandatory-verification implementation
and acceptance baseline. Keep its enforcement until the replacement is reviewed, implemented and
accepted; this ticket does not authorize removing it now. The residual authenticated Web Team paths
recorded under [78](78-cross-host-runtime-cleanup-and-conformance.md) must be assigned concrete
delivery work before claiming full UI acceptance. Neither ticket is considered complete by this plan.

## Background

- [Proton's client-generated secret sharing links](https://proton.me/support/pass-secure-link-security)
  illustrate secret-bearing link delivery, not this proposed membership protocol.
- [1Password's Account Trust Log](https://support.1password.com/account-trust-log-security/)
  illustrates signed trust history. Its documented TOFU initialization is not the first-contact
  guarantee required here.

## Comments

2026-09-23 independent Sol review found no material overclaim in the primary-source inventory.
The next protocol frontier must explicitly distinguish two bindings. First, if the complete link
secret never enters a Server request, define which nonsecret identifier/verifier and bound proof
allow the Server to enforce atomic single use; an Invitation path ID alone does not enforce the
secret. Second, a signature under an untrusted recipient key proves possession, not that the signer
is the intended person in the private conversation. Specify the independent acceptance evidence
binding that channel/person to the exact User/key. These are unresolved design questions within
the existing transcript-binding requirement, not approved cryptographic mechanisms or readiness.

2026-09-23: the [primary-source inventory](../authenticated-invitation-trust-research.md) records
published invitation-link, signed-history, transparency and trusted-device recovery guarantees and
their limits against this ticket. It separates source facts from inference and lists the remaining
bootstrap, authority, freshness, retry and recovery decisions. Protocol design, independent security
review and implementation readiness remain open;100/101 enforcement is unchanged.

2026-09-10: created at the maintainer's request. Product direction recorded; protocol decisions,
dependency refinement, implementation and acceptance remain outstanding.
