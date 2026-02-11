/**
 * tRPC Client Setup
 * Configured to work with Chrome storage for auth tokens and server URL
 *
 * In desktop mode, fetches fresh auth tokens from the desktop app
 * since the extension's stored token may become stale.
 */

import type { AppRouter } from "@bittery/api/routers/index";
import { buildTrpcUrl, normalizeServerUrl } from "@bittery/shared/server-url";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
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
export const trpcClient = createTRPCClient<AppRouter>({
	links: [
		httpBatchLink({
			url: `${fallbackServerUrl}/trpc`,
			async headers() {
				const [token, clientId] = await Promise.all([
					getAuthToken(),
					getOrCreateSyncClientId(),
				]);
				return {
					authorization: token ? `Bearer ${token}` : "",
					"X-Client-Id": clientId,
				};
			},
			async fetch(url, options) {
				const storedServerUrl = await storage.getServerUrl();
				const serverUrl = storedServerUrl ?? fallbackServerUrl;
				const resolvedUrl = buildTrpcUrl(serverUrl, url as string);
				return fetch(resolvedUrl.toString(), options);
			},
		}),
	],
});
