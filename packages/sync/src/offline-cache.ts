/**
 * Offline Vault Cache Manager
 * Provides encrypted local caching of vault items for offline access
 *
 * Features:
 * - Encrypted storage of decrypted item data
 * - Automatic cache invalidation based on sync events
 * - Support for viewing, creating, and editing items offline
 * - Automatic sync when connectivity is restored
 */

import type { SyncStorage } from "./types";

// Cache storage keys
const CACHE_ITEMS_PREFIX = "offline_cache_items_";
const CACHE_VAULTS_KEY = "offline_cache_vaults";
const CACHE_METADATA_KEY = "offline_cache_metadata";
const PENDING_ITEMS_KEY = "offline_pending_items";

/**
 * Cached item representation
 * Stores both encrypted and decrypted data for offline access
 */
export interface CachedItem {
	id: string;
	vaultId: string;
	category: string;
	favorite: boolean;
	createdAt: string;
	updatedAt: string;
	version: number;
	// Encrypted data from server (for re-sync verification)
	encryptedData: string;
	encryptionIv: string;
	encryptionAlgorithm: string;
	// Decrypted data (stored encrypted locally with device key)
	decryptedData: string; // JSON string of DecryptedItemData, encrypted with local key
	// Sync metadata
	lastSyncedAt: number;
	isLocalOnly: boolean; // True if created offline
	isModifiedLocally: boolean; // True if modified offline
	localVersion: number; // For conflict detection
}

/**
 * Cached vault metadata
 */
export interface CachedVault {
	id: string;
	name: string;
	type: "personal" | "team";
	icon?: string | null;
	imageUrl?: string | null;
	lastSyncedAt: number;
	itemCount: number;
}

/**
 * Pending item operation for offline sync
 */
export interface PendingItemOperation {
	id: string;
	operationType: "create" | "update" | "delete";
	itemId: string;
	vaultId: string;
	data?: string; // Encrypted item data for create/update
	iv?: string;
	algorithm?: string;
	category?: string;
	favorite?: boolean;
	timestamp: number;
	retryCount: number;
}

/**
 * Cache metadata
 */
export interface CacheMetadata {
	lastFullSyncAt: number | null;
	lastIncrementalSyncAt: number | null;
	cacheVersion: string;
	totalItemsCached: number;
	totalVaultsCached: number;
}

/**
 * Sync conflict information
 */
export interface SyncConflict {
	itemId: string;
	vaultId: string;
	localItem: CachedItem;
	serverItem: {
		encryptedData: string;
		encryptionIv: string;
		encryptionAlgorithm: string;
		version: number;
		updatedAt: string;
	};
	conflictType: "update_conflict" | "delete_conflict";
	detectedAt: number;
}

const CACHE_VERSION = "1.0.0";

/**
 * Default in-memory storage implementation
 */
class MemoryStorage implements SyncStorage {
	private data = new Map<string, unknown>();

	async get<T>(key: string): Promise<T | null> {
		return (this.data.get(key) as T) || null;
	}

	async set<T>(key: string, value: T): Promise<void> {
		this.data.set(key, value);
	}

	async remove(key: string): Promise<void> {
		this.data.delete(key);
	}
}

/**
 * OfflineCacheManager handles local caching of vault items
 */
export class OfflineCacheManager {
	private storage: SyncStorage;
	private onCacheChange?: (vaultId: string) => void;
	private onConflictDetected?: (conflict: SyncConflict) => void;

	constructor(
		storage?: SyncStorage,
		options?: {
			onCacheChange?: (vaultId: string) => void;
			onConflictDetected?: (conflict: SyncConflict) => void;
		},
	) {
		this.storage = storage || new MemoryStorage();
		this.onCacheChange = options?.onCacheChange;
		this.onConflictDetected = options?.onConflictDetected;
	}

	/**
	 * Initialize the cache
	 */
	async init(): Promise<void> {
		const metadata = await this.getMetadata();
		if (!metadata) {
			await this.setMetadata({
				lastFullSyncAt: null,
				lastIncrementalSyncAt: null,
				cacheVersion: CACHE_VERSION,
				totalItemsCached: 0,
				totalVaultsCached: 0,
			});
		}
	}

	/**
	 * Get cache metadata
	 */
	async getMetadata(): Promise<CacheMetadata | null> {
		return this.storage.get<CacheMetadata>(CACHE_METADATA_KEY);
	}

	/**
	 * Set cache metadata
	 */
	private async setMetadata(metadata: CacheMetadata): Promise<void> {
		await this.storage.set(CACHE_METADATA_KEY, metadata);
	}

	/**
	 * Cache vault metadata
	 */
	async cacheVault(vault: CachedVault): Promise<void> {
		const vaults = (await this.getCachedVaults()) || [];
		const existingIndex = vaults.findIndex((v) => v.id === vault.id);

		if (existingIndex >= 0) {
			vaults[existingIndex] = vault;
		} else {
			vaults.push(vault);
		}

		await this.storage.set(CACHE_VAULTS_KEY, vaults);

		// Update metadata
		const metadata = await this.getMetadata();
		if (metadata) {
			metadata.totalVaultsCached = vaults.length;
			await this.setMetadata(metadata);
		}
	}

	/**
	 * Get all cached vaults
	 */
	async getCachedVaults(): Promise<CachedVault[]> {
		return (await this.storage.get<CachedVault[]>(CACHE_VAULTS_KEY)) || [];
	}

	/**
	 * Get a specific cached vault
	 */
	async getCachedVault(vaultId: string): Promise<CachedVault | null> {
		const vaults = await this.getCachedVaults();
		return vaults.find((v) => v.id === vaultId) || null;
	}

	/**
	 * Cache items for a vault
	 */
	async cacheItems(vaultId: string, items: CachedItem[]): Promise<void> {
		const key = `${CACHE_ITEMS_PREFIX}${vaultId}`;
		await this.storage.set(key, items);

		// Update vault item count
		const vault = await this.getCachedVault(vaultId);
		if (vault) {
			vault.itemCount = items.length;
			vault.lastSyncedAt = Date.now();
			await this.cacheVault(vault);
		}

		// Update metadata
		const metadata = await this.getMetadata();
		if (metadata) {
			// Recalculate total items
			const vaults = await this.getCachedVaults();
			metadata.totalItemsCached = vaults.reduce(
				(sum, v) => sum + v.itemCount,
				0,
			);
			metadata.lastIncrementalSyncAt = Date.now();
			await this.setMetadata(metadata);
		}

		this.onCacheChange?.(vaultId);
	}

	/**
	 * Get cached items for a vault
	 */
	async getCachedItems(vaultId: string): Promise<CachedItem[]> {
		const key = `${CACHE_ITEMS_PREFIX}${vaultId}`;
		return (await this.storage.get<CachedItem[]>(key)) || [];
	}

	/**
	 * Get a specific cached item
	 */
	async getCachedItem(
		vaultId: string,
		itemId: string,
	): Promise<CachedItem | null> {
		const items = await this.getCachedItems(vaultId);
		return items.find((item) => item.id === itemId) || null;
	}

	/**
	 * Add or update a single cached item
	 */
	async upsertCachedItem(vaultId: string, item: CachedItem): Promise<void> {
		const items = await this.getCachedItems(vaultId);
		const existingIndex = items.findIndex((i) => i.id === item.id);

		if (existingIndex >= 0) {
			items[existingIndex] = item;
		} else {
			items.push(item);
		}

		await this.cacheItems(vaultId, items);
	}

	/**
	 * Remove a cached item
	 */
	async removeCachedItem(vaultId: string, itemId: string): Promise<void> {
		const items = await this.getCachedItems(vaultId);
		const filtered = items.filter((item) => item.id !== itemId);
		await this.cacheItems(vaultId, filtered);
	}

	/**
	 * Create an item while offline
	 * Returns a temporary ID for the new item
	 */
	async createOfflineItem(
		vaultId: string,
		item: Omit<
			CachedItem,
			| "id"
			| "lastSyncedAt"
			| "isLocalOnly"
			| "isModifiedLocally"
			| "localVersion"
			| "version"
		>,
	): Promise<string> {
		const tempId = `offline_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

		const cachedItem: CachedItem = {
			...item,
			id: tempId,
			version: 0,
			lastSyncedAt: Date.now(),
			isLocalOnly: true,
			isModifiedLocally: false,
			localVersion: 1,
		};

		await this.upsertCachedItem(vaultId, cachedItem);

		// Add to pending operations
		await this.addPendingOperation({
			id: `pending_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
			operationType: "create",
			itemId: tempId,
			vaultId,
			data: item.encryptedData,
			iv: item.encryptionIv,
			algorithm: item.encryptionAlgorithm,
			category: item.category,
			favorite: item.favorite,
			timestamp: Date.now(),
			retryCount: 0,
		});

		return tempId;
	}

	/**
	 * Update an item while offline
	 */
	async updateOfflineItem(
		vaultId: string,
		itemId: string,
		updates: Partial<
			Pick<
				CachedItem,
				| "encryptedData"
				| "encryptionIv"
				| "decryptedData"
				| "favorite"
				| "category"
			>
		>,
	): Promise<void> {
		const item = await this.getCachedItem(vaultId, itemId);
		if (!item) {
			throw new Error(`Item ${itemId} not found in cache`);
		}

		const updatedItem: CachedItem = {
			...item,
			...updates,
			updatedAt: new Date().toISOString(),
			isModifiedLocally: true,
			localVersion: item.localVersion + 1,
		};

		await this.upsertCachedItem(vaultId, updatedItem);

		// Add to pending operations
		await this.addPendingOperation({
			id: `pending_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
			operationType: item.isLocalOnly ? "create" : "update",
			itemId,
			vaultId,
			data: updates.encryptedData || item.encryptedData,
			iv: updates.encryptionIv || item.encryptionIv,
			algorithm: item.encryptionAlgorithm,
			category: updates.category || item.category,
			favorite: updates.favorite ?? item.favorite,
			timestamp: Date.now(),
			retryCount: 0,
		});
	}

	/**
	 * Delete an item while offline
	 */
	async deleteOfflineItem(vaultId: string, itemId: string): Promise<void> {
		const item = await this.getCachedItem(vaultId, itemId);
		if (!item) {
			return; // Already deleted
		}

		// If item was created offline and never synced, just remove it
		if (item.isLocalOnly) {
			await this.removeCachedItem(vaultId, itemId);
			// Remove any pending create operations for this item
			await this.removePendingOperationsForItem(itemId);
			return;
		}

		// Mark as deleted locally (keep for sync)
		const deletedItem: CachedItem = {
			...item,
			isModifiedLocally: true,
			localVersion: item.localVersion + 1,
		};

		await this.upsertCachedItem(vaultId, deletedItem);

		// Add delete operation to pending
		await this.addPendingOperation({
			id: `pending_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
			operationType: "delete",
			itemId,
			vaultId,
			timestamp: Date.now(),
			retryCount: 0,
		});
	}

	/**
	 * Get all pending operations
	 */
	async getPendingOperations(): Promise<PendingItemOperation[]> {
		return (
			(await this.storage.get<PendingItemOperation[]>(PENDING_ITEMS_KEY)) || []
		);
	}

	/**
	 * Get pending operations count
	 */
	async getPendingCount(): Promise<number> {
		const operations = await this.getPendingOperations();
		return operations.length;
	}

	/**
	 * Add a pending operation
	 */
	private async addPendingOperation(
		operation: PendingItemOperation,
	): Promise<void> {
		const operations = await this.getPendingOperations();

		// Check for existing operations on the same item and merge
		const existingIndex = operations.findIndex(
			(op) => op.itemId === operation.itemId,
		);

		if (existingIndex >= 0) {
			const existing = operations[existingIndex];
			if (!existing) {
				// Should not happen, but TypeScript needs this check
				operations.push(operation);
				await this.storage.set(PENDING_ITEMS_KEY, operations);
				return;
			}

			// Merge logic:
			// - create + update = create (with latest data)
			// - create + delete = remove both (item never existed on server)
			// - update + update = update (with latest data)
			// - update + delete = delete
			if (existing.operationType === "create") {
				if (operation.operationType === "delete") {
					// Remove the create operation entirely
					operations.splice(existingIndex, 1);
					await this.storage.set(PENDING_ITEMS_KEY, operations);
					return;
				}
				// Keep as create with updated data
				const updatedExisting: PendingItemOperation = {
					...existing,
					data: operation.data || existing.data,
					iv: operation.iv || existing.iv,
					category: operation.category || existing.category,
					favorite: operation.favorite ?? existing.favorite,
					timestamp: operation.timestamp,
				};
				operations[existingIndex] = updatedExisting;
				await this.storage.set(PENDING_ITEMS_KEY, operations);
				return;
			}

			if (existing.operationType === "update") {
				if (operation.operationType === "delete") {
					// Replace update with delete
					operations[existingIndex] = operation;
				} else {
					// Update with latest data
					const updatedExisting: PendingItemOperation = {
						...existing,
						data: operation.data || existing.data,
						iv: operation.iv || existing.iv,
						category: operation.category || existing.category,
						favorite: operation.favorite ?? existing.favorite,
						timestamp: operation.timestamp,
					};
					operations[existingIndex] = updatedExisting;
				}
				await this.storage.set(PENDING_ITEMS_KEY, operations);
				return;
			}
		}

		// No existing operation, add new one
		operations.push(operation);
		await this.storage.set(PENDING_ITEMS_KEY, operations);
	}

	/**
	 * Remove pending operations for an item
	 */
	private async removePendingOperationsForItem(itemId: string): Promise<void> {
		const operations = await this.getPendingOperations();
		const filtered = operations.filter((op) => op.itemId !== itemId);
		await this.storage.set(PENDING_ITEMS_KEY, filtered);
	}

	/**
	 * Remove a specific pending operation
	 */
	async removePendingOperation(operationId: string): Promise<void> {
		const operations = await this.getPendingOperations();
		const filtered = operations.filter((op) => op.id !== operationId);
		await this.storage.set(PENDING_ITEMS_KEY, filtered);
	}

	/**
	 * Update pending operation retry count
	 */
	async incrementPendingOperationRetry(operationId: string): Promise<void> {
		const operations = await this.getPendingOperations();
		const operation = operations.find((op) => op.id === operationId);
		if (operation) {
			operation.retryCount++;
			await this.storage.set(PENDING_ITEMS_KEY, operations);
		}
	}

	/**
	 * Clear all pending operations
	 */
	async clearPendingOperations(): Promise<void> {
		await this.storage.set(PENDING_ITEMS_KEY, []);
	}

	/**
	 * Handle server item update (for conflict detection)
	 */
	async handleServerUpdate(
		vaultId: string,
		serverItem: {
			id: string;
			encryptedData: string;
			encryptionIv: string;
			encryptionAlgorithm: string;
			version: number;
			updatedAt: string;
			category: string;
			favorite: boolean;
		},
		decryptedData: string,
	): Promise<boolean> {
		const cachedItem = await this.getCachedItem(vaultId, serverItem.id);

		// If we have local modifications, check for conflicts
		if (cachedItem?.isModifiedLocally) {
			// Conflict detected!
			const conflict: SyncConflict = {
				itemId: serverItem.id,
				vaultId,
				localItem: cachedItem,
				serverItem: {
					encryptedData: serverItem.encryptedData,
					encryptionIv: serverItem.encryptionIv,
					encryptionAlgorithm: serverItem.encryptionAlgorithm,
					version: serverItem.version,
					updatedAt: serverItem.updatedAt,
				},
				conflictType: "update_conflict",
				detectedAt: Date.now(),
			};

			this.onConflictDetected?.(conflict);
			return false; // Conflict not resolved
		}

		// No conflict, update cache
		const updatedItem: CachedItem = {
			id: serverItem.id,
			vaultId,
			category: serverItem.category,
			favorite: serverItem.favorite,
			createdAt: cachedItem?.createdAt || serverItem.updatedAt,
			updatedAt: serverItem.updatedAt,
			version: serverItem.version,
			encryptedData: serverItem.encryptedData,
			encryptionIv: serverItem.encryptionIv,
			encryptionAlgorithm: serverItem.encryptionAlgorithm,
			decryptedData,
			lastSyncedAt: Date.now(),
			isLocalOnly: false,
			isModifiedLocally: false,
			localVersion: serverItem.version,
		};

		await this.upsertCachedItem(vaultId, updatedItem);
		return true; // Successfully updated
	}

	/**
	 * Handle server item deletion
	 */
	async handleServerDelete(vaultId: string, itemId: string): Promise<boolean> {
		const cachedItem = await this.getCachedItem(vaultId, itemId);

		// If we have local modifications, check for conflicts
		if (cachedItem?.isModifiedLocally && !cachedItem.isLocalOnly) {
			// Conflict: item was modified locally but deleted on server
			const conflict: SyncConflict = {
				itemId,
				vaultId,
				localItem: cachedItem,
				serverItem: {
					encryptedData: "",
					encryptionIv: "",
					encryptionAlgorithm: "",
					version: -1,
					updatedAt: new Date().toISOString(),
				},
				conflictType: "delete_conflict",
				detectedAt: Date.now(),
			};

			this.onConflictDetected?.(conflict);
			return false; // Conflict not resolved
		}

		// No conflict, remove from cache
		await this.removeCachedItem(vaultId, itemId);
		return true;
	}

	/**
	 * Resolve a conflict by keeping local changes
	 */
	async resolveConflictKeepLocal(
		conflict: SyncConflict,
	): Promise<PendingItemOperation> {
		// Re-queue the local changes for sync
		const operation: PendingItemOperation = {
			id: `pending_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
			operationType: conflict.localItem.isLocalOnly ? "create" : "update",
			itemId: conflict.itemId,
			vaultId: conflict.vaultId,
			data: conflict.localItem.encryptedData,
			iv: conflict.localItem.encryptionIv,
			algorithm: conflict.localItem.encryptionAlgorithm,
			category: conflict.localItem.category,
			favorite: conflict.localItem.favorite,
			timestamp: Date.now(),
			retryCount: 0,
		};

		await this.addPendingOperation(operation);
		return operation;
	}

	/**
	 * Resolve a conflict by keeping server changes
	 */
	async resolveConflictKeepServer(
		conflict: SyncConflict,
		serverDecryptedData: string,
	): Promise<void> {
		if (conflict.conflictType === "delete_conflict") {
			// Server deleted the item, remove from local cache
			await this.removeCachedItem(conflict.vaultId, conflict.itemId);
			await this.removePendingOperationsForItem(conflict.itemId);
		} else {
			// Update local cache with server data
			const updatedItem: CachedItem = {
				...conflict.localItem,
				encryptedData: conflict.serverItem.encryptedData,
				encryptionIv: conflict.serverItem.encryptionIv,
				encryptionAlgorithm: conflict.serverItem.encryptionAlgorithm,
				decryptedData: serverDecryptedData,
				version: conflict.serverItem.version,
				updatedAt: conflict.serverItem.updatedAt,
				lastSyncedAt: Date.now(),
				isModifiedLocally: false,
				localVersion: conflict.serverItem.version,
			};

			await this.upsertCachedItem(conflict.vaultId, updatedItem);
			await this.removePendingOperationsForItem(conflict.itemId);
		}
	}

	/**
	 * Get all items with local modifications (not yet synced)
	 */
	async getLocallyModifiedItems(): Promise<CachedItem[]> {
		const vaults = await this.getCachedVaults();
		const modifiedItems: CachedItem[] = [];

		for (const vault of vaults) {
			const items = await this.getCachedItems(vault.id);
			modifiedItems.push(
				...items.filter((item) => item.isLocalOnly || item.isModifiedLocally),
			);
		}

		return modifiedItems;
	}

	/**
	 * Clear cache for a specific vault
	 */
	async clearVaultCache(vaultId: string): Promise<void> {
		const key = `${CACHE_ITEMS_PREFIX}${vaultId}`;
		await this.storage.remove(key);

		const vaults = await this.getCachedVaults();
		const filtered = vaults.filter((v) => v.id !== vaultId);
		await this.storage.set(CACHE_VAULTS_KEY, filtered);

		// Update metadata
		const metadata = await this.getMetadata();
		if (metadata) {
			metadata.totalVaultsCached = filtered.length;
			metadata.totalItemsCached = filtered.reduce(
				(sum, v) => sum + v.itemCount,
				0,
			);
			await this.setMetadata(metadata);
		}

		this.onCacheChange?.(vaultId);
	}

	/**
	 * Clear all cache data
	 */
	async clearAllCache(): Promise<void> {
		const vaults = await this.getCachedVaults();

		for (const vault of vaults) {
			const key = `${CACHE_ITEMS_PREFIX}${vault.id}`;
			await this.storage.remove(key);
		}

		await this.storage.remove(CACHE_VAULTS_KEY);
		await this.storage.remove(PENDING_ITEMS_KEY);
		await this.setMetadata({
			lastFullSyncAt: null,
			lastIncrementalSyncAt: null,
			cacheVersion: CACHE_VERSION,
			totalItemsCached: 0,
			totalVaultsCached: 0,
		});
	}

	/**
	 * Mark a full sync as complete
	 */
	async markFullSyncComplete(): Promise<void> {
		const metadata = await this.getMetadata();
		if (metadata) {
			metadata.lastFullSyncAt = Date.now();
			metadata.lastIncrementalSyncAt = Date.now();
			await this.setMetadata(metadata);
		}
	}

	/**
	 * Check if cache needs a full sync
	 */
	async needsFullSync(): Promise<boolean> {
		const metadata = await this.getMetadata();
		return !metadata?.lastFullSyncAt;
	}
}

/**
 * Create an offline cache manager instance
 */
export function createOfflineCacheManager(
	storage?: SyncStorage,
	options?: {
		onCacheChange?: (vaultId: string) => void;
		onConflictDetected?: (conflict: SyncConflict) => void;
	},
): OfflineCacheManager {
	return new OfflineCacheManager(storage, options);
}
