import { describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { ItemCommands } from "@bittery/core/services/item-commands";
import type { ItemSyncCommand } from "@bittery/types";
import { createExtensionItem } from "../../src/background/extension-item-mutations";
import { NativeMessagingClient } from "../../src/background/native-messaging-client";

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
let releaseReconnectRequest: (() => void) | undefined;
let reconnectRequestStarted!: () => void;
const reconnectStarted = new Promise<void>((resolve) => {
	reconnectRequestStarted = resolve;
});
let markFirstRequestStarted: (() => void) | undefined;
const firstRequestStarted = new Promise<void>((resolve) => {
	markFirstRequestStarted = resolve;
});

const apiClient = {
	items: {
		create: async (_vaultId: string, itemId: string) => {
			sentItemIds.push(itemId);
			if (itemId === "item-c") {
				reconnectRequestStarted();
				await new Promise<void>((resolve) => {
					releaseReconnectRequest = resolve;
				});
			}
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

	test("an actual Extension create keeps its accepted Operation through native reconnect", async () => {
		const ids = ["item-c", "command-c"];
		const commands = new ItemCommands({
			queue: { enqueue: enqueueOutboundCommand },
			repository: {
				findAccountForVault: () => ({ accountId: "account-a" }),
				getAccountInfo: () => ({ email: "a@example.com" }),
				getById: () => undefined,
				getDeleted: () => [],
				encryptForVault: async () => ({
					encryptedData: "cipher-c",
					encryptionIv: "iv-c",
					encryptionAlgorithm: "AES-GCM-AAD-V1",
				}),
			},
			resolveUserId: async () => "user-a",
			generateId: async () => ids.shift() ?? "unexpected-id",
			now: () => 3,
		});
		const created = await createExtensionItem(
			{
				vaultId: "vault-a",
				accountId: "account-a",
				category: "login",
				data: { title: "Retained local create" } as never,
			},
			commands,
		);
		expect(created.itemId).toBe("item-c");
		await reconnectStarted;
		const accepted = await getOutboundCommandSummary();
		expect(accepted.pending + accepted.retrying).toBeGreaterThan(0);

		const ports: Array<{
			disconnect: () => void;
			reply: (message: unknown) => void;
			requestId: () => string;
		}> = [];
		const native = new NativeMessagingClient({
			connectNative: () => {
				let reply = (_message: unknown) => {};
				let disconnected = () => {};
				let requestId = "";
				const port = {
					onMessage: {
						addListener(listener: (message: unknown) => void) {
							reply = listener;
						},
					},
					onDisconnect: {
						addListener(listener: () => void) {
							disconnected = listener;
						},
					},
					postMessage(message: { requestId: string }) {
						requestId = message.requestId;
					},
					disconnect() {
						disconnected();
					},
				} as unknown as chrome.runtime.Port;
				ports.push({
					disconnect: () => disconnected(),
					reply: (message) => reply(message),
					requestId: () => requestId,
				});
				return port;
			},
		});
		void native.request({ type: "PING" }).catch(() => {});
		ports[0]?.disconnect();
		const fresh = native.request({ type: "PING" });
		ports[1]?.reply({
			protocolVersion: 1,
			requestId: ports[1].requestId(),
			type: "PONG",
		});
		await fresh;
		expect(ports).toHaveLength(2);
		expect(
			(await getOutboundCommandSummary()).pending +
				(await getOutboundCommandSummary()).retrying,
		).toBeGreaterThan(0);

		releaseReconnectRequest?.();
		await drainOutboundQueue();
		expect(sentItemIds).toContain("item-c");
		expect(await getOutboundCommandSummary()).toEqual({
			pending: 0,
			retrying: 0,
			conflicted: 0,
			failed: 0,
		});
		expect(
			runtimeMessages
				.filter(
					(message): message is { type: string; command: ItemSyncCommand } =>
						!!message &&
						typeof message === "object" &&
						(message as { type?: string }).type ===
							"SYNC_ITEM_COMMAND_ACKNOWLEDGED",
				)
				.map((message) => message.command.operationId),
		).toContain("command-c");
	});
});
