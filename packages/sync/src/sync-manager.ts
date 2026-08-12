import type {
	ConnectionStatus,
	SessionRevokedControlPayload,
	SyncCursor,
	SyncManagerOptions,
	SyncStorage,
} from "./types";

interface StoredSyncBaseline {
	initialized: true;
	cursor: SyncCursor | null;
}

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
	private clientId: string;
	private openSyncEvents: (signal: AbortSignal) => Promise<Response>;
	private storage: SyncStorage;
	private onStatusChange?: (status: ConnectionStatus) => void;
	private onSessionRevoked?: (
		payload: SessionRevokedControlPayload,
	) => void | Promise<void>;
	private onSyncPing?: () => void | Promise<void>;

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

	constructor(options: SyncManagerOptions) {
		this.clientId = options.clientId;
		this.openSyncEvents = options.openSyncEvents;
		this.storage = options.storage || new MemoryStorage();
		this.onStatusChange = options.onStatusChange;
		this.onSessionRevoked = options.onSessionRevoked;
		this.onSyncPing = options.onSyncPing;
		this.reconnectDelay = options.reconnectDelay || 1000;
		this.maxReconnectDelay = options.maxReconnectDelay || 30000;
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
			// Create abort controller for this connection
			this.abortController = new AbortController();

			const response = await this.openSyncEvents(this.abortController.signal);

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
	 * Process a single SSE event.
	 *
	 * The server sends lightweight pings:
	 *   event: sync       → something changed, client should fetch `/sync/changes`
	 *   event: session_revoked → a session was revoked
	 *   event: connected   → connection established
	 *   event: limit_exceeded → plan connection limit reached
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
				return;
			}

			// Handle connection message
			if (eventType === "connected" || event.type === "connected") {
				console.log("Sync connected");
				return;
			}

			// A sync event is only a hint; durable changes come from `/sync/changes`.
			if (eventType === "sync" && !event.id) {
				void this.onSyncPing?.();
				return;
			}

			// Handle session revocation (new format: event: session_revoked)
			if (eventType === "session_revoked") {
				void this.onSessionRevoked?.({
					type: "session_revoked",
					userId: String(event.userId ?? event.user_id ?? ""),
					sessionId: String(event.sessionId ?? event.session_id ?? ""),
					timestamp:
						typeof event.timestamp === "number" ? event.timestamp : Date.now(),
					reason: typeof event.reason === "string" ? event.reason : undefined,
				});
				return;
			}

			// Handle limit exceeded
			if (eventType === "limit_exceeded" || event.type === "limit_exceeded") {
				console.warn("SSE connection limit exceeded");
				return;
			}
		} catch (error) {
			console.error("Failed to parse SSE event:", error, data);
		}
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
		await Promise.all([
			this.storage.set("lastSyncCursor", cursor),
			this.setStoredSyncBaseline(cursor),
		]);
	}

	async setStoredSyncBaseline(cursor: SyncCursor | null): Promise<void> {
		await this.storage.set<StoredSyncBaseline>("syncBaselineV1", {
			initialized: true,
			cursor,
		});
	}

	async getStoredSyncBaseline(): Promise<StoredSyncBaseline | null> {
		const baseline =
			await this.storage.get<StoredSyncBaseline>("syncBaselineV1");
		if (
			baseline?.initialized === true &&
			(baseline.cursor === null ||
				(typeof baseline.cursor === "object" &&
					typeof baseline.cursor.id === "string" &&
					baseline.cursor.id.length > 0))
		) {
			return baseline;
		}

		return null;
	}

	/**
	 * Store the latest cursor from the active SSE stream for offline recovery.
	 */
	async saveLastSyncCursor(): Promise<void> {
		if (this.lastEventCursor) {
			await this.setStoredLastSyncCursor(this.lastEventCursor);
		}
	}

	/** Get the stored sync cursor. */
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
}

/**
 * Create a sync manager instance
 */
export function createSyncManager(options: SyncManagerOptions): SyncManager {
	return new SyncManager(options);
}
