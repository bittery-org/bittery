// Types
export * from "./types";

// Core sync functionality
export { createSyncManager, SyncManager } from "./sync-manager";

// Offline queue
export { createOfflineQueue, OfflineQueue } from "./offline-queue";

// Offline cache
export {
	createOfflineCacheManager,
	OfflineCacheManager,
	type CachedItem,
	type CachedVault,
	type CacheMetadata,
	type PendingItemOperation,
	type SyncConflict,
} from "./offline-cache";

// Query invalidation helpers
export type {
	InvalidationContext,
	QueryInvalidator,
	QueryInvalidatorOptions,
	QueryKeyHelpers,
} from "./query-invalidation";
export {
	createQueryInvalidator,
	getQueryKeysForEvent,
	invalidateQueriesForEvent,
} from "./query-invalidation";

// React hooks
export type { UseSyncOptions } from "./use-sync";
export { generateClientId, getOrCreateClientId, useSync } from "./use-sync";

export type {
	ConnectivityStatus,
	OfflineSyncStatus,
	UseOfflineVaultOptions,
	UseOfflineVaultReturn,
} from "./use-offline-vault";
export { createConnectivityMonitor, useOfflineVault } from "./use-offline-vault";
