import type { LifecycleOutcome } from "@bittery/core/services/account-lifecycle";

/** Refuse to navigate as if a lock succeeded when any required lifecycle step failed. */
export function requireCompleteSessionLock(
	outcome: LifecycleOutcome,
): LifecycleOutcome {
	if (outcome.failures.length > 0) {
		throw new Error("Session reauthentication lock was incomplete", {
			cause: outcome.failures,
		});
	}
	return outcome;
}
