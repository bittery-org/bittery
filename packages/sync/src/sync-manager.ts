import type {
	ConnectionStatus,
	SessionRevokedControlPayload,
	SyncCursor,
	SyncEvent,
	SyncManagerOptions,
	SyncStorage,
} from "./types";

/**
 * Default in-memory storage implementation
 */
class MemoryStorage implements SyncStorage {
	private data = new Map<string, unknown>();

	async get<T>(key: string): Promise<T | null> {
		return (this.data.get(key) as T) || null;
	}

	async set<T>(key: string, value: T): Promise<void> {
		this.data.set(key, value);
	}

	async remove(key: string): Promise<void> {
		this.data.delete(key);
	}
}

/**
 * SyncManager handles real-time synchronization via SSE
 * - Establishes and maintains SSE connection
 * - Handles reconnection with exponential backoff
 * - Filters out events from own client
 * - Dispatches events to listeners
 */
// Grace period before considering connection stale (2x server heartbeat interval + buffer)
const STALE_CONNECTION_THRESHOLD = 35000;
// How often to check for stale connection
const STALE_CHECK_INTERVAL = 10000;

export class SyncManager {
	private serverUrl: string;
	private getAuthToken: () => Promise<string | null>;
	private clientId: string;
	private storage: SyncStorage;
	private onEvent?: (event: SyncEvent) => void;
	private onStatusChange?: (status: ConnectionStatus) => void;
	private onSessionRevoked?: (
		payload: SessionRevokedControlPayload,
	) => void | Promise<void>;

	private fetchImpl: (url: string, init?: any) => Promise<Response>;
	private abortController: AbortController | null = null;
	private connectionStatus: ConnectionStatus = "disconnected";
	private reconnectAttempt = 0;
	private reconnectDelay: number;
	private maxReconnectDelay: number;
	private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
	private lastEventCursor: SyncCursor | null = null;
	private lastEventTimestamp: number | null = null;
	private lastHeartbeatTime: number | null = null;
	private staleCheckInterval: ReturnType<typeof setInterval> | null = null;

	// Event deduplication: batch events for the same entityId within a window
	private static readonly DEDUP_WINDOW_MS = 500;
	private pendingEvents = new Map<
		string,
		{ event: SyncEvent; timer: ReturnType<typeof setTimeout> }
	>();

	constructor(options: SyncManagerOptions) {
		this.serverUrl = options.serverUrl;
		this.getAuthToken = options.getAuthToken;
		this.clientId = options.clientId;
		this.storage = options.storage || new MemoryStorage();
		this.onEvent = options.onEvent;
		this.onStatusChange = options.onStatusChange;
		this.onSessionRevoked = options.onSessionRevoked;
		this.reconnectDelay = options.reconnectDelay || 1000;
		this.maxReconnectDelay = options.maxReconnectDelay || 30000;
		this.fetchImpl = options.fetch || globalThis.fetch.bind(globalThis);
	}

	/**
	 * Get current connection status
	 */
	getStatus(): ConnectionStatus {
		return this.connectionStatus;
	}

	/**
	 * Get last event timestamp
	 */
	getLastEventTimestamp(): number | null {
		return this.lastEventTimestamp;
	}

	/**
	 * Get last event cursor
	 */
	getLastEventCursor(): SyncCursor | null {
		return this.lastEventCursor;
	}

	/**
	 * Get client ID
	 */
	getClientId(): string {
		return this.clientId;
	}

	/**
	 * Update connection status and notify listeners
	 */
	private setStatus(status: ConnectionStatus) {
		if (this.connectionStatus !== status) {
			this.connectionStatus = status;
			this.onStatusChange?.(status);
		}
	}

	/**
	 * Start checking for stale connection
	 */
	private startStaleCheck(): void {
		this.stopStaleCheck();
		this.lastHeartbeatTime = Date.now();

		this.staleCheckInterval = setInterval(() => {
			if (
				this.lastHeartbeatTime &&
				Date.now() - this.lastHeartbeatTime > STALE_CONNECTION_THRESHOLD
			) {
				console.warn("SSE connection appears stale, reconnecting...");
				this.disconnect();
				this.setStatus("reconnecting");
				this.scheduleReconnect();
			}
		}, STALE_CHECK_INTERVAL);
	}

	/**
	 * Stop stale connection check
	 */
	private stopStaleCheck(): void {
		if (this.staleCheckInterval) {
			clearInterval(this.staleCheckInterval);
			this.staleCheckInterval = null;
		}
	}

	/**
	 * Connect to SSE endpoint
	 */
	async connect(): Promise<void> {
		if (
			this.connectionStatus === "connected" ||
			this.connectionStatus === "connecting"
		) {
			return;
		}

		this.setStatus("connecting");

		try {
			const token = await this.getAuthToken();
			if (!token) {
				this.setStatus("reconnecting");
				this.scheduleReconnect();
				return;
			}

			// Create abort controller for this connection
			this.abortController = new AbortController();

			const response = await this.fetchImpl(`${this.serverUrl}/sync/events`, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "text/event-stream",
				},
				signal: this.abortController.signal,
			});

			if (!response.ok) {
				throw new Error(`SSE connection failed: ${response.status}`);
			}

			if (!response.body) {
				throw new Error("No response body");
			}

			this.setStatus("connected");
			this.reconnectAttempt = 0;

			// Start monitoring for stale connection
			this.startStaleCheck();

			// Read SSE stream
			await this.readStream(response.body);
		} catch (error) {
			if ((error as Error).name === "AbortError") {
				// Connection was intentionally aborted
				return;
			}

			console.error("SSE connection error:", error);
			this.setStatus("error");
			this.scheduleReconnect();
		}
	}

	/**
	 * Read and parse SSE stream
	 */
	private async readStream(body: NonNullable<Response["body"]>): Promise<void> {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();

				if (done) {
					// Stream closed by server
					this.setStatus("reconnecting");
					this.scheduleReconnect();
					break;
				}

				buffer += decoder.decode(value, { stream: true });

				// Process complete events in buffer
				const events = buffer.split(/\r?\n\r?\n/);
				buffer = events.pop() || ""; // Keep incomplete event in buffer

				for (const eventStr of events) {
					this.processEvent(eventStr);
				}
			}
		} catch (error) {
			if ((error as Error).name !== "AbortError") {
				console.error("Stream read error:", error);
				this.setStatus("reconnecting");
				this.scheduleReconnect();
			}
		} finally {
			reader.releaseLock();
		}
	}

	/**
	 * Process a single SSE event
	 */
	private processEvent(eventStr: string): void {
		const lines = eventStr.trim().split(/\r?\n/);
		const dataLines: string[] = [];
		let eventType = "";

		for (const line of lines) {
			// Detect heartbeat comments and update stale-check timer
			if (line.startsWith(": heartbeat")) {
				this.lastHeartbeatTime = Date.now();
				return;
			}

			// Skip other comments
			if (line.startsWith(":")) {
				continue;
			}

			if (line.startsWith("event: ")) {
				eventType = line.slice(7);
			} else if (line.startsWith("data:")) {
				dataLines.push(line.slice(5).trimStart());
			}
		}

		const data = dataLines.join("\n");
		if (!data) {
			return;
		}

		try {
			const event = JSON.parse(data);

			// Update heartbeat time for any received event
			this.lastHeartbeatTime = Date.now();

			// Handle heartbeat events
			if (eventType === "heartbeat" || event.type === "heartbeat") {
				// Just update the heartbeat time, already done above
				return;
			}

			// Handle connection message
			if (event.type === "connected") {
				console.log("Sync connected");
				return;
			}

			// Handle control message for targeted session revocation.
			if (
				(eventType === "control" || event.type === "session_revoked") &&
				event.type === "session_revoked"
			) {
				void this.onSessionRevoked?.({
					type: "session_revoked",
					userId: String(event.userId ?? ""),
					sessionId: String(event.sessionId ?? ""),
					timestamp:
						typeof event.timestamp === "number" ? event.timestamp : Date.now(),
					reason: typeof event.reason === "string" ? event.reason : undefined,
				});
				return;
			}

			// Convert to SyncEvent
			const syncEvent: SyncEvent = {
				id: event.id,
				type: event.type,
				entityId: event.entityId,
				entityType: event.entityType,
				vaultId: event.vaultId,
				version: event.version,
				clientId: event.clientId,
				userId: event.userId,
				timestamp: event.timestamp,
				metadata: event.metadata,
			};

			// Track last seen cursor from stream. Persistence is handled after
			// successful event application in the orchestrator path.
			this.lastEventCursor = { id: syncEvent.id };
			this.lastEventTimestamp = syncEvent.timestamp;

			// Events from this client are already reflected locally via optimistic
			// updates. They do not require delta application, so we can acknowledge
			// the cursor immediately.
			if (syncEvent.clientId === this.clientId) {
				void this.setStoredLastSyncCursor({ id: syncEvent.id }).catch(
					(error) => {
						console.error("Failed to persist sync cursor:", error);
					},
				);
				return;
			}

			// Deduplicate: if multiple events arrive for the same entity within the
			// dedup window, only dispatch the latest one. This avoids redundant
			// network fetches and query invalidations for rapid-fire updates.
			this.scheduleEventDispatch(syncEvent);
		} catch (error) {
			console.error("Failed to parse SSE event:", error, data);
		}
	}

	private mergeDedupedEvent(
		existing: SyncEvent,
		incoming: SyncEvent,
	): SyncEvent {
		if (
			existing.type === "vault_updated" &&
			incoming.type === "vault_updated" &&
			existing.entityId === incoming.entityId
		) {
			const existingBulkImport = existing.metadata?.reason === "bulk_import";
			const incomingBulkImport = incoming.metadata?.reason === "bulk_import";
			if (existingBulkImport || incomingBulkImport) {
				return {
					...incoming,
					metadata: {
						...(existing.metadata ?? {}),
						...(incoming.metadata ?? {}),
						reason: "bulk_import",
					},
				};
			}
		}

		return incoming;
	}

	/**
	 * Schedule an event for dispatch, deduplicating by event type + entityId.
	 * If another event for the same entity and type arrives within the window,
	 * the previous one is replaced and only the latest is dispatched.
	 */
	private scheduleEventDispatch(event: SyncEvent): void {
		const key = `${event.type}:${event.entityId}`;
		const existing = this.pendingEvents.get(key);
		const mergedEvent = existing
			? this.mergeDedupedEvent(existing.event, event)
			: event;

		if (existing) {
			clearTimeout(existing.timer);
		}

		const timer = setTimeout(() => {
			this.pendingEvents.delete(key);
			this.onEvent?.(mergedEvent);
		}, SyncManager.DEDUP_WINDOW_MS);

		this.pendingEvents.set(key, { event: mergedEvent, timer });
	}

	/**
	 * Flush all pending debounced events immediately (e.g. on disconnect).
	 */
	private flushPendingEvents(): void {
		for (const [, { event, timer }] of this.pendingEvents) {
			clearTimeout(timer);
			this.onEvent?.(event);
		}
		this.pendingEvents.clear();
	}

	/**
	 * Schedule reconnection with exponential backoff
	 */
	private scheduleReconnect(): void {
		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
		}

		const delay = Math.min(
			this.reconnectDelay * 2 ** this.reconnectAttempt,
			this.maxReconnectDelay,
		);

		this.reconnectAttempt++;

		this.reconnectTimeout = setTimeout(() => {
			this.connect();
		}, delay);
	}

	/**
	 * Disconnect from SSE
	 */
	disconnect(): void {
		this.stopStaleCheck();
		this.flushPendingEvents();

		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}

		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}

		this.setStatus("disconnected");
	}

	/**
	 * Persist an explicit sync cursor.
	 */
	async setStoredLastSyncCursor(cursor: SyncCursor): Promise<void> {
		await this.storage.set("lastSyncCursor", cursor);
	}

	/**
	 * Store the latest cursor from the active SSE stream for offline recovery.
	 */
	async saveLastSyncCursor(): Promise<void> {
		if (this.lastEventCursor) {
			await this.setStoredLastSyncCursor(this.lastEventCursor);
		}
	}

	/**
	 * Get stored sync cursor.
	 * Supports invalidating legacy cursor formats that exposed server seq values.
	 */
	async getStoredLastSyncCursor(): Promise<SyncCursor | null> {
		const cursor = await this.storage.get<SyncCursor>("lastSyncCursor");
		if (
			cursor &&
			typeof cursor === "object" &&
			"id" in cursor &&
			typeof cursor.id === "string" &&
			cursor.id.length > 0
		) {
			return cursor;
		}

		if (cursor) {
			return null;
		}

		return null;
	}

	/**
	 * Backward-compatible wrapper for legacy callers.
	 */
	async saveLastSyncTimestamp(): Promise<void> {
		await this.saveLastSyncCursor();
	}

	/**
	 * Backward-compatible wrapper for legacy callers.
	 */
	async getStoredLastSyncTimestamp(): Promise<number | null> {
		return null;
	}
}

/**
 * Create a sync manager instance
 */
export function createSyncManager(options: SyncManagerOptions): SyncManager {
	return new SyncManager(options);
}
