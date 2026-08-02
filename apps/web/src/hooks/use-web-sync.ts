import { getOrCreateVaultRepositoryCoordinator } from "@bittery/core";
import { getOrCreateClientId, type SyncStorage, useSync } from "@bittery/sync";
import type { ICrypto } from "@bittery/types";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { getServerUrl } from "@/lib/auth-server";
import {
	forgetActiveSession,
	getActiveAccountIdSnapshot,
	initializeStorage,
	itemCache,
	storage,
	subscribeActiveAccountId,
} from "@/lib/storage";
import * as wasmCrypto from "@/lib/wasm-crypto";

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

const crypto: ICrypto = {
	decrypt: wasmCrypto.decrypt,
	encrypt: wasmCrypto.encrypt,
	rsaDecrypt: wasmCrypto.rsaDecrypt,
	generateEncryptionKey: wasmCrypto.generateEncryptionKey,
	generateUuid: wasmCrypto.generateUuid,
	deriveKeys: wasmCrypto.deriveKeys,
	generateClientEphemeral: wasmCrypto.generateClientEphemeralAsync,
	deriveClientSession: wasmCrypto.deriveClientSession,
	verifyServerSession: wasmCrypto.verifyServerSession,
	validateSecretKey: wasmCrypto.validateSecretKeyAsync,
};

/**
 * Web-specific sync hook that integrates with existing auth system
 */
export function useWebSync(queryClient: QueryClient, enabled = true) {
	const serverUrl = getServerUrl();
	const clientId = useMemo(() => getClientId(), []);
	const syncStorage = useMemo(() => new WebSyncStorage(), []);
	const vaultCoordinator = useMemo(
		() => getOrCreateVaultRepositoryCoordinator(crypto, storage, itemCache),
		[],
	);

	/**
	 * The accountId the item cache is namespaced under. `ItemCache` requires a real
	 * accountId for every call, so it is read from the live active-account snapshot
	 * instead of `null`. The snapshot is refreshed whenever the unlocked set changes
	 * and explicitly after a login.
	 */
	const syncAccountId = useSyncExternalStore(
		subscribeActiveAccountId,
		getActiveAccountIdSnapshot,
		getActiveAccountIdSnapshot,
	);

	const getAuthTokenAsync = useCallback(async () => {
		await initializeStorage();
		return (await storage.getAuthToken()) || null;
	}, []);

	const onSessionRevoked = useCallback(async () => {
		// Server-side revocation is a sign-out, not a lock: the quick-unlock prompt must
		// not reappear for a session the server has already killed.
		await forgetActiveSession();
		queryClient.clear();

		if (
			typeof window !== "undefined" &&
			window.location.pathname !== "/login"
		) {
			window.location.href = "/login";
		}
	}, [queryClient]);
	const resolveLegacyAccountId = useCallback(async (email: string) => {
		await initializeStorage();
		const matches = (await storage.getAccountsList()).filter(
			(account) => account.email.toLowerCase() === email.toLowerCase(),
		);
		if (matches.length !== 1)
			throw new Error(`Ambiguous legacy account queue for ${email}`);
		return matches[0]?.accountId;
	}, []);

	return useSync({
		serverUrl,
		getAuthToken: getAuthTokenAsync,
		clientId,
		queryClient,
		storage: syncStorage,
		enabled,
		itemCacheAdapter: vaultCoordinator,
		itemCacheAccountId: syncAccountId,
		resolveLegacyAccountId,
		onSessionRevoked,
	});
}

/**
 * Get the client ID for use in mutations
 */
export function useSyncClientId(): string {
	return useMemo(() => getClientId(), []);
}
