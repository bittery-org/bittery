/**
 * Desktop Mode Recovery Decision Helpers
 *
 * Service workers can be terminated at any time. These helpers keep the
 * restart-recovery decision deterministic and testable.
 */

export interface DesktopModeStateSnapshot {
	lastConnectedAt: number;
	activeAccount: string | null;
}

export type DesktopRecoveryReason =
	| "no_previous_state"
	| "within_recovery_window"
	| "state_too_old";

export interface DesktopRecoveryDecision {
	shouldAttemptRecovery: boolean;
	reason: DesktopRecoveryReason;
	ageMs: number | null;
}

export function evaluateDesktopRecoveryDecision(
	previousState: DesktopModeStateSnapshot | null,
	now: number,
	recoveryWindowMs: number,
): DesktopRecoveryDecision {
	if (!previousState) {
		return {
			shouldAttemptRecovery: false,
			reason: "no_previous_state",
			ageMs: null,
		};
	}

	const ageMs = Math.max(0, now - previousState.lastConnectedAt);
	if (ageMs < recoveryWindowMs) {
		return {
			shouldAttemptRecovery: true,
			reason: "within_recovery_window",
			ageMs,
		};
	}

	return {
		shouldAttemptRecovery: false,
		reason: "state_too_old",
		ageMs,
	};
}
