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
	| "vault_key_rotated"
	| "travel_mode_updated";

/**
 * Entity types that can be synced
 */
export type SyncEntityType =
	| "item"
	| "vault"
	| "vault_member"
	| "vault_key"
	| "user";

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

export interface TravelModeUpdatedMetadata extends SyncMetadataBase {
	enabled: boolean;
	hiddenVaultIds: string[];
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
	travel_mode_updated: TravelModeUpdatedMetadata;
}

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
	metadata?: SyncMetadataBase & { [key: string]: unknown };
}

export interface SyncCursor {
	id: string;
}

export interface SessionRevokedControlPayload {
	type: "session_revoked";
	userId: string;
	sessionId: string;
	timestamp: number;
	reason?: string;
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
	onStatusChange?: (status: ConnectionStatus) => void;
	onSessionRevoked?: (
		payload: SessionRevokedControlPayload,
	) => void | Promise<void>;
	/** Called when the server sends a sync ping — client should fetch events via getEventsSince. */
	onSyncPing?: () => void | Promise<void>;
	reconnectDelay?: number;
	maxReconnectDelay?: number;
	/** Custom fetch implementation (e.g. `expo/fetch` for streaming support in React Native) */
	fetch?: (url: string, init?: any) => Promise<Response>;
}

/**
 * A vault key as delta sync hands it back after refreshing from the server.
 * Structurally identical to `VaultKeyData` in `@bittery/storage/types`; restated
 * here because `packages/sync` deliberately does not depend on storage.
 */
export interface SyncVaultKeyEntry {
	vaultId: string;
	vaultName: string;
	vaultType: "personal" | "team";
	vaultIcon?: string | null;
	vaultImageUrl?: string | null;
	encryptedVaultKey: string;
	role: "owner" | "admin" | "member" | "read-only";
}

/**
 * The encrypted-blob cache, as sync sees it. Names match `ItemCache`
 * (`packages/storage/src/item-cache.ts`), which satisfies this interface structurally.
 *
 * `accountId` is optional in the *signature* only because `ItemCache` allows omitting it
 * (falling back to the `"default"` account segment). Every caller in this repo passes an
 * explicit id; omitting it silently reads and writes the wrong collection.
 */
export interface ItemCacheAdapter {
	upsertCachedItem(
		item: import("@bittery/types").CachedEncryptedItem,
		accountId?: string,
	): Promise<void>;
	removeCachedItem(itemId: string, accountId?: string): Promise<void>;
	upsertCachedVault(
		vault: import("@bittery/types").CachedVaultMetadata,
		accountId?: string,
	): Promise<void>;
	removeCachedVault(vaultId: string, accountId?: string): Promise<void>;
	clearItemCache(accountId?: string): Promise<void>;
}

/**
 * What delta sync and the orchestrator actually drive: an item cache that also owns
 * vault keys and optimistic-id reconciliation.
 *
 * Those two are genuinely NOT `ItemCache` methods and never will be — `ItemCache` stores
 * opaque encrypted blobs and knows nothing about key wrapping or temp ids. In this repo
 * the implementer is `VaultRepositoryCoordinator` (and `VaultRepository`), which sits
 * above both the cache and the crypto.
 */
export interface SyncItemCache extends ItemCacheAdapter {
	syncVaultKeys(
		vaultKeys: SyncVaultKeyEntry[],
		accountId?: string,
	): Promise<void>;
	replaceItemId(tempId: string, realId: string, accountId?: string): void;
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
