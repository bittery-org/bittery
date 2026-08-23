import type { LifecycleOutcome } from "@bittery/core/services/account-lifecycle";

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
	const outcome = await lock();
	if (outcome.failures.length > 0) {
		throw new Error("Desktop session reauthentication lock was incomplete", {
			cause: outcome.failures,
		});
	}
	effects.clearQueries();
	effects.notify();
	effects.navigateToUnlock();
	return outcome;
}
