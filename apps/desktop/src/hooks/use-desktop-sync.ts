import { storage } from "@/lib/storage";
import type { SyncStorage } from "@bittery/sync";
import { generateClientId, useSync } from "@bittery/sync";
import type { QueryClient } from "@tanstack/react-query";
import { Store } from "@tauri-apps/plugin-store";
import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Storage key for client ID
 */
const CLIENT_ID_KEY = "bittery_sync_client_id";

/**
 * Get or initialize the sync store
 */
let syncStoreInstance: Store | null = null;
async function getSyncStore(): Promise<Store> {
	if (!syncStoreInstance) {
		syncStoreInstance = await Store.load("sync-store.json");
	}
	return syncStoreInstance;
}

/**
 * Tauri-compatible sync storage implementation
 */
class TauriSyncStorage implements SyncStorage {
	async get<T>(key: string): Promise<T | null> {
		try {
			const store = await getSyncStore();
			const value = await store.get<string>(key);
			return value ? JSON.parse(value) : null;
		} catch {
			return null;
		}
	}

	async set<T>(key: string, value: T): Promise<void> {
		const store = await getSyncStore();
		await store.set(key, JSON.stringify(value));
		await store.save();
	}

	async remove(key: string): Promise<void> {
		const store = await getSyncStore();
		await store.delete(key);
		await store.save();
	}
}

/**
 * Get or create a unique client ID for this desktop instance
 */
async function getOrCreateClientId(): Promise<string> {
	const store = await getSyncStore();
	const stored = await store.get<string>(CLIENT_ID_KEY);
	if (stored) {
		return stored;
	}
	const clientId = generateClientId();
	await store.set(CLIENT_ID_KEY, clientId);
	await store.save();
	return clientId;
}

/**
 * Desktop-specific sync hook that integrates with Tauri storage
 */
export function useDesktopSync(queryClient: QueryClient, enabled = true) {
	const [clientId, setClientId] = useState<string>("");
	const [serverUrl, setServerUrl] = useState<string>("");
	const [isInitialized, setIsInitialized] = useState(false);

	// Initialize client ID and server URL
	useEffect(() => {
		(async () => {
			const [id, url] = await Promise.all([
				getOrCreateClientId(),
				storage.getServerUrl(),
			]);
			setClientId(id);
			setServerUrl(url || "");
			setIsInitialized(true);
		})();
	}, []);

	const getAuthToken = useCallback(async () => {
		return storage.getAuthToken();
	}, []);

	const syncStorage = useMemo(() => new TauriSyncStorage(), []);

	const syncState = useSync({
		serverUrl,
		getAuthToken,
		clientId,
		queryClient,
		storage: syncStorage,
		enabled: enabled && isInitialized && !!serverUrl && !!clientId,
	});

	return {
		...syncState,
		clientId,
		isInitialized,
	};
}

/**
 * Get the client ID for use in mutations
 */
export function useDesktopClientId(): string {
	const [clientId, setClientId] = useState<string>("");

	useEffect(() => {
		getOrCreateClientId().then(setClientId);
	}, []);

	return clientId;
}
