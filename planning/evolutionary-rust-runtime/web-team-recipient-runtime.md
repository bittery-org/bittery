# Web Team reads through the Client Runtime

## Frontier resolution

Question: how does the existing Web Team page read its authenticated data after Runtime Sign-in,
without exporting the Session or restoring a legacy credential owner?

Answer: the existing Client Runtime request interface provides one closed, Account-scoped Team-page
read. Core constructs authenticated requests, follows bounded Server pagination and returns the
typed data used by the current page. Web keeps presentation and query invalidation. This follows
ADR 0014, the existing generated request protocol and the actual page's read dependencies.

The coordinating source review on 2026-09-22 narrowed the proposed transport migration to this
complete read path. Authenticated transport alone cannot complete recipient provisioning or Key
rotation: their existing callers also read legacy MUK/Vault-key state and update the legacy cache.
[107](issues/107-runtime-recipient-provisioning-and-rotation.md) owns that remaining foreground
workflow. Restoring credentials to the legacy stores would create competing owners and is excluded.

## Closed read interface

Add a closed Team-page request/result to the generated Runtime protocol. The request captures the
Account and its existing caller lifetime; it takes no URL, method, headers, body or credential.
Rust derives the Server and current User from that Account. Use generated Server types for the
existing data and explicit typed page results, rather than arbitrary JSON.

The existing page's authenticated reads are:

- `GET /api/v1/users/me`, for the current User identity.
- `GET /api/v1/teams/current` and `/api/v1/teams/{teamId}`, for current Team and details.
- `GET /api/v1/teams/{teamId}/members` and `/api/v1/teams/{teamId}/invitations`, for its tabs.
- `GET /api/v1/billing/entitlements`, for the existing management presentation.

The public `/api/v1/auth/registration-status` query remains on the public client. Preserve the
current role/entitlement conditions under which invitation data is requested; a Member's valid
Team page must not fail because an owner-only list is unavailable. The Server remains the
authorization authority. Preserve distinguishable absent, forbidden and failed reads; a failed
authenticated request must not masquerade as an absent Team. The result need not claim an atomic
Server snapshot across these independent reads.

Core owns cursor traversal, bounded response limits and cancellation between pages. Reject a
repeated cursor or `hasMore` without a cursor. Preserve the existing API problem status, code,
message, request identity, retryability, retry-after and field errors needed by callers through a
closed typed error; no arbitrary authenticated response or headers are returned to the host.

`apps/web/src/lib/runtime-session.ts` permits the protected Web routes only while unlocked.
This foreground read therefore requires a live unlocked Account and its usable retained Session.
Do not activate Desktop84's background refresh lane on Web or alter its separate locked-Session
validation behavior. Reuse the existing Session renewal and Account execution/cancellation owners.
Capture and recheck Account incarnation, lock epoch and Session identity across external waits and
before publication. Lock, removal, replacement, caller loss and close retire the old read. A host
query captures its Account and clears the prior Account's view on selection changes; it cannot
finish against a replacement active Account. No new retry, Session or Account owner is added.

## Acceptance and remaining callers

Start with the actual Runtime Sign-in and in-app Team-page failure. Core tests cover the read's
exact routes, role-dependent invitation visibility, pagination, typed errors and held-response
Account/Lock/cancellation fences. The actual browser test must render the Team name, current User,
Members tab, role and invitation-tab state from the real Server without any legacy auth token.
Keep existing page query invalidation and role/entitlement presentation tests meaningful.

The first real browser regression is
`apps/web/tests/e2e/teams.spec.ts` → `the Team plan signup names the team the new account owns`.
This ticket establishes that read path, not the whole Teams suite. Invitation composer/mutations,
pending-invitation management, Add-Member and all private Key rotation/provisioning dependencies
remain [107](issues/107-runtime-recipient-provisioning-and-rotation.md) and still block101's joined
acceptance. Team rename/delete, billing management and other residual Web administration stay in
78's executable caller inventory until separately migrated. Do not remove their existing code or
claim it migrated through this read result.

Generate contracts normally under ADR 0012, run affected Core/Web types and tests, independently
review and simplify, and pass both full CI commands before ticket closure. This read requires no
Server route or cryptographic-format change.
