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
	originAccountId: string | null,
	lock: (accountId: string) => Promise<LifecycleOutcome>,
	effects: DesktopSessionReauthEffects,
): Promise<LifecycleOutcome> {
	if (!originAccountId) {
		throw new Error("Unauthorized response has no Account scope.");
	}
	const outcome = requireCompleteLifecycleOutcome(await lock(originAccountId), {
		operation: "Desktop session reauthentication",
		requireAffected: true,
	});
	effects.clearQueries();
	effects.notify();
	effects.navigateToUnlock();
	return outcome;
}
