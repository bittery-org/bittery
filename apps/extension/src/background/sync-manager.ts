/**
 * Extension Sync Manager
 *
 * MV3-compatible SSE sync with explicit service-worker recovery behavior.
 * Incoming events follow a strict order:
 * 1) persist last processed cursor
 * 2) apply account-scoped cache delta updates
 * 3) notify UI listeners for query invalidation/refetch
 */

import {
	type CatchUpClient,
	type ConnectionStatus,
	runCatchUp,
	type SyncCursor,
	type SyncEvent,
} from "@bittery/sync";
import { syncCacheService } from "./services/sync-cache-service";

// Storage keys
const CLIENT_ID_KEY = "bittery_sync_client_id";
const LAST_SYNC_CURSOR_KEY = "bittery_last_sync_cursor";
const LEGACY_LAST_SYNC_KEY = "bittery_last_sync_timestamp";
const SYNC_ALARM_NAME = "bittery_sync_reconnect";

// Connection state
let abortController: AbortController | null = null;
let connectionStatus: ConnectionStatus = "disconnected";
let reconnectAttempt = 0;
let syncConnectionEmail: string | null = null;

/**
 * Generate a random ID (simpler than nanoid for extension context)
 */
function generateId(length = 8): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let result = "";
	const randomValues = new Uint8Array(length);
	crypto.getRandomValues(randomValues);
	for (let i = 0; i < length; i++) {
		const randomVal = randomValues[i] ?? 0;
		result += chars[randomVal % chars.length];
	}
	return result;
}

/**
 * Get or create a unique client ID for this extension instance
 */
async function getOrCreateClientId(): Promise<string> {
	const result = await chrome.storage.local.get(CLIENT_ID_KEY);
	if (result[CLIENT_ID_KEY]) {
		return result[CLIENT_ID_KEY] as string;
	}
	const clientId = `ext_${Date.now()}_${generateId(8)}`;
	await chrome.storage.local.set({ [CLIENT_ID_KEY]: clientId });
	return clientId;
}

/**
 * Get the client ID
 */
export async function getClientId(): Promise<string> {
	return getOrCreateClientId();
}

type SyncRuntimeMessage =
	| { type: "SYNC_STATUS_CHANGED"; status: ConnectionStatus }
	| { type: "SYNC_EVENT"; event: SyncEvent }
	| { type: "SYNC_FULL_REFRESH_REQUIRED" };

function sendRuntimeMessage(message: SyncRuntimeMessage): void {
	chrome.runtime.sendMessage(message).catch(() => {
		// Popup might not be open, ignore.
	});
}

/**
 * Update connection status and notify popup.
 */
function setStatus(status: ConnectionStatus, _reason: string): void {
	if (connectionStatus === status) {
		return;
	}

	connectionStatus = status;
	sendRuntimeMessage({
		type: "SYNC_STATUS_CHANGED",
		status,
	});
}

/**
 * Get current connection status
 */
export function getStatus(): ConnectionStatus {
	return connectionStatus;
}

function isSyncEventPayload(value: unknown): value is SyncEvent {
	if (!value || typeof value !== "object") {
		return false;
	}

	const event = value as Partial<SyncEvent>;
	return (
		typeof event.id === "string" &&
		typeof event.type === "string" &&
		typeof event.entityId === "string" &&
		typeof event.entityType === "string" &&
		typeof event.version === "number" &&
		typeof event.userId === "string" &&
		typeof event.timestamp === "number"
	);
}

/**
 * Handle incoming sync event
 * Cache updates happen before UI notifications so popup reads can be cache-first.
 */
async function handleSyncEvent(event: SyncEvent): Promise<void> {
	// Persist cursor in local storage (survives service worker restarts).
	await setLastSyncCursor({
		timestamp: event.timestamp,
		id: event.id,
	});

	// Skip events from our own client.
	const clientId = await getClientId();
	if (event.clientId === clientId) {
		return;
	}

	if (syncCacheService.supportsItemCache()) {
		try {
			await syncCacheService.applyDeltaSyncForEvent(event);
		} catch (error) {
			console.error(
				"[sync-manager] Delta sync failed, popup will do full refetch:",
				error,
			);
		}
	}

	// Notify popup to refresh data (reads from updated cache if delta sync succeeded).
	sendRuntimeMessage({
		type: "SYNC_EVENT",
		event,
	});
}

/**
 * Catch up on missed events since last sync timestamp.
 */
async function catchUpMissedEvents(): Promise<void> {
	if (!syncCacheService.supportsItemCache()) {
		return;
	}

	try {
		const lastCursor = await getLastSyncCursor();
		if (!lastCursor) {
			return;
		}

		const clientId = await getClientId();
		const client =
			await syncCacheService.getClientForEmail(syncConnectionEmail);
		const result = await runCatchUp({
			client: client as CatchUpClient,
			initialCursor: lastCursor,
			shouldProcessEvent: (event) => event.clientId !== clientId,
			onEvent: async (event) => {
				await syncCacheService.applyDeltaSyncForEvent(event);
			},
			onRequiresFullRefresh: async () => {
				await syncCacheService.clearItemCachesForKnownAccounts();
				sendRuntimeMessage({ type: "SYNC_FULL_REFRESH_REQUIRED" });
			},
		});

		await setLastSyncCursor(result.cursor);
		if (result.processedCount > 0) {
			sendRuntimeMessage({
				type: "SYNC_FULL_REFRESH_REQUIRED",
			});
		}
	} catch (error) {
		console.error(
			"[sync-manager] Catch-up failed, full refetch will happen:",
			error,
		);
	}
}

/**
 * Connect to SSE endpoint.
 */
export async function connect(): Promise<void> {
	if (connectionStatus === "connected" || connectionStatus === "connecting") {
		return;
	}

	setStatus("connecting", "connect requested");

	try {
		const context = await syncCacheService.resolveConnectionContext();
		if (!context) {
			syncConnectionEmail = null;
			setStatus("disconnected", "no auth context available");
			return;
		}

		syncConnectionEmail = context.email;
		abortController = new AbortController();

		const response = await fetch(`${context.serverUrl}/sync/events`, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${context.token}`,
				Accept: "text/event-stream",
			},
			signal: abortController.signal,
		});

		if (!response.ok) {
			throw new Error(`SSE connection failed: ${response.status}`);
		}

		if (!response.body) {
			throw new Error("No response body");
		}

		setStatus("connected", "SSE stream opened");
		reconnectAttempt = 0;

		// Clear any pending reconnect alarms.
		await chrome.alarms.clear(SYNC_ALARM_NAME);

		// Catch up on missed events since last sync.
		await catchUpMissedEvents();

		// Read SSE stream.
		await readStream(response.body);
	} catch (error) {
		if ((error as Error).name === "AbortError") {
			return;
		}

		console.error("[sync-manager] SSE connection error:", error);
		setStatus("error", "connection failed");
		scheduleReconnect("connection_error");
	}
}

/**
 * Read and parse SSE stream.
 */
async function readStream(body: ReadableStream<Uint8Array>): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();

			if (done) {
				setStatus("reconnecting", "stream ended by server");
				scheduleReconnect("stream_ended");
				break;
			}

			buffer += decoder.decode(value, { stream: true });

			// Process complete events.
			const events = buffer.split("\n\n");
			buffer = events.pop() || "";

			for (const eventStr of events) {
				await processEvent(eventStr);
			}
		}
	} catch (error) {
		if ((error as Error).name !== "AbortError") {
			console.error("[sync-manager] Stream read error:", error);
			setStatus("reconnecting", "stream read failure");
			scheduleReconnect("stream_error");
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Process a single SSE event payload.
 */
async function processEvent(eventStr: string): Promise<void> {
	const lines = eventStr.trim().split("\n");
	let data = "";

	for (const line of lines) {
		if (line.startsWith(":")) {
			continue; // Skip heartbeats/comments.
		}
		if (line.startsWith("data: ")) {
			data = line.slice(6);
		}
	}

	if (!data) {
		return;
	}

	try {
		const parsed = JSON.parse(data) as unknown;
		if (!parsed || typeof parsed !== "object") {
			return;
		}

		const eventType = (parsed as { type?: unknown }).type;
		if (eventType === "connected") {
			return;
		}

		if (!isSyncEventPayload(parsed)) {
			console.warn(
				"[sync-manager] Ignoring malformed sync event payload",
				parsed,
			);
			return;
		}

		await handleSyncEvent(parsed);
	} catch (error) {
		console.error("[sync-manager] Failed to parse SSE event:", error, data);
	}
}

/**
 * Schedule reconnection using Chrome Alarms (MV3-compatible).
 */
function scheduleReconnect(reason: string): void {
	const delayMs = Math.min(1000 * 2 ** reconnectAttempt, 30000);
	reconnectAttempt++;

	console.warn(
		`[sync-manager] Scheduling reconnect attempt ${reconnectAttempt} in ${delayMs}ms (${reason})`,
	);

	chrome.alarms.create(SYNC_ALARM_NAME, {
		delayInMinutes: delayMs / 60000,
	});
}

/**
 * Handle reconnect alarm.
 */
export async function handleSyncReconnectAlarm(
	alarm: chrome.alarms.Alarm,
): Promise<void> {
	if (alarm.name === SYNC_ALARM_NAME) {
		await connect();
	}
}

/**
 * Disconnect from SSE.
 */
export function disconnect(reason = "manual disconnect"): void {
	if (abortController) {
		abortController.abort();
		abortController = null;
	}
	syncConnectionEmail = null;
	void chrome.alarms.clear(SYNC_ALARM_NAME);
	setStatus("disconnected", reason);
}

/**
 * Initialize sync on login.
 */
export async function initializeSync(): Promise<void> {
	await connect();
}

/**
 * Cleanup sync on logout.
 */
export async function cleanupSync(): Promise<void> {
	disconnect("logout cleanup");
	await chrome.storage.local.remove([
		LAST_SYNC_CURSOR_KEY,
		LEGACY_LAST_SYNC_KEY,
	]);
}

/**
 * Persist last sync cursor.
 */
export async function setLastSyncCursor(cursor: SyncCursor): Promise<void> {
	await chrome.storage.local.set({ [LAST_SYNC_CURSOR_KEY]: cursor });
}

/**
 * Get last sync cursor.
 * Supports migration from legacy timestamp-only storage.
 */
export async function getLastSyncCursor(): Promise<SyncCursor | null> {
	const result = await chrome.storage.local.get([
		LAST_SYNC_CURSOR_KEY,
		LEGACY_LAST_SYNC_KEY,
	]);
	const cursor = result[LAST_SYNC_CURSOR_KEY] as SyncCursor | undefined;
	if (
		cursor &&
		typeof cursor.timestamp === "number" &&
		typeof cursor.id === "string"
	) {
		return cursor;
	}

	const legacyTimestamp = result[LEGACY_LAST_SYNC_KEY] as number | undefined;
	if (!legacyTimestamp) {
		return null;
	}

	return {
		timestamp: legacyTimestamp,
		id: "",
	};
}
