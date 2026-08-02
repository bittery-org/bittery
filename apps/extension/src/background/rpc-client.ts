import { createSessionRefreshingRpcClient } from "@bittery/shared/rpc-session-refresh";
import { normalizeServerUrl } from "@bittery/shared/server-url";
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

async function getAuthToken(): Promise<string | null> {
	const activeAccount = await storage.getActiveAccount();
	const accountId = activeAccount ?? undefined;

	if (accountId && desktopSync.isDesktopAvailable()) {
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

export const rpcClient = createSessionRefreshingRpcClient({
	defaultServerUrl: fallbackServerUrl,
	getServerUrl: async () => {
		const storedServerUrl = await storage.getServerUrl();
		return storedServerUrl ?? fallbackServerUrl;
	},
	getSessionSnapshot: async () => {
		const activeAccount = await storage.getActiveAccount();
		const accountId = activeAccount ?? undefined;
		const [token, sessionData] = await Promise.all([
			getAuthToken(),
			storage.getStoredSessionData(accountId),
		]);

		return {
			token,
			issuedAt: sessionData?.createdAt ?? null,
			expiresAt: sessionData?.expiresAt ?? null,
		};
	},
	getRefreshToken: getAuthToken,
	storeRefreshedSession: async ({ token, sessionId, expiresAt }) => {
		const activeAccount = await storage.getActiveAccount();
		const accountId = activeAccount ?? undefined;
		await storage.storeAuthToken(token, accountId);
		if (accountId) {
			await storage.updateStoredSessionMetadata(accountId, {
				sessionId,
				expiresAt,
			});
		}
	},
	getClientId: async () => getOrCreateSyncClientId(),
	appPlatform: "extension",
});
