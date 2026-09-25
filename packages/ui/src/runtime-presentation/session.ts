import type {
	RuntimeSessionSnapshot,
	Subscribable,
} from "@bittery/client-runtime/client";

/**
 * Waits for the Device to answer.
 *
 * A route guard cannot decide on `loading`: the host must attach to the Runtime before
 * its first projection arrives. A failure is an answer — a broken transport publishes
 * `unavailable` — so this settles on everything except a Runtime that never replies.
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
