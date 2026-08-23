import {
	type LifecycleOutcome,
	requireCompleteLifecycleOutcome,
} from "@bittery/core/services/account-lifecycle";

export interface DesktopSessionReauthEffects {
	clearQueries(): void;
	notify(): void;
	navigateToUnlock(): void;
}

/** Apply host effects only after every Account-lock lifecycle step succeeded. */
export async function reauthenticateDesktopSession(
	lock: () => Promise<LifecycleOutcome>,
	effects: DesktopSessionReauthEffects,
): Promise<LifecycleOutcome> {
	const outcome = requireCompleteLifecycleOutcome(await lock(), {
		operation: "Desktop session reauthentication",
	});
	effects.clearQueries();
	effects.notify();
	effects.navigateToUnlock();
	return outcome;
}
