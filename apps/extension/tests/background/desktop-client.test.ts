import { describe, expect, test } from "bun:test";
import { DesktopClient } from "../../src/background/desktop-client";

describe("desktop-client bridge auth", () => {
	test("refreshes bridge auth after a 401 and retries once", async () => {
		let authLoads = 0;
		const seenTokens: string[] = [];

		const client = new DesktopClient({
			loadBridgeAuth: async () => {
				authLoads += 1;
				return authLoads === 1
					? {
							bridgeToken: "token-1",
							allowedOrigin: "chrome-extension://test",
						}
					: {
							bridgeToken: "token-2",
							allowedOrigin: "chrome-extension://test",
						};
			},
			fetchImpl: async (_input, init) => {
				const token = new Headers(init?.headers).get("Authorization");
				if (!token) {
					throw new Error("Missing Authorization header");
				}

				seenTokens.push(token);

				if (token === "Bearer token-1") {
					return new Response(null, { status: 401 });
				}

				return new Response(
					JSON.stringify({
						locked: false,
						unlocked_accounts: ["alice@example.com"],
						timestamp: 123,
						autolock_timeout_ms: 456,
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			},
		});

		const status = await client.getLockStatus();

		expect(authLoads).toBe(2);
		expect(seenTokens).toEqual(["Bearer token-1", "Bearer token-2"]);
		expect(status).toEqual({
			available: true,
			locked: false,
			unlockedAccounts: ["alice@example.com"],
			timestamp: 123,
			autolockTimeoutMs: 456,
		});
	});

	test("includes item context metadata when requesting desktop decryption", async () => {
		let requestBody: {
			email: string;
			items: Array<{
				id: string;
				vaultId: string;
				encryptedData: string;
				encryptionIv: string;
				encryptionAlgorithm: string;
				version?: number;
				userId?: string;
			}>;
		} | null = null;

		const client = new DesktopClient({
			loadBridgeAuth: async () => ({
				bridgeToken: "token-1",
				allowedOrigin: "chrome-extension://test",
			}),
			fetchImpl: async (_input, init) => {
				requestBody = JSON.parse(String(init?.body));
				return new Response(
					JSON.stringify({
						decrypted_items: [
							{
								id: "item-1",
								decrypted_data: "{\"title\":\"Example\"}",
							},
						],
						failed: [],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			},
		});

		const result = await client.decryptItems("alice@example.com", [
			{
				id: "item-1",
				vaultId: "vault-1",
				encryptedData: "ciphertext",
				encryptionIv: "iv",
				encryptionAlgorithm: "AES-GCM-AAD-V1",
				version: 3,
				userId: "user-123",
			},
		]);

		expect(requestBody).toEqual({
			email: "alice@example.com",
			items: [
				{
					id: "item-1",
					vaultId: "vault-1",
					encryptedData: "ciphertext",
					encryptionIv: "iv",
					encryptionAlgorithm: "AES-GCM-AAD-V1",
					version: 3,
					userId: "user-123",
				},
			],
		});
		expect(result).toEqual([
			{
				id: "item-1",
				decrypted_data: "{\"title\":\"Example\"}",
			},
		]);
	});
});
