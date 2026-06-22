// Query invalidation helpers

export type {
	CatchUpClient,
	CatchUpPageResponse,
	RunCatchUpOptions,
	RunCatchUpResult,
} from "./catch-up";
export { runCatchUp } from "./catch-up";
// Delta sync (platform-agnostic)
export type { DeltaSyncClient } from "./delta-sync";
export { performDeltaSync } from "./delta-sync";
export {
	OutboundQueue,
	type OutboundQueueClient,
	type PendingMutation,
	type TempIdMapping,
} from "./outbound-queue";
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
export {
	SyncOrchestrator,
	type SyncOrchestratorOptions,
} from "./sync-orchestrator";
export * from "./types";
// React hooks
export type { SyncEventContext, SyncSource, UseSyncOptions } from "./use-sync";
export { generateClientId, getOrCreateClientId, useSync } from "./use-sync";
