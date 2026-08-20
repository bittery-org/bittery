# Abuse defense, rate limiting, and enumeration resistance

Type: grilling
Status: ready-for-human
Blocked by: 06

## Question

OPAQUE removes offline pre-computation and leaves online guessing wide open, so throttling is load-bearing rather than optional. The corpus has no requirement about rate limiting, lockout, abuse defense, or enumeration resistance on any endpoint, and neither open-questions nor the Unclassified list names them. Meanwhile the frozen server already has a first-class subsystem: 19 named limiter scopes with Postgres and Redis backends, plus a deterministic fake salt and constant fake verifier for anti-enumeration. See both research reports.

Decide:

- Per-account, per-IP, and global throttling with explicit lockout semantics, as requirements.
- Enumeration resistance on signup, login, recovery, invitation, and share endpoints.
- Whether lockout is a denial-of-service vector against a targeted user, and what mitigates it.
- Whether rate-limit state may live in Redis given `HOST-002`'s no-correctness-dependency rule.
- What a self-hosted operator can tune, and what is fixed.
- Whether any bot defense beyond throttling is in scope, given no external services by default.

Produces: an `ABUSE-*` requirement family and disposition rows for a subsystem currently unclassified.
### Inherited from ticket 06, password authentication protocol

Enumeration on the sign-in path is **gone by construction**, not by defence. `AUTH-010` derives the salt
from the Secret Key, so the Server exposes no endpoint that reveals whether an Account exists before a
full sign-in begins. There is no decoy-salt response to make indistinguishable, in content or in timing.

What remains for this ticket: the Sign-in Challenge endpoint is unauthenticated and hands out nonces, so
it needs issuance limits and a challenge lifetime. Online guessing is weaker than usual because
`AUTH-003` binds the Secret Key into the credential, so an attacker holding only a leaked password cannot
produce a valid signature at all; rate limiting bounds resource abuse more than it bounds credential
guessing. Registration, invitation, and Share-link endpoints keep their own enumeration questions.

One user-facing consequence to price: a user with the right password but the wrong or missing Secret Key
fails identically to a user with the wrong password. Decide what the client says.

### Inherited from ticket 09, recovery model and single-artifact paths

`AUTH-026` adds a second authentication path, the recovery sign-in, using the same challenge-response
under a different HKDF label. It needs the same rate limiting and the same silence as a full sign-in:
there is no pre-login request, so no enumeration oracle appears, and this ticket must keep it that way.

`AUTH-030` revocation and `AUTH-027` rotation are authenticated writes that delete or replace the
material a locked-out User depends on. Their abuse limits belong here, along with what a Server does
when recovery sign-ins fail repeatedly for one Account.
