/**
 * Sync event types
 */
export type SyncEventType =
	| "item_created"
	| "item_updated"
	| "item_deleted"
	| "item_restored"
	| "item_permanently_deleted"
	| "item_moved"
	| "vault_created"
	| "vault_updated"
	| "vault_deleted"
	| "vault_access_revoked"
	| "vault_member_added"
	| "vault_member_removed"
	| "vault_key_rotated";

/**
 * Entity types that can be synced
 */
export type SyncEntityType = "item" | "vault" | "vault_member" | "vault_key";

/**
 * Typed metadata per event type.
 * All metadata objects include the SSE-injected fields (isOwnEvent, originClientId).
 */
interface SyncMetadataBase {
	isOwnEvent?: boolean;
	originClientId?: string | null;
}

export interface ItemMovedMetadata extends SyncMetadataBase {
	sourceVaultId: string;
}

export interface VaultMemberAddedMetadata extends SyncMetadataBase {
	addedUserId: string;
	role: string;
}

export interface VaultMemberRemovedMetadata extends SyncMetadataBase {
	removedUserId: string;
}

export interface VaultKeyRotatedMetadata extends SyncMetadataBase {
	reason: string;
	keyRotationId: string;
}

/** Default metadata for events that carry no extra fields */
export interface DefaultSyncMetadata extends SyncMetadataBase {
	[key: string]: unknown;
}

/** Map from event type to its metadata shape */
export interface SyncMetadataMap {
	item_created: DefaultSyncMetadata;
	item_updated: DefaultSyncMetadata;
	item_deleted: DefaultSyncMetadata;
	item_restored: DefaultSyncMetadata;
	item_permanently_deleted: DefaultSyncMetadata;
	item_moved: ItemMovedMetadata;
	vault_created: DefaultSyncMetadata;
	vault_updated: DefaultSyncMetadata;
	vault_deleted: DefaultSyncMetadata;
	vault_access_revoked: DefaultSyncMetadata;
	vault_member_added: VaultMemberAddedMetadata;
	vault_member_removed: VaultMemberRemovedMetadata;
	vault_key_rotated: VaultKeyRotatedMetadata;
}

/**
 * Sync event received from server
 */
export interface SyncEvent {
	id: string;
	seq: number;
	type: SyncEventType;
	entityId: string;
	entityType: SyncEntityType;
	vaultId: string | null;
	version: number;
	clientId: string | null;
	userId: string;
	timestamp: number;
	metadata?: SyncMetadataBase & { [key: string]: unknown };
}

export interface SyncCursor {
	seq: number;
	/** @deprecated kept for backward compatibility during migration */
	timestamp?: number;
	/** @deprecated kept for backward compatibility during migration */
	id?: string;
}

/**
 * Type-safe metadata accessor. Narrows metadata based on event type.
 *
 * @example
 *   if (event.type === "item_moved") {
 *     const meta = getTypedMetadata(event);
 *     console.log(meta?.sourceVaultId); // string | undefined
 *   }
 */
export function getTypedMetadata<T extends SyncEventType>(
	event: SyncEvent & { type: T },
): SyncMetadataMap[T] | undefined {
	return event.metadata as SyncMetadataMap[T] | undefined;
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

export type { PendingMutation } from "./outbound-queue";

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
	/** Custom fetch implementation (e.g. `expo/fetch` for streaming support in React Native) */
	fetch?: (url: string, init?: any) => Promise<Response>;
}

/**
 * Adapter interface for item cache operations (subset of IStorageAdapter)
 * Used by delta sync to update local cache on incoming events
 */
export interface ItemCacheAdapter {
	supportsItemCache: boolean;
	upsertEncrypted?(
		item: import("@bittery/types").CachedEncryptedItem,
		email?: string,
	): Promise<void>;
	removeItem?(itemId: string, email?: string): Promise<void>;
	upsertVault?(
		vault: import("@bittery/types").CachedVaultMetadata,
		email?: string,
	): Promise<void>;
	removeVault?(vaultId: string, email?: string): Promise<void>;
	upsertCachedItem?(
		item: import("@bittery/types").CachedEncryptedItem,
		email?: string,
	): Promise<void>;
	removeCachedItem?(itemId: string, email?: string): Promise<void>;
	upsertCachedVault?(
		vault: import("@bittery/types").CachedVaultMetadata,
		email?: string,
	): Promise<void>;
	removeCachedVault?(vaultId: string, email?: string): Promise<void>;
	syncVaultKeys?(
		vaultKeys: Array<{
			vaultId: string;
			vaultName: string;
			vaultType: "personal" | "team";
			vaultIcon?: string | null;
			vaultImageUrl?: string | null;
			encryptedVaultKey: string;
			role: "owner" | "admin" | "member" | "read-only";
		}>,
		email?: string,
	): Promise<void>;
	clearItemCache?(email?: string): Promise<void>;
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
