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
