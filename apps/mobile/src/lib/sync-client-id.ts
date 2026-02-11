import { generateClientId } from "@bittery/sync";
import * as SQLite from "expo-sqlite";

export const MOBILE_SYNC_CLIENT_ID_KEY = "bittery_sync_client_id";

let syncDbInstance: SQLite.SQLiteDatabase | null = null;

export async function getMobileSyncDb(): Promise<SQLite.SQLiteDatabase> {
	if (!syncDbInstance) {
		syncDbInstance = await SQLite.openDatabaseAsync("bittery-sync.db");
		await syncDbInstance.execAsync(`
			CREATE TABLE IF NOT EXISTS sync_storage (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`);
	}
	return syncDbInstance;
}

export async function getOrCreateMobileSyncClientId(): Promise<string> {
	const db = await getMobileSyncDb();
	const result = await db.getFirstAsync<{ value: string }>(
		"SELECT value FROM sync_storage WHERE key = ?",
		[MOBILE_SYNC_CLIENT_ID_KEY],
	);

	if (result?.value) {
		const existing = JSON.parse(result.value);
		(
			globalThis as { __BITTERY_SYNC_CLIENT_ID__?: string }
		).__BITTERY_SYNC_CLIENT_ID__ = existing;
		return existing;
	}

	const clientId = generateClientId();
	await db.runAsync(
		"INSERT OR REPLACE INTO sync_storage (key, value) VALUES (?, ?)",
		[MOBILE_SYNC_CLIENT_ID_KEY, JSON.stringify(clientId)],
	);
	(
		globalThis as { __BITTERY_SYNC_CLIENT_ID__?: string }
	).__BITTERY_SYNC_CLIENT_ID__ = clientId;
	return clientId;
}
