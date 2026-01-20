/**
 * Sync event types
 */
export type SyncEventType =
	| "item_created"
	| "item_updated"
	| "item_deleted"
	| "item_restored"
	| "vault_created"
	| "vault_updated"
	| "vault_deleted"
	| "vault_member_added"
	| "vault_member_removed"
	| "vault_key_rotated";

/**
 * Entity types that can be synced
 */
export type SyncEntityType = "item" | "vault" | "vault_member" | "vault_key";

/**
 * Sync event received from server
 */
export interface SyncEvent {
	id: string;
	type: SyncEventType;
	entityId: string;
	entityType: SyncEntityType;
	vaultId: string | null;
	version: number;
	clientId: string | null;
	userId: string;
	timestamp: number;
	metadata?: {
		isOwnEvent?: boolean;
		originClientId?: string | null;
		[key: string]: unknown;
	};
}

/**
 * Connection status
 */
export type ConnectionStatus =
	| "disconnected"
	| "connecting"
	| "connected"
	| "reconnecting"
	| "error";

/**
 * Sync status for UI display
 */
export interface SyncStatus {
	connectionStatus: ConnectionStatus;
	lastSyncTime: number | null;
	pendingChanges: number;
	error: string | null;
}

/**
 * Offline operation to be synced
 */
export interface OfflineOperation {
	id: string;
	type: "create" | "update" | "delete";
	entityType: SyncEntityType;
	entityId: string;
	vaultId: string;
	data: unknown;
	timestamp: number;
	retryCount: number;
}

/**
 * Storage interface for platform-specific implementations
 */
export interface SyncStorage {
	get<T>(key: string): Promise<T | null>;
	set<T>(key: string, value: T): Promise<void>;
	remove(key: string): Promise<void>;
}

/**
 * Options for SyncManager
 */
export interface SyncManagerOptions {
	serverUrl: string;
	getAuthToken: () => Promise<string | null>;
	clientId: string;
	storage?: SyncStorage;
	onEvent?: (event: SyncEvent) => void;
	onStatusChange?: (status: ConnectionStatus) => void;
	reconnectDelay?: number;
	maxReconnectDelay?: number;
}

/**
 * Conflict information
 */
export interface ConflictInfo {
	itemId: string;
	localVersion: number;
	serverVersion: number;
	localData: unknown;
	serverData: unknown;
	lastModifiedBy: string;
	lastModifiedAt: number;
}

/**
 * Conflict resolution choice
 */
export type ConflictResolution = "keep_local" | "keep_server" | "merge";
