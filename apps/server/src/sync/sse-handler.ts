import { setBroadcastFunction } from "@bittery/api/sync-helper";
import { verifySession } from "@bittery/auth";
import { db, vaultKey } from "@bittery/db";
import type { PubSubAdapter } from "@bittery/pubsub";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

// Types for sync events
export interface SyncEventPayload {
	id: string;
	type:
		| "item_created"
		| "item_updated"
		| "item_deleted"
		| "item_moved"
		| "item_restored"
		| "vault_created"
		| "vault_updated"
		| "vault_deleted"
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
	channel: EventChannel<SyncEventPayload>;
}

// Active connections per user: Map<userId, Map<connectionId, Connection>>
const connections = new Map<string, Map<string, Connection>>();

// Vault memberships for connected users: Map<userId, Set<vaultId>>
const userVaults = new Map<string, Set<string>>();

// Heartbeat interval in milliseconds
const HEARTBEAT_INTERVAL = 15_000;

// Re-validate session every N heartbeats (~5 minutes)
const SESSION_REVALIDATION_HEARTBEATS = 20;

// Max connections per user to prevent resource exhaustion
const MAX_CONNECTIONS_PER_USER = 10;

function generateConnectionId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
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
	return vaultIds;
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
	const { vaultId, clientId, userId: eventUserId } = event;

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

	// Scan all connected users and deliver to vault members
	for (const [userId, userConnections] of connections) {
		const vaults = userVaults.get(userId);
		if (!vaults?.has(vaultId)) continue;

		for (const connection of userConnections.values()) {
			connection.channel.push({
				...event,
				metadata: {
					...event.metadata,
					isOwnEvent: userId === eventUserId,
					originClientId: clientId,
				},
			});
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

	setBroadcastFunction(async (event) => {
		await pubsub.publish("sync", event);
	});

	const app = new Hono();

	app.get("/events", async (c) => {
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
				const channel = new EventChannel<SyncEventPayload>();
				let eventId = 0;
				let heartbeatCount = 0;

				const connection: Connection = {
					id: connectionId,
					userId,
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

				// Main event loop
				while (!abortController.signal.aborted && !channel.isClosed()) {
					try {
						const queuedEvents = channel.drain();
						for (const event of queuedEvents) {
							await stream.writeSSE({
								event: "sync",
								data: JSON.stringify(event),
								id: String(eventId++),
							});
						}

						const event = await channel.waitWithTimeout(
							HEARTBEAT_INTERVAL,
							abortController.signal,
						);

						if (event) {
							await stream.writeSSE({
								event: "sync",
								data: JSON.stringify(event),
								id: String(eventId++),
							});
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
			...getConnectionStats(),
		});
	});

	return app;
}
