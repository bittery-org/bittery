import { describe, expect, test } from "bun:test";
import { notifyWorkerAccountScopeChanged } from "../../src/lib/account-scope-notification";

const flushMicrotasks = () => new Promise((resolve) => queueMicrotask(resolve));

describe("popup account-scope notification", () => {
	test("does not wait for the worker acknowledgement", () => {
		let resolve!: () => void;
		const pending = new Promise<void>((done) => {
			resolve = done;
		});
		let calls = 0;

		const result = notifyWorkerAccountScopeChanged(() => {
			calls++;
			return pending;
		});

		expect(result).toBeUndefined();
		expect(calls).toBe(1);
		resolve();
	});

	test("contains an unavailable worker as a deferred reconciliation", async () => {
		const warnings: unknown[][] = [];
		notifyWorkerAccountScopeChanged(
			async () => {
				throw new Error("worker asleep");
			},
			{ warn: (...args) => warnings.push(args) },
		);

		await flushMicrotasks();
		expect(warnings).toHaveLength(1);
		expect(String(warnings[0]?.[1])).toContain("worker asleep");
	});
});
