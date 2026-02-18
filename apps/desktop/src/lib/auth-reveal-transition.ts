const authRevealListeners = new Set<() => void>();

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
