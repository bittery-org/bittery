import { getOrCreateVaultRepositoryCoordinator } from "@bittery/core";
import { createAccountTrpcClient } from "@bittery/shared/trpc-client-factory";
import type { OutboundQueueClient, SyncStorage } from "@bittery/sync";
import { useSync } from "@bittery/sync";
import type { ICrypto } from "@bittery/types";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	findAccountEmailBySessionId,
	invalidateDesktopAccountSession,
	isUnauthorizedTrpcError,
} from "@/lib/session-invalidation";
import { storage } from "@/lib/storage";
import {
	getDesktopSyncStore,
	getOrCreateDesktopSyncClientId,
} from "@/lib/sync-client-id";
import * as tauriCrypto from "@/lib/tauri-crypto";

interface SyncConnectionContext {
	email: string | null;
	serverUrl: string;
}

async function resolveDesktopSyncContext(): Promise<SyncConnectionContext | null> {
	const [activeAccount, accounts, unlocked] = await Promise.all([
		storage.getActiveAccount(),
		storage.getAccountsList(),
		storage.getUnlockedAccounts?.(),
	]);

	const candidates: string[] = [];
	if (activeAccount?.type === "single") {
		candidates.push(activeAccount.email.toLowerCase());
	} else if (activeAccount?.type === "all") {
		for (const email of unlocked ?? []) {
			const normalized = email.toLowerCase();
			if (!candidates.includes(normalized)) {
				candidates.push(normalized);
			}
		}
	}

	for (const account of accounts) {
		const normalized = account.email.toLowerCase();
		if (!candidates.includes(normalized)) {
			candidates.push(normalized);
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
	generateUuid: tauriCrypto.generateUuid,
	deriveKeys: tauriCrypto.deriveKeys,
	generateClientEphemeral: tauriCrypto.generateClientEphemeral,
	deriveClientSession: tauriCrypto.deriveClientSession,
	verifyServerSession: tauriCrypto.verifyServerSession,
	validateSecretKey: tauriCrypto.validateSecretKey,
	validateServerKdfParams: tauriCrypto.validateServerKdfParams,
};

/**
 * Desktop-specific sync hook that integrates with Tauri storage
 */
export function useDesktopSync(queryClient: QueryClient, enabled = true) {
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
					getOrCreateDesktopSyncClientId(),
					resolveDesktopSyncContext(),
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

	const getClientForAccount = useCallback(
		async (email: string): Promise<OutboundQueueClient> => {
			const normalizedEmail = email.toLowerCase();
			const [accountToken, accountServerUrl] = await Promise.all([
				storage.getAuthToken(normalizedEmail),
				storage.getServerUrl(normalizedEmail),
			]);
			if (accountToken) {
				return createAccountTrpcClient(
					accountToken,
					accountServerUrl || serverUrl || "http://localhost:3000",
				) as unknown as OutboundQueueClient;
			}

			const fallbackToken = await getAuthToken();
			if (!fallbackToken) {
				throw new Error(
					`No auth token available for account queue drain (${normalizedEmail})`,
				);
			}
			return createAccountTrpcClient(
				fallbackToken,
				serverUrl || "http://localhost:3000",
			) as unknown as OutboundQueueClient;
		},
		[getAuthToken, serverUrl],
	);

	const handleAccountSessionInvalidation = useCallback(
		async (email: string) => {
			const normalizedEmail = email.toLowerCase();
			await invalidateDesktopAccountSession(normalizedEmail);
			await queryClient.cancelQueries();
			queryClient.clear();

			const activeAccount = await storage.getActiveAccount();
			if (
				activeAccount?.type === "single" &&
				activeAccount.email.toLowerCase() === normalizedEmail
			) {
				window.location.href = `/unlock?email=${encodeURIComponent(normalizedEmail)}`;
				return;
			}

			if (activeAccount?.type === "all") {
				const unlockedAccounts = await storage.getUnlockedAccounts?.();
				if (!unlockedAccounts || unlockedAccounts.length === 0) {
					window.location.href = "/unlock";
				}
			}
		},
		[queryClient],
	);

	const onSessionRevoked = useCallback(
		async (payload: { sessionId: string }) => {
			const revokedEmail = await findAccountEmailBySessionId(payload.sessionId);
			if (!revokedEmail) {
				return;
			}

			await handleAccountSessionInvalidation(revokedEmail);
			if (syncAccountEmail?.toLowerCase() === revokedEmail.toLowerCase()) {
				setSyncAccountEmail(null);
			}
		},
		[handleAccountSessionInvalidation, syncAccountEmail],
	);

	// Revalidate persisted sessions on startup/interval when online.
	// This catches revoked sessions even if the app was closed at revocation time.
	useEffect(() => {
		if (!enabled || !isInitialized) {
			return;
		}

		let cancelled = false;

		const revalidateSessions = async () => {
			if (typeof navigator !== "undefined" && !navigator.onLine) {
				return;
			}

			const accounts = await storage.getAccountsList();
			for (const account of accounts) {
				if (cancelled) {
					return;
				}

				const email = account.email.toLowerCase();
				const [token, url, sessionData] = await Promise.all([
					storage.getAuthToken(email),
					storage.getServerUrl(email),
					storage.getStoredSessionData(email),
				]);

				if (!token || !url || !sessionData?.sessionId) {
					continue;
				}

				try {
					await createAccountTrpcClient(token, url).auth.me.query();
				} catch (error) {
					if (!isUnauthorizedTrpcError(error)) {
						continue;
					}

					await handleAccountSessionInvalidation(email);
					if (syncAccountEmail?.toLowerCase() === email) {
						setSyncAccountEmail(null);
					}
				}
			}
		};

		void revalidateSessions();
		const interval = setInterval(() => {
			void revalidateSessions();
		}, 30_000);

		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [
		enabled,
		handleAccountSessionInvalidation,
		isInitialized,
		syncAccountEmail,
	]);

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
		itemCacheAccountEmail: syncAccountEmail,
		itemCacheServerUrl: syncAccountEmail ? serverUrl : null,
		getClientForAccount,
		onSessionRevoked,
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
