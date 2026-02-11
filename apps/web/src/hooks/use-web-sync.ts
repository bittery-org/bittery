import { getOrCreateClientId, type SyncStorage, useSync } from "@bittery/sync";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { storage } from "@/lib/storage";

/**
 * Get or create a unique client ID for this browser session
 */
function getClientId(): string {
	if (typeof window === "undefined") {
		return "server";
	}
	return getOrCreateClientId(window.localStorage);
}

class WebSyncStorage implements SyncStorage {
	private getStorageKey(key: string): string {
		return `bittery_sync_${key}`;
	}

	async get<T>(key: string): Promise<T | null> {
		if (typeof window === "undefined") {
			return null;
		}

		const value = window.localStorage.getItem(this.getStorageKey(key));
		if (!value) {
			return null;
		}

		try {
			return JSON.parse(value) as T;
		} catch {
			return null;
		}
	}

	async set<T>(key: string, value: T): Promise<void> {
		if (typeof window === "undefined") {
			return;
		}

		window.localStorage.setItem(this.getStorageKey(key), JSON.stringify(value));
	}

	async remove(key: string): Promise<void> {
		if (typeof window === "undefined") {
			return;
		}
		window.localStorage.removeItem(this.getStorageKey(key));
	}
}

/**
 * Web-specific sync hook that integrates with existing auth system
 */
export function useWebSync(queryClient: QueryClient, enabled = true) {
	const [serverUrl, setServerUrl] = useState("");
	const clientId = useMemo(() => getClientId(), []);
	const syncStorage = useMemo(() => new WebSyncStorage(), []);

	useEffect(() => {
		storage.getServerUrl().then((url) => setServerUrl(url || ""));
	}, []);

	const getAuthTokenAsync = useCallback(async () => {
		return (await storage.getAuthToken()) || null;
	}, []);

	return useSync({
		serverUrl,
		getAuthToken: getAuthTokenAsync,
		clientId,
		queryClient,
		storage: syncStorage,
		enabled: enabled && !!serverUrl,
		itemCacheAdapter: storage,
	});
}

/**
 * Get the client ID for use in mutations
 */
export function useSyncClientId(): string {
	return useMemo(() => getClientId(), []);
}
