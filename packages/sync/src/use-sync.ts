import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type CatchUpClient, runCatchUp } from "./catch-up";
import { performDeltaSync } from "./delta-sync";
import {
	createQueryInvalidator,
	invalidateQueriesForEvent,
	type QueryKeyHelpers,
} from "./query-invalidation";
import { createSyncManager, type SyncManager } from "./sync-manager";
import type {
	ConnectionStatus,
	ItemCacheAdapter,
	SyncEvent,
	SyncStatus,
	SyncStorage,
} from "./types";

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
	itemCacheAdapter?: ItemCacheAdapter;
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
		itemCacheAdapter,
	} = options;

	const [status, setStatus] = useState<SyncStatus>({
		connectionStatus: "disconnected",
		lastSyncTime: null,
		pendingChanges: 0,
		error: null,
	});

	const syncManagerRef = useRef<SyncManager | null>(null);
	const invalidateAfterCatchUp = useCallback(async () => {
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: ["items"] }),
			queryClient.invalidateQueries({ queryKey: ["vault-items"] }),
			queryClient.invalidateQueries({ queryKey: ["decrypted-item"] }),
			queryClient.invalidateQueries({ queryKey: ["deleted-items"] }),
			queryClient.invalidateQueries({ queryKey: ["vault-keys"] }),
		]);
	}, [queryClient]);

	const handleFullRefresh = useCallback(async () => {
		await itemCacheAdapter?.clearItemCache?.();
		await queryClient.invalidateQueries();
	}, [itemCacheAdapter, queryClient]);

	/**
	 * Handle incoming sync events from other clients
	 * Delta sync: fetch only the changed entity, update local cache, then invalidate queries
	 */
	const handleSyncEvent = useCallback(
		async (event: SyncEvent) => {
			// Step 1: Delta sync - fetch only changed entity, update local cache
			if (itemCacheAdapter?.supportsItemCache) {
				try {
					await performDeltaSync(trpcClient, itemCacheAdapter, event);
				} catch (e) {
					console.error(
						"[useSync] Delta sync failed, falling back to full invalidation:",
						e,
					);
				}
			}

			// Step 2: Invalidate queries (reads from updated cache if delta sync succeeded)
			await invalidateQueriesForEvent({
				queryClient,
				trpc: trpc as unknown as QueryKeyHelpers,
				event,
			});

			// Step 3: Persist cursor for catch-up recovery on reconnect/reload
			await syncManagerRef.current?.setStoredLastSyncCursor({
				timestamp: event.timestamp,
				id: event.id,
			});

			// Update last sync time
			setStatus((prev) => ({
				...prev,
				lastSyncTime: event.timestamp,
			}));
		},
		[queryClient, trpc, trpcClient, itemCacheAdapter],
	);

	/**
	 * Handle connection status changes
	 */
	const handleStatusChange = useCallback(
		async (connectionStatus: ConnectionStatus) => {
			setStatus((prev) => ({
				...prev,
				connectionStatus,
				error: connectionStatus === "error" ? "Connection failed" : null,
			}));

			// Catch-up on missed events when reconnected
			if (
				connectionStatus === "connected" &&
				itemCacheAdapter?.supportsItemCache
			) {
				try {
					const lastCursor =
						await syncManagerRef.current?.getStoredLastSyncCursor();
					if (!lastCursor) return;

					const result = await runCatchUp({
						client: trpcClient as unknown as CatchUpClient,
						initialCursor: lastCursor,
						onEvent: async (event) => {
							await performDeltaSync(trpcClient, itemCacheAdapter, event);
						},
						shouldProcessEvent: (event) => event.clientId !== clientId,
						onRequiresFullRefresh: async () => {
							await handleFullRefresh();
						},
					});

					await syncManagerRef.current?.setStoredLastSyncCursor(result.cursor);

					if (result.processedCount > 0 && !result.requiresFullRefresh) {
						await invalidateAfterCatchUp();
					}
				} catch (e) {
					console.error(
						"[useSync] Catch-up failed, full refetch will happen:",
						e,
					);
				}
			}
		},
		[
			trpcClient,
			itemCacheAdapter,
			clientId,
			handleFullRefresh,
			invalidateAfterCatchUp,
		],
	);

	/**
	 * Initialize sync manager
	 */
	useEffect(() => {
		if (!enabled) {
			return;
		}

		// Create sync manager
		const syncManager = createSyncManager({
			serverUrl,
			getAuthToken,
			clientId,
			storage,
			onEvent: handleSyncEvent,
			onStatusChange: handleStatusChange,
		});
		syncManagerRef.current = syncManager;

		// Connect
		(async () => {
			await syncManager.connect();
		})();

		// Cleanup on unmount
		return () => {
			syncManager.disconnect();
			syncManagerRef.current = null;
		};
	}, [
		enabled,
		serverUrl,
		getAuthToken,
		clientId,
		storage,
		handleSyncEvent,
		handleStatusChange,
	]);

	/**
	 * Manually trigger reconnection
	 */
	const reconnect = useCallback(async () => {
		if (syncManagerRef.current) {
			syncManagerRef.current.disconnect();
			await syncManagerRef.current.connect();
		}
	}, []);

	/**
	 * Disconnect from sync
	 */
	const disconnect = useCallback(() => {
		if (syncManagerRef.current) {
			syncManagerRef.current.disconnect();
		}
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
