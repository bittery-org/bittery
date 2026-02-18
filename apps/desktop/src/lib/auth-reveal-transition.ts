const AUTH_REVEAL_TO_VAULT_EVENT = "bittery:auth-reveal-to-vault";

export function triggerAuthRevealToVault(): void {
	if (typeof window === "undefined") {
		return;
	}

	window.dispatchEvent(new Event(AUTH_REVEAL_TO_VAULT_EVENT));
}

export function subscribeAuthRevealToVault(onTrigger: () => void): () => void {
	if (typeof window === "undefined") {
		return () => {};
	}

	window.addEventListener(AUTH_REVEAL_TO_VAULT_EVENT, onTrigger);
	return () => {
		window.removeEventListener(AUTH_REVEAL_TO_VAULT_EVENT, onTrigger);
	};
}
