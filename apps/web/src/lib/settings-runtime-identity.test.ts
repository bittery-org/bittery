import { describe, expect, test } from "bun:test";
import type { RuntimeSessionSnapshot } from "@bittery/client-runtime/client";
import {
	activeRuntimeAccountDeletionTarget,
	activeRuntimeAccountDisplayIdentity,
	advanceSettingsDeletionGesture,
} from "./settings-runtime-identity";

describe("Settings deletion Runtime identity wiring", () => {
	test("selects only the active Account's validated display identity", () => {
		const session: RuntimeSessionSnapshot = {
			state: "unlocked",
			accountId: "account-2",
			accounts: [
				{
					accountId: "account-1",
					access: "unlocked",
					displayIdentity: { email: "wrong@example.test" },
					failure: null,
					replicaRevision: "1",
				},
				{
					accountId: "account-2",
					access: "unlocked",
					displayIdentity: { email: "person@example.test" },
					failure: null,
					replicaRevision: "1",
				},
			],
			waitingReason: null,
			code: null,
		};

		expect(activeRuntimeAccountDisplayIdentity(session)).toEqual({
			email: "person@example.test",
		});
	});

	test("does not fabricate an identity for recovery or a stale Account", () => {
		const recoverySession: RuntimeSessionSnapshot = {
			state: "signedOut",
			accountId: "account-recovery",
			accounts: [
				{
					accountId: "account-recovery",
					access: "signedOut",
					failure: "INVARIANT_VIOLATION",
					replicaRevision: "0",
				},
			],
			waitingReason: null,
			code: "INVARIANT_VIOLATION",
		};
		const staleSession = {
			...recoverySession,
			state: "missing",
			accountId: "account-stale",
		} satisfies RuntimeSessionSnapshot;

		expect(activeRuntimeAccountDisplayIdentity(recoverySession)).toBeNull();
		expect(activeRuntimeAccountDisplayIdentity(staleSession)).toBeNull();
	});

	test("holds the first deletion gesture target across fallback activation and incomplete dismissal", () => {
		const accountA = {
			runtimeAccountId: "runtime-account-a",
			email: "account-a@example.test",
		};
		const accountB = {
			runtimeAccountId: "runtime-account-b",
			email: "account-b@example.test",
		};
		let gesture = advanceSettingsDeletionGesture(null, {
			type: "started",
			target: accountA,
		});

		gesture = advanceSettingsDeletionGesture(gesture, {
			type: "started",
			target: accountB,
		});
		expect(gesture).toEqual({ target: accountA });
		expect(
			advanceSettingsDeletionGesture(gesture, {
				type: "incompleteDismissed",
			}),
		).toEqual({ target: accountA });
	});

	test("releases a deletion gesture only on cancel or terminal completion", () => {
		const held = {
			target: {
				runtimeAccountId: "runtime-account-a",
				email: "account-a@example.test",
			},
		};

		expect(
			advanceSettingsDeletionGesture(held, { type: "canceled" }),
		).toBeNull();
		expect(
			advanceSettingsDeletionGesture(held, { type: "terminal" }),
		).toBeNull();
	});

	test("pairs the active Runtime account id with its own validated email", () => {
		const session: RuntimeSessionSnapshot = {
			state: "unlocked",
			accountId: "account-2",
			accounts: [
				{
					accountId: "account-1",
					access: "unlocked",
					displayIdentity: { email: "wrong@example.test" },
					failure: null,
					replicaRevision: "1",
				},
				{
					accountId: "account-2",
					access: "unlocked",
					displayIdentity: { email: "right@example.test" },
					failure: null,
					replicaRevision: "1",
				},
			],
			waitingReason: null,
			code: null,
		};

		expect(activeRuntimeAccountDeletionTarget(session)).toEqual({
			runtimeAccountId: "account-2",
			email: "right@example.test",
		});
	});
});
