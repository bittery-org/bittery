import { describe, expect, test } from "bun:test";
import type { KeyRef } from "@bittery/crypto-port";
import { createInMemoryCryptoPort } from "@bittery/crypto-port/testing";
import type { CachedEncryptedItem } from "@bittery/types";
import {
	encodeAttachmentBlobEnvelope,
	encryptAttachmentParts,
} from "./attachment-crypto";
import { ItemService } from "./item-service";
import {
	getTravelModeEnforcer,
	resetTravelModeEnforcerForTests,
} from "./travel-mode-enforcer";
import { createVaultCrypto } from "./vault-crypto";

interface TestAccount {
	accountId: string;
	email: string;
	userId: string;
	vaultIds: string[];
}

async function createFixture(
	accounts: TestAccount[],
	options: { sessionMetadataMissing?: boolean } = {},
) {
	const crypto = createInMemoryCryptoPort();
	const masterUnlockKeys = new Map<string, KeyRef>();
	const vaultKeysByAccount = new Map<
		string,
		Array<{ vaultId: string; encryptedVaultKey: string }>
	>();
	let vaultKeyReads = 0;
	const travelModeByAccount = new Map<
		string,
		{ enabled: boolean; hiddenVaultIds: string[] }
	>();
	const storage = {
		getActiveAccount: async () => accounts[0]?.accountId ?? null,
		getAccountsList: async () =>
			accounts.map(({ accountId, email }) => ({ accountId, email })),
		getVaultKeys: async (accountId?: string) => {
			vaultKeyReads += 1;
			return vaultKeysByAccount.get(accountId ?? "") ?? null;
		},
		getMasterUnlockKey: async (accountId?: string) =>
			masterUnlockKeys.get(accountId ?? "") ?? null,
		getEncryptedPrivateKey: async () => null,
		getStoredSessionData: async (accountId?: string) => {
			if (options.sessionMetadataMissing) return null;
			const account = accounts.find((entry) => entry.accountId === accountId);
			return account ? { userId: account.userId } : null;
		},
		getAccountMetadata: async (accountId?: string) => {
			const account = accounts.find((entry) => entry.accountId === accountId);
			return account
				? {
						email: account.email,
						userId: account.userId,
						name: account.email,
						secretKeyHint: "",
						addedAt: 0,
						lastActiveAt: 0,
						biometricEnabled: false,
					}
				: null;
		},
		getActiveAccountUserId: async () => accounts[0]?.userId ?? null,
		getPinnedKdfProfile: async () => null,
		getTravelModeCache: async (accountId?: string) =>
			travelModeByAccount.get(accountId ?? "") ?? null,
		storeTravelModeCache: async (
			config: { enabled: boolean; hiddenVaultIds: string[] },
			accountId?: string,
		) => {
			travelModeByAccount.set(accountId ?? "", config);
		},
	} as never;
	const vaultCrypto = createVaultCrypto({ crypto, storage });

	for (const [accountIndex, account] of accounts.entries()) {
		const masterUnlockKey = await crypto.importKey(
			new Uint8Array(32).fill(accountIndex + 1),
		);
		masterUnlockKeys.set(account.accountId, masterUnlockKey);
		const entries: Array<{ vaultId: string; encryptedVaultKey: string }> = [];
		for (const [vaultIndex, vaultId] of account.vaultIds.entries()) {
			const vaultKey = await crypto.importKey(
				new Uint8Array(32).fill(accountIndex * 20 + vaultIndex + 10),
			);
			try {
				entries.push({
					vaultId,
					encryptedVaultKey: await vaultCrypto.wrapVaultKeyForOwner({
						vaultKey,
						masterUnlockKey,
						vaultId,
						userId: account.userId,
						keyVersion: 1,
					}),
				});
			} finally {
				await crypto.destroyKey(vaultKey);
			}
		}
		vaultKeysByAccount.set(account.accountId, entries);
	}

	return {
		crypto,
		storage,
		vaultCrypto,
		vaultKeyReads: () => vaultKeyReads,
		service(
			getClientForAccount: (accountId: string) => unknown,
			itemCache: unknown = {},
		) {
			return new ItemService({
				storage,
				itemCache: itemCache as never,
				crypto,
				vaultCrypto,
				accounts: {
					getClientForAccount: async (_default: unknown, accountId: string) =>
						getClientForAccount(accountId),
				} as never,
			});
		},
	};
}

const SOURCE = {
	accountId: "acc_source",
	email: "alice@example.com",
	userId: "user_source",
	vaultIds: ["vault_source"],
};
const TARGET = {
	accountId: "acc_target",
	email: "bob@example.com",
	userId: "user_target",
	vaultIds: ["vault_target"],
};

describe("ItemService", () => {
	test("consumes active attachment arrays and accepts trashed items without attachments", async () => {
		resetTravelModeEnforcerForTests();
		const fixture = await createFixture([SOURCE]);
		const vaultKey = await fixture.vaultCrypto.getVaultKey({
			vaultId: "vault_source",
			accountId: SOURCE.accountId,
			userId: SOURCE.userId,
		});
		if (!vaultKey) throw new Error("Missing test vault key");
		const activeEncrypted = await fixture.vaultCrypto.encryptItem(
			JSON.stringify({ title: "Active item" }),
			vaultKey,
			{
				vaultId: "vault_source",
				itemId: "active-item",
				version: 1,
				userId: SOURCE.userId,
			},
		);
		const trashedEncrypted = await fixture.vaultCrypto.encryptItem(
			JSON.stringify({ title: "Trashed item" }),
			vaultKey,
			{
				vaultId: "vault_source",
				itemId: "trashed-item",
				version: 1,
				userId: SOURCE.userId,
			},
		);
		await fixture.crypto.destroyKey(vaultKey);

		const itemCache = {
			getCachedItems: async () => null,
			getCachedVaults: async () => null,
		};
		const trashedWireItem = {
			id: "trashed-item",
			vaultId: "vault_source",
			category: "login",
			favorite: false,
			encryptedData: trashedEncrypted.ciphertext,
			encryptionIv: trashedEncrypted.iv,
			encryptionAlgorithm: trashedEncrypted.algorithm,
			version: 1,
			lastModifiedBy: SOURCE.userId,
			createdAt: "2026-08-10T00:00:00Z",
			updatedAt: "2026-08-10T00:00:00Z",
			deletedAt: "2026-08-10T01:00:00Z",
			vault: {
				id: "vault_source",
				name: "Personal",
				vaultType: "personal",
			},
		};
		const apiClient = {
			items: {
				listInVault: async () => ({
					data: [
						{
							id: "active-item",
							vaultId: "vault_source",
							category: "login",
							favorite: false,
							encryptedData: activeEncrypted.ciphertext,
							encryptionIv: activeEncrypted.iv,
							encryptionAlgorithm: activeEncrypted.algorithm,
							version: 1,
							lastModifiedBy: SOURCE.userId,
							createdAt: "2026-08-10T00:00:00Z",
							updatedAt: "2026-08-10T00:00:00Z",
							attachments: [{ id: "attachment-1" }],
						},
					],
				}),
				listTrashed: async () => ({ data: [trashedWireItem] }),
			},
		};
		const service = fixture.service(() => apiClient, itemCache);
		await getTravelModeEnforcer(
			fixture.storage,
			itemCache as never,
		).applyConfig(SOURCE.accountId, { enabled: false, hiddenVaultIds: [] });
		const account = {
			...SOURCE,
			name: "Alice",
			authToken: "token",
			serverUrl: "https://api.example.test",
			apiClient,
		} as never;

		const active = await service.fetchVaultItems("vault_source", [account]);
		const trashed = await service.fetchDeletedItems([account]);

		expect(active[0]?.title).toBe("Active item");
		expect(trashed[0]?.title).toBe("Trashed item");
		expect("attachments" in trashedWireItem).toBe(false);
	});

	test("never reads vault keys when the account scope cannot be resolved", async () => {
		const fixture = await createFixture([SOURCE]);
		const service = fixture.service(() => ({}));

		await expect(
			service.createItem(
				{
					vaultId: "vault_source",
					category: "login",
					data: { title: "example.com" },
					accountEmail: "stranger@example.com",
				},
				{} as never,
			),
		).rejects.toThrow();
		expect(fixture.vaultKeyReads()).toBe(0);
	});

	test("uses account metadata userId when session metadata is missing", async () => {
		const fixture = await createFixture([SOURCE], {
			sessionMetadataMissing: true,
		});
		let mutation: Record<string, string> | undefined;
		const service = fixture.service(() => ({
			items: {
				create: async (
					_vaultId: string,
					itemId: string,
					input: Record<string, string>,
				) => {
					mutation = input;
					return { data: { itemId } };
				},
			},
		}));

		const result = await service.createItem(
			{
				vaultId: "vault_source",
				category: "login",
				data: { title: "example.com" },
				accountEmail: SOURCE.email,
			},
			{} as never,
		);
		const vaultKey = await fixture.vaultCrypto.getVaultKey({
			vaultId: "vault_source",
			accountId: SOURCE.accountId,
			userId: SOURCE.userId,
		});
		if (!vaultKey || !mutation) throw new Error("Test fixture did not encrypt");
		await expect(
			fixture.vaultCrypto.decryptItem(
				{
					ciphertext: mutation.encryptedData ?? "",
					iv: mutation.encryptionIv ?? "",
					algorithm: mutation.encryptionAlgorithm ?? "",
				},
				vaultKey,
				{
					vaultId: "vault_source",
					itemId: result.itemId,
					version: 1,
					userId: SOURCE.userId,
				},
			),
		).resolves.toContain("example.com");
		await fixture.crypto.destroyKey(vaultKey);
	});

	test("falls back to older encryption versions when cached item metadata drifted", async () => {
		const fixture = await createFixture([SOURCE]);
		const vaultKey = await fixture.vaultCrypto.getVaultKey({
			vaultId: "vault_source",
			accountId: SOURCE.accountId,
			userId: SOURCE.userId,
		});
		if (!vaultKey) throw new Error("Missing test vault key");
		const encrypted = await fixture.vaultCrypto.encryptItem(
			JSON.stringify({ title: "Recovered item" }),
			vaultKey,
			{
				vaultId: "vault_source",
				itemId: "item_1",
				version: 1,
				userId: SOURCE.userId,
			},
		);
		await fixture.crypto.destroyKey(vaultKey);
		const cached: CachedEncryptedItem = {
			id: "item_1",
			vaultId: "vault_source",
			category: "login",
			favorite: false,
			encryptedData: encrypted.ciphertext,
			encryptionIv: encrypted.iv,
			encryptionAlgorithm: encrypted.algorithm,
			version: 3,
			lastModifiedBy: SOURCE.userId,
			createdAt: "2026-03-13T00:00:00.000Z",
			updatedAt: "2026-03-13T00:00:00.000Z",
		};
		const service = fixture.service(() => ({}), {
			getCachedItems: async () => [cached],
		});

		const result = await service.fetchAndDecryptItem(
			"item_1",
			{} as never,
			SOURCE.email,
		);
		expect(result.decryptedData?.title).toBe("Recovered item");
	});

	test("performs a cross-account move while a single account is active", async () => {
		const fixture = await createFixture([SOURCE, TARGET]);
		const before = fixture.crypto.liveKeyCount;
		const sourceDeletes: string[] = [];
		const createItemCalls: Array<{
			itemId: string;
			vaultId: string;
			category: string;
			encryptedData: string;
			encryptionIv: string;
			encryptionAlgorithm: string;
		}> = [];
		const service = fixture.service((accountId) =>
			accountId === TARGET.accountId
				? {
						items: {
							create: async (
								vaultId: string,
								itemId: string,
								input: Omit<
									(typeof createItemCalls)[number],
									"itemId" | "vaultId"
								>,
							) => {
								createItemCalls.push({ ...input, itemId, vaultId });
								return { data: { itemId } };
							},
						},
					}
				: {
						attachments: { list: async () => ({ data: [] }) },
						items: {
							get: async () => ({ data: { version: 1 } }),
							trash: async (itemId: string) => {
								sourceDeletes.push(itemId);
							},
							deletePermanently: async () => ({ data: {} }),
						},
					},
		);

		const result = await service.moveItem(
			{
				itemId: "item_1",
				sourceVaultId: "vault_source",
				targetVaultId: "vault_target",
				category: "login",
				decryptedData: { title: "example.com" },
				sourceAccountEmail: SOURCE.email,
				targetAccountEmail: TARGET.email,
			},
			{} as never,
		);

		expect(result.crossAccount).toBe(true);
		if (!result.newItemId)
			throw new Error("Cross-account move returned no item ID");
		expect(createItemCalls).toEqual([
			{
				itemId: result.newItemId,
				vaultId: "vault_target",
				category: "login",
				encryptedData: result._encryptedData.ciphertext,
				encryptionIv: result._encryptedData.iv,
				encryptionAlgorithm: result._encryptedData.algorithm,
			},
		]);
		expect(sourceDeletes).toEqual(["item_1"]);
		expect(fixture.crypto.liveKeyCount).toBe(before);
	});

	test("migrates attachments before deleting the source", async () => {
		const fixture = await createFixture([SOURCE, TARGET]);
		const before = fixture.crypto.liveKeyCount;
		const sourceVaultKey = await fixture.vaultCrypto.getVaultKey({
			vaultId: "vault_source",
			accountId: SOURCE.accountId,
			userId: SOURCE.userId,
		});
		if (!sourceVaultKey) throw new Error("Missing source key");
		const sourceParts = await encryptAttachmentParts(
			fixture.vaultCrypto,
			sourceVaultKey,
			{
				vaultId: "vault_source",
				attachmentKey: "source_key",
				userId: SOURCE.userId,
			},
			{ base64File: "ZmlsZQ==", name: "secret.txt", contentType: "text/plain" },
		);
		await fixture.crypto.destroyKey(sourceVaultKey);
		const originalFetch = globalThis.fetch;
		const events: string[] = [];
		globalThis.fetch = (async (_url: string, init?: RequestInit) => {
			if (init?.body) {
				events.push("put");
				return { ok: true } as Response;
			}
			events.push("get");
			return {
				ok: true,
				text: async () =>
					new TextDecoder().decode(
						encodeAttachmentBlobEnvelope(sourceParts.blobEnvelope),
					),
			} as Response;
		}) as typeof fetch;
		try {
			const service = fixture.service((accountId) =>
				accountId === TARGET.accountId
					? {
							items: {
								create: async (_vaultId: string, itemId: string) => ({
									data: { itemId },
								}),
							},
							attachments: {
								createUpload: async () => ({
									data: {
										key: "target_key",
										uploadUrl: "https://upload.test",
									},
								}),
								create: async () => {
									events.push("createAttachment");
								},
							},
						}
					: {
							attachments: {
								list: async () => ({
									data: [
										{
											id: "attachment_1",
											storageKey: "source_key",
											encryptedName: sourceParts.encryptedName,
											encryptedContentType: sourceParts.encryptedContentType,
											encryptionIv: sourceParts.encryptionIv,
											encryptedContentTypeIv:
												sourceParts.encryptedContentTypeIv,
											encryptionAlgorithm: sourceParts.encryptionAlgorithm,
											fileSize: 4,
											uploadedBy: SOURCE.userId,
										},
									],
								}),
								createDownloadUrl: async () => ({
									data: {
										downloadUrl: "https://download.test",
									},
								}),
							},
							items: {
								get: async () => ({ data: { version: 1 } }),
								trash: async () => events.push("sourceDelete"),
								deletePermanently: async () => ({ data: {} }),
							},
						},
			);
			await service.moveItem(
				{
					itemId: "item_1",
					sourceVaultId: "vault_source",
					targetVaultId: "vault_target",
					category: "login",
					decryptedData: { title: "example.com" },
					sourceAccountEmail: SOURCE.email,
					targetAccountEmail: TARGET.email,
				},
				{} as never,
			);
			expect(events.indexOf("createAttachment")).toBeLessThan(
				events.indexOf("sourceDelete"),
			);
			expect(events).toContain("put");
			expect(fixture.crypto.liveKeyCount).toBe(before);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("does not delete the source when attachment migration fails", async () => {
		const fixture = await createFixture([SOURCE, TARGET]);
		const before = fixture.crypto.liveKeyCount;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => ({ ok: false })) as never;
		let sourceDeleted = false;
		let targetDeleted = false;
		try {
			const service = fixture.service((accountId) =>
				accountId === TARGET.accountId
					? {
							items: {
								create: async (_vaultId: string, itemId: string) => ({
									data: { itemId },
								}),
								trash: async () => {
									targetDeleted = true;
								},
								deletePermanently: async () => ({ data: {} }),
							},
						}
					: {
							attachments: {
								list: async () => ({
									data: [
										{
											id: "attachment_1",
											storageKey: "source_key",
											fileSize: 4,
										},
									],
								}),
								createDownloadUrl: async () => ({
									data: {
										downloadUrl: "https://download.test",
									},
								}),
							},
							items: {
								trash: async () => {
									sourceDeleted = true;
								},
								deletePermanently: async () => ({ data: {} }),
							},
						},
			);
			await expect(
				service.moveItem(
					{
						itemId: "item_1",
						sourceVaultId: "vault_source",
						targetVaultId: "vault_target",
						category: "login",
						decryptedData: { title: "example.com" },
						sourceAccountEmail: SOURCE.email,
						targetAccountEmail: TARGET.email,
					},
					{} as never,
				),
			).rejects.toThrow("Failed to download attachment");
			expect(sourceDeleted).toBe(false);
			expect(targetDeleted).toBe(true);
			expect(fixture.crypto.liveKeyCount).toBe(before);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
