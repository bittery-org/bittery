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
	originAccountId: string | null,
	lock: (accountId: string) => Promise<LifecycleOutcome>,
	effects: MobileSessionReauthEffects,
): Promise<void> {
	if (!originAccountId) {
		throw new Error("Unauthorized response has no Account scope.");
	}
	const outcome = requireCompleteLifecycleOutcome(await lock(originAccountId), {
		operation: "Mobile session reauthentication",
		requireAffected: true,
	});
	effects.clearQueries();
	effects.notifyExpired();
	effects.navigate(outcome.wasActive);
}
