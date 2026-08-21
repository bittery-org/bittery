# Abuse defense, rate limiting, and enumeration resistance

Type: grilling
Status: resolved
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

## Answer

Bittery uses layered local abuse controls and never creates a hard Account lock. A completed failed
full sign-in or recovery sign-in enters a progressive **Sign-in cooldown** after five failures: one,
two, four, eight, then fifteen minutes, capped there. Success clears it and twenty-four quiet hours
reset it. Starts and abandoned exchanges consume request and concurrency budgets but do not count as
credential failures. A targeted attacker can keep an Account at one attempt per fifteen minutes, so
the remaining denial of service is Acknowledged rather than disguised as solved.

OPAQUE starts default to ten per normalized login subject and twenty per source in fifteen minutes.
An attempt lives for five minutes; at most three are live per subject and twenty per source, plus a
deployment-sized Server capacity. Excess starts reject the newcomer and never evict accepted work.
Unknown Accounts run RFC 9807's fake-record path with the ordinary versioned Server setup, fresh
per-attempt state, and no second seed or persisted fake registration. Real and fake exchanges share
their outward status, shape, size class, lifecycle, and limits; exact network timing is not promised.

All public signup, sign-in, recovery, invitation, and Share identifier checks conceal target existence.
Only an authenticated relationship check or possession of an unguessable invitation or Share token
may reveal state. Message-producing public ceremonies default to five requests per keyed subject and
ten per source per hour. A short code burns after five failures and imposes a fifteen-minute subject
cooldown which survives replacement. Clients show one generic credential error; cooldowns return the
same `429` and `Retry-After` for real and unknown subjects, while Server saturation returns `503`.

Password change, Secret Key rotation, Recovery Key create/replace/revoke, and mass Device revocation
each get an independent five-per-Account-per-hour budget, counting successful and failed submissions.
They never consume the credential-failure cooldown. Server-wide protection measures live attempts,
expensive authentication work, queued limiter writes, and database capacity separately rather than
using one global request bucket.

PostgreSQL is the default abuse-state authority. Redis or Valkey is a selectable alternative with the
same atomic contract, selected only at startup and never used as a live fallback. Its required profile
is persistent and non-evicting; a namespace marker detects state loss, after which protected traffic
fails closed until an operator explicitly acknowledges reinitialization. Protected credential and
verification policies may only be strengthened. Positive source, concurrency, and capacity settings
may scale to the deployment but cannot be disabled.

The direct transport peer supplies the source address unless an explicitly trusted proxy is configured
to replace forwarding headers. Public identifiers and capabilities are keyed digests in limiter state;
raw credentials and bearer capabilities are never stored, and enforcement state expires with its
purpose. The first release adds no CAPTCHA, proof of work, external bot provider, or speculative
provider interface.

Promoted to `ABUSE-001` through `ABUSE-014` in
[`docs/greenfield/target/product.md`](../../../docs/greenfield/target/product.md), with **Sign-in
cooldown** and **Fake OPAQUE exchange** added to [`CONTEXT.md`](../../../CONTEXT.md). The legacy fake
verifier and rate-limiting subsystem now have explicit replacement rows in
[`feature-disposition.md`](../../../docs/greenfield/feature-disposition.md). No ADR is warranted: these
are testable, configurable security policies rather than a hard-to-reverse architectural commitment.
