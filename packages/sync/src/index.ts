// Query invalidation helpers

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
	SyncEventContext,
	SyncSource,
	UseSyncOptions,
} from "./use-sync";
export {
	buildDefaultSyncSourceId,
	generateClientId,
	getOrCreateClientId,
	useSync,
} from "./use-sync";
