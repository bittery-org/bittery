import type { SyncStorage } from "@bittery/sync";
import { generateClientId, useSync } from "@bittery/sync";
import type { QueryClient } from "@tanstack/react-query";
import * as SQLite from "expo-sqlite";
import { useCallback, useEffect, useMemo, useState } from "react";
import { storage } from "../services/storage";

/**
 * Storage key for client ID
 */
const CLIENT_ID_KEY = "bittery_sync_client_id";

/**
 * Get or initialize the sync database
 */
let syncDbInstance: SQLite.SQLiteDatabase | null = null;
async function getSyncDb(): Promise<SQLite.SQLiteDatabase> {
	if (!syncDbInstance) {
		syncDbInstance = await SQLite.openDatabaseAsync("bittery-sync.db");
		// Create sync storage table
		await syncDbInstance.execAsync(`
			CREATE TABLE IF NOT EXISTS sync_storage (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`);
	}
	return syncDbInstance;
}

/**
 * React Native-compatible sync storage implementation using SQLite
 */
class ReactNativeSyncStorage implements SyncStorage {
	async get<T>(key: string): Promise<T | null> {
		try {
			const db = await getSyncDb();
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
		const db = await getSyncDb();
		await db.runAsync(
			"INSERT OR REPLACE INTO sync_storage (key, value) VALUES (?, ?)",
			[key, JSON.stringify(value)],
		);
	}

	async remove(key: string): Promise<void> {
		const db = await getSyncDb();
		await db.runAsync("DELETE FROM sync_storage WHERE key = ?", [key]);
	}
}

/**
 * Get or create a unique client ID for this mobile device
 */
async function getOrCreateClientId(): Promise<string> {
	const db = await getSyncDb();
	const result = await db.getFirstAsync<{ value: string }>(
		"SELECT value FROM sync_storage WHERE key = ?",
		[CLIENT_ID_KEY],
	);

	if (result?.value) {
		return JSON.parse(result.value);
	}

	const clientId = generateClientId();
	await db.runAsync(
		"INSERT OR REPLACE INTO sync_storage (key, value) VALUES (?, ?)",
		[CLIENT_ID_KEY, JSON.stringify(clientId)],
	);
	return clientId;
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

	const syncStorage = useMemo(() => new ReactNativeSyncStorage(), []);

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
export function useMobileClientId(): string {
	const [clientId, setClientId] = useState<string>("");

	useEffect(() => {
		getOrCreateClientId().then(setClientId);
	}, []);

	return clientId;
}
