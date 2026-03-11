import { afterEach, describe, expect, test } from "bun:test";
import { routeRuntimeMessage } from "../../src/background/message-router";

const originalChrome = globalThis.chrome;

function createMockStorageArea(store: Record<string, unknown>) {
	return {
		async get(keys?: string | string[] | Record<string, unknown>) {
			if (typeof keys === "string") {
				return { [keys]: store[keys] };
			}

			if (Array.isArray(keys)) {
				return Object.fromEntries(keys.map((key) => [key, store[key]]));
			}

			if (keys && typeof keys === "object") {
				return Object.fromEntries(
					Object.entries(keys).map(([key, fallback]) => [
						key,
						store[key] ?? fallback,
					]),
				);
			}

			return { ...store };
		},
		async set(items: Record<string, unknown>) {
			Object.assign(store, items);
		},
		async remove(keys: string | string[]) {
			for (const key of Array.isArray(keys) ? keys : [keys]) {
				delete store[key];
			}
		},
	};
}

afterEach(() => {
	if (originalChrome) {
		globalThis.chrome = originalChrome;
		return;
	}

	Reflect.deleteProperty(globalThis, "chrome");
});

describe("message-router passkey dispatch", () => {
	test("dispatches PASSKEY_GET payload to handler override", async () => {
		let receivedPayload: unknown;

		const response = await routeRuntimeMessage(
			{
				type: "PASSKEY_GET",
				payload: {
					requestId: "req_1",
					origin: "https://example.com",
					clientDataJSON: "json",
					clientDataHash: "hash",
					publicKey: {
						challenge: "challenge",
					},
					selectedCredentialId: "cred_1",
				},
			},
			{
				handlePasskeyGet: async (payload) => {
					receivedPayload = payload;
					return {
						success: true,
						fallbackToNative: true,
					};
				},
			},
		);

		expect(receivedPayload).toEqual({
			requestId: "req_1",
			origin: "https://example.com",
			clientDataJSON: "json",
			clientDataHash: "hash",
			publicKey: {
				challenge: "challenge",
			},
			selectedCredentialId: "cred_1",
		});
		expect(response).toEqual({
			success: true,
			fallbackToNative: true,
		});
	});

	test("returns unknown message error for unsupported runtime types", async () => {
		const response = (await routeRuntimeMessage({
			type: "UNSUPPORTED_MESSAGE",
		})) as { success: boolean; error: string };

		expect(response.success).toBe(false);
		expect(response.error).toBe("Unknown message type");
	});

	test("routes pending save prompt persistence messages", async () => {
		const sessionStore: Record<string, unknown> = {};
		const localStore: Record<string, unknown> = {};
		globalThis.chrome = {
			storage: {
				session: createMockStorageArea(sessionStore),
				local: createMockStorageArea(localStore),
			},
		} as typeof chrome;

		const payload = {
			username: "alice@example.com",
			password: "test-password",
			url: "https://example.com/login",
			hostname: "example.com",
		};

		expect(
			await routeRuntimeMessage({
				type: "SET_PENDING_SAVE_PROMPT",
				payload,
			}),
		).toEqual({ success: true });
		expect(Object.values(sessionStore)).toEqual([payload]);
		expect(localStore).toEqual({});

		expect(
			await routeRuntimeMessage({
				type: "GET_PENDING_SAVE_PROMPT",
			}),
		).toEqual({
			success: true,
			data: payload,
		});

		expect(
			await routeRuntimeMessage({
				type: "CLEAR_PENDING_SAVE_PROMPT",
			}),
		).toEqual({ success: true });
		expect(sessionStore).toEqual({});
	});

	test("surfaces handler errors for route-level error paths", async () => {
		let errorMessage = "";
		try {
			await routeRuntimeMessage(
				{
					type: "PASSKEY_CREATE",
					payload: {
						requestId: "req_2",
						origin: "https://example.com",
						clientDataJSON: "json",
						clientDataHash: "hash",
						publicKey: {
							rp: { name: "Example" },
							user: { id: "id", name: "alice", displayName: "Alice" },
							challenge: "challenge",
							pubKeyCredParams: [],
						},
					},
				},
				{
					handlePasskeyCreate: async () => {
						throw new Error("forced handler failure");
					},
				},
			);
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		}

		expect(errorMessage).toContain("forced handler failure");
	});
});
