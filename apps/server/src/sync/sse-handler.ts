import {
	type SessionControlPayload,
	setBroadcastFunction,
	setControlBroadcastFunction,
} from "@bittery/api/sync-helper";
import { resolveTrustedSourceIpFromHeaders } from "@bittery/api/context";
import {
	verifySession,
} from "@bittery/auth";
import {
	incrementRateLimitWindow,
	RATE_LIMIT_NAMESPACE,
} from "@bittery/rate-limit";
import { db, vaultKey } from "@bittery/db";
import type { PubSubAdapter } from "@bittery/pubsub";
import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";

// Types for sync events
export interface SyncEventPayload {
	id: string;
	type:
		| "item_created"
		| "item_updated"
		| "item_deleted"
		| "item_permanently_deleted"
		| "item_moved"
		| "item_restored"
		| "vault_created"
		| "vault_updated"
		| "vault_deleted"
		| "vault_access_revoked"
		| "vault_member_added"
		| "vault_member_removed"
		| "vault_key_rotated";
	entityId: string;
	entityType: "item" | "vault" | "vault_member" | "vault_key";
	vaultId: string | null;
	version: number;
	clientId: string | null;
	userId: string;
	timestamp: number;
	metadata?: Record<string, unknown>;
}

type StreamPayload = SyncEventPayload | SessionControlPayload;

function isSessionControlPayload(
	payload: StreamPayload,
): payload is SessionControlPayload {
	return payload.type === "session_revoked";
}

/**
 * Event channel that supports both push and async waiting.
 * Single-consumer: only one waiter at a time (enforced by the event loop pattern).
 */
class EventChannel<T> {
	private queue: T[] = [];
	private waitResolve: ((value: T | null) => void) | null = null;
	private closed = false;

	push(event: T): void {
		if (this.closed) return;

		if (this.waitResolve) {
			const resolve = this.waitResolve;
			this.waitResolve = null;
			resolve(event);
		} else {
			this.queue.push(event);
		}
	}

	drain(): T[] {
		const events = this.queue;
		this.queue = [];
		return events;
	}

	waitWithTimeout(ms: number, signal: AbortSignal): Promise<T | null> {
		return new Promise((resolve, reject) => {
			if (signal.aborted) {
				reject(signal.reason);
				return;
			}

			if (this.queue.length > 0) {
				resolve(this.queue.shift() as T);
				return;
			}

			if (this.closed) {
				resolve(null);
				return;
			}

			let timeoutId: ReturnType<typeof setTimeout> | null = null;

			const cleanup = () => {
				if (timeoutId) {
					clearTimeout(timeoutId);
					timeoutId = null;
				}
				this.waitResolve = null;
			};

			const onAbort = () => {
				cleanup();
				reject(signal.reason);
			};
			signal.addEventListener("abort", onAbort, { once: true });

			timeoutId = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				cleanup();
				resolve(null);
			}, ms);

			this.waitResolve = (event: T | null) => {
				signal.removeEventListener("abort", onAbort);
				cleanup();
				resolve(event);
			};
		});
	}

	close(): void {
		this.closed = true;
		if (this.waitResolve) {
			const resolve = this.waitResolve;
			this.waitResolve = null;
			resolve(null);
		}
	}

	isClosed(): boolean {
		return this.closed;
	}
}

// Connection tracking
interface Connection {
	id: string;
	userId: string;
	sessionId: string;
	channel: EventChannel<StreamPayload>;
}

// Active connections per user: Map<userId, Map<connectionId, Connection>>
const connections = new Map<string, Map<string, Connection>>();

// Vault memberships for connected users: Map<userId, Set<vaultId>>
const userVaults = new Map<string, Set<string>>();
const deniedVaultRecipients = new Map<string, Set<string>>();

// Heartbeat interval in milliseconds
const HEARTBEAT_INTERVAL = 15_000;

// Re-validate session every N heartbeats (~5 minutes)
const SESSION_REVALIDATION_HEARTBEATS = 20;

// Max connections per user to prevent resource exhaustion
const MAX_CONNECTIONS_PER_USER = 10;
const SSE_CONNECT_SOURCE_WINDOW_LIMIT = 20;
const SSE_CONNECT_SOURCE_WINDOW_MS = 60 * 1000;

function generateConnectionId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function getWindowBucketStart(windowMs: number, now: Date): Date {
	return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

function resolveSyncSourceIp(context: Context): string | null {
	return resolveTrustedSourceIpFromHeaders({
		forwardedForHeader: context.req.header("X-Forwarded-For"),
		realIpHeader: context.req.header("X-Real-IP"),
		cfConnectingIpHeader: context.req.header("CF-Connecting-IP"),
	});
}

export async function isSyncConnectionRateLimited(
	sourceIp: string | null,
): Promise<boolean> {
	if (!sourceIp) {
		return false;
	}

	const now = new Date();
	const result = await incrementRateLimitWindow({
		namespace: RATE_LIMIT_NAMESPACE.syncConnectSource,
		key: sourceIp,
		subject: sourceIp,
		now,
		windowStart: getWindowBucketStart(SSE_CONNECT_SOURCE_WINDOW_MS, now),
		limit: SSE_CONNECT_SOURCE_WINDOW_LIMIT,
	});

	return !result.allowed;
}

/**
 * Get or refresh user's vault memberships
 */
async function getUserVaults(userId: string): Promise<Set<string>> {
	const vaultKeys = await db.query.vaultKey.findMany({
		where: eq(vaultKey.userId, userId),
	});
	const vaultIds = new Set(vaultKeys.map((vk) => vk.vaultId));
	userVaults.set(userId, vaultIds);
	const deniedVaults = deniedVaultRecipients.get(userId);
	if (deniedVaults) {
		for (const vaultId of [...deniedVaults]) {
			if (vaultIds.has(vaultId)) {
				deniedVaults.delete(vaultId);
			}
		}
		if (deniedVaults.size === 0) {
			deniedVaultRecipients.delete(userId);
		}
	}
	return vaultIds;
}

function addDeniedVaultRecipient(userId: string, vaultId: string): void {
	const deniedVaults = deniedVaultRecipients.get(userId) ?? new Set<string>();
	deniedVaults.add(vaultId);
	deniedVaultRecipients.set(userId, deniedVaults);
}

function clearDeniedVaultRecipient(userId: string, vaultId: string): void {
	const deniedVaults = deniedVaultRecipients.get(userId);
	if (!deniedVaults) {
		return;
	}

	deniedVaults.delete(vaultId);
	if (deniedVaults.size === 0) {
		deniedVaultRecipients.delete(userId);
	}
}

function collectVaultRecipients(
	vaultId: string,
	actorUserId: string,
): Set<string> {
	const recipients = new Set<string>([actorUserId]);
	for (const [userId] of connections) {
		if (userVaults.get(userId)?.has(vaultId)) {
			recipients.add(userId);
		}
	}
	return recipients;
}

function createOutboundSyncPayload(
	event: SyncEventPayload,
	recipientUserId: string,
): SyncEventPayload {
	return {
		...event,
		metadata: {
			...event.metadata,
			isOwnEvent:
				event.type === "vault_access_revoked"
					? false
					: recipientUserId === event.userId,
			originClientId: event.clientId,
		},
	};
}

function addConnection(connection: Connection): void {
	const { userId, id } = connection;
	let userConnections = connections.get(userId);
	if (!userConnections) {
		userConnections = new Map();
		connections.set(userId, userConnections);
	}
	userConnections.set(id, connection);
	console.log(
		`[SSE] Connection ${id} added for user ${userId} (total: ${getConnectionStats().totalConnections})`,
	);
}

function removeConnection(userId: string, connectionId: string): void {
	const userConnections = connections.get(userId);
	if (userConnections) {
		const connection = userConnections.get(connectionId);
		if (connection) {
			connection.channel.close();
		}
		userConnections.delete(connectionId);
		if (userConnections.size === 0) {
			connections.delete(userId);
			userVaults.delete(userId);
			deniedVaultRecipients.delete(userId);
		}
	}
	console.log(
		`[SSE] Connection ${connectionId} removed for user ${userId} (total: ${getConnectionStats().totalConnections})`,
	);
}

/**
 * Deliver a sync event to all locally connected users who have access.
 * Scans connections and filters by vault membership — simple and correct.
 */
function deliverToConnections(event: SyncEventPayload): void {
	const { vaultId, userId: eventUserId } = event;
	const pushEventToRecipients = (recipients: Set<string>) => {
		for (const userId of recipients) {
			const userConnections = connections.get(userId);
			if (!userConnections) continue;

			for (const connection of userConnections.values()) {
				connection.channel.push(createOutboundSyncPayload(event, userId));
			}
		}
	};
	const vaultCreatedRecipients =
		event.type === "vault_created" && vaultId
			? collectVaultRecipients(vaultId, eventUserId)
			: null;
	const vaultDeletedRecipients =
		event.type === "vault_deleted" && vaultId
			? collectVaultRecipients(vaultId, eventUserId)
			: null;

	// User-targeted control events are delivered directly to the target user.
	if (event.type === "vault_access_revoked") {
		if (vaultId) {
			addDeniedVaultRecipient(eventUserId, vaultId);
			userVaults.get(eventUserId)?.delete(vaultId);
		}
		const targetConnections = connections.get(eventUserId);
		if (targetConnections) {
			for (const connection of targetConnections.values()) {
				connection.channel.push(createOutboundSyncPayload(event, eventUserId));
			}
		}
		return;
	}

	// Keep cached memberships coherent for membership-changing events so
	// subsequent events can be routed immediately.
	if (event.type === "vault_created" && vaultId) {
		const creatorVaults = userVaults.get(eventUserId);
		if (creatorVaults) {
			creatorVaults.add(vaultId);
		}
	}

	if (event.type === "vault_deleted" && vaultId) {
		for (const connectedVaults of userVaults.values()) {
			connectedVaults.delete(vaultId);
		}
	}

	if (event.type === "vault_member_added" && vaultId) {
		const addedUserId = event.metadata?.addedUserId as string | undefined;
		if (addedUserId) {
			const addedUserVaults = userVaults.get(addedUserId);
			if (addedUserVaults) {
				addedUserVaults.add(vaultId);
			}
			clearDeniedVaultRecipient(addedUserId, vaultId);
		}
	}

	if (event.type === "vault_member_removed" && vaultId) {
		const removedUserId = event.metadata?.removedUserId as string | undefined;
		if (removedUserId) {
			userVaults.get(removedUserId)?.delete(vaultId);
		}
	}

	// If no vaultId, only deliver to the user who triggered the event
	if (!vaultId) {
		const userConnections = connections.get(eventUserId);
		if (userConnections) {
			for (const connection of userConnections.values()) {
				connection.channel.push(event);
			}
		}
		return;
	}

	// For vault creation we always deliver to the creator and any recipients
	// already known to have access.
	if (event.type === "vault_created" && vaultCreatedRecipients) {
		pushEventToRecipients(vaultCreatedRecipients);
		return;
	}

	// For vault deletion we need to deliver to users who had access before the
	// membership cache was mutated above.
	if (event.type === "vault_deleted" && vaultDeletedRecipients) {
		pushEventToRecipients(vaultDeletedRecipients);
		return;
	}

	// Scan all connected users and deliver to vault members
	for (const [userId, userConnections] of connections) {
		const vaults = userVaults.get(userId);
		if (!vaults?.has(vaultId)) continue;
		if (deniedVaultRecipients.get(userId)?.has(vaultId)) continue;

		for (const connection of userConnections.values()) {
			connection.channel.push(createOutboundSyncPayload(event, userId));
		}
	}

	// Refresh vault membership cache when membership changes
	if (event.type === "vault_member_added" && event.metadata?.addedUserId) {
		const addedUserId = event.metadata.addedUserId as string;
		if (connections.has(addedUserId)) {
			void getUserVaults(addedUserId);
		}
	} else if (
		event.type === "vault_member_removed" &&
		event.metadata?.removedUserId
	) {
		const removedUserId = event.metadata.removedUserId as string;
		if (connections.has(removedUserId)) {
			void getUserVaults(removedUserId);
		}
	}
}

function deliverSessionControl(payload: SessionControlPayload): void {
	const userConnections = connections.get(payload.userId);
	if (!userConnections) {
		return;
	}

	for (const connection of userConnections.values()) {
		if (connection.sessionId !== payload.sessionId) {
			continue;
		}
		connection.channel.push(payload);
	}
}

/**
 * Refresh vault memberships for a user after membership changes
 */
export async function refreshUserVaults(userId: string): Promise<void> {
	if (connections.has(userId)) {
		await getUserVaults(userId);
	}
}

export function getConnectionStats(): {
	totalUsers: number;
	totalConnections: number;
} {
	let totalConnections = 0;
	for (const userConnections of connections.values()) {
		totalConnections += userConnections.size;
	}
	return {
		totalUsers: connections.size,
		totalConnections,
	};
}

/**
 * Create the Hono router for SSE sync endpoints.
 * Accepts a PubSubAdapter for decoupled event delivery.
 */
export function createSyncRouter(pubsub: PubSubAdapter): Hono {
	pubsub.subscribe("sync", (message) => {
		deliverToConnections(message.payload as SyncEventPayload);
	});

	pubsub.subscribe("sync-control", (message) => {
		deliverSessionControl(message.payload as SessionControlPayload);
	});

	setBroadcastFunction(async (event) => {
		await pubsub.publish("sync", event);
	});

	setControlBroadcastFunction(async (payload) => {
		await pubsub.publish("sync-control", payload);
	});

	const app = new Hono();

	app.get("/events", async (c) => {
		const sourceIp = resolveSyncSourceIp(c);
		if (await isSyncConnectionRateLimited(sourceIp)) {
			return c.json({ error: "Too many connections" }, 429);
		}

		const authHeader = c.req.header("Authorization");
		const token = authHeader?.replace("Bearer ", "");

		if (!token) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		const session = await verifySession(token);
		if (!session) {
			return c.json({ error: "Invalid session" }, 401);
		}

		const userId = session.userId;
		const sessionId = session.sessionId;
		const connectionId = generateConnectionId();

		// Reject if user already has too many connections
		const existingConnections = connections.get(userId);
		if (
			existingConnections &&
			existingConnections.size >= MAX_CONNECTIONS_PER_USER
		) {
			return c.json({ error: "Too many connections" }, 429);
		}

		await getUserVaults(userId);

		return streamSSE(
			c,
			async (stream) => {
				const abortController = new AbortController();
				const channel = new EventChannel<StreamPayload>();
				let eventId = 0;
				let heartbeatCount = 0;

				const connection: Connection = {
					id: connectionId,
					userId,
					sessionId,
					channel,
				};
				addConnection(connection);

				stream.onAbort(() => {
					abortController.abort();
					removeConnection(userId, connectionId);
				});

				await stream.writeSSE({
					event: "connected",
					data: JSON.stringify({
						type: "connected",
						userId,
						connectionId,
						timestamp: Date.now(),
					}),
					id: String(eventId++),
				});

				const writePayload = async (event: StreamPayload) => {
					if (isSessionControlPayload(event)) {
						await stream.writeSSE({
							event: "control",
							data: JSON.stringify(event),
							id: String(eventId++),
						});
						return "disconnect" as const;
					}

					await stream.writeSSE({
						event: "sync",
						data: JSON.stringify(event),
						id: String(eventId++),
					});
					return "continue" as const;
				};

				// Main event loop
				while (!abortController.signal.aborted && !channel.isClosed()) {
					try {
						const queuedEvents = channel.drain();
						for (const event of queuedEvents) {
							const action = await writePayload(event);
							if (action === "disconnect") {
								abortController.abort();
								break;
							}
						}

						if (abortController.signal.aborted) {
							break;
						}

						const event = await channel.waitWithTimeout(
							HEARTBEAT_INTERVAL,
							abortController.signal,
						);

						if (event) {
							const action = await writePayload(event);
							if (action === "disconnect") {
								break;
							}
						} else {
							// Heartbeat — periodically re-validate session
							heartbeatCount++;
							if (heartbeatCount % SESSION_REVALIDATION_HEARTBEATS === 0) {
								const valid = await verifySession(token);
								if (!valid) {
									console.log(
										`[SSE] Session revoked for ${connectionId}, disconnecting`,
									);
									break;
								}
								// Also refresh vault memberships on revalidation
								await getUserVaults(userId);
							}

							await stream.write(`: heartbeat ${Date.now()}\n\n`);
						}
					} catch {
						break;
					}
				}

				// Clean up on exit (may already be cleaned up by onAbort)
				removeConnection(userId, connectionId);
			},
			async (err) => {
				if (err.name !== "AbortError") {
					console.error(`[SSE ${connectionId}] Stream error:`, err);
				}
			},
		);
	});

	app.get("/health", (c) => {
		return c.json({
			status: "ok",
		});
	});

	return app;
}
