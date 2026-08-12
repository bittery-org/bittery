import { describe, expect, test } from "bun:test";
import type { IPendingMutationQueue } from "@bittery/types";
import { enqueueItemMutation, enqueuePendingMutation } from "./mutation-utils";

describe("Item command persistence", () => {
	test("does not resolve enqueue until the durable queue write completes", async () => {
		const gate = Promise.withResolvers<void>();
		let stored: unknown;
		let optimisticApplied = false;
		const queue: IPendingMutationQueue = {
			enqueue: async (mutation, applyOptimistic) => {
				stored = mutation;
				await gate.promise;
				await applyOptimistic?.();
			},
		};
		let resolved = false;
		const pending = enqueuePendingMutation(
			queue,
			{
				type: "delete",
				entityId: "item_1",
				vaultId: "vault_1",
				baseVersion: 4,
				accountId: "account_1",
				accountEmail: "alice@example.com",
			},
			async () => {
				optimisticApplied = true;
			},
		).then(() => {
			resolved = true;
		});

		await Promise.resolve();
		expect(stored).toBeDefined();
		expect(resolved).toBe(false);
		expect(optimisticApplied).toBe(false);
		gate.resolve();
		await pending;
		expect(resolved).toBe(true);
		expect(optimisticApplied).toBe(true);
	});

	test("enqueues content update and move commands", async () => {
		const calls: string[] = [];
		const queue: IPendingMutationQueue = {
			enqueue: async (command) => {
				calls.push(command.type);
			},
		};
		const context = {
			accountId: "account_1",
			accountEmail: "alice@example.com",
			baseVersion: 4,
			repo: {} as never,
		};

		for (const mutation of [
			{ type: "update" as const, entityId: "item_1", vaultId: "vault_1" },
			{
				type: "move" as const,
				entityId: "item_1",
				vaultId: "vault_1",
				targetVaultId: "vault_2",
			},
		]) {
			await enqueueItemMutation(queue, context, mutation);
		}

		expect(calls).toEqual(["update", "move"]);
	});
});
