import { useApiClient } from "@bittery/shared/api";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ItemSyncEngine, type OutboundQueueApiClient } from "./outbound-queue";
import {
	createQueryInvalidator,
	invalidateQueriesForEvent,
} from "./query-invalidation";
import {
	SyncOrchestrator,
	type SyncOrchestratorOptions,
} from "./sync-orchestrator";
import { subscribeToNewTerminalCommands } from "./terminal-command-status";
import type {
	SessionRevokedControlPayload,
	SyncCommandSummary,
	SyncEvent,
	SyncItemCache,
	SyncStatus,
	SyncStorage,
} from "./types";

class MemorySyncStorage implements SyncStorage {
	private readonly data = new Map<string, unknown>();

	async get<T>(key: string): Promise<T | null> {
		return (this.data.get(key) as T | undefined) ?? null;
	}

	async set<T>(key: string, value: T): Promise<void> {
		this.data.set(key, value);
	}

	async remove(key: string): Promise<void> {
		this.data.delete(key);
	}
}

class NamespacedSyncStorage implements SyncStorage {
	constructor(
		private readonly storage: SyncStorage,
		private readonly namespace: string,
	) {}

	private key(key: string): string {
		return `${this.namespace}:${key}`;
	}

	get<T>(key: string): Promise<T | null> {
		return this.storage.get<T>(this.key(key));
	}

	set<T>(key: string, value: T): Promise<void> {
		return this.storage.set(this.key(key), value);
	}

	remove(key: string): Promise<void> {
		return this.storage.remove(this.key(key));
	}

	update<T>(
		key: string,
		updater: (current: T | null) => T | null,
	): Promise<T | null> {
		if (!this.storage.update) {
			return this.storage.get<T>(this.key(key)).then(async (current) => {
				const next = updater(current);
				if (next === null) {
					await this.storage.remove(this.key(key));
				} else {
					await this.storage.set(this.key(key), next);
				}
				return next;
			});
		}
		return this.storage.update(this.key(key), updater);
	}
}

export interface SyncSource {
	id: string;
	serverUrl: string;
	getAuthToken: () => Promise<string | null>;
	apiClient: SyncOrchestratorOptions["apiClient"];
	refreshFromServer?: SyncOrchestratorOptions["refreshFromServer"];
	initializeFromServer?: SyncOrchestratorOptions["initializeFromServer"];
	itemCacheAccountId?: string | null;
	itemCacheAccountEmail?: string | null;
	itemCacheServerUrl?: string | null;
}

export interface SyncEventContext {
	sourceId: string;
	accountId?: string | null;
	accountEmail?: string | null;
	serverUrl?: string | null;
}

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
 * `SyncOrchestrator.getDeltaSyncAccountScope()` throws without an accountId, so a source
 * that has not resolved one yet can only produce an orchestrator that fails on connect.
 */
export function selectScopedSyncSources(sources: SyncSource[]): SyncSource[] {
	return sources.filter((source) => !!source.itemCacheAccountId);
}

export function buildDefaultSyncSourceId(
	serverUrl: string,
	accountId: string | null | undefined,
): string {
	if (!accountId) {
		return "unscoped";
	}
	let normalizedServerUrl = serverUrl.trim().replace(/\/+$/, "");
	try {
		normalizedServerUrl = new URL(serverUrl).toString().replace(/\/+$/, "");
	} catch {
		// A malformed URL still gets a deterministic isolated scope.
	}
	return `account:${encodeURIComponent(accountId)}:server:${encodeURIComponent(normalizedServerUrl)}`;
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
	itemCacheAdapter?: SyncItemCache;
	itemCacheAccountId?: string | null;
	itemCacheAccountEmail?: string | null;
	itemCacheServerUrl?: string | null;
	sources?: SyncSource[];
	getClientForAccount?: (
		accountId: string,
	) => OutboundQueueApiClient | Promise<OutboundQueueApiClient>;
	refreshFromServer?: SyncOrchestratorOptions["refreshFromServer"];
	initializeFromServer?: SyncOrchestratorOptions["initializeFromServer"];
	resolveLegacyAccountId?: (
		email: string,
	) => string | undefined | Promise<string | undefined>;
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
 * React hook for real-time synchronization
 */
export function useSync(options: UseSyncOptions) {
	const apiClient = useApiClient();

	const {
		serverUrl,
		getAuthToken,
		clientId,
		queryClient,
		storage,
		enabled = true,
		realtimeEnabled = true,
		itemCacheAdapter,
		itemCacheAccountId,
		itemCacheAccountEmail,
		itemCacheServerUrl,
		sources,
		getClientForAccount,
		refreshFromServer,
		initializeFromServer,
		resolveLegacyAccountId,
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
			new ItemSyncEngine(syncStorage, clientId, resolveLegacyAccountId, {
				apply: async (command) => {
					await itemCacheAdapter?.applyItemCommand(command);
				},
				executeSemanticCommand: async (command) =>
					itemCacheAdapter?.executeSemanticItemCommand(command),
				discardAcknowledgedElsewhere: async (command) => {
					await itemCacheAdapter?.discardItemCommandAcknowledgedElsewhere(
						command,
					);
				},
				preserveConflict: async (command) =>
					itemCacheAdapter?.preserveItemConflict(command),
				reconcileAuthoritative: async (command, item) => {
					await itemCacheAdapter?.upsertCachedItem(item, command.accountId);
				},
				acknowledge: async (command, acknowledgement) => {
					await itemCacheAdapter?.acknowledgeItemCommand(
						command,
						acknowledgement,
					);
				},
			}),
		[syncStorage, clientId, resolveLegacyAccountId, itemCacheAdapter],
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
		if (!enabled || !itemCacheAdapter || syncSources.length === 0) {
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
				itemCache: itemCacheAdapter,
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
			await itemCacheAdapter.setEncryptionContextMigrationPort(
				async (context) => {
					const operationId = `adopt-context:${context.accountId}:${context.itemId}:${context.encryptionVersion}:${context.encryptedByUserId}`;
					await outboundQueue.enqueue({
						accountId: context.accountId,
						id: operationId,
						operationId,
						type: "adopt_encryption_context",
						entityId: context.itemId,
						vaultId: context.vaultId,
						encryptedPayload: {
							encryptedData: "",
							encryptionIv: "",
							encryptionAlgorithm: "",
							encryptionVersion: context.encryptionVersion,
							encryptedByUserId: context.encryptedByUserId,
						},
						baseVersion: context.baseVersion,
						timestamp: Date.now(),
						retryCount: 0,
						migrationTrigger: "explicit_open",
					});
				},
			);
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
			void itemCacheAdapter.setEncryptionContextMigrationPort(undefined);
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
		itemCacheAdapter,
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
