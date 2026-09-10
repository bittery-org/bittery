import { describe, expect, mock, test } from "bun:test";
import path from "node:path";
import type { ItemSyncCommand } from "@bittery/types";

const backgroundDir = path.resolve(import.meta.dir, "../../src/background");
const localStorage = new Map<string, unknown>();
const sentItemIds: string[] = [];
const runtimeMessages: unknown[] = [];
const lockTails = new Map<string, Promise<void>>();

const locks = {
	request: async <T>(name: string, callback: () => Promise<T>): Promise<T> => {
		const previous = lockTails.get(name) ?? Promise.resolve();
		const release = Promise.withResolvers<void>();
		lockTails.set(
			name,
			previous.then(() => release.promise),
		);
		await previous;
		try {
			return await callback();
		} finally {
			release.resolve();
		}
	},
};

let releaseFirstRequest: (() => void) | undefined;
let markFirstRequestStarted: (() => void) | undefined;
const firstRequestStarted = new Promise<void>((resolve) => {
	markFirstRequestStarted = resolve;
});

const apiClient = {
	items: {
		create: async (_vaultId: string, itemId: string) => {
			sentItemIds.push(itemId);
			if (itemId === "item-a") {
				markFirstRequestStarted?.();
				await new Promise<void>((resolve) => {
					releaseFirstRequest = resolve;
				});
			}
			return {
				data: {
					operationId: `command-${itemId.slice("item-".length)}`,
					kind: "create_item",
					result: { status: "applied", itemId, version: 1 },
				},
				etag: null,
			};
		},
	},
};

Object.assign(globalThis, {
	navigator: { locks },
	chrome: {
		storage: {
			local: {
				get: async (keys: string | string[]) => {
					const requested = Array.isArray(keys) ? keys : [keys];
					return Object.fromEntries(
						requested
							.filter((key) => localStorage.has(key))
							.map((key) => [key, structuredClone(localStorage.get(key))]),
					);
				},
				set: async (items: Record<string, unknown>) => {
					for (const [key, value] of Object.entries(items)) {
						localStorage.set(key, structuredClone(value));
					}
				},
				remove: async (keys: string | string[]) => {
					for (const key of Array.isArray(keys) ? keys : [keys]) {
						localStorage.delete(key);
					}
				},
			},
		},
		alarms: {
			clear: async () => true,
			create: () => {},
		},
		runtime: {
			sendMessage: async (message: unknown) => {
				runtimeMessages.push(structuredClone(message));
				return undefined;
			},
		},
	},
});

mock.module(path.resolve(backgroundDir, "../lib/vault-runtime.ts"), () => ({
	vaultCrypto: {},
	vaultRepository: {
		applyItemCommand: async () => {},
		executeSemanticItemCommand: async () => undefined,
		discardItemCommandAcknowledgedElsewhere: async () => {},
		preserveItemConflict: async () => undefined,
		reconcileAuthoritative: async () => {},
		acknowledgeItemCommand: async () => {},
		replaceItemId: () => {},
		setEncryptionContextMigrationPort: async () => {},
	},
}));

mock.module(path.join(backgroundDir, "services/sync-cache-service.ts"), () => ({
	syncCacheService: {
		getClientForAccountId: async () => apiClient,
	},
}));

mock.module(path.join(backgroundDir, "sync-client-id.ts"), () => ({
	getOrCreateSyncClientId: async () => "extension-worker-client",
}));

mock.module(path.resolve(backgroundDir, "../lib/storage.ts"), () => ({
	storage: { getAccountsList: async () => [] },
	itemCache: {},
}));

const {
	drainOutboundQueue,
	enqueueOutboundCommand,
	getOutboundCommandSummary,
} = await import("../../src/background/outbound-drain");

function createCommand(id: string, timestamp: number): ItemSyncCommand {
	return {
		accountId: "account-a",
		id: `command-${id}`,
		type: "create",
		entityId: `item-${id}`,
		vaultId: "vault-a",
		category: "login",
		encryptedPayload: {
			encryptedData: `cipher-${id}`,
			encryptionIv: `iv-${id}`,
			encryptionAlgorithm: "AES-GCM-AAD-V1",
		},
		baseVersion: 0,
		timestamp,
		retryCount: 0,
	};
}

describe("background outbound drain ownership", () => {
	test("an enqueue concurrent with a worker drain cannot lose either command", async () => {
		await enqueueOutboundCommand(createCommand("a", 1));
		await firstRequestStarted;

		await enqueueOutboundCommand(createCommand("b", 2));
		releaseFirstRequest?.();
		await drainOutboundQueue();

		expect(sentItemIds).toEqual(["item-a", "item-b"]);
		expect(
			runtimeMessages
				.filter(
					(message): message is { type: string; command: ItemSyncCommand } =>
						!!message &&
						typeof message === "object" &&
						(message as { type?: string }).type ===
							"SYNC_ITEM_COMMAND_ACKNOWLEDGED",
				)
				.map((message) => message.command.id),
		).toEqual(["command-a", "command-b"]);
		expect(await getOutboundCommandSummary()).toEqual({
			pending: 0,
			retrying: 0,
			conflicted: 0,
			failed: 0,
		});
	});
});
