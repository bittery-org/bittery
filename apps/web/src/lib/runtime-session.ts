import type {
	RuntimeSessionSnapshot,
	Subscribable,
} from "@bittery/client-runtime/client";

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

/**
 * Waits for the Device to answer.
 *
 * A route guard cannot decide on `loading`, and the first read always is: the Worker spawns
 * and instantiates WASM before the first projection arrives. A failure is an answer —
 * a broken transport publishes `unavailable` — so this settles on everything except a
 * Runtime that never replies at all.
 */
export function settledRuntimeSession(
	store: Subscribable<RuntimeSessionSnapshot>,
): Promise<RuntimeSessionSnapshot> {
	const current = store.getSnapshot();
	if (current.state !== "loading") return Promise.resolve(current);
	return new Promise((resolve) => {
		let settled = false;
		let release: (() => void) | undefined;
		const check = () => {
			if (settled) return;
			const snapshot = store.getSnapshot();
			if (snapshot.state === "loading") return;
			settled = true;
			resolve(snapshot);
			release?.();
		};
		// Subscribing is what opens the observation, and it notifies synchronously, so the
		// first read has to happen after it rather than before.
		release = store.subscribe(check);
		check();
		if (settled) release();
	});
}
