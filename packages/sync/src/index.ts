// Types
export * from "./types";

// Core sync functionality
export { SyncManager, createSyncManager } from "./sync-manager";
export { OfflineQueue, createOfflineQueue } from "./offline-queue";

// Query invalidation helpers
export {
	createQueryInvalidator,
	getQueryKeysForEvent,
	invalidateQueriesForEvent,
} from "./query-invalidation";
export type {
	QueryInvalidator,
	QueryInvalidatorOptions,
	QueryKeyHelpers,
	InvalidationContext,
} from "./query-invalidation";

// React integration
export { useSync, generateClientId, getOrCreateClientId } from "./use-sync";
export type { UseSyncOptions } from "./use-sync";
