/**
 * Environment overrides for the API server that Playwright starts for E2E runs.
 *
 * WHY THIS EXISTS - please do not "clean this up":
 *
 * The auth endpoints are rate limited per IP and per email (see
 * `apps/server/src/services/rate_limit.rs`). Those defaults are tuned for real
 * users, where one IP is roughly one person. An E2E run is the opposite: the
 * entire suite - ~23 signups, ~45 logins and every other auth call, multiplied
 * by `retries` in CI and by parallel workers locally - originates from a single
 * client IP within a few minutes.
 *
 * With production defaults the suite trips its own limits partway through and
 * later tests fail with "Too many requests", which reads like a product bug:
 *   - RATE_LIMIT_SIGNUP_VERIFY_REQUEST (5/hour, enforced per email AND per IP)
 *     runs out after the 5th signup in the run.
 *   - RATE_LIMIT_SIGNUP_IP (10/hour) and RATE_LIMIT_LOGIN_IP (20/15min) run out
 *     shortly after.
 *   - RATE_LIMIT_SIGNUP_VERIFY_MAX is a *lifetime* failure counter keyed on the
 *     email hash that a fresh code request deliberately does not reset, so a
 *     spec that ever submits a wrong code would poison that address until the
 *     lockout expires.
 *
 * These are the same `RATE_LIMIT_*` variables the server already reads, set
 * only for the process Playwright spawns. Nothing here is a new server code
 * path, a "test mode" flag, or a change to any committed `.env` - so it cannot
 * leak into a real deployment. Rate limiting stays *on* under test; the budgets
 * are just raised past what one machine can spend in one run.
 *
 * Per-IP budgets are set high because "one IP" is meaningless here. Per-email
 * budgets stay modest on purpose: every spec signs up with a freshly generated
 * address (`generateTestUser()` in `tests/fixtures/test-fixtures.ts`), so a
 * per-email limit that trips still points at a real bug.
 *
 * Note: `webServer.reuseExistingServer` is true outside CI, so when a dev
 * server is already running locally these overrides are NOT applied to it - the
 * running server keeps its own environment. They take effect in CI, where
 * Playwright owns the server process.
 */
export const E2E_SERVER_RATE_LIMITS: Record<string, string> = {
	// Per-IP windows: raised well past a whole suite run (with CI retries).
	RATE_LIMIT_LOGIN_IP: "2000", // default 20 per 15 min
	RATE_LIMIT_SIGNUP_IP: "2000", // default 10 per hour
	RATE_LIMIT_AUTH_IP: "2000", // default 30 per 15 min (generic auth endpoints)

	// Signup verification code requests: 5/hour per email *and* per IP by
	// default; the per-IP half is what breaks the suite first.
	RATE_LIMIT_SIGNUP_VERIFY_REQUEST: "2000",

	// Per-email windows: kept small-ish, emails are unique per run.
	RATE_LIMIT_LOGIN_EMAIL: "200", // default 10 per 15 min
	RATE_LIMIT_SIGNUP_EMAIL: "50", // default 5 per hour

	// Lifetime wrong-code counter + lockout. Raised, and the lockout shortened
	// to the minimum so that a spec which deliberately submits a bad code
	// recovers inside the same run instead of poisoning the address for 15 min.
	RATE_LIMIT_SIGNUP_VERIFY_MAX: "500", // default 10 (lifetime, survives re-request)
	RATE_LIMIT_SIGNUP_VERIFY_LOCK_MINUTES: "1", // default 15

	// Share links are capped per *day*, so this one leaks across runs on the
	// same database if left at the default.
	SHARE_LINK_DAILY_LIMIT: "2000", // default 50 per day
};
