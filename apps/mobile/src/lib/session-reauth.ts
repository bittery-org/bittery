import {
	type LifecycleOutcome,
	requireCompleteLifecycleOutcome,
} from "@bittery/core/services/account-lifecycle";

export interface MobileSessionReauthEffects {
	clearQueries(): void;
	notifyExpired(): void;
	navigate(wasActive: boolean): void;
}

/** Applies host effects only after every required lock step completed. */
export async function reauthenticateMobileSession(
	lock: () => Promise<LifecycleOutcome>,
	effects: MobileSessionReauthEffects,
): Promise<void> {
	const outcome = requireCompleteLifecycleOutcome(await lock(), {
		operation: "Mobile session reauthentication",
	});
	effects.clearQueries();
	effects.notifyExpired();
	effects.navigate(outcome.wasActive);
}
