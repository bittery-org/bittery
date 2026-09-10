import type {
	SyncEntityType,
	SyncEventType,
	SyncEvent as WireSyncEvent,
} from "@bittery/api-contract";
import type { VaultKeyEntry } from "@bittery/types";

/**
 * The two closed sets an event is identified by. Rust enums in
 * `apps/server/src/db/enums.rs` that reach OpenAPI as string enums, so the client unions are
 * generated rather than typed twice — aliased here, never restated (ADR 0012).
 */
export type { SyncEntityType, SyncEventType };

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
	operation_resolved: DefaultSyncMetadata;
}

/**
 * A sync event as this package handles it.
 *
 * The identity fields — `id`, `type`, `entityId`, `entityType`, `version`, `userId` — are
 * the wire's and are subtracted from it rather than restated, so a server-side rename fails
 * to compile here. Three fields are deliberately re-typed, and `types.drift-guard.ts` pins
 * every one of them at both ends:
 *
 * - `timestamp` is a `bigint` below the seam and a `number` above it. See
 *   {@link toClientTimestamp} for why that conversion is safe and where it stops being so.
 * - `vaultId` and `clientId` are optional-or-null on the wire and resolved to an explicit
 *   `null` here, so a consumer never has to distinguish "absent" from "no vault".
 * - `metadata` is `unknown` on the wire; {@link SyncMetadataMap} is the per-event-type
 *   narrowing, which is genuinely sync-local — the server types the column as free JSON.
 */
export type SyncEvent = Omit<
	WireSyncEvent,
	"timestamp" | "vaultId" | "clientId" | "metadata"
> & {
	vaultId: string | null;
	clientId: string | null;
	timestamp: number;
	metadata?: SyncMetadataBase & { [key: string]: unknown };
};

/**
 * The wire→client half of the `timestamp` conversion, written down rather than left as a
 * bare `Number()` at the one call site.
 *
 * The transport spells the server's `i64` as a decimal string because an `i64` in general
 * exceeds `Number.MAX_SAFE_INTEGER`. This particular `i64` does not: it is epoch
 * milliseconds (`services::sync::timestamp_millis`), and `Number.MAX_SAFE_INTEGER` ms is the
 * year 287396. So the narrowing is lossless for every value the server can produce from a
 * real clock, and only a corrupt or non-epoch value could lose precision here.
 *
 * This is not the sync cursor. The cursor is {@link SyncCursor}, an opaque event id;
 * `timestamp` only ever feeds `SyncStatus.lastSyncTime`, which is display state.
 */
export function toClientTimestamp(timestamp: bigint): number {
	return Number(timestamp);
}

/**
 * Where a client has consumed the event log up to. An opaque server-minted event id — not a
 * time, and not derived from one, so nothing about it depends on clock skew or on
 * {@link toClientTimestamp}.
 */
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
	commandSummary: SyncCommandSummary;
	error: string | null;
}

export interface SyncCommandSummary {
	pending: number;
	retrying: number;
	conflicted: number;
	failed: number;
}

export type { PendingMutation } from "./outbound-queue";

/**
 * Storage seam for platform-specific implementations.
 *
 * `update` must serialize overlapping read-modify-write calls for the same key across every
 * execution context that can mutate that document. The outbound queue relies on this invariant
 * when one context enqueues while another acknowledges or drains commands.
 */
export interface SyncStorage {
	get<T>(key: string): Promise<T | null>;
	set<T>(key: string, value: T): Promise<void>;
	remove(key: string): Promise<void>;
	update<T>(
		key: string,
		updater: (current: T | null) => T | null,
	): Promise<T | null>;
}

/**
 * Options for SyncManager
 */
export interface SyncManagerOptions {
	clientId: string;
	openSyncEvents: (signal: AbortSignal) => Promise<Response>;
	storage?: SyncStorage;
	onStatusChange?: (status: ConnectionStatus) => void;
	onSessionRevoked?: (
		payload: SessionRevokedControlPayload,
	) => void | Promise<void>;
	/** Called when the server sends a sync ping so the client can fetch `/sync/changes`. */
	onSyncPing?: () => void | Promise<void>;
	reconnectDelay?: number;
	maxReconnectDelay?: number;
}

/**
 * A vault key as delta sync hands it back after refreshing from the server.
 *
 * This used to be a restatement of `VaultKeyData` in `@bittery/storage/types`, justified by
 * the fact that `packages/sync` deliberately does not depend on storage. That constraint is
 * still real; the restatement no longer follows from it, because both packages already
 * depend on `@bittery/types`, where the shape now lives once and derives from the generated
 * contract (ADR 0012).
 */
export type SyncVaultKeyEntry = VaultKeyEntry;

/**
 * The encrypted-blob cache, as sync sees it. Names match `ItemCache`
 * (`packages/storage/src/item-cache.ts`), which satisfies this interface structurally.
 *
 * `accountId` is required: an omitted one used to name the wrong collection, and an
 * email passed in its place named a collection after an email.
 */
export interface SyncReplicaStore {
	upsertCachedItem(
		item: import("@bittery/types").CachedEncryptedItem,
		accountId: string,
	): Promise<void>;
	removeCachedItem(itemId: string, accountId: string): Promise<void>;
	upsertCachedVault(
		vault: import("@bittery/types").CachedVaultMetadata,
		accountId: string,
	): Promise<void>;
	removeCachedVault(vaultId: string, accountId: string): Promise<void>;
	clearItemCache(accountId: string): Promise<void>;
	syncVaultKeys(
		vaultKeys: SyncVaultKeyEntry[],
		accountId: string,
	): Promise<void>;
}

/** Replica operations additionally needed by the orchestrator after outbound creates. */
export interface SyncOrchestratorReplica extends SyncReplicaStore {
	replaceItemId(tempId: string, realId: string, accountId: string): void;
}

/** Optimistic projection and authoritative-result reconciliation for queued commands. */
export interface ItemCommandProjection {
	applyItemCommand(
		command: import("@bittery/types").ItemSyncCommand,
	): Promise<void>;
	discardItemCommandAcknowledgedElsewhere(
		command: import("@bittery/types").ItemSyncCommand,
	): Promise<void>;
	preserveItemConflict(
		command: import("@bittery/types").ItemSyncCommand,
	): Promise<import("@bittery/types").ItemSyncCommand | undefined>;
	rejectItemCommand(
		command: import("@bittery/types").ItemSyncCommand,
		code: import("@bittery/types").CreateItemRejectionCode,
	): Promise<void>;
	acknowledgeItemCommand(
		command: import("@bittery/types").ItemSyncCommand,
		acknowledgement: import("@bittery/types").ItemSyncAcknowledgement,
	): Promise<void>;
}

/** Executes commands whose meaning cannot be represented by the ordinary item API. */
export interface SemanticItemCommandExecutor {
	executeSemanticItemCommand(
		command: import("@bittery/types").ItemSyncCommand,
	): Promise<import("@bittery/types").ItemSyncAcknowledgement | undefined>;
}
