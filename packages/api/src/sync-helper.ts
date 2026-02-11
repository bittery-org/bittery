import { db, syncEvent } from "@bittery/db";
import { nanoid } from "nanoid";

// Re-export types for convenience
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

export type SyncEntityType = "item" | "vault" | "vault_member" | "vault_key";

/** Drizzle transaction or db instance — anything with .insert() */
type Transaction = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];
export type DbOrTx = typeof db | Transaction;

export interface CreateSyncEventParams {
	eventType: SyncEventType;
	entityId: string;
	entityType: SyncEntityType;
	vaultId: string | null;
	userId: string;
	clientId?: string | null;
	version?: number;
	metadata?: Record<string, unknown>;
}

/** Payload returned by createSyncEvent for deferred broadcast */
export interface SyncBroadcastPayload {
	id: string;
	type: SyncEventType;
	entityId: string;
	entityType: SyncEntityType;
	vaultId: string | null;
	version: number;
	clientId: string | null;
	userId: string;
	timestamp: number;
	metadata?: Record<string, unknown>;
}

/**
 * Create a sync event in the database.
 * Accepts an optional transaction handle so the event insert can be atomic
 * with the mutation that triggered it.
 */
export async function createSyncEvent(
	params: CreateSyncEventParams,
	tx?: DbOrTx,
	contextClientId?: string | null,
): Promise<SyncBroadcastPayload> {
	const resolvedClientId = params.clientId ?? contextClientId ?? null;
	const resolvedVersion = params.version ?? 1;
	const eventId = nanoid();

	const [inserted] = await (tx ?? db)
		.insert(syncEvent)
		.values({
			id: eventId,
			eventType: params.eventType,
			entityId: params.entityId,
			entityType: params.entityType,
			vaultId: params.vaultId,
			userId: params.userId,
			clientId: resolvedClientId,
			version: resolvedVersion,
			metadata: params.metadata ? JSON.stringify(params.metadata) : null,
		})
		.returning({
			createdAt: syncEvent.createdAt,
		});

	if (!inserted) {
		throw new Error("Failed to create sync event");
	}

	return {
		id: eventId,
		type: params.eventType,
		entityId: params.entityId,
		entityType: params.entityType,
		vaultId: params.vaultId,
		version: resolvedVersion,
		clientId: resolvedClientId,
		userId: params.userId,
		timestamp: inserted.createdAt.getTime(),
		metadata: params.metadata,
	};
}

/**
 * Broadcast helper - to be used in conjunction with SSE handler
 * This is a placeholder that will be connected to the SSE handler
 */
let broadcastFn: ((event: SyncBroadcastPayload) => Promise<void>) | null = null;

/**
 * Set the broadcast function (called by server on startup)
 */
export function setBroadcastFunction(fn: typeof broadcastFn): void {
	broadcastFn = fn;
}

/**
 * Broadcast a sync event to connected SSE clients.
 * Call this AFTER the database transaction has committed.
 */
export async function broadcastSyncPayload(
	payload: SyncBroadcastPayload,
): Promise<void> {
	if (broadcastFn) {
		await broadcastFn(payload);
	}
}

/**
 * Broadcast multiple sync events to connected SSE clients.
 * Call this AFTER the database transaction has committed.
 */
export async function broadcastSyncPayloads(
	payloads: SyncBroadcastPayload[],
): Promise<void> {
	for (const payload of payloads) {
		await broadcastSyncPayload(payload);
	}
}

/**
 * Create and broadcast a sync event in one call.
 * Use this for simple mutations that don't need an explicit transaction —
 * the insert and broadcast happen sequentially (not atomically with the mutation).
 *
 * For atomic mutation + event, use db.transaction() with createSyncEvent(params, tx)
 * inside, then broadcastSyncPayload() after the transaction commits.
 */
export async function emitSyncEvent(
	params: CreateSyncEventParams,
): Promise<string> {
	const payload = await createSyncEvent(params);
	await broadcastSyncPayload(payload);
	return payload.id;
}
