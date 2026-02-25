import { getOrCreateVaultRepositoryCoordinator } from "@bittery/core";
import type { SyncStorage } from "@bittery/sync";
import { useSync } from "@bittery/sync";
import type { ICrypto } from "@bittery/types";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { storage } from "@/lib/storage";
import {
	getDesktopSyncStore,
	getOrCreateDesktopSyncClientId,
} from "@/lib/sync-client-id";
import * as tauriCrypto from "@/lib/tauri-crypto";

/**
 * Tauri-compatible sync storage implementation
 */
class TauriSyncStorage implements SyncStorage {
	async get<T>(key: string): Promise<T | null> {
		try {
			const store = await getDesktopSyncStore();
			const value = await store.get<string>(key);
			return value ? JSON.parse(value) : null;
		} catch {
			return null;
		}
	}

	async set<T>(key: string, value: T): Promise<void> {
		const store = await getDesktopSyncStore();
		await store.set(key, JSON.stringify(value));
		await store.save();
	}

	async remove(key: string): Promise<void> {
		const store = await getDesktopSyncStore();
		await store.delete(key);
		await store.save();
	}
}

const crypto: ICrypto = {
	decrypt: tauriCrypto.decrypt,
	encrypt: tauriCrypto.encrypt,
	rsaDecrypt: tauriCrypto.rsaDecrypt,
	generateEncryptionKey: tauriCrypto.generateEncryptionKey,
	deriveKeys: tauriCrypto.deriveKeys,
	generateClientEphemeral: tauriCrypto.generateClientEphemeral,
	deriveClientSession: tauriCrypto.deriveClientSession,
	verifyServerSession: tauriCrypto.verifyServerSession,
	validateSecretKey: tauriCrypto.validateSecretKey,
};

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
				getOrCreateDesktopSyncClientId(),
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
	const vaultCoordinator = useMemo(
		() => getOrCreateVaultRepositoryCoordinator(crypto, storage),
		[],
	);

	const syncState = useSync({
		serverUrl,
		getAuthToken,
		clientId,
		queryClient,
		storage: syncStorage,
		enabled: enabled && isInitialized && !!serverUrl && !!clientId,
		itemCacheAdapter: vaultCoordinator,
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
		getOrCreateDesktopSyncClientId().then(setClientId);
	}, []);

	return clientId;
}
