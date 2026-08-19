import { describe, expect, test } from "bun:test";
import type { ItemSyncCommand } from "@bittery/types";
import {
	createWorkerOwnedOutboundQueue,
	type WorkerQueueMessage,
} from "../../src/lib/worker-owned-outbound-queue";

const command: ItemSyncCommand = {
	accountId: "account-a",
	id: "command-a",
	type: "toggle_favorite",
	entityId: "item-a",
	vaultId: "vault-a",
	favorite: true,
	baseVersion: 1,
	timestamp: 1,
	retryCount: 0,
};

describe("worker-owned outbound queue", () => {
	test("popup delegates ownership to the worker before applying its projection", async () => {
		const calls: string[] = [];
		const queue = createWorkerOwnedOutboundQueue({
			sendMessage: async (message) => {
				calls.push(`worker:${message.type}`);
				return {
					success: true,
					commands:
						message.type === "CLAIM_STAGED_ITEM_COMMANDS"
							? [command]
							: undefined,
				};
			},
			applyProjection: async () => {
				calls.push("popup:project");
			},
		});

		await queue.enqueue(command);

		expect(calls).toEqual([
			"worker:ENQUEUE_ITEM_COMMAND",
			"popup:project",
			"worker:DRAIN_OUTBOUND_QUEUE",
		]);
	});

	test("a fast worker ACK cannot overtake the popup projection", async () => {
		let projected = false;
		let acknowledged = false;
		const queue = createWorkerOwnedOutboundQueue({
			sendMessage: async (message) => {
				if (message.type === "DRAIN_OUTBOUND_QUEUE") {
					expect(projected).toBe(true);
					acknowledged = true;
				}
				return { success: true };
			},
			applyProjection: async () => {
				await Promise.resolve();
				projected = true;
			},
		});

		await queue.enqueue(command);

		expect(acknowledged).toBe(true);
	});

	test("does not project a command the worker failed to persist", async () => {
		let projected = false;
		const queue = createWorkerOwnedOutboundQueue({
			sendMessage: async () => ({ success: false, error: "storage failed" }),
			applyProjection: async () => {
				projected = true;
			},
		});

		expect(queue.enqueue(command)).rejects.toThrow("storage failed");
		expect(projected).toBe(false);
	});

	test("cancels the durable worker command when popup projection fails", async () => {
		const calls: string[] = [];
		const queue = createWorkerOwnedOutboundQueue({
			sendMessage: async (message) => {
				calls.push(message.type);
				return { success: true };
			},
			applyProjection: async () => {
				throw new Error("popup cache unavailable");
			},
		});

		expect(queue.enqueue(command)).rejects.toThrow("popup cache unavailable");
		expect(calls).toEqual([
			"ENQUEUE_ITEM_COMMAND",
			"CANCEL_STAGED_ITEM_COMMAND",
		]);
	});

	test("popup reopen projects staged commands before activating them", async () => {
		const calls: string[] = [];
		const queue = createWorkerOwnedOutboundQueue({
			sendMessage: async (message) => {
				calls.push(`worker:${message.type}`);
				return {
					success: true,
					commands:
						message.type === "CLAIM_STAGED_ITEM_COMMANDS"
							? [command]
							: undefined,
				};
			},
			applyProjection: async (staged) => {
				calls.push(`popup:project:${staged.id}`);
			},
		});

		await queue.recoverStaged();

		expect(calls).toEqual([
			"worker:CLAIM_STAGED_ITEM_COMMANDS",
			"popup:project:command-a",
			"worker:DRAIN_OUTBOUND_QUEUE",
		]);
	});

	test("two popup recoveries cannot project the same claimed operation", async () => {
		let claimed = false;
		let acknowledged = false;
		let popupBProjections = 0;
		const projectionStarted = Promise.withResolvers<void>();
		const releaseProjection = Promise.withResolvers<void>();
		const sendMessage = async (message: {
			type: string;
		}): Promise<{ success: boolean; commands?: ItemSyncCommand[] }> => {
			if (message.type === "CLAIM_STAGED_ITEM_COMMANDS") {
				if (claimed) return { success: true, commands: [] };
				claimed = true;
				return { success: true, commands: [command] };
			}
			if (message.type === "DRAIN_OUTBOUND_QUEUE") acknowledged = true;
			return { success: true };
		};
		const popupA = createWorkerOwnedOutboundQueue({
			sendMessage,
			applyProjection: async () => {
				projectionStarted.resolve();
				await releaseProjection.promise;
			},
		});
		const popupB = createWorkerOwnedOutboundQueue({
			sendMessage,
			applyProjection: async () => {
				popupBProjections += 1;
			},
		});

		const recoveryA = popupA.recoverStaged();
		await projectionStarted.promise;
		await popupB.recoverStaged();
		releaseProjection.resolve();
		await recoveryA;

		expect(acknowledged).toBe(true);
		expect(popupBProjections).toBe(0);
	});

	test("an expired slow claimant discards its overlay after the new claimant ACKs", async () => {
		let claimOwner = "";
		let claimCount = 0;
		let authoritativeVersion = 1;
		let popupAOverlay = false;
		let popupABaseVersion = 1;
		const popupAStarted = Promise.withResolvers<void>();
		const releasePopupA = Promise.withResolvers<void>();
		const sendMessage = async (message: WorkerQueueMessage) => {
			if (message.type === "CLAIM_STAGED_ITEM_COMMANDS") {
				claimCount += 1;
				claimOwner = message.payload.claimId;
				return { success: true, commands: [command] };
			}
			if (message.type === "DRAIN_OUTBOUND_QUEUE") {
				if (message.payload.claimId !== claimOwner) {
					return {
						success: false,
						code: "CLAIM_LOST" as const,
						error: "claim expired",
					};
				}
				authoritativeVersion = 2;
				return { success: true };
			}
			return { success: true };
		};
		const popupA = createWorkerOwnedOutboundQueue({
			sendMessage,
			applyProjection: async () => {
				popupAOverlay = true;
				popupAStarted.resolve();
				await releasePopupA.promise;
			},
			discardProjection: async () => {
				popupAOverlay = false;
				popupABaseVersion = authoritativeVersion;
			},
		});
		const popupB = createWorkerOwnedOutboundQueue({
			sendMessage,
			applyProjection: async () => undefined,
		});

		const recoveryA = popupA.recoverStaged();
		await popupAStarted.promise;
		await popupB.recoverStaged();
		expect(authoritativeVersion).toBe(2);
		releasePopupA.resolve();
		expect(recoveryA).rejects.toThrow("claim expired");

		expect(claimCount).toBe(2);
		expect(popupAOverlay).toBe(false);
		expect(popupABaseVersion).toBe(2);
	});
});
