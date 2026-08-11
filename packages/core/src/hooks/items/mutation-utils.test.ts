import { describe, expect, test } from "bun:test";
import type { IPendingMutationQueue } from "@bittery/types";
import {
	enqueuePendingMutation,
	toQueueEncryptedPayload,
} from "./mutation-utils";

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
		const pending = enqueuePendingMutation(queue, {
			type: "delete",
			entityId: "item_1",
			vaultId: "vault_1",
			baseVersion: 4,
			accountId: "account_1",
			accountEmail: "alice@example.com",
		}, async () => {
			optimisticApplied = true;
		}).then(() => {
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

	test("keeps the exact AAD context with encrypted command payloads", () => {
		expect(
			toQueueEncryptedPayload({
				ciphertext: "ciphertext",
				iv: "iv",
				algorithm: "AES-GCM-AAD-V1",
				encryptionVersion: 5,
				encryptedByUserId: "user_2",
			}),
		).toEqual({
			encryptedData: "ciphertext",
			encryptionIv: "iv",
			encryptionAlgorithm: "AES-GCM-AAD-V1",
			encryptionVersion: 5,
			encryptedByUserId: "user_2",
		});
	});
});
