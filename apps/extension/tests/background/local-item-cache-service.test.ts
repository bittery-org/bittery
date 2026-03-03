import { describe, expect, test } from "bun:test";
import { createLocalItemCacheService } from "../../src/background/services/local-item-cache-service";

describe("local-item-cache-service", () => {
	test("item update path writes cache then clears desktop cache for immediate TOTP/UI reads", async () => {
		const calls: Array<{ itemId: string; accountEmail?: string }> = [];
		let desktopCacheClearCount = 0;

		const service = createLocalItemCacheService({
			cache: {
				onItemCreated: async () => {},
				onItemUpdated: async (input) => {
					calls.push({
						itemId: input.itemId,
						accountEmail: input.accountEmail,
					});
				},
			},
			desktopClient: {
				clearCache: () => {
					desktopCacheClearCount++;
				},
			},
		});

		await service.onLocalItemUpdated({
			itemId: "item_123",
			accountEmail: "alice@example.com",
			encryptedData: {
				ciphertext: "encrypted",
				iv: "iv",
				algorithm: "AES-GCM-AAD-V1",
			},
		});

		expect(calls).toEqual([
			{
				itemId: "item_123",
				accountEmail: "alice@example.com",
			},
		]);
		expect(desktopCacheClearCount).toBe(1);
	});

	test("item create path also clears desktop cache", async () => {
		let createCallCount = 0;
		let desktopCacheClearCount = 0;

		const service = createLocalItemCacheService({
			cache: {
				onItemCreated: async () => {
					createCallCount++;
				},
				onItemUpdated: async () => {},
			},
			desktopClient: {
				clearCache: () => {
					desktopCacheClearCount++;
				},
			},
		});

		await service.onLocalItemCreated({
			itemId: "item_123",
			vaultId: "vault_abc",
			category: "login",
			encryptedData: {
				ciphertext: "encrypted",
				iv: "iv",
				algorithm: "AES-GCM-AAD-V1",
			},
		});

		expect(createCallCount).toBe(1);
		expect(desktopCacheClearCount).toBe(1);
	});
});
