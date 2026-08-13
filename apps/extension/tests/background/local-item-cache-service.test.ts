import { describe, expect, test } from "bun:test";
import { createLocalItemCacheService } from "../../src/background/services/local-item-cache-service";

describe("local-item-cache-service", () => {
	test("item update path writes the account repository then clears the desktop cache", async () => {
		const calls: Array<{ itemId: string; accountId: string }> = [];
		let desktopCacheClearCount = 0;
		const existing = {
			id: "item_123",
			vaultId: "vault_abc",
			accountEmail: "alice@example.com",
			serverUrl: "https://api.example.test",
			category: "login",
			favorite: false,
			createdAt: "2026-08-11T00:00:00.000Z",
			deletedAt: null,
		};

		const service = createLocalItemCacheService({
			vaultRepository: {
				resolveAccountIdByEmail: () => "account_123",
				getAccountInfo: () => ({ serverUrl: "https://api.example.test" }),
				getById: () => existing,
				upsertCachedItem: async (item, accountId) => {
					calls.push({ itemId: item.id, accountId });
				},
			} as never,
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
				encryptionVersion: 1,
				encryptedByUserId: "user_123",
			},
		});

		expect(calls).toEqual([
			{
				itemId: "item_123",
				accountId: "account_123",
			},
		]);
		expect(desktopCacheClearCount).toBe(1);
	});

	test("item create path writes the account repository and clears desktop cache", async () => {
		let createCallCount = 0;
		let desktopCacheClearCount = 0;

		const service = createLocalItemCacheService({
			vaultRepository: {
				resolveAccountIdByEmail: () => "account_123",
				getAccountInfo: () => ({ serverUrl: "https://api.example.test" }),
				upsertCachedItem: async () => {
					createCallCount++;
				},
			} as never,
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
			accountEmail: "alice@example.com",
			encryptedData: {
				ciphertext: "encrypted",
				iv: "iv",
				algorithm: "AES-GCM-AAD-V1",
				encryptionVersion: 1,
				encryptedByUserId: "user_123",
			},
		});

		expect(createCallCount).toBe(1);
		expect(desktopCacheClearCount).toBe(1);
	});
});
