// Query invalidation helpers

export type {
	IPendingMutationQueue,
	IQueryInvalidator,
	ISyncContext,
} from "./capabilities";
export type {
	CatchUpApiClient,
	CatchUpPageResponse,
	RunCatchUpOptions,
	RunCatchUpResult,
} from "./catch-up";
export { runCatchUp } from "./catch-up";
// Delta sync (platform-agnostic)
export type { DeltaSyncApiClient } from "./delta-sync";
export { performDeltaSync } from "./delta-sync";
export {
	createNativeItemSyncCommand,
	type NativeEncryptedItemHandoff,
} from "./native-command-handoff";
export {
	ItemSyncEngine,
	OutboundQueue,
	type OutboundQueueApiClient,
	type PendingMutation,
	SemanticOperationRejected,
	type TempIdMapping,
} from "./outbound-queue";
export type {
	InvalidationContext,
	QueryInvalidator,
	QueryInvalidatorOptions,
} from "./query-invalidation";
export {
	createQueryInvalidator,
	getQueryKeysForEvent,
	invalidateQueriesForEvent,
} from "./query-invalidation";
export type { SyncEventContext, SyncSource } from "./source";
export {
	buildDefaultSyncSourceId,
	selectScopedSyncSources,
} from "./source";
export { MemorySyncStorage, NamespacedSyncStorage } from "./storage";
// Core sync functionality
export { createSyncManager, SyncManager } from "./sync-manager";
export {
	type SyncApiClient,
	SyncOrchestrator,
	type SyncOrchestratorOptions,
} from "./sync-orchestrator";
export {
	getNewTerminalCommandCount,
	subscribeToNewTerminalCommands,
} from "./terminal-command-status";
export * from "./types";
// React hooks
export type {
	SyncContextValue,
	UseSyncOptions,
} from "./use-sync";
export {
	generateClientId,
	getOrCreateClientId,
	useSync,
} from "./use-sync";
export { useSyncCapability } from "./use-sync-capability";
