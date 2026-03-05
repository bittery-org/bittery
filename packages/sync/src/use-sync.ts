import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
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
	itemCacheAccountEmail?: string | null;
	getClientForAccount?: (
		email: string,
	) => OutboundQueueClient | Promise<OutboundQueueClient>;
	onSessionRevoked?: (
		payload: SessionRevokedControlPayload,
	) => void | Promise<void>;
	/** Custom fetch implementation (e.g. `expo/fetch` for streaming support in React Native) */
	fetch?: (url: string, init?: any) => Promise<Response>;
}

/**
 * React hook for real-time synchronization
 */
export function useSync(options: UseSyncOptions) {
	const trpc = useTRPC();
	const trpcClient = useTRPCClient();

	const {
		serverUrl,
		getAuthToken,
		clientId,
		queryClient,
		storage,
		enabled = true,
		realtimeEnabled = true,
		itemCacheAdapter,
		itemCacheAccountEmail,
		getClientForAccount,
		onSessionRevoked,
		fetch: fetchImpl,
	} = options;

	const syncStorage = useMemo<SyncStorage>(
		() => storage ?? new MemorySyncStorage(),
		[storage],
	);
	const outboundQueue = useMemo(
		() => new OutboundQueue(syncStorage, clientId),
		[syncStorage, clientId],
	);
	const orchestratorRef = useRef<SyncOrchestrator | null>(null);

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
				trpc: trpc as unknown as QueryKeyHelpers,
				event,
			});
		},
		[queryClient, trpc],
	);

	useEffect(() => {
		if (!enabled || !itemCacheAdapter || !serverUrl) {
			return;
		}

		let disposed = false;
		let unsubscribeStatus: (() => void) | undefined;

		const orchestrator = new SyncOrchestrator({
			syncManager: {
				serverUrl,
				getAuthToken,
				clientId,
				storage: syncStorage,
				fetch: fetchImpl,
			},
				trpcClient:
					trpcClient as unknown as SyncOrchestratorOptions["trpcClient"],
				itemCache: itemCacheAdapter,
				outboundQueue,
				itemCacheAccountEmail,
				getClientForAccount,
				onEventProcessed: invalidateForEvent,
				onSessionRevoked,
			});

		orchestratorRef.current = orchestrator;
		unsubscribeStatus = orchestrator.subscribe((nextStatus) => {
			if (disposed) {
				return;
			}
			setStatus({
				...nextStatus,
				pendingChanges: outboundQueue.getPendingCount(),
			});
		});

		(async () => {
			await outboundQueue.restore();
			if (disposed) {
				return;
			}
			setStatus((prev) => ({
				...prev,
				pendingChanges: outboundQueue.getPendingCount(),
			}));

			if (realtimeEnabled) {
				await orchestrator.connect();
			} else {
				await orchestrator.reconnect();
			}
		})();

		return () => {
			disposed = true;
			unsubscribeStatus?.();
			orchestrator.dispose();
			orchestratorRef.current = null;
		};
	}, [
		enabled,
		itemCacheAdapter,
		serverUrl,
		getAuthToken,
		clientId,
		syncStorage,
		fetchImpl,
			trpcClient,
			outboundQueue,
			itemCacheAccountEmail,
			getClientForAccount,
			onSessionRevoked,
			invalidateForEvent,
			realtimeEnabled,
		]);

	/**
	 * Manually trigger reconnection
	 */
	const reconnect = useCallback(async () => {
		if (orchestratorRef.current) {
			await orchestratorRef.current.reconnect();
		}
	}, []);

	/**
	 * Disconnect from sync
	 */
	const disconnect = useCallback(() => {
		orchestratorRef.current?.disconnect();
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
				trpc: trpc as unknown as QueryKeyHelpers,
			}),
		[queryClient, trpc],
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
