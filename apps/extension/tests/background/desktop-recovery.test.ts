import { describe, expect, test } from "bun:test";
import { evaluateDesktopRecoveryDecision } from "../../src/background/services/desktop-recovery";

describe("desktop-recovery decision", () => {
	test("does not attempt recovery when there is no previous state", () => {
		const decision = evaluateDesktopRecoveryDecision(null, 1_000_000, 60_000);

		expect(decision).toEqual({
			shouldAttemptRecovery: false,
			reason: "no_previous_state",
			ageMs: null,
		});
	});

	test("attempts recovery when previous desktop mode state is within window", () => {
		const decision = evaluateDesktopRecoveryDecision(
			{
				lastConnectedAt: 1_000_000,
				activeAccount: "alice@example.com",
			},
			1_030_000,
			60_000,
		);

		expect(decision).toEqual({
			shouldAttemptRecovery: true,
			reason: "within_recovery_window",
			ageMs: 30_000,
		});
	});

	test("skips recovery when previous state is stale", () => {
		const decision = evaluateDesktopRecoveryDecision(
			{
				lastConnectedAt: 1_000_000,
				activeAccount: "all",
			},
			1_120_000,
			60_000,
		);

		expect(decision).toEqual({
			shouldAttemptRecovery: false,
			reason: "state_too_old",
			ageMs: 120_000,
		});
	});
});
