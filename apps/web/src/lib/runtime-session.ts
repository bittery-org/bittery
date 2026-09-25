import type { RuntimeSessionSnapshot } from "@bittery/client-runtime/client";

export { settledRuntimeSession } from "@bittery/ui/runtime-presentation";

/**
 * The `_app` route guard, as a decision rather than a side effect.
 *
 * It reads the Runtime's own published session. The old guard read
 * `storage.isAuthenticated()`, which was true only because Sign-in wrote the literal
 * `"runtime-session"` into the credential store — a value `api-client-factory` then sent as
 * a bearer token, so the first transitional query answered 401 and the router bounced the
 * user straight back out of the app it had just let them into.
 *
 * Anything short of `unlocked` goes to `/login`: that route already renders Quick Unlock for
 * a locked Account and the full ceremony for a signed-out one, so it is the lock screen.
 */
export function evaluateRuntimeSessionAccess(
	session: RuntimeSessionSnapshot,
): "/login" | null {
	return session.state === "unlocked" ? null : "/login";
}
