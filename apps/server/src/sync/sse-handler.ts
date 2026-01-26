import { setBroadcastFunction } from "@bittery/api/sync-helper";
import { verifySession } from "@bittery/auth";
import { db, vaultKey } from "@bittery/db";
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
 * Event channel that supports both push and async waiting
 */
class EventChannel<T> {
	private queue: T[] = [];
	private waitResolve: ((value: T) => void) | null = null;
	private closed = false;

	/**
	 * Push an event to the channel
	 * If someone is waiting, they receive it immediately
	 */
	push(event: T): void {
		if (this.closed) return;

		if (this.waitResolve) {
			// Someone is waiting - deliver immediately
			const resolve = this.waitResolve;
			this.waitResolve = null;
			resolve(event);
		} else {
			// No one waiting - queue it
			this.queue.push(event);
		}
	}

	/**
	 * Take all currently queued events (non-blocking)
	 */
	drain(): T[] {
		const events = this.queue;
		this.queue = [];
		return events;
	}

	/**
	 * Wait for the next event with timeout
	 * Returns the event or null on timeout
	 */
	waitWithTimeout(ms: number, signal: AbortSignal): Promise<T | null> {
		return new Promise((resolve, reject) => {
			// Check if already aborted
			if (signal.aborted) {
				reject(signal.reason);
				return;
			}

			// Check queue first
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

			// Set up abort handler
			const onAbort = () => {
				cleanup();
				reject(signal.reason);
			};
			signal.addEventListener("abort", onAbort, { once: true });

			// Set up timeout
			timeoutId = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				cleanup();
				resolve(null);
			}, ms);

			// Set up wait resolver
			this.waitResolve = (event: T) => {
				signal.removeEventListener("abort", onAbort);
				cleanup();
				resolve(event);
			};
		});
	}

	close(): void {
		this.closed = true;
		if (this.waitResolve) {
			// Resolve any pending wait with undefined to signal close
			// Actually we need to handle this differently - just set closed flag
			// The waitWithTimeout will return null on next check
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

// Store active connections per user
// Map<userId, Map<connectionId, Connection>>
const connections = new Map<string, Map<string, Connection>>();

// Store user's vault memberships for filtering events
// Map<userId, Set<vaultId>>
const userVaults = new Map<string, Set<string>>();

// Heartbeat interval in milliseconds
const HEARTBEAT_INTERVAL = 15_000;

/**
 * Generate unique connection ID
 */
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

/**
 * Register a new connection
 */
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

/**
 * Remove a connection
 */
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
 * Broadcast a sync event to all relevant users
 * Only sends to users who have access to the vault
 */
export async function broadcastSyncEvent(
	event: SyncEventPayload,
): Promise<void> {
	const { vaultId, clientId, userId: eventUserId } = event;

	// If no vaultId, only broadcast to the user who triggered the event
	if (!vaultId) {
		const userConnections = connections.get(eventUserId);
		if (userConnections) {
			for (const connection of userConnections.values()) {
				connection.channel.push(event);
			}
		}
		return;
	}

	// Get all users who have access to this vault
	const vaultMembers = await db.query.vaultKey.findMany({
		where: eq(vaultKey.vaultId, vaultId),
	});

	for (const member of vaultMembers) {
		const memberUserId = member.userId;
		const userConnections = connections.get(memberUserId);

		if (userConnections) {
			for (const connection of userConnections.values()) {
				connection.channel.push({
					...event,
					metadata: {
						...event.metadata,
						isOwnEvent: memberUserId === eventUserId,
						originClientId: clientId,
					},
				});
			}
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

/**
 * Get connection statistics
 */
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
 * Initialize the broadcast function for the API package
 */
export function initializeSyncBroadcast(): void {
	setBroadcastFunction(broadcastSyncEvent);
}

/**
 * Create the Hono router for SSE sync endpoints
 */
export function createSyncRouter(): Hono {
	initializeSyncBroadcast();

	const app = new Hono();

	// SSE endpoint for real-time sync events
	app.get("/events", async (c) => {
		// Extract and verify JWT token
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

		// Get initial vault memberships
		await getUserVaults(userId);

		return streamSSE(
			c,
			async (stream) => {
				const abortController = new AbortController();
				const channel = new EventChannel<SyncEventPayload>();
				let eventId = 0;

				// Register connection
				const connection: Connection = {
					id: connectionId,
					userId,
					channel,
				};
				addConnection(connection);

				// Cleanup on abort
				stream.onAbort(() => {
					abortController.abort();
					removeConnection(userId, connectionId);
				});

				// Send initial connection message
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
						// First, drain any queued events
						const queuedEvents = channel.drain();
						for (const event of queuedEvents) {
							await stream.writeSSE({
								event: "sync",
								data: JSON.stringify(event),
								id: String(eventId++),
							});
						}

						// Wait for next event or timeout for heartbeat
						const event = await channel.waitWithTimeout(
							HEARTBEAT_INTERVAL,
							abortController.signal,
						);

						if (event) {
							// Got an event - send it
							await stream.writeSSE({
								event: "sync",
								data: JSON.stringify(event),
								id: String(eventId++),
							});
						} else {
							// Timeout - send heartbeat
							await stream.writeSSE({
								event: "heartbeat",
								data: JSON.stringify({ timestamp: Date.now() }),
								id: String(eventId++),
							});
						}
					} catch {
						// Aborted or connection closed
						break;
					}
				}
			},
			async (err) => {
				if (err.name !== "AbortError") {
					console.error(`[SSE ${connectionId}] Stream error:`, err);
				}
			},
		);
	});

	// Health check endpoint
	app.get("/health", (c) => {
		return c.json({
			status: "ok",
			...getConnectionStats(),
		});
	});

	return app;
}
