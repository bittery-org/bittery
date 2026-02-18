import { describe, expect, test } from "bun:test";
import { routeRuntimeMessage } from "../../src/background/message-router";

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
