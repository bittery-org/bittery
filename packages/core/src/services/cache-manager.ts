import type { IStorageAdapter } from "@bittery/storage/adapter";
import type {
	CachedEncryptedItem,
	CachedVaultMetadata,
} from "@bittery/types";

export interface EncryptedPayload {
	ciphertext: string;
	iv: string;
	algorithm: string;
}

export class CacheManager {
	constructor(private readonly storage: IStorageAdapter) {}

	get supportsCache(): boolean {
		return !!this.storage.supportsItemCache;
	}

	async getCachedItems(email?: string): Promise<CachedEncryptedItem[] | null> {
		if (!this.supportsCache) return null;
		return (await this.storage.getCachedItems?.(email)) ?? null;
	}

	async getCachedVaults(email?: string): Promise<CachedVaultMetadata[] | null> {
		if (!this.supportsCache) return null;
		return (await this.storage.getCachedVaults?.(email)) ?? null;
	}

	async populateFromServerResponse(
		items: CachedEncryptedItem[],
		vaults: CachedVaultMetadata[],
		email?: string,
	): Promise<void> {
		if (!this.supportsCache) return;

		await this.storage.setCachedItems?.(items, email);
		await this.storage.setCachedVaults?.(vaults, email);
		await this.storage.setItemCacheMetadata?.(
			{
				lastFullSyncAt: Date.now(),
				itemCount: items.length,
				cacheVersion: 1,
			},
			email,
		);
	}

	async onItemCreated(input: {
		itemId: string;
		vaultId: string;
		category: string;
		encryptedData: EncryptedPayload;
		accountEmail?: string;
		favorite?: boolean;
	}): Promise<void> {
		if (!this.supportsCache) return;

		const now = new Date().toISOString();
		await this.storage.upsertCachedItem?.(
			{
				id: input.itemId,
				vaultId: input.vaultId,
				category: input.category,
				favorite: input.favorite ?? false,
				encryptedData: input.encryptedData.ciphertext,
				encryptionIv: input.encryptedData.iv,
				encryptionAlgorithm: input.encryptedData.algorithm,
				version: 1,
				lastModifiedBy: null,
				createdAt: now,
				updatedAt: now,
				deletedAt: null,
			},
			input.accountEmail,
		);
	}

	async onItemUpdated(input: {
		itemId: string;
		encryptedData: EncryptedPayload;
		accountEmail?: string;
	}): Promise<void> {
		if (!this.supportsCache) return;

		const cachedItems = await this.storage.getCachedItems?.(input.accountEmail);
		const existing = cachedItems?.find((item) => item.id === input.itemId);
		if (!existing) return;

		await this.storage.upsertCachedItem?.(
			{
				...existing,
				encryptedData: input.encryptedData.ciphertext,
				encryptionIv: input.encryptedData.iv,
				encryptionAlgorithm: input.encryptedData.algorithm,
				updatedAt: new Date().toISOString(),
				version: existing.version + 1,
			},
			input.accountEmail,
		);
	}

	async onItemDeleted(input: {
		itemId: string;
		accountEmail?: string;
	}): Promise<void> {
		if (!this.supportsCache) return;

		const cachedItems = await this.storage.getCachedItems?.(input.accountEmail);
		const existing = cachedItems?.find((item) => item.id === input.itemId);
		if (!existing) return;

		const now = new Date().toISOString();
		await this.storage.upsertCachedItem?.(
			{
				...existing,
				deletedAt: now,
				updatedAt: now,
			},
			input.accountEmail,
		);
	}

	async onItemRestored(input: {
		itemId: string;
		accountEmail?: string;
	}): Promise<void> {
		if (!this.supportsCache) return;

		const cachedItems = await this.storage.getCachedItems?.(input.accountEmail);
		const existing = cachedItems?.find((item) => item.id === input.itemId);
		if (!existing) return;

		await this.storage.upsertCachedItem?.(
			{
				...existing,
				deletedAt: null,
				updatedAt: new Date().toISOString(),
			},
			input.accountEmail,
		);
	}

	async onItemPermanentlyDeleted(input: {
		itemId: string;
		accountEmail?: string;
	}): Promise<void> {
		if (!this.supportsCache) return;
		await this.storage.removeCachedItem?.(input.itemId, input.accountEmail);
	}

	async onFavoriteToggled(input: {
		itemId: string;
		favorite: boolean;
		accountEmail?: string;
	}): Promise<void> {
		if (!this.supportsCache) return;

		const cachedItems = await this.storage.getCachedItems?.(input.accountEmail);
		const existing = cachedItems?.find((item) => item.id === input.itemId);
		if (!existing) return;

		await this.storage.upsertCachedItem?.(
			{
				...existing,
				favorite: input.favorite,
				updatedAt: new Date().toISOString(),
			},
			input.accountEmail,
		);
	}

	async onItemMoved(input: {
		itemId: string;
		sourceVaultId: string;
		targetVaultId: string;
		category: string;
		crossAccount: boolean;
		newItemId?: string;
		encryptedData?: EncryptedPayload;
		sourceAccountEmail?: string;
		targetAccountEmail?: string;
	}): Promise<void> {
		if (!this.supportsCache) return;

		if (input.crossAccount) {
			await this.storage.removeCachedItem?.(
				input.itemId,
				input.sourceAccountEmail,
			);
			if (input.newItemId && input.encryptedData) {
				const now = new Date().toISOString();
				await this.storage.upsertCachedItem?.(
					{
						id: input.newItemId,
						vaultId: input.targetVaultId,
						category: input.category,
						favorite: false,
						encryptedData: input.encryptedData.ciphertext,
						encryptionIv: input.encryptedData.iv,
						encryptionAlgorithm: input.encryptedData.algorithm,
						version: 1,
						lastModifiedBy: null,
						createdAt: now,
						updatedAt: now,
						deletedAt: null,
					},
					input.targetAccountEmail,
				);
			}
			return;
		}

		if (!input.encryptedData) return;

		const cachedItems = await this.storage.getCachedItems?.(
			input.sourceAccountEmail,
		);
		const existing = cachedItems?.find((item) => item.id === input.itemId);
		if (!existing) return;

		await this.storage.upsertCachedItem?.(
			{
				...existing,
				vaultId: input.targetVaultId,
				encryptedData: input.encryptedData.ciphertext,
				encryptionIv: input.encryptedData.iv,
				encryptionAlgorithm: input.encryptedData.algorithm,
				updatedAt: new Date().toISOString(),
			},
			input.sourceAccountEmail,
		);
	}
}
