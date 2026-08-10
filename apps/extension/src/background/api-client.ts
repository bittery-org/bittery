import { createSessionRefreshingApiClient } from "@bittery/shared/api-session-refresh";
import { normalizeServerUrl } from "@bittery/shared/server-url";
import { storage } from "../lib/storage";
import { desktopClient } from "./desktop-client";
import { desktopSync } from "./desktop-sync";

const fallbackServerUrl =
	normalizeServerUrl("http://localhost:3000") ?? "http://localhost:3000";
const CLIENT_ID_KEY = "bittery_sync_client_id";

export function getExtensionClientVersion(): string {
	return globalThis.chrome?.runtime?.getManifest?.().version ?? "0.0.0";
}

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

async function getAuthToken(accountId: string): Promise<string | null> {
	if (desktopSync.isDesktopAvailable()) {
		try {
			const desktopToken = await desktopClient.getAuthToken(accountId);
			if (desktopToken) {
				await storage.storeAuthToken(desktopToken, accountId);
				return desktopToken;
			}
		} catch {
			// Fall through to storage token
		}
	}

	return storage.getAuthToken(accountId);
}

export const apiClient = createSessionRefreshingApiClient({
	defaultServerUrl: fallbackServerUrl,
	getAccountSnapshot: async () => {
		const activeAccount = await storage.getActiveAccount();
		if (!activeAccount) return null;
		const [token, sessionData, serverUrl] = await Promise.all([
			getAuthToken(activeAccount),
			storage.getStoredSessionData(activeAccount),
			storage.getServerUrl(activeAccount),
		]);

		return {
			accountId: activeAccount,
			serverUrl: serverUrl ?? fallbackServerUrl,
			token,
			issuedAt: sessionData?.createdAt ?? null,
			expiresAt: sessionData?.expiresAt ?? null,
		};
	},
	storeRefreshedSession: async (snapshot, { token, sessionId, expiresAt }) => {
		await storage.storeAuthToken(token, snapshot.accountId);
		await storage.updateStoredSessionMetadata(snapshot.accountId, {
			sessionId,
			expiresAt,
		});
	},
	getClientId: async () => getOrCreateSyncClientId(),
	clientPlatform: "extension",
	clientVersion: getExtensionClientVersion(),
});
