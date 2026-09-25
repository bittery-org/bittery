import { expect, mock, test } from "bun:test";
import path from "node:path";

const background = path.resolve(import.meta.dir, "../../src/background");
const lib = path.resolve(import.meta.dir, "../../src/lib");
const accountId = "account-material";
const trace: string[] = [];
let storedKeys: unknown[] | null = null;
let readCount = 0;
let releaseSetter!: () => void;
let setterEntered!: () => void;
const setterStarted = new Promise<void>((resolve) => {
	setterEntered = resolve;
});
const setterGate = new Promise<void>((resolve) => {
	releaseSetter = resolve;
});
let releaseCleanup!: () => void;
let cleanupEntered!: () => void;
const cleanupStarted = new Promise<void>((resolve) => {
	cleanupEntered = resolve;
});
const cleanupGate = new Promise<void>((resolve) => {
	releaseCleanup = resolve;
});

mock.module(path.join(lib, "storage.ts"), () => ({
	itemCache: {},
	storage: {
		getAccountMetadata: async () => ({ accountId }),
		getAuthToken: async () => "local-token",
		getMasterUnlockKey: async () => null,
		getVaultKeys: async () => storedKeys,
		storeVaultKeys: async (keys: unknown[]) => {
			const label = readCount === 1 ? "old" : "fresh";
			trace.push(`${label}-setter-start`);
			if (label === "old") {
				setterEntered();
				await setterGate;
			}
			storedKeys = keys;
			trace.push(`${label}-setter-end`);
		},
		tryRestoreSession: async () => {
			trace.push("restore");
			return true;
		},
	},
}));
mock.module(path.join(background, "desktop-client.ts"), () => ({
	desktopClient: {
		getVaultKeys: async () => {
			readCount += 1;
			trace.push(`read-${readCount}`);
			return {
				vaultKeys: JSON.stringify([
					{ vaultId: "vault-1", encryptedVaultKey: `key-${readCount}` },
				]),
			};
		},
		getAuthToken: async () => null,
	},
}));
mock.module(path.join(background, "desktop-status.ts"), () => ({
	isDesktopUnlockedNow: async () => true,
}));
mock.module(path.join(background, "native-messaging.ts"), () => ({
	handleNativeBiometricUnlockAll: async () => ({ success: false }),
}));

const listeners = new Set<(message: unknown) => void>();
const posted: Array<{ requestId: string; type: string }> = [];
const port = {
	onMessage: {
		addListener(listener: (message: unknown) => void) {
			listeners.add(listener);
		},
	},
	onDisconnect: { addListener() {} },
	postMessage(message: { requestId: string; type: string }) {
		posted.push(message);
	},
	disconnect() {},
} as unknown as chrome.runtime.Port;
(globalThis as { chrome?: typeof chrome }).chrome = {
	runtime: { connectNative: () => port },
} as typeof chrome;

const { nativeMessagingClient } = await import(
	path.join(background, "native-messaging-client.ts")
);
const { createLifecycleAdapter } = await import(
	path.join(background, "vault-session/adapters/lifecycle-adapter.ts")
);
const { hydrateDesktopAccountMaterial } = await import(
	path.join(background, "desktop-key-material.ts")
);

test("old nested setter drains before C1 cleanup and fresh hydration waits for its acknowledgement", async () => {
	const lifecycle = createLifecycleAdapter({
		deps: {} as never,
		lockAll: async () => {
			trace.push("cleanup-start");
			cleanupEntered();
			await cleanupGate;
			storedKeys = null;
			trace.push("cleanup-ack");
			return {
				affected: [],
				activeAccountId: undefined,
				activeAccount: null,
				wasActive: false,
				remaining: [],
				failures: [],
			};
		},
	});
	nativeMessagingClient.configureRetirementCleanup(() => lifecycle.lockAll());
	nativeMessagingClient.subscribeToDesktopEvents(() => {});
	const subscription = posted[0];
	for (const listener of listeners)
		listener({
			protocolVersion: 1,
			requestId: subscription.requestId,
			type: "DESKTOP_EVENT_SUBSCRIPTION",
			subscribed: true,
		});
	await Promise.resolve();

	const oldHydration = hydrateDesktopAccountMaterial(accountId);
	await setterStarted;
	for (const listener of listeners)
		listener({
			protocolVersion: 1,
			type: "DESKTOP_EVENT",
			event: "lock",
			payload: { reason: "Core lock", timestamp: 1 },
		});
	const successor = hydrateDesktopAccountMaterial(accountId);
	await Promise.resolve();
	expect(trace).toEqual(["read-1", "old-setter-start"]);

	releaseSetter();
	await cleanupStarted;
	expect(trace).toEqual([
		"read-1",
		"old-setter-start",
		"old-setter-end",
		"cleanup-start",
	]);
	expect(readCount).toBe(1);
	releaseCleanup();
	await Promise.all([oldHydration, successor]);
	expect(trace).toEqual([
		"read-1",
		"old-setter-start",
		"old-setter-end",
		"cleanup-start",
		"cleanup-ack",
		"read-2",
		"fresh-setter-start",
		"fresh-setter-end",
		"restore",
	]);
	expect(storedKeys).toEqual([
		{ vaultId: "vault-1", encryptedVaultKey: "key-2" },
	]);
});

test("a direct C1 failure keeps the native material acquisition gate closed", async () => {
	const failing = createLifecycleAdapter({
		deps: {} as never,
		lockAll: async () => ({
			affected: [],
			activeAccountId: undefined,
			activeAccount: null,
			wasActive: false,
			remaining: [],
			failures: [
				{ accountId, step: "lock_all_accounts", cause: "held storage" },
			],
		}),
	});
	await expect(failing.lockAll()).rejects.toThrow("did not complete safely");
	await expect(
		nativeMessagingClient.captureDeliveryGeneration(),
	).rejects.toThrow("did not complete safely");
});
