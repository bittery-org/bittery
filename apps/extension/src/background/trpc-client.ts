/**
 * tRPC Client Setup
 * Configured to work with Chrome storage for auth tokens and server URL
 *
 * In desktop mode, fetches fresh auth tokens from the desktop app
 * since the extension's stored token may become stale.
 */

import { normalizeServerUrl } from "@bittery/shared/server-url";
import { createSessionRefreshingTrpcClient } from "@bittery/shared/trpc-session-refresh";
import { storage } from "../lib/storage";
import { desktopClient } from "./desktop-client";
import { desktopSync } from "./desktop-sync";

const fallbackServerUrl =
	normalizeServerUrl("http://localhost:3000") ?? "http://localhost:3000";
const CLIENT_ID_KEY = "bittery_sync_client_id";

function generateClientId(): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	const randomValues = new Uint8Array(8);
	crypto.getRandomValues(randomValues);
	let suffix = "";
	for (let i = 0; i < randomValues.length; i++) {
		const randomVal = randomValues[i] ?? 0;
		suffix += chars[randomVal % chars.length];
	}
	return `ext_${Date.now()}_${suffix}`;
}

async function getOrCreateSyncClientId(): Promise<string> {
	const result = await chrome.storage.local.get(CLIENT_ID_KEY);
	const existing = result[CLIENT_ID_KEY];
	if (typeof existing === "string" && existing.length > 0) {
		return existing;
	}

	const clientId = generateClientId();
	await chrome.storage.local.set({ [CLIENT_ID_KEY]: clientId });
	return clientId;
}

/**
 * Get the best available auth token.
 * In desktop mode, fetches a fresh token from the desktop app and
 * updates extension storage so it stays in sync.
 */
async function getAuthToken(): Promise<string | null> {
	const activeAccount = await storage.getActiveAccount();
	const email = activeAccount?.type === "single" ? activeAccount.email : null;

	// In desktop mode, try to get a fresh token from the desktop app
	if (email && desktopSync.isDesktopAvailable()) {
		try {
			const desktopToken = await desktopClient.getAuthToken(email);
			if (desktopToken) {
				// Update extension storage with the fresh token
				await storage.storeAuthToken(desktopToken, email);
				return desktopToken;
			}
		} catch {
			// Fall through to storage token
		}
	}

	return storage.getAuthToken();
}

// tRPC client for API calls
export const trpcClient = createSessionRefreshingTrpcClient({
	defaultServerUrl: fallbackServerUrl,
	getServerUrl: async () => {
		const storedServerUrl = await storage.getServerUrl();
		return storedServerUrl ?? fallbackServerUrl;
	},
	getSessionSnapshot: async () => {
		const activeAccount = await storage.getActiveAccount();
		const email =
			activeAccount?.type === "single" ? activeAccount.email : undefined;
		const [token, sessionData] = await Promise.all([
			getAuthToken(),
			storage.getStoredSessionData?.(email) ?? Promise.resolve(null),
		]);

		return {
			token,
			issuedAt: sessionData?.createdAt ?? null,
			expiresAt: sessionData?.expiresAt ?? null,
		};
	},
	getRefreshToken: getAuthToken,
	storeRefreshedToken: async (token) => {
		const activeAccount = await storage.getActiveAccount();
		const email =
			activeAccount?.type === "single" ? activeAccount.email : undefined;
		await storage.storeAuthToken(token, email);
	},
	getClientId: async () => getOrCreateSyncClientId(),
	appPlatform: "extension",
});
