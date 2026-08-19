export type AddAccountExit =
	| { kind: "back" }
	| { kind: "navigate"; to: "/vault" | "/unlock" };

/**
 * Where "Add account" should send the user when they leave without signing in.
 *
 * Prefer the screen they came from (the switcher in the vault, or unlock). A cold
 * start or a deep link may have no history, so fall back to the vault if that
 * account is still unlocked, otherwise to unlock.
 */
export function resolveAddAccountExit(input: {
	canGoBack: boolean;
	isUnlocked: boolean;
}): AddAccountExit {
	if (input.canGoBack) {
		return { kind: "back" };
	}

	return {
		kind: "navigate",
		to: input.isUnlocked ? "/vault" : "/unlock",
	};
}
