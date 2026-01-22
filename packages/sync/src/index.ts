// Types

// Offline cache
export {
	type CachedItem,
	type CachedVault,
	type CacheMetadata,
	createOfflineCacheManager,
	OfflineCacheManager,
	type PendingItemOperation,
	type SyncConflict,
} from "./offline-cache";
// Offline queue
export { createOfflineQueue, OfflineQueue } from "./offline-queue";
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
// Core sync functionality
export { createSyncManager, SyncManager } from "./sync-manager";
export * from "./types";
export type {
	ConnectivityStatus,
	OfflineSyncStatus,
	UseOfflineVaultOptions,
	UseOfflineVaultReturn,
} from "./use-offline-vault";
export {
	createConnectivityMonitor,
	useOfflineVault,
} from "./use-offline-vault";
// React hooks
export type { UseSyncOptions } from "./use-sync";
export { generateClientId, getOrCreateClientId, useSync } from "./use-sync";
