import { describe, expect, it } from "bun:test";
import { ApiError } from "@bittery/shared/api-client";
import { serverEncryptedItem } from "@bittery/shared/testing/item-fixtures";
import type { CachedEncryptedItem, CachedVaultMetadata } from "@bittery/types";
import { type DeltaSyncApiClient, performDeltaSync } from "../delta-sync";
import type { SyncEvent, SyncItemCache, SyncVaultKeyEntry } from "../types";

function serverVault() {
	return {
		id: "vault_1",
		name: "Team Vault",
		vaultType: "team",
		icon: "lock",
		imageUrl: null,
	};
}

function client(): DeltaSyncApiClient {
	return {
		items: {
			get: async () => {
				throw new Error("not used");
			},
			listInVault: async () => ({ data: [] }),
		},
		vaults: {
			get: async () => ({ data: serverVault() }),
			list: async () => ({
				data: [
					{
						...serverVault(),
						encryptedVaultKey: "ZW5jcnlwdGVk",
						role: "owner",
					},
				],
			}),
		},
	} as unknown as DeltaSyncApiClient;
}

function event(overrides: Partial<SyncEvent> = {}): SyncEvent {
	return {
		id: "evt_1",
		type: "vault_member_added",
		entityId: "vault_1",
		entityType: "vault_member",
		vaultId: "vault_1",
		version: 1,
		clientId: null,
		userId: "user_1",
		timestamp: 0,
		...overrides,
	};
}

function recordingCache() {
	const vaultKeys: SyncVaultKeyEntry[] = [];
	const vaults: CachedVaultMetadata[] = [];
	const items: CachedEncryptedItem[] = [];
	const removedItems: string[] = [];

	const cache: SyncItemCache = {
		syncVaultKeys: async (keys) => {
			vaultKeys.push(...keys);
		},
		upsertCachedVault: async (vault) => {
			vaults.push(vault);
		},
		upsertCachedItem: async (item) => {
			items.push(item);
		},
		removeCachedItem: async (itemId) => {
			removedItems.push(itemId);
		},
		removeCachedVault: async () => undefined,
		clearItemCache: async () => undefined,
		replaceItemId: () => undefined,
		applyItemCommand: async () => undefined,
		executeSemanticItemCommand: async () => undefined,
		discardItemCommandAcknowledgedElsewhere: async () => undefined,
		preserveItemConflict: async () => undefined,
		acknowledgeItemCommand: async () => undefined,
	};

	return { cache, items, removedItems, vaultKeys, vaults };
}

function serverItem() {
	return serverEncryptedItem({
		id: "item_1",
		vaultId: "vault_1",
		encryptedData: "ciphertext",
		encryptionIv: "iv",
		encryptionAlgorithm: "AES-GCM-AAD-V1",
		version: 4,
		lastModifiedBy: "member_2",
		encryptionVersion: 2,
		encryptedByUserId: "member_1",
		createdAt: "2026-08-01T00:00:00.000Z",
		updatedAt: "2026-08-02T00:00:00.000Z",
		deletedAt: null,
		attachments: [],
	});
}

describe("performDeltaSync vault mapping", () => {
	// Regression guard: the server sends `vaultType`, not `type`. Reading the
	// wrong key cached `vaultType: undefined`, and the vault detail page — which
	// only renders member management for `vaultType === "team"` — silently hid
	// every way to share a team vault until the cache was rebuilt elsewhere.
	it("keeps the team type when refreshing vault keys after a member change", async () => {
		const { cache, vaultKeys } = recordingCache();

		await performDeltaSync(client(), cache, event(), "acc_1");

		expect(vaultKeys).toHaveLength(1);
		expect(vaultKeys[0]?.vaultType).toBe("team");
		expect(vaultKeys[0]?.vaultId).toBe("vault_1");
		expect(vaultKeys[0]?.role).toBe("owner");
	});

	it("keeps the team type when caching vault metadata after a vault update", async () => {
		const { cache, vaults } = recordingCache();

		await performDeltaSync(
			client(),
			cache,
			event({ type: "vault_updated" }),
			"acc_1",
		);

		const cached = vaults.find((vault) => vault.id === "vault_1");
		expect(cached?.type).toBe("team");
	});

	it("still refreshes vault keys when a vault is created", async () => {
		const { cache, vaultKeys } = recordingCache();

		await performDeltaSync(
			client(),
			cache,
			event({ type: "vault_created" }),
			"acc_1",
		);

		expect(vaultKeys[0]?.vaultType).toBe("team");
	});

	it("hydrates existing Items and Attachments when Vault access is granted", async () => {
		const attachment = {
			id: "attachment_1",
			itemId: "item_1",
			vaultId: "vault_1",
			storageKey: "attachments/item_1/file.enc",
			encryptedAttachmentKey: "wrapped-key",
			attachmentKeyIv: "key-iv",
			attachmentKeyAlgorithm: "AES-GCM-AAD-V1",
			envelopeVersion: 1,
			encryptedName: "encrypted-name",
			encryptedContentType: "encrypted-type",
			encryptionIv: "name-iv",
			encryptedContentTypeIv: "type-iv",
			encryptionAlgorithm: "AES-GCM-AAD-V1",
			fileSize: 42,
			uploadedBy: "member_1",
			createdAt: "2026-08-01T00:00:00.000Z",
		};
		const api = client();
		api.items.listInVault = async () =>
			({
				data: [{ ...serverItem(), attachments: [attachment] }],
			}) as never;
		const { cache, items, vaultKeys } = recordingCache();

		await performDeltaSync(api, cache, event(), "acc_1");

		expect(vaultKeys).toHaveLength(1);
		expect(items[0]?.attachments).toEqual([attachment]);
	});
});

describe("performDeltaSync Item encryption context", () => {
	it.each([
		"item_created",
		"item_updated",
		"item_restored",
		"item_moved",
	] as const)(
		"converges a %s event when the Item was permanently deleted before its fetch",
		async (type) => {
			const api = client();
			api.items.get = async () => {
				throw new ApiError(
					{
						type: "about:blank",
						title: "Not found",
						status: 404,
						code: "NOT_FOUND",
					},
					null,
				);
			};
			const { cache, removedItems } = recordingCache();

			await performDeltaSync(
				api,
				cache,
				event({ type, entityId: "item_1", entityType: "item" }),
				"acc_1",
			);

			expect(removedItems).toEqual(["item_1"]);
		},
	);

	it("retains an Item event when fetching its trashed state fails transiently", async () => {
		const api = client();
		api.items.get = async () => {
			throw new ApiError(
				{
					type: "about:blank",
					title: "Unavailable",
					status: 503,
					code: "UNAVAILABLE",
				},
				null,
			);
		};
		const { cache } = recordingCache();

		expect(
			performDeltaSync(
				api,
				cache,
				event({ type: "item_deleted", entityType: "item" }),
				"acc_1",
			),
		).rejects.toThrow("Unavailable");
	});

	it("preserves the exact ciphertext context from an Item event", async () => {
		const api = client();
		api.items.get = async () => ({ data: serverItem() }) as never;
		const { cache, items } = recordingCache();

		await performDeltaSync(
			api,
			cache,
			event({
				type: "item_updated",
				entityId: "item_1",
				entityType: "item",
			}),
			"acc_1",
		);

		expect(items[0]?.version).toBe(4);
		expect(items[0]?.encryptionVersion).toBe(2);
		expect(items[0]?.encryptedByUserId).toBe("member_1");
	});

	it("preserves ciphertext context during bulk-import refresh", async () => {
		const api = client();
		api.items.listInVault = async () => ({ data: [serverItem()] }) as never;
		const { cache, items } = recordingCache();

		await performDeltaSync(
			api,
			cache,
			event({
				type: "vault_updated",
				metadata: { reason: "bulk_import" },
			}),
			"acc_1",
		);

		expect(items[0]?.encryptionVersion).toBe(2);
		expect(items[0]?.encryptedByUserId).toBe("member_1");
	});

	it("refreshes re-encrypted items after a Vault key rotation", async () => {
		const api = client();
		api.items.listInVault = async () => ({ data: [serverItem()] }) as never;
		const { cache, items, vaultKeys } = recordingCache();

		await performDeltaSync(
			api,
			cache,
			event({ type: "vault_key_rotated", entityType: "vault_key" }),
			"acc_1",
		);

		expect(vaultKeys).toHaveLength(1);
		expect(items[0]?.encryptedData).toBe(serverItem().encryptedData);
	});
});
