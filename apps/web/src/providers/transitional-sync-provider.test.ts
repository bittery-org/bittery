import { describe, expect, test } from "bun:test";
import { INERT_OUTBOUND_QUEUE } from "./transitional-sync-provider";

/**
 * The spec forbids two active writers for one Account, and the Runtime is the Web's writer
 * now. These pin the two halves of that: the loop is gone from the source, and the only
 * queue the Web still hands the transitional stack dispatches nothing.
 *
 * `scripts/transitional-reachability.test.ts` proves the first half over the whole entry
 * graph, where absence is the right proof. This proves the second half by behaviour.
 */
describe("what the Web still hands the transitional stack", () => {
	test("an enqueued command applies locally and is never staged", async () => {
		let applied = 0;
		await INERT_OUTBOUND_QUEUE.enqueue(
			{
				id: "command-1",
				accountId: "account-1",
				type: "update",
			} as unknown as Parameters<typeof INERT_OUTBOUND_QUEUE.enqueue>[0],
			async () => {
				applied += 1;
			},
		);
		expect(applied).toBe(1);
		expect(INERT_OUTBOUND_QUEUE.getPendingCount?.()).toBe(0);
		expect(INERT_OUTBOUND_QUEUE.getCommands?.("account-1")).toEqual([]);
		expect(INERT_OUTBOUND_QUEUE.hasPendingForItem?.("item-1")).toBe(false);
	});

	test("a command with nothing to apply is still not an error", async () => {
		await INERT_OUTBOUND_QUEUE.enqueue({
			id: "command-2",
			accountId: "account-1",
		} as unknown as Parameters<typeof INERT_OUTBOUND_QUEUE.enqueue>[0]);
	});
});
