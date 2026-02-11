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
	realtimeEnabled?: boolean;
	itemCacheAdapter?: ItemCacheAdapter;
	itemCacheAccountEmail?: string | null;
	catchUpIntervalMs?: number;
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
		catchUpIntervalMs = 0,
		fetch: fetchImpl,
	} = options;

	const [status, setStatus] = useState<SyncStatus>({
		connectionStatus: "disconnected",
		lastSyncTime: null,
		pendingChanges: 0,
		error: null,
	});

	const syncManagerRef = useRef<SyncManager | null>(null);
	const catchUpInFlightRef = useRef(false);
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
		await itemCacheAdapter?.clearItemCache?.(
			itemCacheAccountEmail ?? undefined,
		);
		await queryClient.invalidateQueries();
	}, [itemCacheAdapter, queryClient, itemCacheAccountEmail]);

	const runStartupCatchUp = useCallback(async () => {
		if (!itemCacheAdapter?.supportsItemCache) {
			return;
		}

		const token = await getAuthToken();
		if (!token) {
			return;
		}

		const manager = syncManagerRef.current;
		if (!manager) {
			return;
		}

		const lastCursor = await manager.getStoredLastSyncCursor();
		if (!lastCursor) {
			// No baseline cursor exists yet; refresh once so startup is never stuck on stale data.
			console.log("[useSync] No stored cursor, forcing baseline full refresh");
			await handleFullRefresh();
			await manager.setStoredLastSyncCursor({
				timestamp: Date.now(),
				id: "",
			});
			return;
		}

		const result = await runCatchUp({
			client: trpcClient as unknown as CatchUpClient,
			initialCursor: lastCursor,
			onEvent: async (event) => {
				try {
					await performDeltaSync(
						trpcClient,
						itemCacheAdapter,
						event,
						itemCacheAccountEmail ?? undefined,
					);
				} catch (error) {
					console.error(
						"[useSync] Catch-up delta sync failed, forcing full refresh:",
						error,
					);
					await handleFullRefresh();
				}
			},
			shouldProcessEvent: (event) => event.clientId !== clientId,
			onRequiresFullRefresh: async () => {
				await handleFullRefresh();
			},
		});
		console.log("[useSync] Catch-up result", {
			processedCount: result.processedCount,
			requiresFullRefresh: result.requiresFullRefresh,
			cursor: result.cursor,
		});

		await manager.setStoredLastSyncCursor(result.cursor);

		if (result.processedCount > 0 && !result.requiresFullRefresh) {
			await invalidateAfterCatchUp();
		}
	}, [
		itemCacheAdapter,
		getAuthToken,
		trpcClient,
		clientId,
		itemCacheAccountEmail,
		handleFullRefresh,
		invalidateAfterCatchUp,
	]);

	const runCatchUpSafely = useCallback(async () => {
		if (catchUpInFlightRef.current) {
			return;
		}

		catchUpInFlightRef.current = true;
		try {
			await runStartupCatchUp();
		} finally {
			catchUpInFlightRef.current = false;
		}
	}, [runStartupCatchUp]);

	/**
	 * Handle incoming sync events from other clients
	 * Delta sync: fetch only the changed entity, update local cache, then invalidate queries
	 */
	const handleSyncEvent = useCallback(
		async (event: SyncEvent) => {
			console.log("[useSync] Received sync event", {
				id: event.id,
				type: event.type,
				entityId: event.entityId,
				clientId: event.clientId,
			});
			// Step 1: Delta sync - fetch only changed entity, update local cache
			if (itemCacheAdapter?.supportsItemCache) {
				try {
					await performDeltaSync(
						trpcClient,
						itemCacheAdapter,
						event,
						itemCacheAccountEmail ?? undefined,
					);
				} catch (e) {
					console.error(
						"[useSync] Delta sync failed, falling back to full invalidation:",
						e,
					);
					await handleFullRefresh();
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
		[
			queryClient,
			trpc,
			trpcClient,
			itemCacheAdapter,
			itemCacheAccountEmail,
			handleFullRefresh,
		],
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
			console.log("[useSync] Connection status", connectionStatus);

			// Catch-up on missed events when reconnected
			if (connectionStatus === "connected") {
				try {
					await runCatchUpSafely();
				} catch (e) {
					console.error(
						"[useSync] Catch-up failed, full refetch will happen:",
						e,
					);
				}
			}
		},
		[runCatchUpSafely],
	);

	/**
	 * Optional polling fallback for platforms where SSE can be unreliable.
	 * Runs catch-up on an interval to recover missed updates even when no events stream in.
	 */
	useEffect(() => {
		if (!enabled || catchUpIntervalMs <= 0 || realtimeEnabled) {
			return;
		}

		const interval = setInterval(() => {
			void runCatchUpSafely().catch((error) => {
				console.error("[useSync] Periodic catch-up failed:", error);
			});
		}, catchUpIntervalMs);

		return () => {
			clearInterval(interval);
		};
	}, [enabled, catchUpIntervalMs, runCatchUpSafely, realtimeEnabled]);

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
			fetch: fetchImpl,
		});
		syncManagerRef.current = syncManager;

		if (realtimeEnabled) {
			// Connect SSE stream for live updates.
			(async () => {
				await syncManager.connect();
			})();
		} else {
			// Polling-only mode (useful on platforms where SSE is unreliable).
			setStatus((prev) => ({
				...prev,
				connectionStatus: "connected",
				error: null,
			}));
			void runCatchUpSafely().catch((error) => {
				console.error("[useSync] Initial polling catch-up failed:", error);
			});
		}

		// Cleanup on unmount
		return () => {
			if (realtimeEnabled) {
				syncManager.disconnect();
			}
			syncManagerRef.current = null;
		};
	}, [
		enabled,
		realtimeEnabled,
		serverUrl,
		getAuthToken,
		clientId,
		storage,
		handleSyncEvent,
		handleStatusChange,
		runCatchUpSafely,
		fetchImpl,
	]);

	/**
	 * Manually trigger reconnection
	 */
	const reconnect = useCallback(async () => {
		if (syncManagerRef.current) {
			if (realtimeEnabled) {
				syncManagerRef.current.disconnect();
				await syncManagerRef.current.connect();
			} else {
				await runCatchUpSafely();
				setStatus((prev) => ({
					...prev,
					connectionStatus: "connected",
					error: null,
				}));
			}
		}
	}, [realtimeEnabled, runCatchUpSafely]);

	/**
	 * Disconnect from sync
	 */
	const disconnect = useCallback(() => {
		if (syncManagerRef.current) {
			if (realtimeEnabled) {
				syncManagerRef.current.disconnect();
			}
			setStatus((prev) => ({
				...prev,
				connectionStatus: "disconnected",
				error: null,
			}));
		}
	}, [realtimeEnabled]);

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
