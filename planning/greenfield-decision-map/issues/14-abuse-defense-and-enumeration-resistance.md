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

Full sign-in now uses RFC 9807 OPAQUE. A Server-wide setup permits the RFC's indistinguishable fake
credential responses, but ticket 06 deliberately leaves the policy to this ticket: require or reject
fake responses, define their timing obligations, and account for the global OPRF seed's blast radius.

KE1 creates a Server-side Sign-in attempt under a random 128-bit identifier. This ticket fixes attempt
expiry, concurrent-attempt bounds, fake-record behavior, and limits for KE1, KE2, and failed or abandoned
KE3 exchanges. The attempt is atomically consumed on the first KE3 submission, success or failure.
Registration is ceremony-bound and has no general public replacement endpoint.

One user-facing consequence to price: a user with the right password but the wrong or missing Secret Key
fails identically to a user with the wrong password. Decide what the client says.

### Inherited from ticket 09, recovery model and single-artifact paths

Ticket 09 will decide the recovery authentication mechanism again. It needs equivalent rate limiting
and enumeration analysis, but must not silently inherit the superseded signature challenge-response.

`AUTH-030` revocation and `AUTH-027` rotation are authenticated writes that delete or replace the
material a locked-out User depends on. Their abuse limits belong here, along with what a Server does
when recovery sign-ins fail repeatedly for one Account.
