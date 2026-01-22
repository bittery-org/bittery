/**
 * Offline Vault Context
 * Provides offline vault functionality across the mobile app
 */

import type { DecryptedItem } from "@bittery/shared/types";
import {
	type CachedItem,
	type CachedVault,
	type OfflineSyncStatus,
	type PendingItemOperation,
	type SyncConflict,
	useOfflineVault,
} from "@bittery/sync";
import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";
import {
	deleteOfflineCacheItem,
	getOfflineCacheItem,
	setOfflineCacheItem,
} from "../services/storage";

/**
 * Sync storage adapter for React Native using secure storage
 */
const _createReactNativeSyncStorage = () => {
	const STORAGE_PREFIX = "bittery_offline_";

	return {
		async get<T>(key: string): Promise<T | null> {
			try {
				const value = await getOfflineCacheItem(`${STORAGE_PREFIX}${key}`);
				if (value) {
					return JSON.parse(value) as T;
				}
				return null;
			} catch {
				return null;
			}
		},
		async set<T>(key: string, value: T): Promise<void> {
			await setOfflineCacheItem(
				`${STORAGE_PREFIX}${key}`,
				JSON.stringify(value),
			);
		},
		async remove(key: string): Promise<void> {
			await deleteOfflineCacheItem(`${STORAGE_PREFIX}${key}`);
		},
	};
};

/**
 * Offline vault context value
 */
export interface OfflineVaultContextValue {
	// Connectivity status
	isOnline: boolean;
	connectionType: string | null;

	// Sync status
	status: OfflineSyncStatus;
	pendingChangesCount: number;
	lastSyncedAt: number | null;

	// Conflicts
	conflicts: SyncConflict[];
	hasConflicts: boolean;

	// Cache operations
	getCachedVaults: () => Promise<CachedVault[]>;
	getCachedItems: (vaultId: string) => Promise<CachedItem[]>;
	getCachedItem: (
		vaultId: string,
		itemId: string,
	) => Promise<CachedItem | null>;

	// Offline item operations
	createItemOffline: (
		vaultId: string,
		category: string,
		encryptedData: string,
		encryptionIv: string,
		encryptionAlgorithm: string,
		decryptedData: DecryptedItem,
	) => Promise<string>;
	updateItemOffline: (
		vaultId: string,
		itemId: string,
		encryptedData: string,
		encryptionIv: string,
		decryptedData: DecryptedItem,
	) => Promise<void>;
	deleteItemOffline: (vaultId: string, itemId: string) => Promise<void>;

	// Sync operations
	cacheVaultData: (vault: CachedVault, items: CachedItem[]) => Promise<void>;
	getPendingOperations: () => Promise<PendingItemOperation[]>;
	syncPendingChanges: () => Promise<void>;
	forceSync: () => Promise<void>;

	// Conflict resolution
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
}

const OfflineVaultContext = createContext<OfflineVaultContextValue | null>(
	null,
);

/**
 * Offline Vault Provider Props
 */
export interface OfflineVaultProviderProps {
	children: ReactNode;
	onSyncComplete?: () => void;
	onSyncError?: (error: Error) => void;
	onConflict?: (conflict: SyncConflict) => void;
}

/**
 * Persistent storage adapter for sync using React Native secure storage
 * This ensures offline data persists across app restarts
 */
class PersistentSyncStorage {
	private memoryCache = new Map<string, string>();
	private storagePrefix = "bittery_offline_";

	async get<T>(key: string): Promise<T | null> {
		// Check memory cache first
		const cached = this.memoryCache.get(key);
		if (cached) {
			try {
				return JSON.parse(cached) as T;
			} catch {
				return null;
			}
		}

		// Try persistent storage
		try {
			const value = await getOfflineCacheItem(`${this.storagePrefix}${key}`);
			if (value) {
				this.memoryCache.set(key, value);
				return JSON.parse(value) as T;
			}
		} catch {
			// Storage error, return null
		}
		return null;
	}

	async set<T>(key: string, value: T): Promise<void> {
		const serialized = JSON.stringify(value);
		this.memoryCache.set(key, serialized);
		try {
			await setOfflineCacheItem(`${this.storagePrefix}${key}`, serialized);
		} catch (error) {
			console.warn("Failed to persist offline cache:", error);
		}
	}

	async remove(key: string): Promise<void> {
		this.memoryCache.delete(key);
		try {
			await deleteOfflineCacheItem(`${this.storagePrefix}${key}`);
		} catch {
			// Ignore removal errors
		}
	}
}

/**
 * Offline Vault Provider
 * Wraps the app with offline vault functionality
 */
export function OfflineVaultProvider({
	children,
	onSyncComplete,
	onSyncError,
	onConflict,
}: OfflineVaultProviderProps) {
	// Network state
	const [isOnline, setIsOnline] = useState<boolean>(true);
	const [connectionType, setConnectionType] = useState<string | null>(null);

	// Use the offline vault hook with persistent storage
	const [persistentStorage] = useState(() => new PersistentSyncStorage());

	const offlineVault = useOfflineVault({
		storage: persistentStorage,
		enabled: true,
		onConflict,
		onSyncComplete,
		onSyncError,
	});

	// Listen for network changes
	useEffect(() => {
		const unsubscribe = NetInfo.addEventListener((state: NetInfoState) => {
			setIsOnline(state.isConnected ?? false);
			setConnectionType(state.type);
		});

		// Get initial state
		NetInfo.fetch().then((state: NetInfoState) => {
			setIsOnline(state.isConnected ?? false);
			setConnectionType(state.type);
		});

		return () => {
			unsubscribe();
		};
	}, []);

	/**
	 * Create an item while offline
	 */
	const createItemOffline = useCallback(
		async (
			vaultId: string,
			category: string,
			encryptedData: string,
			encryptionIv: string,
			encryptionAlgorithm: string,
			decryptedData: DecryptedItem,
		): Promise<string> => {
			const cachedItem: Omit<
				CachedItem,
				| "id"
				| "lastSyncedAt"
				| "isLocalOnly"
				| "isModifiedLocally"
				| "localVersion"
				| "version"
			> = {
				vaultId,
				category,
				favorite: decryptedData.favorite,
				createdAt: decryptedData.createdAt || new Date().toISOString(),
				updatedAt: decryptedData.updatedAt || new Date().toISOString(),
				encryptedData,
				encryptionIv,
				encryptionAlgorithm,
				decryptedData: JSON.stringify(decryptedData),
			};

			return offlineVault.createOfflineItem(vaultId, cachedItem);
		},
		[offlineVault],
	);

	/**
	 * Update an item while offline
	 */
	const updateItemOffline = useCallback(
		async (
			vaultId: string,
			itemId: string,
			encryptedData: string,
			encryptionIv: string,
			decryptedData: DecryptedItem,
		): Promise<void> => {
			await offlineVault.updateOfflineItem(vaultId, itemId, {
				encryptedData,
				encryptionIv,
				decryptedData: JSON.stringify(decryptedData),
				favorite: decryptedData.favorite,
				category: decryptedData.category,
			});
		},
		[offlineVault],
	);

	/**
	 * Delete an item while offline
	 */
	const deleteItemOffline = useCallback(
		async (vaultId: string, itemId: string): Promise<void> => {
			await offlineVault.deleteOfflineItem(vaultId, itemId);
		},
		[offlineVault],
	);

	/**
	 * Cache vault data from server
	 */
	const cacheVaultData = useCallback(
		async (vault: CachedVault, items: CachedItem[]): Promise<void> => {
			await offlineVault.cacheVault(vault);
			await offlineVault.cacheItems(vault.id, items);
		},
		[offlineVault],
	);

	/**
	 * Sync pending changes to server
	 */
	const syncPendingChanges = useCallback(async (): Promise<void> => {
		if (!isOnline) {
			console.log("Cannot sync: offline");
			return;
		}

		const pending = await offlineVault.getPendingOperations();
		if (pending.length === 0) {
			console.log("No pending changes to sync");
			return;
		}

		console.log(`Syncing ${pending.length} pending changes...`);

		// TODO: Implement actual sync with tRPC client
		// This will be connected to the actual API in the integration step

		onSyncComplete?.();
	}, [isOnline, offlineVault, onSyncComplete]);

	/**
	 * Force a full sync
	 */
	const forceSync = useCallback(async (): Promise<void> => {
		if (!isOnline) {
			throw new Error("Cannot sync while offline");
		}

		// First sync pending changes
		await syncPendingChanges();

		// Then trigger a full refresh from server
		// TODO: Implement full sync from server

		await offlineVault.markFullSyncComplete();
	}, [isOnline, syncPendingChanges, offlineVault]);

	// Build context value
	const contextValue: OfflineVaultContextValue = {
		// Connectivity
		isOnline,
		connectionType,

		// Status
		status: offlineVault.status,
		pendingChangesCount: offlineVault.status.pendingChangesCount,
		lastSyncedAt: offlineVault.status.lastSyncedAt,

		// Conflicts
		conflicts: offlineVault.conflicts,
		hasConflicts: offlineVault.conflicts.length > 0,

		// Cache operations
		getCachedVaults: offlineVault.getCachedVaults,
		getCachedItems: offlineVault.getCachedItems,
		getCachedItem: offlineVault.getCachedItem,

		// Offline item operations
		createItemOffline,
		updateItemOffline,
		deleteItemOffline,

		// Sync operations
		cacheVaultData,
		getPendingOperations: offlineVault.getPendingOperations,
		syncPendingChanges,
		forceSync,

		// Conflict resolution
		resolveConflictKeepLocal: offlineVault.resolveConflictKeepLocal,
		resolveConflictKeepServer: offlineVault.resolveConflictKeepServer,
		dismissConflict: offlineVault.dismissConflict,

		// Cache management
		clearVaultCache: offlineVault.clearVaultCache,
		clearAllCache: offlineVault.clearAllCache,
		needsFullSync: offlineVault.needsFullSync,
	};

	return (
		<OfflineVaultContext.Provider value={contextValue}>
			{children}
		</OfflineVaultContext.Provider>
	);
}

/**
 * Hook to access offline vault context
 */
export function useOfflineVaultContext(): OfflineVaultContextValue {
	const context = useContext(OfflineVaultContext);
	if (!context) {
		throw new Error(
			"useOfflineVaultContext must be used within an OfflineVaultProvider",
		);
	}
	return context;
}

/**
 * Hook to check if offline mode is active
 */
export function useIsOffline(): boolean {
	const context = useContext(OfflineVaultContext);
	return context ? !context.isOnline : false;
}

/**
 * Hook to get sync status
 */
export function useSyncStatus(): OfflineSyncStatus | null {
	const context = useContext(OfflineVaultContext);
	return context?.status ?? null;
}
