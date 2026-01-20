/**
 * Extension Sync Manager
 * MV3-compatible sync implementation using SSE with service worker constraints
 */

import type { SyncEvent, ConnectionStatus } from "@bittery/sync";
import * as chromeStorage from "@bittery/crypto/storage-chrome";

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

// Storage keys
const CLIENT_ID_KEY = "bittery_sync_client_id";
const LAST_SYNC_KEY = "bittery_last_sync_timestamp";
const SYNC_ALARM_NAME = "bittery_sync_reconnect";

// Connection state
let abortController: AbortController | null = null;
let connectionStatus: ConnectionStatus = "disconnected";
let reconnectAttempt = 0;

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

/**
 * Update connection status and notify popup
 */
function setStatus(status: ConnectionStatus) {
	if (connectionStatus !== status) {
		connectionStatus = status;
		// Broadcast to popup
		chrome.runtime.sendMessage({
			type: "SYNC_STATUS_CHANGED",
			status,
		}).catch(() => {
			// Popup might not be open, ignore
		});
	}
}

/**
 * Get current connection status
 */
export function getStatus(): ConnectionStatus {
	return connectionStatus;
}

/**
 * Handle incoming sync event
 */
async function handleSyncEvent(event: SyncEvent) {
	// Store last sync timestamp
	await chrome.storage.session.set({ [LAST_SYNC_KEY]: event.timestamp });

	// Skip events from our own client
	const clientId = await getClientId();
	if (event.metadata?.originClientId === clientId) {
		return;
	}

	// Notify popup to refresh data
	chrome.runtime.sendMessage({
		type: "SYNC_EVENT",
		event,
	}).catch(() => {
		// Popup might not be open, ignore
	});

	// Clear cached vault data so it refreshes
	await chrome.storage.session.remove(["cachedVaultItems", "cachedVaults"]);
}

/**
 * Connect to SSE endpoint
 */
export async function connect(): Promise<void> {
	if (connectionStatus === "connected" || connectionStatus === "connecting") {
		return;
	}

	setStatus("connecting");

	try {
		const serverUrl = await chromeStorage.getServerUrl();
		const token = await chromeStorage.getAuthToken();

		if (!serverUrl || !token) {
			setStatus("disconnected");
			return;
		}

		// Create abort controller
		abortController = new AbortController();

		const response = await fetch(`${serverUrl}/sync/events`, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
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

		setStatus("connected");
		reconnectAttempt = 0;

		// Clear any pending reconnect alarms
		await chrome.alarms.clear(SYNC_ALARM_NAME);

		// Read SSE stream
		await readStream(response.body);
	} catch (error) {
		if ((error as Error).name === "AbortError") {
			return;
		}

		console.error("SSE connection error:", error);
		setStatus("error");
		scheduleReconnect();
	}
}

/**
 * Read and parse SSE stream
 */
async function readStream(body: ReadableStream<Uint8Array>): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();

			if (done) {
				setStatus("reconnecting");
				scheduleReconnect();
				break;
			}

			buffer += decoder.decode(value, { stream: true });

			// Process complete events
			const events = buffer.split("\n\n");
			buffer = events.pop() || "";

			for (const eventStr of events) {
				await processEvent(eventStr);
			}
		}
	} catch (error) {
		if ((error as Error).name !== "AbortError") {
			console.error("Stream read error:", error);
			setStatus("reconnecting");
			scheduleReconnect();
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Process a single SSE event
 */
async function processEvent(eventStr: string): Promise<void> {
	const lines = eventStr.trim().split("\n");
	let data = "";

	for (const line of lines) {
		if (line.startsWith(":")) continue; // Skip heartbeats
		if (line.startsWith("data: ")) {
			data = line.slice(6);
		}
	}

	if (!data) return;

	try {
		const event = JSON.parse(data);

		// Handle connection message
		if (event.type === "connected") {
			console.log("SSE connected:", event);
			return;
		}

		// Convert to SyncEvent and handle
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

		await handleSyncEvent(syncEvent);
	} catch (error) {
		console.error("Failed to parse SSE event:", error, data);
	}
}

/**
 * Schedule reconnection using Chrome Alarms (MV3 compatible)
 */
function scheduleReconnect() {
	const delay = Math.min(
		1000 * Math.pow(2, reconnectAttempt),
		30000
	);
	reconnectAttempt++;

	// Use Chrome Alarms for reconnection (survives service worker termination)
	chrome.alarms.create(SYNC_ALARM_NAME, {
		delayInMinutes: delay / 60000,
	});
}

/**
 * Handle reconnect alarm
 */
export async function handleSyncReconnectAlarm(alarm: chrome.alarms.Alarm) {
	if (alarm.name === SYNC_ALARM_NAME) {
		await connect();
	}
}

/**
 * Disconnect from SSE
 */
export function disconnect() {
	if (abortController) {
		abortController.abort();
		abortController = null;
	}
	chrome.alarms.clear(SYNC_ALARM_NAME);
	setStatus("disconnected");
}

/**
 * Initialize sync on login
 */
export async function initializeSync() {
	await connect();
}

/**
 * Cleanup sync on logout
 */
export async function cleanupSync() {
	disconnect();
	await chrome.storage.session.remove([LAST_SYNC_KEY]);
}

/**
 * Get last sync timestamp
 */
export async function getLastSyncTimestamp(): Promise<number | null> {
	const result = await chrome.storage.session.get(LAST_SYNC_KEY);
	return (result[LAST_SYNC_KEY] as number) || null;
}
