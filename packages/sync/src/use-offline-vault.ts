/**
 * useOfflineVault Hook
 * React hook for managing offline vault access with encrypted local caching
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type CachedItem,
	type CachedVault,
	createOfflineCacheManager,
	type OfflineCacheManager,
	type PendingItemOperation,
	type SyncConflict,
} from "./offline-cache";
import type { SyncStorage } from "./types";

/**
 * Connection state for the application
 */
export type ConnectivityStatus = "online" | "offline" | "unknown";

/**
 * Sync status for UI display
 */
export interface OfflineSyncStatus {
	isOnline: boolean;
	isSyncing: boolean;
	pendingChangesCount: number;
	lastSyncedAt: number | null;
	hasConflicts: boolean;
	conflictsCount: number;
	error: string | null;
}

/**
 * Options for useOfflineVault hook
 */
export interface UseOfflineVaultOptions {
	storage?: SyncStorage;
	enabled?: boolean;
	onConflict?: (conflict: SyncConflict) => void;
	onSyncComplete?: () => void;
	onSyncError?: (error: Error) => void;
}

/**
 * Return type for useOfflineVault hook
 */
export interface UseOfflineVaultReturn {
	// Status
	status: OfflineSyncStatus;
	isOnline: boolean;

	// Cache operations
	getCachedVaults: () => Promise<CachedVault[]>;
	getCachedItems: (vaultId: string) => Promise<CachedItem[]>;
	getCachedItem: (
		vaultId: string,
		itemId: string,
	) => Promise<CachedItem | null>;

	// Offline operations
	createOfflineItem: (
		vaultId: string,
		item: Omit<
			CachedItem,
			| "id"
			| "lastSyncedAt"
			| "isLocalOnly"
			| "isModifiedLocally"
			| "localVersion"
			| "version"
		>,
	) => Promise<string>;
	updateOfflineItem: (
		vaultId: string,
		itemId: string,
		updates: Partial<
			Pick<
				CachedItem,
				| "encryptedData"
				| "encryptionIv"
				| "decryptedData"
				| "favorite"
				| "category"
			>
		>,
	) => Promise<void>;
	deleteOfflineItem: (vaultId: string, itemId: string) => Promise<void>;

	// Sync operations
	cacheVault: (vault: CachedVault) => Promise<void>;
	cacheItems: (vaultId: string, items: CachedItem[]) => Promise<void>;
	getPendingOperations: () => Promise<PendingItemOperation[]>;
	clearPendingOperations: () => Promise<void>;

	// Conflict resolution
	conflicts: SyncConflict[];
	resolveConflictKeepLocal: (conflict: SyncConflict) => Promise<void>;
	resolveConflictKeepServer: (
		conflict: SyncConflict,
		serverDecryptedData: string,
	) => Promise<void>;
	dismissConflict: (itemId: string) => void;

	// Cache management
	clearVaultCache: (vaultId: string) => Promise<void>;
	clearAllCache: () => Promise<void>;
	needsFullSync: () => Promise<boolean>;
	markFullSyncComplete: () => Promise<void>;
}

/**
 * React hook for offline vault functionality
 */
export function useOfflineVault(
	options: UseOfflineVaultOptions = {},
): UseOfflineVaultReturn {
	const { storage, enabled = true, onConflict } = options;
	// Reserved for future sync implementation
	// const { onSyncComplete, onSyncError } = options;

	// State
	const [isOnline, setIsOnline] = useState<boolean>(true);
	// Reserved for future sync implementation
	const [_isSyncing] = useState<boolean>(false);
	const [pendingChangesCount, setPendingChangesCount] = useState<number>(0);
	const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
	const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
	const [error, setError] = useState<string | null>(null);

	// Refs
	const cacheManagerRef = useRef<OfflineCacheManager | null>(null);
	const mountedRef = useRef<boolean>(true);

	/**
	 * Handle conflict detection
	 */
	const handleConflict = useCallback(
		(conflict: SyncConflict) => {
			if (!mountedRef.current) return;

			setConflicts((prev) => {
				// Don't add duplicate conflicts
				if (prev.some((c) => c.itemId === conflict.itemId)) {
					return prev;
				}
				return [...prev, conflict];
			});

			onConflict?.(conflict);
		},
		[onConflict],
	);

	/**
	 * Handle cache changes
	 */
	const handleCacheChange = useCallback(async (_vaultId: string) => {
		if (!mountedRef.current || !cacheManagerRef.current) return;

		const count = await cacheManagerRef.current.getPendingCount();
		setPendingChangesCount(count);
	}, []);

	/**
	 * Initialize cache manager
	 */
	useEffect(() => {
		if (!enabled) return;

		const cacheManager = createOfflineCacheManager(storage, {
			onCacheChange: handleCacheChange,
			onConflictDetected: handleConflict,
		});

		cacheManagerRef.current = cacheManager;

		// Initialize
		(async () => {
			try {
				await cacheManager.init();

				if (mountedRef.current) {
					const count = await cacheManager.getPendingCount();
					setPendingChangesCount(count);

					const metadata = await cacheManager.getMetadata();
					if (metadata?.lastIncrementalSyncAt) {
						setLastSyncedAt(metadata.lastIncrementalSyncAt);
					}
				}
			} catch (err) {
				console.error("Failed to initialize offline cache:", err);
				if (mountedRef.current) {
					setError("Failed to initialize offline cache");
				}
			}
		})();

		// Cleanup
		return () => {
			mountedRef.current = false;
			cacheManagerRef.current = null;
		};
	}, [enabled, storage, handleCacheChange, handleConflict]);

	/**
	 * Listen for online/offline events (browser only)
	 */
	useEffect(() => {
		if (!enabled) return;

		// Check if we're in a browser environment with DOM APIs
		// React Native has navigator but not window.addEventListener
		// Use globalThis to access window in a cross-platform way
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const win =
			typeof globalThis !== "undefined"
				? ((globalThis as any).window as
						| {
								addEventListener: (type: string, listener: () => void) => void;
								removeEventListener: (
									type: string,
									listener: () => void,
								) => void;
								navigator: { onLine: boolean };
						  }
						| undefined)
				: undefined;

		const isBrowser =
			typeof win !== "undefined" &&
			typeof win.addEventListener === "function" &&
			typeof win.navigator !== "undefined" &&
			typeof win.navigator.onLine === "boolean";

		if (isBrowser && win) {
			const updateOnlineStatus = () => {
				if (mountedRef.current) {
					setIsOnline(win.navigator.onLine);
				}
			};

			// Set initial status
			updateOnlineStatus();

			// Listen for changes
			win.addEventListener("online", updateOnlineStatus);
			win.addEventListener("offline", updateOnlineStatus);

			return () => {
				win.removeEventListener("online", updateOnlineStatus);
				win.removeEventListener("offline", updateOnlineStatus);
			};
		}

		// For React Native, we'll rely on external connectivity detection
		// The parent component should update connectivity status via a different mechanism
	}, [enabled]);

	/**
	 * Get cached vaults
	 */
	const getCachedVaults = useCallback(async (): Promise<CachedVault[]> => {
		if (!cacheManagerRef.current) return [];
		return cacheManagerRef.current.getCachedVaults();
	}, []);

	/**
	 * Get cached items for a vault
	 */
	const getCachedItems = useCallback(
		async (vaultId: string): Promise<CachedItem[]> => {
			if (!cacheManagerRef.current) return [];
			return cacheManagerRef.current.getCachedItems(vaultId);
		},
		[],
	);

	/**
	 * Get a specific cached item
	 */
	const getCachedItem = useCallback(
		async (vaultId: string, itemId: string): Promise<CachedItem | null> => {
			if (!cacheManagerRef.current) return null;
			return cacheManagerRef.current.getCachedItem(vaultId, itemId);
		},
		[],
	);

	/**
	 * Create an item while offline
	 */
	const createOfflineItem = useCallback(
		async (
			vaultId: string,
			item: Omit<
				CachedItem,
				| "id"
				| "lastSyncedAt"
				| "isLocalOnly"
				| "isModifiedLocally"
				| "localVersion"
				| "version"
			>,
		): Promise<string> => {
			if (!cacheManagerRef.current) {
				throw new Error("Offline cache not initialized");
			}
			const id = await cacheManagerRef.current.createOfflineItem(vaultId, item);
			const count = await cacheManagerRef.current.getPendingCount();
			setPendingChangesCount(count);
			return id;
		},
		[],
	);

	/**
	 * Update an item while offline
	 */
	const updateOfflineItem = useCallback(
		async (
			vaultId: string,
			itemId: string,
			updates: Partial<
				Pick<
					CachedItem,
					| "encryptedData"
					| "encryptionIv"
					| "decryptedData"
					| "favorite"
					| "category"
				>
			>,
		): Promise<void> => {
			if (!cacheManagerRef.current) {
				throw new Error("Offline cache not initialized");
			}
			await cacheManagerRef.current.updateOfflineItem(vaultId, itemId, updates);
			const count = await cacheManagerRef.current.getPendingCount();
			setPendingChangesCount(count);
		},
		[],
	);

	/**
	 * Delete an item while offline
	 */
	const deleteOfflineItem = useCallback(
		async (vaultId: string, itemId: string): Promise<void> => {
			if (!cacheManagerRef.current) {
				throw new Error("Offline cache not initialized");
			}
			await cacheManagerRef.current.deleteOfflineItem(vaultId, itemId);
			const count = await cacheManagerRef.current.getPendingCount();
			setPendingChangesCount(count);
		},
		[],
	);

	/**
	 * Cache vault metadata
	 */
	const cacheVault = useCallback(async (vault: CachedVault): Promise<void> => {
		if (!cacheManagerRef.current) {
			throw new Error("Offline cache not initialized");
		}
		await cacheManagerRef.current.cacheVault(vault);
	}, []);

	/**
	 * Cache items for a vault
	 */
	const cacheItems = useCallback(
		async (vaultId: string, items: CachedItem[]): Promise<void> => {
			if (!cacheManagerRef.current) {
				throw new Error("Offline cache not initialized");
			}
			await cacheManagerRef.current.cacheItems(vaultId, items);
			setLastSyncedAt(Date.now());
		},
		[],
	);

	/**
	 * Get pending operations
	 */
	const getPendingOperations = useCallback(async (): Promise<
		PendingItemOperation[]
	> => {
		if (!cacheManagerRef.current) return [];
		return cacheManagerRef.current.getPendingOperations();
	}, []);

	/**
	 * Clear pending operations
	 */
	const clearPendingOperations = useCallback(async (): Promise<void> => {
		if (!cacheManagerRef.current) return;
		await cacheManagerRef.current.clearPendingOperations();
		setPendingChangesCount(0);
	}, []);

	/**
	 * Resolve conflict by keeping local changes
	 */
	const resolveConflictKeepLocal = useCallback(
		async (conflict: SyncConflict): Promise<void> => {
			if (!cacheManagerRef.current) {
				throw new Error("Offline cache not initialized");
			}
			await cacheManagerRef.current.resolveConflictKeepLocal(conflict);
			setConflicts((prev) => prev.filter((c) => c.itemId !== conflict.itemId));
			const count = await cacheManagerRef.current.getPendingCount();
			setPendingChangesCount(count);
		},
		[],
	);

	/**
	 * Resolve conflict by keeping server changes
	 */
	const resolveConflictKeepServer = useCallback(
		async (
			conflict: SyncConflict,
			serverDecryptedData: string,
		): Promise<void> => {
			if (!cacheManagerRef.current) {
				throw new Error("Offline cache not initialized");
			}
			await cacheManagerRef.current.resolveConflictKeepServer(
				conflict,
				serverDecryptedData,
			);
			setConflicts((prev) => prev.filter((c) => c.itemId !== conflict.itemId));
		},
		[],
	);

	/**
	 * Dismiss a conflict without resolution
	 */
	const dismissConflict = useCallback((itemId: string): void => {
		setConflicts((prev) => prev.filter((c) => c.itemId !== itemId));
	}, []);

	/**
	 * Clear vault cache
	 */
	const clearVaultCache = useCallback(
		async (vaultId: string): Promise<void> => {
			if (!cacheManagerRef.current) return;
			await cacheManagerRef.current.clearVaultCache(vaultId);
		},
		[],
	);

	/**
	 * Clear all cache
	 */
	const clearAllCache = useCallback(async (): Promise<void> => {
		if (!cacheManagerRef.current) return;
		await cacheManagerRef.current.clearAllCache();
		setPendingChangesCount(0);
		setLastSyncedAt(null);
		setConflicts([]);
	}, []);

	/**
	 * Check if full sync is needed
	 */
	const needsFullSync = useCallback(async (): Promise<boolean> => {
		if (!cacheManagerRef.current) return true;
		return cacheManagerRef.current.needsFullSync();
	}, []);

	/**
	 * Mark full sync as complete
	 */
	const markFullSyncComplete = useCallback(async (): Promise<void> => {
		if (!cacheManagerRef.current) return;
		await cacheManagerRef.current.markFullSyncComplete();
		setLastSyncedAt(Date.now());
	}, []);

	/**
	 * Computed status object
	 */
	const status: OfflineSyncStatus = useMemo(
		() => ({
			isOnline,
			isSyncing: _isSyncing,
			pendingChangesCount,
			lastSyncedAt,
			hasConflicts: conflicts.length > 0,
			conflictsCount: conflicts.length,
			error,
		}),
		[isOnline, _isSyncing, pendingChangesCount, lastSyncedAt, conflicts, error],
	);

	return {
		status,
		isOnline,
		getCachedVaults,
		getCachedItems,
		getCachedItem,
		createOfflineItem,
		updateOfflineItem,
		deleteOfflineItem,
		cacheVault,
		cacheItems,
		getPendingOperations,
		clearPendingOperations,
		conflicts,
		resolveConflictKeepLocal,
		resolveConflictKeepServer,
		dismissConflict,
		clearVaultCache,
		clearAllCache,
		needsFullSync,
		markFullSyncComplete,
	};
}

/**
 * Set connectivity status externally (for React Native)
 */
export function createConnectivityMonitor(
	setOnline: (isOnline: boolean) => void,
) {
	return {
		setOnline,
		checkConnectivity: async (testUrl?: string): Promise<boolean> => {
			try {
				const url = testUrl || "https://clients3.google.com/generate_204";
				const response = await fetch(url, {
					method: "HEAD",
					cache: "no-cache",
				});
				const online = response.ok;
				setOnline(online);
				return online;
			} catch {
				setOnline(false);
				return false;
			}
		},
	};
}
