/**
 * Extension Sync Manager
 *
 * MV3-compatible SSE sync with explicit service-worker recovery behavior.
 * Incoming events follow a strict order:
 * 1) apply account-scoped cache delta updates
 * 2) persist the processed cursor
 * 3) notify UI listeners for query invalidation/refetch
 */

import {
	type ConnectionStatus,
	runCatchUp,
	type SyncCursor,
} from "@bittery/sync";
import { getExtensionClientVersion } from "./api-client";
import { parseSseFrame, type SseFrame } from "./services/sse-frame";
import { syncCacheService } from "./services/sync-cache-service";
import {
	setSessionFallbackEmail,
	setSyncPort,
	vaultSession,
} from "./vault-session";

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
/** Set once the server revoked this session; the JWT is dead, so reconnecting only loops 401s. */
let revoked = false;

// Registered at module scope, not from `initializeSync`: a reconnect alarm can reach
// `connect()` on a cold worker that never ran init, and a revocation arriving on that
// stream must still be able to tear the connection down.
setSyncPort({ disconnect });

/** The revocation payload names a session, never an account, so the machine needs this identity. */
function setSyncConnectionEmail(email: string | null): void {
	syncConnectionEmail = email;
	setSessionFallbackEmail(email);
}

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

/**
 * Catch up on missed events since last sync timestamp.
 */
async function catchUpMissedEvents(): Promise<void> {
	try {
		const lastCursor = await getLastSyncCursor();

		const clientId = await getClientId();
		const client =
			await syncCacheService.getClientForEmail(syncConnectionEmail);
		const result = await runCatchUp({
			client,
			initialCursor: lastCursor ?? { id: "" },
			shouldProcessEvent: (event) => event.clientId !== clientId,
			onEvent: async (event) => {
				await syncCacheService.applyDeltaSyncForEvent(event);
			},
			onRequiresFullRefresh: async () => {
				await syncCacheService.refreshItemCachesForKnownAccounts();
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
			setSyncConnectionEmail(null);
			setStatus("disconnected", "no auth context available");
			return;
		}

		setSyncConnectionEmail(context.email);
		abortController = new AbortController();

		const clientId = await getClientId();
		const serverUrl = context.serverUrl.replace(/\/$/, "");
		const response = await fetch(`${serverUrl}/api/v1/sync/events`, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${context.token}`,
				Accept: "text/event-stream",
				"Bittery-Client-Id": clientId,
				"Bittery-Client-Platform": "extension",
				"Bittery-Client-Version": getExtensionClientVersion(),
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
				// The server terminates the stream right after revoking it, and that
				// teardown already reported `disconnected` — there is nothing to rejoin.
				if (!revoked) {
					setStatus("reconnecting", "stream ended by server");
				}
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

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Handle a single parsed SSE frame.
 *
 * The server sends lightweight pings:
 *   event: sync             → something changed, catch up via `/sync/changes`
 *   event: session_revoked  → this connection's own session was revoked
 *   event: connected        → connection established
 */
export async function handleSyncSseFrame(frame: SseFrame): Promise<void> {
	const payload = frame.data as Record<string, unknown>;
	const jsonType = payload.type;

	if (frame.event === "connected" || jsonType === "connected") {
		return;
	}

	if (frame.event === "sync") {
		await catchUpMissedEvents();
		sendRuntimeMessage({ type: "SYNC_FULL_REFRESH_REQUIRED" });
		return;
	}

	if (frame.event === "session_revoked") {
		// Server payload is snake_case; the shared sync client accepts both casings.
		const sessionId =
			readString(payload.session_id) ?? readString(payload.sessionId) ?? null;

		// Locking is the reducer's first act and must not wait on resolving an
		// account: the invalidation, the disconnect and the popup broadcast all
		// follow from this one dispatch.
		await vaultSession.dispatch({
			type: "SESSION_REVOKED",
			sessionId,
			reason: readString(payload.reason),
			at: Date.now(),
		});
	}
}

async function processEvent(eventStr: string): Promise<void> {
	const frame = parseSseFrame(eventStr);
	if (!frame) {
		return;
	}
	await handleSyncSseFrame(frame);
}

/**
 * Schedule reconnection using Chrome Alarms (MV3-compatible).
 */
function scheduleReconnect(reason: string): void {
	if (revoked) {
		return;
	}

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
	if (alarm.name === SYNC_ALARM_NAME && !revoked) {
		await connect();
	}
}

/**
 * Disconnect from SSE.
 *
 * `suppressReconnect` marks the session dead, so nothing schedules or honours a
 * reconnect until a fresh sign-in runs `initializeSync`.
 */
export function disconnect(
	reason = "manual disconnect",
	suppressReconnect = false,
): void {
	if (suppressReconnect) {
		revoked = true;
	}
	if (abortController) {
		abortController.abort();
		abortController = null;
	}
	syncConnectionEmail = null;
	// A revoked teardown keeps the fallback identity: the session invalidation it
	// triggers runs after this disconnect and resolves by email.
	if (!suppressReconnect) {
		setSessionFallbackEmail(null);
	}
	void chrome.alarms.clear(SYNC_ALARM_NAME);
	setStatus("disconnected", reason);
}

/**
 * Initialize sync on login.
 */
export async function initializeSync(): Promise<void> {
	revoked = false;
	await connect();
}

/**
 * Cleanup sync on logout.
 */
export async function cleanupSync(): Promise<void> {
	disconnect("logout cleanup");
	revoked = false;
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
 * Supports migration from legacy timestamp+id storage.
 */
export async function getLastSyncCursor(): Promise<SyncCursor | null> {
	const result = await chrome.storage.local.get([
		LAST_SYNC_CURSOR_KEY,
		LEGACY_LAST_SYNC_KEY,
	]);
	const cursor = result[LAST_SYNC_CURSOR_KEY] as SyncCursor | undefined;
	if (cursor && typeof cursor.id === "string") {
		return cursor;
	}

	return null;
}
