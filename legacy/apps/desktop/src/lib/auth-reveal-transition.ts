const AUTH_REVEAL_LISTENERS = Symbol.for(
	"bittery.desktop.auth-reveal-listeners",
);
const existingListeners = Reflect.get(globalThis, AUTH_REVEAL_LISTENERS);
const authRevealListeners: Set<() => void> =
	existingListeners instanceof Set ? existingListeners : new Set();

// The root route can survive while Vite replaces the unlock module. Keep the
// listener registry on the process global so both module instances share it.
if (existingListeners !== authRevealListeners) {
	Reflect.set(globalThis, AUTH_REVEAL_LISTENERS, authRevealListeners);
}

export function triggerAuthRevealToVault(): void {
	for (const listener of [...authRevealListeners]) {
		listener();
	}
}

export function subscribeAuthRevealToVault(onTrigger: () => void): () => void {
	authRevealListeners.add(onTrigger);
	return () => {
		authRevealListeners.delete(onTrigger);
	};
}
