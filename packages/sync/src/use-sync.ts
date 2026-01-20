import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { createOfflineQueue, OfflineQueue } from "./offline-queue";
import {
	createQueryInvalidator,
	invalidateQueriesForEvent,
	type QueryKeyHelpers,
} from "./query-invalidation";
import { createSyncManager, SyncManager } from "./sync-manager";
import type {
	ConnectionStatus,
	SyncEvent,
	SyncStatus,
	SyncStorage,
} from "./types";
import { useTRPC } from "@bittery/shared/trpc";

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
}

/**
 * React hook for real-time synchronization
 */
export function useSync(options: UseSyncOptions) {
	const trpc = useTRPC();

	const { serverUrl, getAuthToken, clientId, queryClient, storage, enabled = true } = options;

	const [status, setStatus] = useState<SyncStatus>({
		connectionStatus: "disconnected",
		lastSyncTime: null,
		pendingChanges: 0,
		error: null,
	});

	const syncManagerRef = useRef<SyncManager | null>(null);
	const offlineQueueRef = useRef<OfflineQueue | null>(null);

	/**
	 * Handle incoming sync events from other clients
	 * This invalidates the appropriate queries to refresh stale data
	 */
	const handleSyncEvent = useCallback(
		async (event: SyncEvent) => {
			// Invalidate queries based on the event type
			await invalidateQueriesForEvent({
				queryClient,
				trpc: trpc as unknown as QueryKeyHelpers,
				event,
			});

			// Update last sync time
			setStatus((prev) => ({
				...prev,
				lastSyncTime: event.timestamp,
			}));
		},
		[queryClient, trpc],
	);

	/**
	 * Handle connection status changes
	 */
	const handleStatusChange = useCallback((connectionStatus: ConnectionStatus) => {
		setStatus((prev) => ({
			...prev,
			connectionStatus,
			error: connectionStatus === "error" ? "Connection failed" : null,
		}));

		// If reconnected, process offline queue
		if (connectionStatus === "connected" && offlineQueueRef.current) {
			// TODO: Process offline queue with actual API calls
		}
	}, []);

	/**
	 * Handle offline queue changes
	 */
	const handleQueueChange = useCallback((count: number) => {
		setStatus((prev) => ({
			...prev,
			pendingChanges: count,
		}));
	}, []);

	/**
	 * Initialize sync manager and offline queue
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

		// Create offline queue
		const offlineQueue = createOfflineQueue(storage, handleQueueChange);
		offlineQueueRef.current = offlineQueue;

		// Initialize offline queue and connect
		(async () => {
			await offlineQueue.init();
			await syncManager.connect();
		})();

		// Cleanup on unmount
		return () => {
			syncManager.disconnect();
			syncManagerRef.current = null;
			offlineQueueRef.current = null;
		};
	}, [
		enabled,
		serverUrl,
		getAuthToken,
		clientId,
		storage,
		handleSyncEvent,
		handleStatusChange,
		handleQueueChange,
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
	 * Add operation to offline queue
	 */
	const queueOperation = useCallback(
		async (operation: {
			type: "create" | "update" | "delete";
			entityType: "item" | "vault" | "vault_member" | "vault_key";
			entityId: string;
			vaultId: string;
			data: unknown;
		}) => {
			if (offlineQueueRef.current) {
				return offlineQueueRef.current.mergeOperation(operation);
			}
			return "";
		},
		[],
	);

	/**
	 * Get pending changes count
	 */
	const getPendingChanges = useCallback(() => {
		return offlineQueueRef.current?.count() || 0;
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
		queueOperation,
		getPendingChanges,
		invalidator,
		isConnected: status.connectionStatus === "connected",
		isOnline: status.connectionStatus !== "disconnected" && status.connectionStatus !== "error",
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
