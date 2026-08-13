import { describe, expect, test } from "bun:test";
import type { ItemSyncCommand } from "@bittery/types";
import {
	isWorkerItemCommandAcknowledgedMessage,
	reconcileWorkerItemCommandAcknowledgement,
} from "../../src/lib/worker-item-acknowledgement";

describe("worker Item acknowledgement", () => {
	test("rejects malformed runtime messages before projection access", () => {
		expect(
			isWorkerItemCommandAcknowledgedMessage({
				type: "SYNC_ITEM_COMMAND_ACKNOWLEDGED",
				command: {
					id: "operation-a",
					operationId: "",
					accountId: "account-a",
					entityId: "item-a",
					vaultId: "vault-a",
					type: "update",
					baseVersion: 1,
					timestamp: 1,
					retryCount: 0,
				},
				acknowledgement: {
					entityId: "item-a",
					etag: '"2"',
					version: 2,
				},
			}),
		).toBe(false);
		expect(
			isWorkerItemCommandAcknowledgedMessage({
				type: "SYNC_ITEM_COMMAND_ACKNOWLEDGED",
				command: {
					id: "operation-a",
					operationId: "operation-a",
					accountId: "account-a",
					entityId: "item-a",
					vaultId: "vault-a",
					type: "forged_operation",
					baseVersion: 1,
					timestamp: 1,
					retryCount: 0,
				},
				acknowledgement: {
					entityId: "item-a",
					etag: {},
					version: -1,
				},
			}),
		).toBe(false);
		expect(
			isWorkerItemCommandAcknowledgedMessage({
				type: "SYNC_ITEM_COMMAND_ACKNOWLEDGED",
				command: {
					id: "operation-a",
					operationId: "operation-a",
					accountId: "account-a",
					entityId: "item-a",
					vaultId: "vault-a",
					type: "update",
					baseVersion: 1,
					timestamp: 1,
					retryCount: 0,
				},
				acknowledgement: {
					entityId: "different-item",
					etag: '"2"',
					version: 2,
				},
			}),
		).toBe(false);
	});

	test("removes the matching popup overlay and advances the next write base", async () => {
		const pendingOperations = new Set(["operation-a"]);
		let currentVersion = 1;
		const command: ItemSyncCommand = {
			accountId: "account-a",
			id: "operation-a",
			operationId: "operation-a",
			type: "toggle_favorite",
			entityId: "item-a",
			vaultId: "vault-a",
			favorite: true,
			baseVersion: 1,
			timestamp: 1,
			retryCount: 0,
		};
		const message = {
			type: "SYNC_ITEM_COMMAND_ACKNOWLEDGED",
			command,
			acknowledgement: {
				entityId: "item-a",
				etag: '"2"',
				version: 2,
			},
		} as const;
		expect(isWorkerItemCommandAcknowledgedMessage(message)).toBe(true);

		await reconcileWorkerItemCommandAcknowledgement(message, {
			acknowledgeItemCommand: async (acknowledged, acknowledgement) => {
				pendingOperations.delete(acknowledged.operationId ?? acknowledged.id);
				currentVersion = acknowledgement.version ?? currentVersion;
			},
		});

		expect(pendingOperations).toEqual(new Set());
		expect(currentVersion).toBe(2);
		expect({ baseVersion: currentVersion }).toEqual({ baseVersion: 2 });
	});
});
