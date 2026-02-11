import type { SyncStorage } from "@bittery/sync";
import { useSync } from "@bittery/sync";
import type { QueryClient } from "@tanstack/react-query";
import { fetch as expoFetch } from "expo/fetch";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	getMobileSyncDb,
	getOrCreateMobileSyncClientId,
} from "../lib/sync-client-id";
import { storage } from "../services/storage";

interface SyncConnectionContext {
	email: string | null;
	serverUrl: string;
}

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
 * Resolve the best available account-scoped sync context.
 * In multi-account mode we prefer the active single account first, then fall
 * back to other known accounts.
 */
async function resolveMobileSyncContext(): Promise<SyncConnectionContext | null> {
	const activeAccount = await storage.getActiveAccount();
	const accounts = await storage.getAccountsList();

	const candidates: string[] = [];
	if (activeAccount?.type === "single") {
		candidates.push(activeAccount.email.toLowerCase());
	}
	for (const account of accounts) {
		const email = account.email.toLowerCase();
		if (!candidates.includes(email)) {
			candidates.push(email);
		}
	}

	for (const email of candidates) {
		const [token, url] = await Promise.all([
			storage.getAuthToken(email),
			storage.getServerUrl(email),
		]);
		if (token && url) {
			return { email, serverUrl: url };
		}
	}

	// Backward-compatible fallback for legacy/global single-account data.
	const [fallbackToken, fallbackUrl] = await Promise.all([
		storage.getAuthToken(),
		storage.getServerUrl(),
	]);
	if (fallbackToken && fallbackUrl) {
		return { email: null, serverUrl: fallbackUrl };
	}

	return null;
}

/**
 * Mobile-specific sync hook that integrates with React Native storage
 */
export function useMobileSync(queryClient: QueryClient, enabled = true) {
	const [clientId, setClientId] = useState<string>("");
	const [serverUrl, setServerUrl] = useState<string>("");
	const [syncAccountEmail, setSyncAccountEmail] = useState<string | null>(null);
	const [isInitialized, setIsInitialized] = useState(false);

	// Initialize and keep sync connection context fresh.
	useEffect(() => {
		let mounted = true;
		let resolving = false;

		const resolveContext = async () => {
			if (resolving) {
				return;
			}
			resolving = true;
			try {
				const [id, context] = await Promise.all([
					getOrCreateMobileSyncClientId(),
					resolveMobileSyncContext(),
				]);
				if (!mounted) {
					return;
				}
				setClientId(id);
				setServerUrl(context?.serverUrl ?? "");
				setSyncAccountEmail(context?.email ?? null);
				setIsInitialized(true);
			} finally {
				resolving = false;
			}
		};

		void resolveContext();
		const interval = setInterval(() => {
			void resolveContext();
		}, 5000);

		return () => {
			mounted = false;
			clearInterval(interval);
		};
	}, []);

	const getAuthToken = useCallback(async () => {
		return storage.getAuthToken(syncAccountEmail ?? undefined);
	}, [syncAccountEmail]);

	const syncStorage = useMemo(() => new ReactNativeSyncStorage(), []);

	const syncState = useSync({
		serverUrl,
		getAuthToken,
		clientId,
		queryClient,
		storage: syncStorage,
		enabled: enabled && isInitialized && !!serverUrl && !!clientId,
		realtimeEnabled: true,
		itemCacheAdapter: storage,
		itemCacheAccountEmail: syncAccountEmail,
		// RN fallback: periodically run catch-up in case SSE stream stalls on device.
		catchUpIntervalMs: 15000,
		fetch: expoFetch,
	});

	useEffect(() => {
		if (!__DEV__) {
			return;
		}
		console.log("[mobile-sync] status", {
			connectionStatus: syncState.status.connectionStatus,
			isConnected: syncState.isConnected,
			clientId,
			serverUrl,
			syncAccountEmail,
		});
	}, [
		syncState.status.connectionStatus,
		syncState.isConnected,
		clientId,
		serverUrl,
		syncAccountEmail,
	]);

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
