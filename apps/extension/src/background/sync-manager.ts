/**
 * Extension Sync Manager
 *
 * MV3-compatible SSE sync with explicit service-worker recovery behavior.
 * Incoming events follow a strict order:
 * 1) apply account-scoped cache delta updates
 * 2) persist the processed cursor
 * 3) notify UI listeners for query invalidation/refetch
 */

import { normalizeAccountServerUrl } from "@bittery/storage/account-id";
import {
	type ConnectionStatus,
	runCatchUp,
	type SyncCursor,
} from "@bittery/sync";
import { drainOutboundQueue } from "./outbound-drain";
import { parseSseFrame, type SseFrame } from "./services/sse-frame";
import { syncCacheService } from "./services/sync-cache-service";
import { getOrCreateSyncClientId } from "./sync-client-id";
import {
	setSessionFallbackEmail,
	setSyncPort,
	vaultSession,
} from "./vault-session";

// Storage keys
const LAST_SYNC_CURSOR_KEY_PREFIX = "bittery_last_sync_cursor_v3";
const SYNC_ALARM_NAME = "bittery_sync_reconnect";

// Connection state
let abortController: AbortController | null = null;
let connectionStatus: ConnectionStatus = "disconnected";
let reconnectAttempt = 0;
let syncConnectionAccountId: string | null = null;
let syncConnectionServerUrl: string | null = null;
let syncBaselineValidated = false;
/** Set once the server revoked this session; the JWT is dead, so reconnecting only loops 401s. */
let revoked = false;

// Registered at module scope, not from `initializeSync`: a reconnect alarm can reach
// `connect()` on a cold worker that never ran init, and a revocation arriving on that
// stream must still be able to tear the connection down.
setSyncPort({ disconnect });

/** The revocation payload names a session, never an account, so the machine needs this identity. */
function setSyncConnectionEmail(email: string | null): void {
	setSessionFallbackEmail(email);
}

/**
 * Get the client ID
 */
export async function getClientId(): Promise<string> {
	return getOrCreateSyncClientId();
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
 * Push locally queued mutations. Never rethrows: a failed push keeps its
 * mutations queued, and the connect flow that triggered it must carry on.
 */
async function pushOutboundQueue(reason: string): Promise<void> {
	try {
		await drainOutboundQueue();
	} catch (error) {
		console.error(
			`[sync-manager] Outbound queue drain failed (${reason}):`,
			error,
		);
	}
}

/**
 * Catch up on missed events since last sync timestamp.
 */
async function catchUpMissedEvents(): Promise<void> {
	try {
		if (!syncConnectionAccountId) {
			throw new Error("Sync catch-up requires an accountId cursor scope");
		}
		if (!syncConnectionServerUrl) {
			throw new Error("Sync catch-up requires a server URL cursor scope");
		}
		let lastCursor = await getLastSyncCursor(
			syncConnectionAccountId,
			syncConnectionServerUrl,
		);
		if (!syncBaselineValidated || !lastCursor) {
			const committedCursor =
				await syncCacheService.initializeSyncBaselineForAccount(
					syncConnectionAccountId,
					lastCursor,
				);
			lastCursor = committedCursor ?? { id: "" };
			await setLastSyncCursor(
				syncConnectionAccountId,
				syncConnectionServerUrl,
				lastCursor,
			);
			syncBaselineValidated = true;
		}

		const client = await syncCacheService.getClientForAccountId(
			syncConnectionAccountId,
		);
		if (!client) {
			throw new Error(
				"No account-scoped client is available for sync catch-up",
			);
		}
		const result = await runCatchUp({
			client,
			initialCursor: lastCursor ?? { id: "" },
			onEvent: async (event) => {
				await syncCacheService.applyDeltaSyncForEvent(event);
			},
			onRequiresFullRefresh: async () => {
				await syncCacheService.refreshItemCachesForKnownAccounts();
				sendRuntimeMessage({ type: "SYNC_FULL_REFRESH_REQUIRED" });
			},
		});

		await setLastSyncCursor(
			syncConnectionAccountId,
			syncConnectionServerUrl,
			result.cursor,
		);
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
		syncConnectionAccountId = context.accountId;
		syncConnectionServerUrl = context.serverUrl;
		syncBaselineValidated = false;
		abortController = new AbortController();

		const response = await context.client.sync.events(abortController.signal);

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

		// Anything the popup queued while the worker was asleep or offline.
		await pushOutboundQueue("stream opened");

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
	syncConnectionAccountId = null;
	syncConnectionServerUrl = null;
	syncBaselineValidated = false;
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
	const accountId = syncConnectionAccountId;
	const serverUrl = syncConnectionServerUrl;
	disconnect("logout cleanup");
	revoked = false;
	const keys: string[] = [];
	if (accountId && serverUrl) {
		keys.push(lastSyncCursorKey(accountId, serverUrl));
	}
	await chrome.storage.local.remove(keys);
}

function lastSyncCursorKey(accountId: string, serverUrl: string): string {
	return `${LAST_SYNC_CURSOR_KEY_PREFIX}:${encodeURIComponent(normalizeAccountServerUrl(serverUrl))}:${encodeURIComponent(accountId)}`;
}

/**
 * Persist last sync cursor.
 */
export async function setLastSyncCursor(
	accountId: string,
	serverUrl: string,
	cursor: SyncCursor,
): Promise<void> {
	await chrome.storage.local.set({
		[lastSyncCursorKey(accountId, serverUrl)]: cursor,
	});
}

/**
 * Get last sync cursor.
 */
export async function getLastSyncCursor(
	accountId: string,
	serverUrl: string,
): Promise<SyncCursor | null> {
	const key = lastSyncCursorKey(accountId, serverUrl);
	const result = await chrome.storage.local.get(key);
	const cursor = result[key] as SyncCursor | undefined;
	if (cursor && typeof cursor.id === "string") {
		return cursor;
	}

	return null;
}
