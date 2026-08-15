import { generateClientId } from "@bittery/sync";
import { Store } from "@tauri-apps/plugin-store";

export const MOBILE_SYNC_CLIENT_ID_KEY = "bittery_sync_client_id";

let syncStoreInstance: Store | null = null;

async function getSyncStore(): Promise<Store> {
	if (!syncStoreInstance) {
		syncStoreInstance = await Store.load("sync-store.json");
	}
	return syncStoreInstance;
}

export async function getOrCreateMobileSyncClientId(): Promise<string> {
	const store = await getSyncStore();
	const stored = await store.get<string>(MOBILE_SYNC_CLIENT_ID_KEY);
	if (stored) {
		(
			globalThis as { __BITTERY_SYNC_CLIENT_ID__?: string }
		).__BITTERY_SYNC_CLIENT_ID__ = stored;
		if (typeof window !== "undefined") {
			window.localStorage.setItem(MOBILE_SYNC_CLIENT_ID_KEY, stored);
		}
		return stored;
	}

	const clientId = generateClientId();
	await store.set(MOBILE_SYNC_CLIENT_ID_KEY, clientId);
	await store.save();
	(
		globalThis as { __BITTERY_SYNC_CLIENT_ID__?: string }
	).__BITTERY_SYNC_CLIENT_ID__ = clientId;
	if (typeof window !== "undefined") {
		window.localStorage.setItem(MOBILE_SYNC_CLIENT_ID_KEY, clientId);
	}
	return clientId;
}

export async function getMobileSyncStore(): Promise<Store> {
	return getSyncStore();
}

export async function clearMobileSyncState(options?: {
	preserveClientId?: boolean;
}): Promise<void> {
	const preserveClientId = options?.preserveClientId ?? true;
	const store = await getSyncStore();
	const preservedClientId = preserveClientId
		? await store.get<string>(MOBILE_SYNC_CLIENT_ID_KEY)
		: undefined;

	await store.clear();

	if (preservedClientId) {
		await store.set(MOBILE_SYNC_CLIENT_ID_KEY, preservedClientId);
	}
	await store.save();

	const globalState = globalThis as { __BITTERY_SYNC_CLIENT_ID__?: string };
	if (preservedClientId) {
		globalState.__BITTERY_SYNC_CLIENT_ID__ = preservedClientId;
		if (typeof window !== "undefined") {
			window.localStorage.setItem(MOBILE_SYNC_CLIENT_ID_KEY, preservedClientId);
		}
		return;
	}

	delete globalState.__BITTERY_SYNC_CLIENT_ID__;
	if (typeof window !== "undefined") {
		window.localStorage.removeItem(MOBILE_SYNC_CLIENT_ID_KEY);
	}
}
