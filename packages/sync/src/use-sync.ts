import { useApiClient } from "@bittery/shared/api";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ItemSyncEngine, type OutboundQueueApiClient } from "./outbound-queue";
import {
	createQueryInvalidator,
	invalidateQueriesForEvent,
	type QueryInvalidator,
} from "./query-invalidation";
import {
	buildDefaultSyncSourceId,
	type SyncEventContext,
	type SyncSource,
	selectScopedSyncSources,
} from "./source";
import { MemorySyncStorage, NamespacedSyncStorage } from "./storage";
import {
	SyncOrchestrator,
	type SyncOrchestratorOptions,
} from "./sync-orchestrator";
import { subscribeToNewTerminalCommands } from "./terminal-command-status";
import type {
	ItemCommandProjection,
	SemanticItemCommandExecutor,
	SessionRevokedControlPayload,
	SyncCommandSummary,
	SyncEvent,
	SyncOrchestratorReplica,
	SyncStatus,
	SyncStorage,
} from "./types";

function aggregateStatuses(
	statuses: Iterable<SyncStatus>,
	pendingChanges: number,
	commandSummary: SyncCommandSummary,
): SyncStatus {
	const list = Array.from(statuses);
	if (list.length === 0) {
		return {
			connectionStatus: "disconnected",
			lastSyncTime: null,
			pendingChanges,
			commandSummary,
			error: null,
		};
	}

	const connectionStatus = list.every(
		(status) => status.connectionStatus === "connected",
	)
		? "connected"
		: list.some((status) => status.connectionStatus === "error")
			? "error"
			: list.some((status) => status.connectionStatus === "connecting")
				? "connecting"
				: list.some((status) => status.connectionStatus === "reconnecting")
					? "reconnecting"
					: "disconnected";

	const lastSyncTime = list.reduce<number | null>((latest, current) => {
		if (current.lastSyncTime === null) {
			return latest;
		}
		return latest === null
			? current.lastSyncTime
			: Math.max(latest, current.lastSyncTime);
	}, null);

	return {
		connectionStatus,
		lastSyncTime,
		pendingChanges,
		commandSummary,
		error: list.find((status) => status.error)?.error ?? null,
	};
}

/**
 * Options for useSync hook
 */
export interface UseSyncOptions {
	serverUrl: string;
	getAuthToken: () => Promise<string | null>;
	clientId: string;
	queryClient: QueryClient;
	storage?: SyncStorage;
	enabled?: boolean;
	realtimeEnabled?: boolean;
	/** Replica state updated by inbound sync events. */
	replicaStore?: SyncOrchestratorReplica;
	/** Optimistic local projection and acknowledgement reconciliation. */
	commandProjection?: ItemCommandProjection;
	/** Executor for commands that do not map to the ordinary item API. */
	semanticCommandExecutor?: SemanticItemCommandExecutor;
	itemCacheAccountId?: string | null;
	itemCacheAccountEmail?: string | null;
	itemCacheServerUrl?: string | null;
	sources?: SyncSource[];
	getClientForAccount?: (
		accountId: string,
	) => OutboundQueueApiClient | Promise<OutboundQueueApiClient>;
	refreshFromServer?: SyncOrchestratorOptions["refreshFromServer"];
	initializeFromServer?: SyncOrchestratorOptions["initializeFromServer"];
	onSessionRevoked?: (
		payload: SessionRevokedControlPayload,
	) => void | Promise<void>;
	onEventProcessed?: (
		event: SyncEvent,
		context: SyncEventContext,
	) => void | Promise<void>;
	onTerminalCommandFailure?: (newTerminalCount: number) => void;
}

/**
 * What {@link useSync} returns, and therefore what a platform's sync React context carries.
 *
 * Declared here rather than once per app because web, desktop and mobile had three
 * near-identical private copies of it, and a member added to the hook's return silently
 * reached none of them. Desktop and mobile extend it with `isInitialized`, which is genuinely
 * theirs: both resolve their sync sources asynchronously at boot and gate on the answer,
 * whereas web's are available synchronously.
 *
 * The extension does NOT use this. Its provider does not own a connection — the background
 * worker does — so it publishes the worker's {@link ConnectionStatus} instead of a
 * {@link SyncStatus} and has no `reconnect`/`disconnect` to offer. See the note on its own
 * declaration.
 */
export interface SyncContextValue {
	status: SyncStatus;
	clientId: string;
	isConnected: boolean;
	isOnline: boolean;
	reconnect: () => Promise<void>;
	disconnect: () => void;
	invalidator: QueryInvalidator;
	outboundQueue: ItemSyncEngine;
}

/**
 * React hook for real-time synchronization
 */
export function useSync(options: UseSyncOptions): SyncContextValue {
	const apiClient = useApiClient();

	const {
		serverUrl,
		getAuthToken,
		clientId,
		queryClient,
		storage,
		enabled = true,
		realtimeEnabled = true,
		replicaStore,
		commandProjection,
		semanticCommandExecutor,
		itemCacheAccountId,
		itemCacheAccountEmail,
		itemCacheServerUrl,
		sources,
		getClientForAccount,
		refreshFromServer,
		initializeFromServer,
		onSessionRevoked,
		onEventProcessed,
		onTerminalCommandFailure,
	} = options;

	const syncStorage = useMemo<SyncStorage>(
		() => storage ?? new MemorySyncStorage(),
		[storage],
	);
	const outboundQueue = useMemo(
		() =>
			new ItemSyncEngine(syncStorage, clientId, {
				apply: async (command) => {
					await commandProjection?.applyItemCommand(command);
				},
				executeSemanticCommand: async (command) =>
					semanticCommandExecutor?.executeSemanticItemCommand(command),
				discardAcknowledgedElsewhere: async (command) => {
					await commandProjection?.discardItemCommandAcknowledgedElsewhere(
						command,
					);
				},
				preserveConflict: async (command) =>
					commandProjection?.preserveItemConflict(command),
				reconcileAuthoritative: async (command, item) => {
					await replicaStore?.upsertCachedItem(item, command.accountId);
				},
				acknowledge: async (command, acknowledgement) => {
					await commandProjection?.acknowledgeItemCommand(
						command,
						acknowledgement,
					);
				},
			}),
		[
			syncStorage,
			clientId,
			commandProjection,
			semanticCommandExecutor,
			replicaStore,
		],
	);
	const orchestratorsRef = useRef<Map<string, SyncOrchestrator>>(new Map());
	const sourceStatusesRef = useRef<Map<string, SyncStatus>>(new Map());

	const [status, setStatus] = useState<SyncStatus>({
		connectionStatus: "disconnected",
		lastSyncTime: null,
		pendingChanges: 0,
		commandSummary: {
			pending: 0,
			retrying: 0,
			conflicted: 0,
			failed: 0,
		},
		error: null,
	});

	const invalidateForEvent = useCallback(
		async (event: Parameters<typeof invalidateQueriesForEvent>[0]["event"]) => {
			await invalidateQueriesForEvent({
				queryClient,
				event,
			});
		},
		[queryClient],
	);

	const syncSources = useMemo<SyncSource[]>(() => {
		if (sources && sources.length > 0) {
			return selectScopedSyncSources(sources);
		}

		return selectScopedSyncSources([
			{
				id: buildDefaultSyncSourceId(serverUrl, itemCacheAccountId),
				serverUrl,
				getAuthToken,
				apiClient,
				refreshFromServer,
				initializeFromServer,
				itemCacheAccountId,
				itemCacheAccountEmail,
				itemCacheServerUrl,
			},
		]);
	}, [
		sources,
		serverUrl,
		getAuthToken,
		apiClient,
		refreshFromServer,
		initializeFromServer,
		itemCacheAccountId,
		itemCacheAccountEmail,
		itemCacheServerUrl,
	]);

	useEffect(() => {
		if (!enabled || !replicaStore || syncSources.length === 0) {
			return;
		}

		let disposed = false;
		const unsubscribers: Array<() => void> = [];
		const orchestrators = new Map<string, SyncOrchestrator>();
		sourceStatusesRef.current = new Map();

		const updateStatus = () => {
			if (disposed) {
				return;
			}
			setStatus(
				aggregateStatuses(
					sourceStatusesRef.current.values(),
					outboundQueue.getPendingCount(),
					outboundQueue.getCommandSummary(),
				),
			);
		};

		for (const source of syncSources) {
			const sourceStorage = new NamespacedSyncStorage(
				syncStorage,
				`sync_source_${encodeURIComponent(source.id)}`,
			);
			const orchestrator = new SyncOrchestrator({
				syncManager: {
					clientId,
					storage: sourceStorage,
				},
				apiClient: source.apiClient,
				refreshFromServer: source.refreshFromServer,
				initializeFromServer: source.initializeFromServer,
				itemCache: replicaStore,
				outboundQueue,
				itemCacheAccountId: source.itemCacheAccountId,
				itemCacheAccountEmail: source.itemCacheAccountEmail,
				itemCacheServerUrl: source.itemCacheServerUrl,
				getClientForAccount,
				// Any connected source may drain the shared outbound queue; the
				// queue serializes concurrent drains internally. Gating on a single
				// source (e.g. index === 0) would starve every account's outbound
				// sync whenever that one source failed to connect.
				drainOutboundQueue: true,
				onEventProcessed: async (event) => {
					await invalidateForEvent(event);
					await onEventProcessed?.(event, {
						sourceId: source.id,
						accountId: source.itemCacheAccountId,
						accountEmail: source.itemCacheAccountEmail,
						serverUrl: source.itemCacheServerUrl ?? source.serverUrl,
					});
				},
				onSessionRevoked,
			});

			orchestrators.set(source.id, orchestrator);
			unsubscribers.push(
				orchestrator.subscribe((nextStatus) => {
					sourceStatusesRef.current.set(source.id, nextStatus);
					updateStatus();
				}),
			);
		}

		orchestratorsRef.current = orchestrators;

		(async () => {
			await outboundQueue.restore();
			if (disposed) {
				return;
			}
			unsubscribers.push(
				subscribeToNewTerminalCommands(outboundQueue, (newTerminalCount) => {
					onTerminalCommandFailure?.(newTerminalCount);
				}),
			);
			setStatus((prev) => ({
				...prev,
				pendingChanges: outboundQueue.getPendingCount(),
				commandSummary: outboundQueue.getCommandSummary(),
			}));

			await Promise.all(
				Array.from(orchestrators.values()).map((orchestrator) =>
					realtimeEnabled ? orchestrator.connect() : orchestrator.reconnect(),
				),
			);
		})();

		return () => {
			disposed = true;
			for (const unsubscribe of unsubscribers) {
				unsubscribe();
			}
			for (const orchestrator of orchestrators.values()) {
				orchestrator.dispose();
			}
			orchestratorsRef.current = new Map();
			sourceStatusesRef.current = new Map();
		};
	}, [
		enabled,
		replicaStore,
		syncSources,
		clientId,
		syncStorage,
		outboundQueue,
		getClientForAccount,
		onSessionRevoked,
		onEventProcessed,
		onTerminalCommandFailure,
		invalidateForEvent,
		realtimeEnabled,
	]);

	/**
	 * Manually trigger reconnection
	 */
	const reconnect = useCallback(async () => {
		await Promise.all(
			Array.from(orchestratorsRef.current.values()).map((orchestrator) =>
				orchestrator.reconnect(),
			),
		);
	}, []);

	/**
	 * Disconnect from sync
	 */
	const disconnect = useCallback(() => {
		for (const orchestrator of orchestratorsRef.current.values()) {
			orchestrator.disconnect();
		}
		setStatus((prev) => ({
			...prev,
			connectionStatus: "disconnected",
			error: null,
		}));
	}, []);

	/**
	 * Query invalidator for use by mutations
	 * Provides centralized invalidation methods that match sync event handling
	 */
	const invalidator = useMemo(
		() =>
			createQueryInvalidator({
				queryClient,
			}),
		[queryClient],
	);

	return {
		status,
		clientId,
		reconnect,
		disconnect,
		invalidator,
		outboundQueue,
		isConnected: status.connectionStatus === "connected",
		isOnline:
			status.connectionStatus !== "disconnected" &&
			status.connectionStatus !== "error",
	};
}

/**
 * Generate a unique client ID
 */
export function generateClientId(): string {
	return `client_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Get or create a client ID from storage
 */
export function getOrCreateClientId(storage: Storage): string {
	const key = "bittery_sync_client_id";
	let clientId = storage.getItem(key);

	if (!clientId) {
		clientId = generateClientId();
		storage.setItem(key, clientId);
	}

	return clientId;
}
