import { describe, expect, test } from "bun:test";
import type { EncryptedData, EncryptionContext } from "@bittery/types";
import { ItemService } from "./item-service";

describe("ItemService", () => {
	test("uses account metadata userId when session metadata is missing", async () => {
		const encryptCalls: Array<{ context?: { userId?: string } }> = [];
		const service = new ItemService({
			storage: {
				getVaultKeys: async () => [
					{
						vaultId: "vault_1",
						encryptedVaultKey: JSON.stringify({
							ciphertext: "wrapped",
							iv: "vault-iv",
							algorithm: "aes-256-gcm",
							context: {
								vaultId: "vault_1",
								userId: "user_from_account_metadata",
								keyVersion: 1,
								purpose: "vault-key-wrap",
							},
						}),
					},
				],
				getMasterUnlockKey: async () => new Uint8Array([1, 2, 3]),
				getEncryptedPrivateKey: async () => null,
				getStoredSessionData: async () => null,
				getAccountMetadata: async () => ({
					email: "alice@example.com",
					userId: "user_from_account_metadata",
					name: "Alice",
					secretKeyHint: "",
					addedAt: 0,
					lastActiveAt: 0,
					biometricEnabled: false,
				}),
				getActiveAccountUserId: async () => null,
				getAccountsList: async () => [
					{ accountId: "acc_alice", email: "alice@example.com" },
				],
			} as never,
			crypto: {
				generateUuid: async () => "item_123",
				decrypt: async () => Buffer.from("vault-key").toString("base64"),
				encrypt: async (
					_plaintext: string,
					_key: Uint8Array,
					context?: EncryptionContext,
				) => {
					encryptCalls.push({ context });
					return {
						ciphertext: "ciphertext",
						iv: "iv",
						algorithm: "aes-256-gcm",
					};
				},
			} as never,
			accounts: {
				getClientForAccount: async () => ({
					vault: {
						createItem: {
							mutate: async ({ itemId }: { itemId: string }) => ({
								itemId,
							}),
						},
					},
				}),
			} as never,
		});

		await service.createItem(
			{
				vaultId: "vault_1",
				category: "login",
				data: {
					title: "example.com",
				},
				accountEmail: "alice@example.com",
			},
			{} as never,
		);

		expect(encryptCalls).toHaveLength(1);
		expect(encryptCalls[0]?.context?.userId).toBe("user_from_account_metadata");
	});

	test("falls back to older encryption versions when cached item metadata drifted", async () => {
		const attemptedVersions: number[] = [];
		const service = new ItemService({
			storage: {
				getCachedItems: async () => [
					{
						id: "item_1",
						vaultId: "vault_1",
						category: "login",
						favorite: false,
						encryptedData: "ciphertext",
						encryptionIv: "iv",
						encryptionAlgorithm: "AES-GCM-AAD-V1",
						version: 3,
						lastModifiedBy: "user_1",
						createdAt: "2026-03-13T00:00:00.000Z",
						updatedAt: "2026-03-13T00:00:00.000Z",
						deletedAt: null,
						attachments: [],
					},
				],
				getVaultKeys: async () => [
					{
						vaultId: "vault_1",
						encryptedVaultKey: JSON.stringify({
							ciphertext: "wrapped",
							iv: "vault-iv",
							algorithm: "AES-GCM-AAD-V1",
							context: {
								vaultId: "vault_1",
								userId: "user_1",
								keyVersion: 1,
								purpose: "vault-key-wrap",
							},
						}),
					},
				],
				getMasterUnlockKey: async () => new Uint8Array([1, 2, 3]),
				getEncryptedPrivateKey: async () => null,
				getStoredSessionData: async () => ({ userId: "user_1" }),
				getActiveAccountUserId: async () => "user_1",
				getAccountsList: async () => [
					{ accountId: "acc_alice", email: "alice@example.com" },
				],
			} as never,
			crypto: {
				decrypt: async (
					_encryptedData: EncryptedData,
					_key: Uint8Array,
					context?: EncryptionContext,
				) => {
					if (context?.entityType === "vault_key") {
						return Buffer.from("vault-key").toString("base64");
					}
					if (context?.entityType === "item") {
						attemptedVersions.push(context.version);
						if (context.version === 1) {
							return JSON.stringify({ title: "Recovered item" });
						}
					}
					throw new Error("AAD mismatch");
				},
			} as never,
			accounts: {} as never,
		});

		const result = await service.fetchAndDecryptItem(
			"item_1",
			{} as never,
			"alice@example.com",
		);

		expect(attemptedVersions).toEqual([3, 2, 1]);
		expect(result.decryptedData?.title).toBe("Recovered item");
	});

	test("performs a cross-account move while a single account is active", async () => {
		// Regression guard for the "All Accounts" removal: a cross-account item
		// move must keep working when only one account is active (the move dialog
		// surfaces every unlocked account's vaults as targets regardless of the
		// active-account view mode). See useMoveTargetVaults.
		const createItemCalls: Array<{ vaultId: string; itemId: string }> = [];
		const sourceDeletes: string[] = [];

		const targetVaultKey = JSON.stringify({
			ciphertext: "wrapped",
			iv: "vault-iv",
			algorithm: "aes-256-gcm",
			context: {
				vaultId: "vault_target",
				userId: "user_target",
				keyVersion: 1,
				purpose: "vault-key-wrap",
			},
		});

		const service = new ItemService({
			storage: {
				// One account active, the other merely unlocked in the background.
				getActiveAccount: async () => ({
					type: "single",
					accountId: "acc_source",
				}),
				getAccountsList: async () => [
					{ accountId: "acc_source", email: "alice@example.com" },
					{ accountId: "acc_target", email: "bob@example.com" },
				],
				supportsMultiAccount: true,
				getVaultKeys: async () => [
					{ vaultId: "vault_target", encryptedVaultKey: targetVaultKey },
				],
				getMasterUnlockKey: async () => new Uint8Array([1, 2, 3]),
				getEncryptedPrivateKey: async () => null,
				getStoredSessionData: async () => ({ userId: "user_target" }),
				getAccountMetadata: async () => ({ userId: "user_target" }),
				getActiveAccountUserId: async () => "user_target",
			} as never,
			crypto: {
				generateUuid: async () => "item_new",
				decrypt: async () => Buffer.from("vault-key").toString("base64"),
				encrypt: async () => ({
					ciphertext: "cipher",
					iv: "iv",
					algorithm: "aes-256-gcm",
				}),
			} as never,
			accounts: {
				getClientForAccount: async (_default: unknown, accountId: string) => {
					if (accountId === "acc_target") {
						return {
							vault: {
								createItem: {
									mutate: async (input: {
										vaultId: string;
										itemId: string;
									}) => {
										createItemCalls.push({
											vaultId: input.vaultId,
											itemId: input.itemId,
										});
										return { itemId: input.itemId };
									},
								},
							},
						};
					}
					return {
						vault: {
							listAttachments: {
								query: async () => [],
							},
							deleteItem: {
								mutate: async ({ itemId }: { itemId: string }) => {
									sourceDeletes.push(itemId);
									return {};
								},
							},
							permanentlyDeleteItem: {
								mutate: async () => ({}),
							},
						},
					};
				},
			} as never,
		});

		const result = await service.moveItem(
			{
				itemId: "item_1",
				sourceVaultId: "vault_source",
				targetVaultId: "vault_target",
				category: "login",
				decryptedData: { title: "example.com" },
				sourceAccountEmail: "alice@example.com",
				targetAccountEmail: "bob@example.com",
			},
			{} as never,
		);

		expect(result.crossAccount).toBe(true);
		expect(result.newItemId).toBe("item_new");
		expect(createItemCalls).toEqual([
			{ vaultId: "vault_target", itemId: "item_new" },
		]);
		expect(sourceDeletes).toEqual(["item_1"]);
	});

	test("migrates attachments during a cross-account move before deleting the source", async () => {
		const originalFetch = globalThis.fetch;
		const putBodies: string[] = [];
		const createAttachmentCalls: Array<{
			itemId: string;
			storageKey: string;
		}> = [];
		const attachmentEncryptContexts: Array<string | undefined> = [];
		const eventLog: string[] = [];

		// Source vault key + target vault key (both need to be present so the
		// source blob can be decrypted and re-encrypted for the target).
		const wrappedKey = (vaultId: string, userId: string) =>
			JSON.stringify({
				ciphertext: "wrapped",
				iv: "vault-iv",
				algorithm: "aes-256-gcm",
				context: { vaultId, userId, keyVersion: 1, purpose: "vault-key-wrap" },
			});

		globalThis.fetch = (async (_url: string, init?: { body?: unknown }) => {
			if (init?.body) {
				eventLog.push("put");
				putBodies.push(new TextDecoder().decode(init.body as Uint8Array));
				return { ok: true } as never;
			}
			eventLog.push("get");
			// Downloaded blob envelope (source ciphertext).
			return {
				ok: true,
				text: async () =>
					JSON.stringify({
						ciphertext: "src-blob-cipher",
						iv: "src-blob-iv",
						algorithm: "aes-256-gcm",
					}),
			} as never;
		}) as never;

		try {
			const service = new ItemService({
				storage: {
					getAccountsList: async () => [
						{ accountId: "acc_source", email: "alice@example.com" },
						{ accountId: "acc_target", email: "bob@example.com" },
					],
					getVaultKeys: async (accountId: string) =>
						accountId === "acc_target"
							? [
									{
										vaultId: "vault_target",
										encryptedVaultKey: wrappedKey(
											"vault_target",
											"user_target",
										),
									},
								]
							: [
									{
										vaultId: "vault_source",
										encryptedVaultKey: wrappedKey(
											"vault_source",
											"user_source",
										),
									},
								],
					getMasterUnlockKey: async () => new Uint8Array([1, 2, 3]),
					getEncryptedPrivateKey: async () => null,
					getStoredSessionData: async (accountId?: string) => ({
						userId: accountId === "acc_target" ? "user_target" : "user_source",
					}),
					getAccountMetadata: async (accountId?: string) => ({
						userId: accountId === "acc_target" ? "user_target" : "user_source",
					}),
					getActiveAccountUserId: async () => "user_target",
				} as never,
				crypto: {
					generateUuid: async () => "item_new",
					decrypt: async (
						_encryptedData: EncryptedData,
						_key: Uint8Array,
						context?: EncryptionContext,
					) => {
						if (context?.entityType === "vault_key") {
							return Buffer.from("vault-key").toString("base64");
						}
						if (context?.entityType === "attachment_blob") {
							return "ZmlsZQ=="; // base64("file")
						}
						if (context?.entityType === "attachment_name") {
							return "secret.txt";
						}
						if (context?.entityType === "attachment_content_type") {
							return "text/plain";
						}
						return Buffer.from("vault-key").toString("base64");
					},
					encrypt: async (
						_plaintext: string,
						_key: Uint8Array,
						context?: EncryptionContext,
					) => {
						if (context?.entityType?.startsWith("attachment")) {
							attachmentEncryptContexts.push(context.entityType);
						}
						return {
							ciphertext: `re-${context?.entityType ?? "item"}`,
							iv: "new-iv",
							algorithm: "aes-256-gcm",
						};
					},
				} as never,
				accounts: {
					getClientForAccount: async (_default: unknown, accountId: string) => {
						if (accountId === "acc_target") {
							return {
								vault: {
									createItem: {
										mutate: async (input: { itemId: string }) => {
											eventLog.push("createItem");
											return { itemId: input.itemId };
										},
									},
									createAttachmentUpload: {
										mutate: async (input: { itemId: string }) => {
											eventLog.push("createAttachmentUpload");
											return {
												key: `newkey_${input.itemId}`,
												uploadUrl: "https://upload.example/put",
												publicUrl: null,
											};
										},
									},
									createAttachment: {
										mutate: async (input: {
											itemId: string;
											storageKey: string;
										}) => {
											eventLog.push("createAttachment");
											createAttachmentCalls.push({
												itemId: input.itemId,
												storageKey: input.storageKey,
											});
											return { attachmentId: "att_new" };
										},
									},
								},
							};
						}
						return {
							vault: {
								listAttachments: {
									query: async () => [
										{
											id: "att_src",
											itemId: "item_1",
											vaultId: "vault_source",
											storageKey: "srckey",
											encryptedName: "enc-name",
											encryptedContentType: "enc-ct",
											encryptionIv: "name-iv",
											encryptedContentTypeIv: "ct-iv",
											encryptionAlgorithm: "aes-256-gcm",
											fileSize: 4,
											uploadedBy: "user_source",
											createdAt: "2026-01-01T00:00:00.000Z",
										},
									],
								},
								getAttachmentDownloadUrl: {
									mutate: async () => ({
										downloadUrl: "https://download.example/get",
									}),
								},
								deleteItem: {
									mutate: async () => {
										eventLog.push("sourceDelete");
										return {};
									},
								},
								permanentlyDeleteItem: {
									mutate: async () => ({}),
								},
							},
						};
					},
				} as never,
			});

			const result = await service.moveItem(
				{
					itemId: "item_1",
					sourceVaultId: "vault_source",
					targetVaultId: "vault_target",
					category: "login",
					decryptedData: { title: "example.com" },
					sourceAccountEmail: "alice@example.com",
					targetAccountEmail: "bob@example.com",
				},
				{} as never,
			);

			expect(result.crossAccount).toBe(true);
			// Attachment re-created on the target item with the freshly-minted key.
			expect(createAttachmentCalls).toEqual([
				{ itemId: "item_new", storageKey: "newkey_item_new" },
			]);
			// Blob was re-encrypted for the target (fresh ciphertext PUT to storage).
			expect(putBodies).toHaveLength(1);
			expect(putBodies[0]).toContain("re-attachment_blob");
			expect(attachmentEncryptContexts).toEqual([
				"attachment_blob",
				"attachment_name",
				"attachment_content_type",
			]);
			// Source delete happens only AFTER the attachment was created.
			expect(eventLog.indexOf("createAttachment")).toBeLessThan(
				eventLog.indexOf("sourceDelete"),
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("does not delete the source when attachment migration fails", async () => {
		const originalFetch = globalThis.fetch;
		let sourceDeleted = false;
		let targetItemDeleted = false;

		const wrappedKey = (vaultId: string, userId: string) =>
			JSON.stringify({
				ciphertext: "wrapped",
				iv: "vault-iv",
				algorithm: "aes-256-gcm",
				context: { vaultId, userId, keyVersion: 1, purpose: "vault-key-wrap" },
			});

		// Blob download fails -> migration aborts before any source deletion.
		globalThis.fetch = (async () => ({ ok: false })) as never;

		try {
			const service = new ItemService({
				storage: {
					getAccountsList: async () => [
						{ accountId: "acc_source", email: "alice@example.com" },
						{ accountId: "acc_target", email: "bob@example.com" },
					],
					getVaultKeys: async (accountId: string) =>
						accountId === "acc_target"
							? [
									{
										vaultId: "vault_target",
										encryptedVaultKey: wrappedKey(
											"vault_target",
											"user_target",
										),
									},
								]
							: [
									{
										vaultId: "vault_source",
										encryptedVaultKey: wrappedKey(
											"vault_source",
											"user_source",
										),
									},
								],
					getMasterUnlockKey: async () => new Uint8Array([1, 2, 3]),
					getEncryptedPrivateKey: async () => null,
					getStoredSessionData: async (accountId?: string) => ({
						userId: accountId === "acc_target" ? "user_target" : "user_source",
					}),
					getAccountMetadata: async (accountId?: string) => ({
						userId: accountId === "acc_target" ? "user_target" : "user_source",
					}),
					getActiveAccountUserId: async () => "user_target",
				} as never,
				crypto: {
					generateUuid: async () => "item_new",
					decrypt: async () => Buffer.from("vault-key").toString("base64"),
					encrypt: async () => ({
						ciphertext: "cipher",
						iv: "iv",
						algorithm: "aes-256-gcm",
					}),
				} as never,
				accounts: {
					getClientForAccount: async (_default: unknown, accountId: string) => {
						if (accountId === "acc_target") {
							return {
								vault: {
									createItem: {
										mutate: async (input: { itemId: string }) => ({
											itemId: input.itemId,
										}),
									},
									deleteItem: {
										mutate: async () => {
											targetItemDeleted = true;
											return {};
										},
									},
									permanentlyDeleteItem: {
										mutate: async () => ({}),
									},
								},
							};
						}
						return {
							vault: {
								listAttachments: {
									query: async () => [
										{
											id: "att_src",
											itemId: "item_1",
											vaultId: "vault_source",
											storageKey: "srckey",
											encryptedName: "enc-name",
											encryptedContentType: "enc-ct",
											encryptionIv: "name-iv",
											encryptedContentTypeIv: "ct-iv",
											encryptionAlgorithm: "aes-256-gcm",
											fileSize: 4,
											uploadedBy: "user_source",
											createdAt: "2026-01-01T00:00:00.000Z",
										},
									],
								},
								getAttachmentDownloadUrl: {
									mutate: async () => ({
										downloadUrl: "https://download.example/get",
									}),
								},
								deleteItem: {
									mutate: async () => {
										sourceDeleted = true;
										return {};
									},
								},
								permanentlyDeleteItem: {
									mutate: async () => ({}),
								},
							},
						};
					},
				} as never,
			});

			await expect(
				service.moveItem(
					{
						itemId: "item_1",
						sourceVaultId: "vault_source",
						targetVaultId: "vault_target",
						category: "login",
						decryptedData: { title: "example.com" },
						sourceAccountEmail: "alice@example.com",
						targetAccountEmail: "bob@example.com",
					},
					{} as never,
				),
			).rejects.toThrow();

			expect(sourceDeleted).toBe(false);
			// Best-effort cleanup removed the partially-created target item.
			expect(targetItemDeleted).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
