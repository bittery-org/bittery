import { expect, mock, test } from "bun:test";
import path from "node:path";

const background = path.resolve(import.meta.dir, "../../src/background");
const lib = path.resolve(import.meta.dir, "../../src/lib");
const accountId = "desktop-material-account";
const localAccountId = "extension-local-account";
const trace: string[] = [];
let token: string | null = null;
let vaultKeys: unknown[] | null = null;
let muk = false;
let localMuk = true;
let desktopStatus: Record<string, unknown> | null = {
	available: true,
	locked: false,
	unlockedAccounts: [accountId],
	timestamp: 1,
	autolockTimeoutMs: 60_000,
	theme: null,
};
let vaultReads = 0;
let cleanupCount = 0;
let projectedRetirements = 0;
let failCleanup = false;
let holdSetter = true;
let holdCleanup = true;
let startSetter!: () => void;
let releaseSetter!: () => void;
const setterStarted = new Promise<void>((resolve) => (startSetter = resolve));
const setterGate = new Promise<void>((resolve) => (releaseSetter = resolve));
let startCleanup!: () => void;
let releaseCleanup!: () => void;
const cleanupStarted = new Promise<void>((resolve) => (startCleanup = resolve));
const cleanupGate = new Promise<void>((resolve) => (releaseCleanup = resolve));

mock.module(path.join(lib, "storage.ts"), () => ({
	storage: {
		getAccountMetadata: async (id: string) => ({
			accountId: id,
			email: `${id}@example.test`,
		}),
		getAccountsList: async () => [
			{ accountId, email: "desktop@example.test" },
			{ accountId: localAccountId, email: "local@example.test" },
		],
		getActiveAccount: async () => null,
		getAuthToken: async (id: string) =>
			id === accountId ? token : "local-token",
		getServerUrl: async () => "https://example.test",
		getVaultKeys: async (id: string) =>
			id === accountId ? vaultKeys : [{ vaultId: "local" }],
		storeAuthToken: async (value: string) => {
			trace.push("store-token");
			token = value;
		},
		storeVaultKeys: async (value: unknown[]) => {
			trace.push("setter-start");
			if (holdSetter) {
				startSetter();
				await setterGate;
				holdSetter = false;
			}
			vaultKeys = value;
			trace.push("setter-finish");
		},
		tryRestoreSession: async () => {
			muk = true;
			trace.push("restore-muk");
			return true;
		},
		getMasterUnlockKey: async (id: string) =>
			id === accountId && muk ? new Uint8Array([1]) : null,
		lockAllAccounts: async () => {
			cleanupCount += 1;
			trace.push("c1-start");
			startCleanup();
			if (holdCleanup) {
				await cleanupGate;
				holdCleanup = false;
			}
			if (failCleanup) throw new Error("incomplete local key erasure");
			muk = false;
			localMuk = false;
			trace.push("c1-complete");
		},
	},
	itemCache: { clearItemCache: async () => {} },
}));
mock.module(path.join(lib, "vault-runtime.ts"), () => ({
	vaultCrypto: {},
	vaultRepository: {},
}));
mock.module(path.join(background, "desktop-client.ts"), () => ({
	desktopClient: {
		getLockStatus: async () => desktopStatus,
		getAuthToken: async () => "native-token",
		getVaultKeys: async () => {
			vaultReads += 1;
			trace.push("read-native-vault");
			return {
				vaultKeys: JSON.stringify([
					{ vaultId: "native", encryptedVaultKey: `key-${vaultReads}` },
				]),
			};
		},
		clearCache: () => {},
	},
}));
mock.module(path.join(background, "core-instance.ts"), () => ({
	createBackgroundCore: () => ({ itemCommands: {} }),
}));
mock.module(path.join(background, "vault-runtime.ts"), () => ({
	backgroundClientRuntime: {
		accounts: {
			retireUnlockedProjection: () => {
				projectedRetirements++;
			},
		},
	},
	reconcileClientRuntime: async () => {},
}));
mock.module(path.join(background, "router/index.ts"), () => ({
	registerBackgroundMessageRouter: () => {},
}));
mock.module(
	path.join(background, "services/service-worker-lifecycle.ts"),
	() => ({
		initializeBackgroundServices: async () => {},
		ensureBackgroundServicesReady: async () => {},
		registerLifecycleListeners: () => {},
	}),
);

function makePort() {
	const messages = new Set<(message: unknown) => void>();
	const disconnects = new Set<() => void>();
	const posted: Array<{ requestId: string; type: string }> = [];
	return {
		port: {
			onMessage: {
				addListener: (listener: (message: unknown) => void) =>
					messages.add(listener),
			},
			onDisconnect: {
				addListener: (listener: () => void) => disconnects.add(listener),
			},
			postMessage: (message: { requestId: string; type: string }) =>
				posted.push(message),
			disconnect: () => {
				for (const listener of disconnects) listener();
			},
		} as unknown as chrome.runtime.Port,
		posted,
		emit: (message: unknown) => {
			for (const listener of messages) listener(message);
		},
		close: () => {
			for (const listener of disconnects) listener();
		},
	};
}
const ports: ReturnType<typeof makePort>[] = [];
(globalThis as { chrome?: typeof chrome }).chrome = {
	runtime: {
		connectNative: () => {
			const port = makePort();
			ports.push(port);
			return port.port;
		},
	},
	storage: { local: { remove: async () => {} } },
} as typeof chrome;

const { nativeMessagingClient } = await import(
	path.join(background, "native-messaging-client.ts")
);
const { getDesktopSync } = await import(
	path.join(background, "desktop-sync.ts")
);
const { vaultSession } = await import(
	path.join(background, "vault-session/index.ts")
);
const { hydrateDesktopAccountMaterial } = await import(
	path.join(background, "desktop-key-material.ts")
);
await import(path.join(background, "index.ts"));

async function openPort(): Promise<ReturnType<typeof makePort>> {
	const pending = nativeMessagingClient.request({ type: "PING" });
	const port = ports.at(-1);
	if (!port) throw new Error("Native test port was not created");
	const request = port.posted.at(-1);
	if (!request) throw new Error("Native test request was not posted");
	port.emit({
		protocolVersion: 1,
		requestId: request.requestId,
		type: "PONG",
	});
	await pending;
	return port;
}

test("configured ownerless retirement drains native material and requires C1 acknowledgement", async () => {
	const sync = getDesktopSync();
	await sync.checkDesktopStatus();
	expect(vaultSession.getSnapshot().owner).toBe("none");

	// An unrelated failed Desktop probe must leave the Extension's local session usable.
	desktopStatus = null;
	await sync.checkDesktopStatus();
	expect(localMuk).toBe(true);
	expect(cleanupCount).toBe(0);

	desktopStatus = {
		available: true,
		locked: false,
		unlockedAccounts: [accountId],
		timestamp: 2,
		autolockTimeoutMs: 60_000,
		theme: null,
	};
	await sync.checkDesktopStatus();
	const port = await openPort();
	const oldHydration = hydrateDesktopAccountMaterial(accountId);
	await setterStarted;
	expect(vaultSession.getSnapshot().owner).toBe("none");
	port.close();
	const successor = hydrateDesktopAccountMaterial(accountId);
	await Promise.resolve();
	expect(vaultReads).toBe(1);
	releaseSetter();
	await Promise.race([
		cleanupStarted,
		Bun.sleep(100).then(() => {
			throw new Error("C1 cleanup was not reached");
		}),
	]);
	expect(trace).toContain("setter-finish");
	expect(trace).not.toContain("c1-complete");
	expect(vaultReads).toBe(1);
	releaseCleanup();
	await oldHydration;
	await nativeMessagingClient.captureDeliveryGeneration();
	expect({ token, vaultKeys, muk }).toEqual({
		token: "native-token",
		vaultKeys: [{ vaultId: "native", encryptedVaultKey: "key-1" }],
		muk: false,
	});
	await successor;
	expect(vaultReads).toBe(1);
	expect({ token, muk }).toEqual({ token: "native-token", muk: true });
	expect(cleanupCount).toBe(1);
	expect(projectedRetirements).toBe(1);

	// The ordinary Desktop-owned Lock already runs C1 through the machine.
	await sync.handleUnlockEvent({ accounts: [accountId], timestamp: 3 });
	expect(vaultSession.getSnapshot().owner).toBe("desktop");
	const lockPort = await openPort();
	lockPort.emit({
		protocolVersion: 1,
		type: "DESKTOP_EVENT",
		event: "lock",
		payload: { reason: "Core Lock", timestamp: 4 },
	});
	await nativeMessagingClient.captureDeliveryGeneration();
	expect(cleanupCount).toBe(2);
	expect(projectedRetirements).toBe(2);
	expect({ token, vaultKeys, muk }).toEqual({
		token: "native-token",
		vaultKeys: [{ vaultId: "native", encryptedVaultKey: "key-1" }],
		muk: false,
	});

	// A returned incomplete C1 outcome keeps the same acquisition fence closed.
	await hydrateDesktopAccountMaterial(accountId);
	expect(muk).toBe(true);
	failCleanup = true;
	lockPort.emit({
		protocolVersion: 1,
		type: "DESKTOP_EVENT",
		event: "desktop_close",
		payload: { timestamp: 5 },
	});
	await expect(
		nativeMessagingClient.captureDeliveryGeneration(),
	).rejects.toThrow("did not complete safely");
	await expect(hydrateDesktopAccountMaterial(accountId)).rejects.toThrow(
		"did not complete safely",
	);
	expect(cleanupCount).toBe(3);
	expect(projectedRetirements).toBe(3);
});
