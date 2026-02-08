/**
 * Extension Sync Manager
 * MV3-compatible sync implementation using SSE with service worker constraints
 * Supports delta sync: incoming events update the local item cache before notifying the popup
 */

import { createAccountTrpcClient } from "@bittery/shared/trpc-client-factory";
import type { ConnectionStatus, SyncEvent } from "@bittery/sync";
import { performDeltaSync } from "@bittery/sync";
import { storage } from "../lib/storage";
import { desktopClient } from "./desktop-client";
import { trpcClient } from "./trpc-client";

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
let syncConnectionEmail: string | null = null;

type SyncConnectionContext = {
	email: string | null;
	serverUrl: string;
	token: string;
};

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
 * Resolve the active account email
 */
async function resolveActiveEmail(): Promise<string | null> {
	const account = await storage.getActiveAccount();
	if (!account || account.type === "all") return null;
	return account.email.toLowerCase();
}

/**
 * Get auth token for an account, hydrating from desktop if available.
 */
async function getAuthTokenForEmail(email: string): Promise<string | null> {
	const normalizedEmail = email.toLowerCase();
	const localToken = await storage.getAuthToken(normalizedEmail);
	if (localToken) {
		return localToken;
	}

	try {
		const desktopToken = await desktopClient.getAuthToken(normalizedEmail);
		if (desktopToken) {
			await storage.storeAuthToken(desktopToken, normalizedEmail);
			return desktopToken;
		}
	} catch {
		// Ignore desktop bridge errors and fall back to null.
	}

	return null;
}

/**
 * Build an account-scoped tRPC client. Returns null when no auth token is available.
 */
async function getAccountClientForEmail(
	email: string,
): Promise<ReturnType<typeof createAccountTrpcClient> | null> {
	const normalizedEmail = email.toLowerCase();
	const authToken = await getAuthTokenForEmail(normalizedEmail);
	if (!authToken) return null;

	const serverUrl =
		(await storage.getServerUrl(normalizedEmail)) ||
		(await storage.getServerUrl()) ||
		"http://localhost:3000";
	return createAccountTrpcClient(authToken, serverUrl);
}

/**
 * Resolve auth context used to connect SSE.
 */
async function resolveSyncConnectionContext(): Promise<SyncConnectionContext | null> {
	const candidateEmails: string[] = [];
	const activeEmail = await resolveActiveEmail();
	if (activeEmail) {
		candidateEmails.push(activeEmail);
	}

	const accounts = await storage.getAccountsList();
	for (const account of accounts) {
		const email = account.email.toLowerCase();
		if (!candidateEmails.includes(email)) {
			candidateEmails.push(email);
		}
	}

	for (const email of candidateEmails) {
		const token = await getAuthTokenForEmail(email);
		if (!token) continue;

		const serverUrl =
			(await storage.getServerUrl(email)) ||
			(await storage.getServerUrl()) ||
			"http://localhost:3000";
		return { email, serverUrl, token };
	}

	const fallbackToken = await storage.getAuthToken();
	if (!fallbackToken) return null;

	const fallbackServerUrl =
		(await storage.getServerUrl()) || "http://localhost:3000";
	return { email: null, serverUrl: fallbackServerUrl, token: fallbackToken };
}

/**
 * Get candidate account emails to apply cache updates for a sync event.
 */
async function getCandidateEmailsForEvent(event: SyncEvent): Promise<string[]> {
	const activeEmail = await resolveActiveEmail();
	if (activeEmail) {
		return [activeEmail];
	}

	const accounts = await storage.getAccountsList();
	const allEmails = Array.from(
		new Set(accounts.map((account) => account.email.toLowerCase())),
	);
	if (allEmails.length === 0) {
		return [];
	}

	if (!event.vaultId) {
		return allEmails;
	}

	const matchedEmails: string[] = [];
	for (const email of allEmails) {
		const vaultKeys = await storage.getVaultKeys(email);
		if (vaultKeys?.some((vaultKey) => vaultKey.vaultId === event.vaultId)) {
			matchedEmails.push(email);
		}
	}

	return matchedEmails.length > 0 ? matchedEmails : allEmails;
}

/**
 * Apply delta sync updates to per-account caches.
 */
async function applyDeltaSyncForEvent(event: SyncEvent): Promise<void> {
	const candidateEmails = await getCandidateEmailsForEvent(event);

	if (candidateEmails.length === 0) {
		await performDeltaSync(trpcClient, storage, event);
		return;
	}

	let applied = 0;
	for (const email of candidateEmails) {
		try {
			const client = await getAccountClientForEmail(email);
			if (!client) continue;

			await performDeltaSync(client, storage, event, email);
			applied++;
		} catch (error) {
			console.warn(
				`[sync-manager] Delta sync failed for ${email} (${event.type}):`,
				error,
			);
		}
	}

	if (applied === 0) {
		await Promise.all(
			candidateEmails.map((email) => storage.clearItemCache?.(email)),
		);
		await performDeltaSync(trpcClient, storage, event);
	}
}

/**
 * Create a tRPC client for a specific account email.
 * Falls back to the default trpcClient if email is not provided.
 */
async function getClientForEmail(
	email?: string | null,
): Promise<typeof trpcClient> {
	if (!email) return trpcClient;

	const client = await getAccountClientForEmail(email);
	return client ?? trpcClient;
}

/**
 * Update connection status and notify popup
 */
function setStatus(status: ConnectionStatus) {
	if (connectionStatus !== status) {
		connectionStatus = status;
		// Broadcast to popup
		chrome.runtime
			.sendMessage({
				type: "SYNC_STATUS_CHANGED",
				status,
			})
			.catch(() => {
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
 * Delta sync: fetch only the changed entity, update local cache, THEN broadcast to popup
 */
async function handleSyncEvent(event: SyncEvent) {
	// Store last sync timestamp in local storage (survives service worker restarts)
	await chrome.storage.local.set({ [LAST_SYNC_KEY]: event.timestamp });

	// Skip events from our own client
	const clientId = await getClientId();
	if (event.metadata?.originClientId === clientId) {
		return;
	}

	// Delta sync: update local item cache before notifying popup
	if (storage.supportsItemCache) {
		try {
			await applyDeltaSyncForEvent(event);
			// Desktop decryption cache is keyed by item id, so clear on data-changing events.
			if (event.type.startsWith("item_") || event.type.startsWith("vault_")) {
				desktopClient.clearCache();
			}
		} catch (e) {
			console.error(
				"[sync-manager] Delta sync failed, popup will do full refetch:",
				e,
			);
		}
	}

	// Notify popup to refresh data (reads from updated cache if delta sync succeeded)
	chrome.runtime
		.sendMessage({
			type: "SYNC_EVENT",
			event,
		})
		.catch(() => {
			// Popup might not be open, ignore
		});
}

/**
 * Catch up on missed events since last sync timestamp
 */
async function catchUpMissedEvents(): Promise<void> {
	if (!storage.supportsItemCache) return;

	try {
		const lastTimestamp = await getLastSyncTimestamp();
		if (!lastTimestamp) return;

		const clientId = await getClientId();
		const client = await getClientForEmail(syncConnectionEmail);

		const result = await client.sync.getEventsSince.query({
			since: lastTimestamp,
		});

		let processed = 0;
		for (const event of result.events) {
			// Skip own events
			if (event.clientId === clientId) continue;
			await applyDeltaSyncForEvent(event as SyncEvent);
			processed++;
		}

		if (processed > 0) {
			console.log(
				`[sync-manager] Catch-up: processed ${processed} missed events`,
			);
			desktopClient.clearCache();
			// Save the latest timestamp
			const latestTimestamp =
				result.events[result.events.length - 1]?.timestamp;
			if (latestTimestamp) {
				await chrome.storage.local.set({
					[LAST_SYNC_KEY]: latestTimestamp,
				});
			}
		}
	} catch (e) {
		console.error(
			"[sync-manager] Catch-up failed, full refetch will happen:",
			e,
		);
	}
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
		const context = await resolveSyncConnectionContext();
		if (!context) {
			setStatus("disconnected");
			return;
		}
		syncConnectionEmail = context.email;

		// Create abort controller
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

		setStatus("connected");
		reconnectAttempt = 0;

		// Clear any pending reconnect alarms
		await chrome.alarms.clear(SYNC_ALARM_NAME);

		// Catch up on missed events since last sync
		await catchUpMissedEvents();

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
	const delay = Math.min(1000 * 2 ** reconnectAttempt, 30000);
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
	syncConnectionEmail = null;
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
	await chrome.storage.local.remove([LAST_SYNC_KEY]);
}

/**
 * Get last sync timestamp
 */
export async function getLastSyncTimestamp(): Promise<number | null> {
	const result = await chrome.storage.local.get(LAST_SYNC_KEY);
	return (result[LAST_SYNC_KEY] as number) || null;
}
