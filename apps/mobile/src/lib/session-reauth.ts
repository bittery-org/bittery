import type { LifecycleOutcome } from "@bittery/core/services/account-lifecycle";

export interface MobileSessionReauthEffects {
	clearQueries(): void;
	notifyExpired(): void;
	navigate(wasActive: boolean): void;
}

export function requireCompleteMobileSessionLock(
	outcome: LifecycleOutcome,
): LifecycleOutcome {
	if (outcome.failures.length > 0) {
		throw new Error("Could not safely lock the rejected session.", {
			cause: outcome.failures,
		});
	}
	return outcome;
}

/** Applies host effects only after every required lock step completed. */
export async function reauthenticateMobileSession(
	lock: () => Promise<LifecycleOutcome>,
	effects: MobileSessionReauthEffects,
): Promise<void> {
	const outcome = requireCompleteMobileSessionLock(await lock());
	effects.clearQueries();
	effects.notifyExpired();
	effects.navigate(outcome.wasActive);
}
