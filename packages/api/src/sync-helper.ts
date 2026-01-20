import { db } from "@bittery/db";
import { syncEvent } from "@bittery/db";
import { nanoid } from "nanoid";

// Re-export types for convenience
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

export type SyncEntityType = "item" | "vault" | "vault_member" | "vault_key";

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

/**
 * Create a sync event in the database
 * This is called after each mutation to record the change
 */
export async function createSyncEvent(params: CreateSyncEventParams): Promise<string> {
	const eventId = nanoid();

	await db.insert(syncEvent).values({
		id: eventId,
		eventType: params.eventType,
		entityId: params.entityId,
		entityType: params.entityType,
		vaultId: params.vaultId,
		userId: params.userId,
		clientId: params.clientId || null,
		version: params.version || 1,
		metadata: params.metadata ? JSON.stringify(params.metadata) : null,
	});

	return eventId;
}

/**
 * Broadcast helper - to be used in conjunction with SSE handler
 * This is a placeholder that will be connected to the SSE handler
 */
let broadcastFn: ((event: {
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
}) => Promise<void>) | null = null;

/**
 * Set the broadcast function (called by server on startup)
 */
export function setBroadcastFunction(fn: typeof broadcastFn): void {
	broadcastFn = fn;
}

/**
 * Create and broadcast a sync event
 */
export async function emitSyncEvent(params: CreateSyncEventParams): Promise<string> {
	const eventId = await createSyncEvent(params);

	// Broadcast to connected clients if function is set
	if (broadcastFn) {
		await broadcastFn({
			id: eventId,
			type: params.eventType,
			entityId: params.entityId,
			entityType: params.entityType,
			vaultId: params.vaultId,
			version: params.version || 1,
			clientId: params.clientId || null,
			userId: params.userId,
			timestamp: Date.now(),
			metadata: params.metadata,
		});
	}

	return eventId;
}
