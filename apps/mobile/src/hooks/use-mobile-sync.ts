import type { SyncStorage } from "@bittery/sync";
import { useSync } from "@bittery/sync";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	getMobileSyncDb,
	getOrCreateMobileSyncClientId,
} from "../lib/sync-client-id";
import { storage } from "../services/storage";

/**
 * React Native-compatible sync storage implementation using SQLite
 */
class ReactNativeSyncStorage implements SyncStorage {
	async get<T>(key: string): Promise<T | null> {
		try {
			const db = await getMobileSyncDb();
			const result = await db.getFirstAsync<{ value: string }>(
				"SELECT value FROM sync_storage WHERE key = ?",
				[key],
			);
			return result ? JSON.parse(result.value) : null;
		} catch {
			return null;
		}
	}

	async set<T>(key: string, value: T): Promise<void> {
		const db = await getMobileSyncDb();
		await db.runAsync(
			"INSERT OR REPLACE INTO sync_storage (key, value) VALUES (?, ?)",
			[key, JSON.stringify(value)],
		);
	}

	async remove(key: string): Promise<void> {
		const db = await getMobileSyncDb();
		await db.runAsync("DELETE FROM sync_storage WHERE key = ?", [key]);
	}
}

/**
 * Mobile-specific sync hook that integrates with React Native storage
 */
export function useMobileSync(queryClient: QueryClient, enabled = true) {
	const [clientId, setClientId] = useState<string>("");
	const [serverUrl, setServerUrl] = useState<string>("");
	const [isInitialized, setIsInitialized] = useState(false);

	// Initialize client ID and server URL
	useEffect(() => {
		(async () => {
			const [id, url] = await Promise.all([
				getOrCreateMobileSyncClientId(),
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

	const syncStorage = useMemo(() => new ReactNativeSyncStorage(), []);

	const syncState = useSync({
		serverUrl,
		getAuthToken,
		clientId,
		queryClient,
		storage: syncStorage,
		enabled: enabled && isInitialized && !!serverUrl && !!clientId,
		itemCacheAdapter: storage,
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
export function useMobileClientId(): string {
	const [clientId, setClientId] = useState<string>("");

	useEffect(() => {
		getOrCreateMobileSyncClientId().then(setClientId);
	}, []);

	return clientId;
}
