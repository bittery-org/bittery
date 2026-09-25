import { describe, expect, test } from "bun:test";
import { DesktopClient } from "../../src/background/desktop-client";
import { DesktopProtocolMismatchError } from "../../src/background/desktop-protocol";
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
				unlockedAccounts: ["account-alice"],
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
			unlockedAccounts: ["account-alice"],
			timestamp: 123,
			autolockTimeoutMs: 456,
			// `theme` is additive on the desktop side, so a host that predates it
			// still parses — the client normalizes the absence to null.
			theme: null,
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
						accountId: "account-alice",
						email: "alice@example.com",
						authToken: "token-1",
					};
				}

				return {
					type: "DESKTOP_ITEMS_SNAPSHOT" as const,
					items: [
						{
							id: "item-1",
							vaultId: "vault-1",
							vault: {
								id: "vault-1",
								name: "Main",
								type: "personal",
								icon: null,
								imageUrl: null,
							},
						},
					],
					generatedAt: 123,
				};
			},
			subscribeToDesktopEvents: () => () => {},
		};

		const client = new DesktopClient({ nativeClient });

		await client.getAuthToken("account-alice");
		await client.getAuthToken("account-alice");
		await client.getItemsSnapshot(["account-alice"]);
		await client.getItemsSnapshot(["account-alice"]);

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
			client.getItemsSnapshot(["account-alice"]),
		).resolves.toBeNull();
	});
});

describe("native-messaging-client", () => {
	test("late failure cleanup cannot erase a newer material owner", async () => {
		const client = new NativeMessagingClient();
		const generation = await client.captureDeliveryGeneration();
		const oldInvocation = client.newMaterialInvocation();
		const newInvocation = client.newMaterialInvocation();
		let material = "empty";
		await client.withMaterialMutation(
			generation,
			"account-alice",
			async () => {
				material = "old";
			},
			oldInvocation,
		);
		await client.withMaterialMutation(
			generation,
			"account-alice",
			async () => {
				material = "new";
			},
			newInvocation,
		);
		await client.withOwnedFailureCleanup(
			generation,
			"account-alice",
			oldInvocation,
			async () => {
				material = "cleared";
				return {
					affected: [{ accountId: "account-alice", email: "a@example.test" }],
					activeAccountId: undefined,
					activeAccount: null,
					wasActive: false,
					remaining: [],
					failures: [],
				};
			},
		);
		expect(material).toBe("new");
		await client.withOwnedFailureCleanup(
			generation,
			"account-alice",
			newInvocation,
			async () => {
				material = "cleared";
				return {
					affected: [{ accountId: "account-alice", email: "a@example.test" }],
					activeAccountId: undefined,
					activeAccount: null,
					wasActive: false,
					remaining: [],
					failures: [],
				};
			},
		);
		expect(material).toBe("cleared");
	});

	test("a lock event retires a buffered reply before DesktopClient can cache it", async () => {
		const fakePort = createFakePort();
		const transport = new NativeMessagingClient({
			connectNative: () => fakePort.port,
		});
		const client = new DesktopClient({ nativeClient: transport });
		const unsubscribe = transport.subscribeToDesktopEvents(() => {});
		const subscription = fakePort.postedMessages[0] as { requestId: string };
		fakePort.emitMessage({
			protocolVersion: 1,
			requestId: subscription.requestId,
			type: "DESKTOP_EVENT_SUBSCRIPTION",
			subscribed: true,
		});
		await Promise.resolve();

		const stale = client.getAuthToken("account-alice");
		const tokenRequest = fakePort.postedMessages[1] as { requestId: string };
		fakePort.emitMessage({
			protocolVersion: 1,
			type: "DESKTOP_EVENT",
			event: "lock",
			payload: { reason: "Core lock", timestamp: 1 },
		});
		fakePort.emitMessage({
			protocolVersion: 1,
			requestId: tokenRequest.requestId,
			type: "DESKTOP_AUTH_TOKEN",
			accountId: "account-alice",
			email: "alice@example.com",
			authToken: "stale",
		});
		expect(await stale).toBeNull();
		expect(fakePort.postedMessages).toHaveLength(2);
		unsubscribe();
	});

	test("a reply already resolved cannot publish a cache after invalidation", async () => {
		const fakePort = createFakePort();
		const transport = new NativeMessagingClient({
			connectNative: () => fakePort.port,
		});
		const client = new DesktopClient({ nativeClient: transport });
		transport.subscribeToDesktopEvents(() => {});
		const subscription = fakePort.postedMessages[0] as { requestId: string };
		fakePort.emitMessage({
			protocolVersion: 1,
			requestId: subscription.requestId,
			type: "DESKTOP_EVENT_SUBSCRIPTION",
			subscribed: true,
		});
		await Promise.resolve();

		const stale = client.getAuthToken("account-alice");
		const first = fakePort.postedMessages[1] as { requestId: string };
		fakePort.emitMessage({
			protocolVersion: 1,
			requestId: first.requestId,
			type: "DESKTOP_AUTH_TOKEN",
			accountId: "account-alice",
			email: "alice@example.com",
			authToken: "stale",
		});
		fakePort.emitMessage({
			protocolVersion: 1,
			type: "DESKTOP_EVENT",
			event: "lock",
			payload: { reason: "Core lock", timestamp: 2 },
		});
		expect(await stale).toBeNull();
		const fresh = client.getAuthToken("account-alice");
		const second = fakePort.postedMessages[2] as { requestId: string };
		fakePort.emitMessage({
			protocolVersion: 1,
			requestId: second.requestId,
			type: "DESKTOP_AUTH_TOKEN",
			accountId: "account-alice",
			email: "alice@example.com",
			authToken: "fresh",
		});
		expect(await fresh).toBe("fresh");
	});
	test("includes the current desktop protocol version on requests", () => {
		const fakePort = createFakePort();
		const client = new NativeMessagingClient({
			connectNative: () => fakePort.port,
		});

		void client.request({ type: "PING" }, 1).catch(() => {});

		expect(fakePort.postedMessages[0]).toMatchObject({
			protocolVersion: 1,
			type: "PING",
		});
	});

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
			protocolVersion: 1,
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
			protocolVersion: 1,
			requestId: secondEnvelope.requestId,
			type: "DESKTOP_STATUS",
			available: true,
			locked: true,
			unlockedAccounts: [],
			timestamp: 2,
			autolockTimeoutMs: 3,
		});

		await expect(secondRequest).resolves.toEqual({
			protocolVersion: 1,
			type: "DESKTOP_STATUS",
			requestId: secondEnvelope.requestId,
			available: true,
			locked: true,
			unlockedAccounts: [],
			timestamp: 2,
			autolockTimeoutMs: 3,
		});
	});

	test("port loss waits for C1 before successor acquisition and old callbacks stay retired", async () => {
		const firstPort = createFakePort();
		const secondPort = createFakePort();
		let connects = 0;
		let cleanups = 0;
		let releaseCleanup!: () => void;
		let markCleanup!: () => void;
		const cleanupStarted = new Promise<void>((resolve) => {
			markCleanup = resolve;
		});
		const cleanupGate = new Promise<void>((resolve) => {
			releaseCleanup = resolve;
		});
		const client = new NativeMessagingClient({
			connectNative: () =>
				++connects === 1 ? firstPort.port : secondPort.port,
		});
		client.configureRetirementCleanup(async () => {
			cleanups += 1;
			markCleanup();
			await cleanupGate;
		});
		client.subscribeToDesktopEvents(() => {});
		const subscription = firstPort.postedMessages[0] as { requestId: string };
		firstPort.emitMessage({
			protocolVersion: 1,
			requestId: subscription.requestId,
			type: "DESKTOP_EVENT_SUBSCRIPTION",
			subscribed: true,
		});
		await Promise.resolve();
		firstPort.emitDisconnect();
		await cleanupStarted;
		const successor = client.request({ type: "PING" });
		expect(secondPort.postedMessages).toHaveLength(0);
		releaseCleanup();
		await client.captureDeliveryGeneration();
		const ping = secondPort.postedMessages[0] as { requestId: string };
		secondPort.emitMessage({
			protocolVersion: 1,
			requestId: ping.requestId,
			type: "PONG",
		});
		await successor;
		const generation = client.currentDeliveryGeneration();
		firstPort.emitMessage({
			protocolVersion: 1,
			type: "DESKTOP_EVENT",
			event: "lock",
			payload: { reason: "old port", timestamp: 3 },
		});
		expect(client.currentDeliveryGeneration()).toBe(generation);
		expect(cleanups).toBe(1);
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
			protocolVersion: 1,
			requestId: subscribeEnvelope.requestId,
			type: "DESKTOP_EVENT_SUBSCRIPTION",
			subscribed: true,
		});
		fakePort.emitMessage({
			protocolVersion: 1,
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

	test("rejects a response without a protocol version before the request timeout", async () => {
		const fakePort = createFakePort();
		const client = new NativeMessagingClient({
			connectNative: () => fakePort.port,
		});
		const request = client.request({ type: "GET_DESKTOP_STATUS" });
		const envelope = fakePort.postedMessages[0] as { requestId: string };

		fakePort.emitMessage({
			requestId: envelope.requestId,
			type: "DESKTOP_STATUS",
			available: true,
			locked: false,
			unlockedAccounts: [],
			timestamp: 1,
			autolockTimeoutMs: 2,
		});

		await expect(request).rejects.toEqual(
			expect.objectContaining({
				expectedVersion: 1,
				receivedVersion: undefined,
			}),
		);
	});

	test("rejects all pending requests when a response has the wrong version", async () => {
		const fakePort = createFakePort();
		const client = new NativeMessagingClient({
			connectNative: () => fakePort.port,
		});
		const firstRequest = client.request({ type: "GET_DESKTOP_STATUS" });
		const secondRequest = client.request({ type: "GET_DESKTOP_ACCOUNTS" });
		const firstEnvelope = fakePort.postedMessages[0] as { requestId: string };

		fakePort.emitMessage({
			protocolVersion: 99,
			requestId: firstEnvelope.requestId,
			type: "DESKTOP_STATUS",
			available: true,
			locked: false,
			unlockedAccounts: [],
			timestamp: 1,
			autolockTimeoutMs: 2,
		});

		await expect(firstRequest).rejects.toBeInstanceOf(
			DesktopProtocolMismatchError,
		);
		await expect(secondRequest).rejects.toBeInstanceOf(
			DesktopProtocolMismatchError,
		);
	});

	test("does not reconnect an event subscription after a protocol mismatch", async () => {
		const fakePort = createFakePort();
		let connectCount = 0;
		const client = new NativeMessagingClient({
			connectNative: () => {
				connectCount += 1;
				return fakePort.port;
			},
		});

		client.subscribeToDesktopEvents(() => {});
		const envelope = fakePort.postedMessages[0] as { requestId: string };
		fakePort.emitMessage({
			protocolVersion: 99,
			requestId: envelope.requestId,
			type: "DESKTOP_EVENT_SUBSCRIPTION",
			subscribed: false,
		});
		fakePort.emitDisconnect();
		await Bun.sleep(1100);

		expect(connectCount).toBe(1);
	});
});
