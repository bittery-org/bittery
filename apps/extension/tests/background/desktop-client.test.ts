import { describe, expect, test } from "bun:test";
import { DesktopClient } from "../../src/background/desktop-client";
import { NativeMessagingClient } from "../../src/background/native-messaging-client";

type FakeListener<T> = (value: T) => void;

function createFakePort() {
	const messageListeners = new Set<FakeListener<unknown>>();
	const disconnectListeners = new Set<FakeListener<void>>();
	const postedMessages: unknown[] = [];

	const port = {
		onMessage: {
			addListener(listener: FakeListener<unknown>) {
				messageListeners.add(listener);
			},
		},
		onDisconnect: {
			addListener(listener: FakeListener<void>) {
				disconnectListeners.add(listener);
			},
		},
		postMessage(message: unknown) {
			postedMessages.push(message);
		},
		disconnect() {
			for (const listener of disconnectListeners) {
				listener();
			}
		},
	} as chrome.runtime.Port;

	return {
		port,
		postedMessages,
		emitMessage(message: unknown) {
			for (const listener of messageListeners) {
				listener(message);
			}
		},
		emitDisconnect(lastError?: string) {
			(globalThis as { chrome?: typeof chrome }).chrome = {
				runtime: {
					lastError: lastError ? { message: lastError } : undefined,
				},
			} as typeof chrome;
			for (const listener of disconnectListeners) {
				listener();
			}
		},
	};
}

describe("desktop-client native transport", () => {
	test("routes desktop status requests over native messaging", async () => {
		const nativeClient = {
			request: async () => ({
				type: "DESKTOP_STATUS" as const,
				available: true,
				locked: false,
				unlockedAccounts: ["alice@example.com"],
				timestamp: 123,
				autolockTimeoutMs: 456,
			}),
			subscribeToDesktopEvents: () => () => {},
		};

		const client = new DesktopClient({ nativeClient });
		const status = await client.getLockStatus();

		expect(status).toEqual({
			available: true,
			locked: false,
			unlockedAccounts: ["alice@example.com"],
			timestamp: 123,
			autolockTimeoutMs: 456,
		});
	});

	test("caches desktop auth token and snapshot responses briefly", async () => {
		const requests: Array<string> = [];
		const nativeClient = {
			request: async (message: { type: string }) => {
				requests.push(message.type);
				if (message.type === "GET_DESKTOP_AUTH_TOKEN") {
					return {
						type: "DESKTOP_AUTH_TOKEN" as const,
						email: "alice@example.com",
						authToken: "token-1",
					};
				}

				return {
					type: "DESKTOP_ITEMS_SNAPSHOT" as const,
					items: [{ id: "item-1", vaultId: "vault-1", vault: { id: "vault-1", name: "Main", type: "personal", icon: null, imageUrl: null } }],
					generatedAt: 123,
				};
			},
			subscribeToDesktopEvents: () => () => {},
		};

		const client = new DesktopClient({ nativeClient });

		await client.getAuthToken("alice@example.com");
		await client.getAuthToken("alice@example.com");
		await client.getItemsSnapshot(["alice@example.com"]);
		await client.getItemsSnapshot(["alice@example.com"]);

		expect(requests).toEqual([
			"GET_DESKTOP_AUTH_TOKEN",
			"GET_DESKTOP_ITEMS_SNAPSHOT",
		]);
	});

	test("returns null when desktop snapshot request responds with an error", async () => {
		const nativeClient = {
			request: async () => ({
				type: "ERROR" as const,
				message: "Decryption failed",
			}),
			subscribeToDesktopEvents: () => () => {},
		};

		const client = new DesktopClient({ nativeClient });

		await expect(
			client.getItemsSnapshot(["alice@example.com"]),
		).resolves.toBeNull();
	});
});

describe("native-messaging-client", () => {
	test("reconnects after disconnect and routes the next request through a new port", async () => {
		const firstPort = createFakePort();
		const secondPort = createFakePort();
		let connectCount = 0;

		const client = new NativeMessagingClient({
			connectNative: () => {
				connectCount += 1;
				return connectCount === 1 ? firstPort.port : secondPort.port;
			},
		});

		const firstRequest = client.request({ type: "GET_DESKTOP_STATUS" });
		const firstEnvelope = firstPort.postedMessages[0] as {
			requestId: string;
		};
		firstPort.emitMessage({
			requestId: firstEnvelope.requestId,
			type: "DESKTOP_STATUS",
			available: true,
			locked: false,
			unlockedAccounts: [],
			timestamp: 1,
			autolockTimeoutMs: 2,
		});
		await firstRequest;

		firstPort.emitDisconnect();

		const secondRequest = client.request({ type: "GET_DESKTOP_STATUS" });
		const secondEnvelope = secondPort.postedMessages[0] as {
			requestId: string;
		};
		secondPort.emitMessage({
			requestId: secondEnvelope.requestId,
			type: "DESKTOP_STATUS",
			available: true,
			locked: true,
			unlockedAccounts: [],
			timestamp: 2,
			autolockTimeoutMs: 3,
		});

		await expect(secondRequest).resolves.toEqual({
			type: "DESKTOP_STATUS",
			requestId: secondEnvelope.requestId,
			available: true,
			locked: true,
			unlockedAccounts: [],
			timestamp: 2,
			autolockTimeoutMs: 3,
		});
	});

	test("delivers desktop events through the persistent native port", async () => {
		const fakePort = createFakePort();
		const events: string[] = [];
		const client = new NativeMessagingClient({
			connectNative: () => fakePort.port,
		});

		const unsubscribe = client.subscribeToDesktopEvents((event) => {
			events.push(event.event);
		});

		const subscribeEnvelope = fakePort.postedMessages[0] as {
			requestId: string;
		};
		fakePort.emitMessage({
			requestId: subscribeEnvelope.requestId,
			type: "DESKTOP_EVENT_SUBSCRIPTION",
			subscribed: true,
		});
		fakePort.emitMessage({
			type: "DESKTOP_EVENT",
			event: "unlock",
			payload: {
				accounts: ["alice@example.com"],
				timestamp: 123,
			},
		});

		expect(events).toEqual(["unlock"]);

		unsubscribe();
	});
});
