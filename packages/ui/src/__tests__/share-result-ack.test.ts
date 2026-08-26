import { describe, expect, mock, test } from "bun:test";
import { retryShareResultAcknowledgement } from "../components/sharing/share-item-dialog";

describe("delivered Share result acknowledgement", () => {
	test("keeps retrying failures until Runtime durably acknowledges", async () => {
		const scheduled: Array<() => void> = [];
		let failures = 7;
		const acknowledge = mock(async () => {
			if (failures > 0) {
				failures -= 1;
				throw new Error("persistence unavailable");
			}
		});
		const delivered = mock(() => undefined);
		const cancel = retryShareResultAcknowledgement(
			acknowledge,
			delivered,
			(run) => {
				scheduled.push(run);
				return () => undefined;
			},
		);

		for (let index = 0; index < 7; index += 1) {
			await Promise.resolve();
			const retry = scheduled.shift();
			expect(retry).toBeDefined();
			retry?.();
		}
		await Promise.resolve();
		await Promise.resolve();
		expect(acknowledge).toHaveBeenCalledTimes(8);
		expect(delivered).toHaveBeenCalledTimes(1);
		cancel();
	});
});
