import { useRPC, useRPCClient } from "@bittery/shared/rpc";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OutboundQueue, type OutboundQueueClient } from "./outbound-queue";
import {
	createQueryInvalidator,
	invalidateQueriesForEvent,
	type QueryKeyHelpers,
} from "./query-invalidation";
import {
	SyncOrchestrator,
	type SyncOrchestratorOptions,
} from "./sync-orchestrator";
import type {
	ItemCacheAdapter,
	SessionRevokedControlPayload,
	SyncEvent,
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
}

export interface SyncSource {
	id: string;
	serverUrl: string;
	getAuthToken: () => Promise<string | null>;
	rpcClient: SyncOrchestratorOptions["rpcClient"];
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
): SyncStatus {
	const list = Array.from(statuses);
	if (list.length === 0) {
		return {
			connectionStatus: "disconnected",
			lastSyncTime: null,
			pendingChanges,
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
	itemCacheAdapter?: ItemCacheAdapter;
	itemCacheAccountId?: string | null;
	itemCacheAccountEmail?: string | null;
	itemCacheServerUrl?: string | null;
	sources?: SyncSource[];
	getClientForAccount?: (
		accountId: string,
	) => OutboundQueueClient | Promise<OutboundQueueClient>;
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
	/** Custom fetch implementation (e.g. `expo/fetch` for streaming support in React Native) */
	fetch?: (url: string, init?: any) => Promise<Response>;
}

/**
 * React hook for real-time synchronization
 */
export function useSync(options: UseSyncOptions) {
	const rpc = useRPC();
	const rpcClient = useRPCClient();

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
		resolveLegacyAccountId,
		onSessionRevoked,
		onEventProcessed,
		fetch: fetchImpl,
	} = options;

	const syncStorage = useMemo<SyncStorage>(
		() => storage ?? new MemorySyncStorage(),
		[storage],
	);
	const outboundQueue = useMemo(
		() => new OutboundQueue(syncStorage, clientId, resolveLegacyAccountId),
		[syncStorage, clientId, resolveLegacyAccountId],
	);
	const orchestratorsRef = useRef<Map<string, SyncOrchestrator>>(new Map());
	const sourceStatusesRef = useRef<Map<string, SyncStatus>>(new Map());

	const [status, setStatus] = useState<SyncStatus>({
		connectionStatus: "disconnected",
		lastSyncTime: null,
		pendingChanges: 0,
		error: null,
	});

	const invalidateForEvent = useCallback(
		async (event: Parameters<typeof invalidateQueriesForEvent>[0]["event"]) => {
			await invalidateQueriesForEvent({
				queryClient,
				rpc: rpc as unknown as QueryKeyHelpers,
				event,
			});
		},
		[queryClient, rpc],
	);

	const syncSources = useMemo<SyncSource[]>(() => {
		if (sources && sources.length > 0) {
			return sources;
		}

		return [
			{
				id: "default",
				serverUrl,
				getAuthToken,
				rpcClient: rpcClient as unknown as SyncOrchestratorOptions["rpcClient"],
				itemCacheAccountId,
				itemCacheAccountEmail,
				itemCacheServerUrl,
			},
		];
	}, [
		sources,
		serverUrl,
		getAuthToken,
		rpcClient,
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
				),
			);
		};

		for (const [index, source] of syncSources.entries()) {
			const sourceStorage = new NamespacedSyncStorage(
				syncStorage,
				`sync_source_${encodeURIComponent(source.id)}`,
			);
			const orchestrator = new SyncOrchestrator({
				syncManager: {
					serverUrl: source.serverUrl,
					getAuthToken: source.getAuthToken,
					clientId,
					storage: sourceStorage,
					fetch: fetchImpl,
				},
				rpcClient: source.rpcClient,
				itemCache: itemCacheAdapter,
				outboundQueue,
				itemCacheAccountId: source.itemCacheAccountId,
				itemCacheAccountEmail: source.itemCacheAccountEmail,
				itemCacheServerUrl: source.itemCacheServerUrl,
				getClientForAccount,
				drainOutboundQueue: index === 0,
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
			setStatus((prev) => ({
				...prev,
				pendingChanges: outboundQueue.getPendingCount(),
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
		itemCacheAdapter,
		syncSources,
		clientId,
		syncStorage,
		fetchImpl,
		outboundQueue,
		getClientForAccount,
		onSessionRevoked,
		onEventProcessed,
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
				rpc: rpc as unknown as QueryKeyHelpers,
			}),
		[queryClient, rpc],
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
