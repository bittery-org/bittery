import { describe, expect, test } from "bun:test";
import type { KeyRef } from "@bittery/crypto-port";
import { createInMemoryCryptoPort } from "@bittery/crypto-port/testing";
import { ApiError } from "@bittery/shared/api-client";
import type { CachedEncryptedItem, ItemSyncCommand } from "@bittery/types";
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

function notFound(): ApiError {
	return new ApiError(
		{
			type: "https://bittery.test/not-found",
			title: "Not found",
			status: 404,
			code: "NOT_FOUND",
		},
		null,
	);
}

function crossAccountMoveCommand(
	overrides: Partial<ItemSyncCommand> = {},
): ItemSyncCommand {
	return {
		accountId: SOURCE.accountId,
		accountEmail: SOURCE.email,
		id: "move_1",
		operationId: "move_1",
		type: "cross_account_move",
		entityId: "item_1",
		vaultId: "vault_source",
		targetAccountId: TARGET.accountId,
		targetAccountEmail: TARGET.email,
		targetVaultId: "vault_target",
		targetItemId: "item_target",
		category: "login",
		encryptedPayload: {
			encryptedData: "target_ciphertext",
			encryptionIv: "target_iv",
			encryptionAlgorithm: "AES-GCM-AAD-V1",
		},
		baseVersion: 1,
		timestamp: 1,
		retryCount: 0,
		...overrides,
	};
}

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

	test("completes a durable cross-account move with stable phase identities", async () => {
		const fixture = await createFixture([SOURCE, TARGET]);
		const phases: Array<{ phase: string; key?: string }> = [];
		const service = fixture.service((accountId) =>
			accountId === TARGET.accountId
				? {
						items: {
							get: async () => {
								throw notFound();
							},
							create: async (
								_vaultId: string,
								itemId: string,
								_input: unknown,
								options: { idempotencyKey?: string },
							) => {
								phases.push({
									phase: `create:${itemId}`,
									key: options.idempotencyKey,
								});
								return { data: { itemId } };
							},
						},
						attachments: { list: async () => ({ data: [] }) },
					}
				: {
						items: {
							get: async () => ({
								data: { version: 1, deletedAt: null },
							}),
							trash: async (
								_itemId: string,
								options: { idempotencyKey?: string },
							) => phases.push({ phase: "trash", key: options.idempotencyKey }),
							deletePermanently: async (
								_itemId: string,
								options: { idempotencyKey?: string },
							) =>
								phases.push({ phase: "delete", key: options.idempotencyKey }),
						},
						attachments: { list: async () => ({ data: [] }) },
					},
		);

		await expect(
			service.executeCrossAccountMoveCommand(crossAccountMoveCommand()),
		).resolves.toEqual({ entityId: "item_1", etag: '"3"', version: 3 });
		expect(phases).toEqual([
			{ phase: "create:item_target", key: "move_1:create-target" },
			{ phase: "trash", key: "move_1:trash-source" },
			{ phase: "delete", key: "move_1:delete-source" },
		]);
	});

	test("probes the deterministic target after a lost create response", async () => {
		const fixture = await createFixture([SOURCE, TARGET]);
		let targetExists = false;
		let createAttempts = 0;
		let sourceDeleted = false;
		const service = fixture.service((accountId) =>
			accountId === TARGET.accountId
				? {
						items: {
							get: async () => {
								if (!targetExists) throw notFound();
								return {
									data: {
										vaultId: "vault_target",
										category: "login",
										encryptedData: "target_ciphertext",
										encryptionIv: "target_iv",
										encryptionAlgorithm: "AES-GCM-AAD-V1",
									},
								};
							},
							create: async () => {
								createAttempts += 1;
								targetExists = true;
								throw new Error("network lost after commit");
							},
						},
						attachments: { list: async () => ({ data: [] }) },
					}
				: {
						items: {
							get: async () => ({ data: { version: 1, deletedAt: null } }),
							trash: async () => undefined,
							deletePermanently: async () => {
								sourceDeleted = true;
							},
						},
						attachments: { list: async () => ({ data: [] }) },
					},
		);

		await expect(
			service.executeCrossAccountMoveCommand(crossAccountMoveCommand()),
		).rejects.toThrow("network lost after commit");
		await service.executeCrossAccountMoveCommand(crossAccountMoveCommand());

		expect(createAttempts).toBe(1);
		expect(sourceDeleted).toBe(true);
	});

	test("rejects a changed source before creating the deterministic target", async () => {
		const fixture = await createFixture([SOURCE, TARGET]);
		let targetCreated = false;
		const service = fixture.service((accountId) =>
			accountId === TARGET.accountId
				? {
						items: {
							get: async () => {
								throw notFound();
							},
							create: async () => {
								targetCreated = true;
							},
						},
					}
				: {
						items: {
							get: async () => ({ data: { version: 2, deletedAt: null } }),
						},
					},
		);

		await expect(
			service.executeCrossAccountMoveCommand(crossAccountMoveCommand()),
		).rejects.toMatchObject({ status: 412 });
		expect(targetCreated).toBe(false);
	});

	test("keeps the source when a durable move attachment transfer fails", async () => {
		const fixture = await createFixture([SOURCE, TARGET]);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => ({ ok: false })) as never;
		let sourceDeleted = false;
		try {
			const service = fixture.service((accountId) =>
				accountId === TARGET.accountId
					? {
							items: {
								get: async () => ({
									data: {
										vaultId: "vault_target",
										category: "login",
										encryptedData: "target_ciphertext",
										encryptionIv: "target_iv",
										encryptionAlgorithm: "AES-GCM-AAD-V1",
									},
								}),
							},
							attachments: { list: async () => ({ data: [] }) },
						}
					: {
							items: {
								get: async () => ({
									data: { version: 1, deletedAt: null },
								}),
								trash: async () => {
									sourceDeleted = true;
								},
							},
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
									data: { downloadUrl: "https://download.test" },
								}),
							},
						},
			);

			await expect(
				service.executeCrossAccountMoveCommand(crossAccountMoveCommand()),
			).rejects.toThrow("Failed to download attachment");
			expect(sourceDeleted).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("rebuilds a partial target with the retry attachment identity", async () => {
		const fixture = await createFixture([SOURCE, TARGET]);
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
		globalThis.fetch = (async (_url: string, init?: RequestInit) => {
			if (init?.method === "PUT") return { ok: true } as Response;
			return {
				ok: true,
				text: async () =>
					new TextDecoder().decode(
						encodeAttachmentBlobEnvelope(sourceParts.blobEnvelope),
					),
			} as Response;
		}) as typeof fetch;
		const attachmentCreateKeys: string[] = [];
		let sourceDeleted = false;
		try {
			const service = fixture.service((accountId) =>
				accountId === TARGET.accountId
					? {
							items: {
								get: async () => ({
									data: {
										vaultId: "vault_target",
										category: "login",
										encryptedData: "target_ciphertext",
										encryptionIv: "target_iv",
										encryptionAlgorithm: "AES-GCM-AAD-V1",
									},
								}),
							},
							attachments: {
								list: async () => ({ data: [{ id: "partial_attachment" }] }),
								remove: async () => {
									throw notFound();
								},
								createUpload: async () => ({
									data: { key: "target_key", uploadUrl: "https://upload.test" },
								}),
								create: async (
									_itemId: string,
									_input: unknown,
									options: { idempotencyKey?: string },
								) => {
									attachmentCreateKeys.push(options.idempotencyKey ?? "");
								},
							},
						}
					: {
							items: {
								get: async () => ({ data: { version: 1, deletedAt: null } }),
								trash: async () => undefined,
								deletePermanently: async () => {
									sourceDeleted = true;
								},
							},
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
									data: { downloadUrl: "https://download.test" },
								}),
							},
						},
			);
			await service.executeCrossAccountMoveCommand(
				crossAccountMoveCommand({ attemptId: "move_1:attempt:second" }),
			);

			expect(attachmentCreateKeys).toEqual([
				"move_1:attempt:second:attachment:attachment_1",
			]);
			expect(sourceDeleted).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("resumes source finalization after trash and after a lost permanent-delete response", async () => {
		const fixture = await createFixture([SOURCE, TARGET]);
		let sourceState: "trashed" | "missing" = "trashed";
		let permanentDeleteAttempts = 0;
		const target = {
			vaultId: "vault_target",
			category: "login",
			encryptedData: "target_ciphertext",
			encryptionIv: "target_iv",
			encryptionAlgorithm: "AES-GCM-AAD-V1",
		};
		const service = fixture.service((accountId) =>
			accountId === TARGET.accountId
				? { items: { get: async () => ({ data: target }) } }
				: {
						items: {
							get: async () => {
								if (sourceState === "missing") throw notFound();
								return {
									data: {
										version: 2,
										deletedAt: "2026-08-11T00:00:00Z",
									},
								};
							},
							deletePermanently: async () => {
								permanentDeleteAttempts += 1;
								sourceState = "missing";
								throw new Error("network lost after permanent delete");
							},
						},
					},
		);

		await expect(
			service.executeCrossAccountMoveCommand(crossAccountMoveCommand()),
		).rejects.toThrow("network lost after permanent delete");
		await expect(
			service.executeCrossAccountMoveCommand(crossAccountMoveCommand()),
		).resolves.toEqual({ entityId: "item_1", etag: '"3"', version: 3 });
		expect(permanentDeleteAttempts).toBe(1);
	});

	test("does not accept a mismatched target after the source is already gone", async () => {
		const fixture = await createFixture([SOURCE, TARGET]);
		const service = fixture.service((accountId) =>
			accountId === TARGET.accountId
				? {
						items: {
							get: async () => ({
								data: {
									vaultId: "vault_target",
									category: "login",
									encryptedData: "different_ciphertext",
									encryptionIv: "target_iv",
									encryptionAlgorithm: "AES-GCM-AAD-V1",
								},
							}),
						},
					}
				: { items: { get: async () => Promise.reject(notFound()) } },
		);

		await expect(
			service.executeCrossAccountMoveCommand(crossAccountMoveCommand()),
		).rejects.toThrow("does not match move");
	});
});
