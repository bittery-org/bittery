import { isUnauthorizedApiError } from "@bittery/api-contract";
import type { LifecycleOutcome } from "@bittery/core/services/account-lifecycle";
import type { AccountSessionManager } from "@bittery/core/services/account-session-manager";
import {
	type AccountSyncAssembly,
	createAccountSync,
} from "@bittery/core/services/account-sync";
import type { AccountVaultRuntime } from "@bittery/core/services/account-vault-runtime";
import { createAccountApiClient } from "@bittery/shared/api-client-factory";
import type { SyncStorage } from "@bittery/sync";
import { useSync } from "@bittery/sync";
import { toast } from "@bittery/ui";
import type { QueryClient } from "@tanstack/react-query";
import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";
import { crypto } from "@/lib/crypto";
import { lifecycleDeps } from "@/lib/lifecycle";
import { storage } from "@/lib/storage";
import {
	getDesktopSyncStore,
	getOrCreateDesktopSyncClientId,
} from "@/lib/sync-client-id";
import { vaultCrypto, vaultRepository } from "@/lib/vault-runtime";
import { useI18n } from "@/providers/i18n-provider";

// Desktop currently has one renderer. This tail coordinates every SyncStorage instance in
// that process; the Tauri store write and save stay inside the same critical section.
let desktopSyncUpdateTail: Promise<void> = Promise.resolve();

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

	async update<T>(
		key: string,
		updater: (current: T | null) => T | null,
	): Promise<T | null> {
		let result: T | null = null;
		const update = desktopSyncUpdateTail.then(async () => {
			const store = await getDesktopSyncStore();
			const stored = await store.get<string>(key);
			let current: T | null = null;
			if (stored) {
				try {
					current = JSON.parse(stored) as T;
				} catch {
					current = null;
				}
			}
			result = updater(current);
			if (result === null) {
				await store.delete(key);
			} else {
				await store.set(key, JSON.stringify(result));
			}
			await store.save();
		});
		desktopSyncUpdateTail = update.catch(() => undefined);
		await update;
		return result;
	}
}

const SESSION_REVALIDATION_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Desktop-specific sync hook that integrates with Tauri storage
 */
export function useDesktopSync(
	queryClient: QueryClient,
	manager: AccountSessionManager,
	vaultRuntime: AccountVaultRuntime,
	enabled = true,
) {
	const { m } = useI18n();
	const [clientId, setClientId] = useState<string>("");
	const [assembly, setAssembly] = useState<AccountSyncAssembly | null>(null);
	const [isInitialized, setIsInitialized] = useState(false);
	const accountSync = useMemo(
		() =>
			createAccountSync({
				lifecycle: lifecycleDeps,
				vaultRepository,
				crypto,
				vaultCrypto,
			}),
		[],
	);

	useSyncExternalStore(
		vaultRuntime.subscribe,
		vaultRuntime.getSnapshot,
		vaultRuntime.getSnapshot,
	);
	const accountRevision = useSyncExternalStore(
		manager.subscribe,
		manager.getSnapshot,
		manager.getSnapshot,
	);
	const activeAccountId = manager.getActiveAccount();

	// Client identity is process-stable; account changes drive assembly separately.
	useEffect(() => {
		let mounted = true;
		void getOrCreateDesktopSyncClientId().then((id) => {
			if (mounted) setClientId(id);
		});

		return () => {
			mounted = false;
		};
	}, []);

	// Generation cancellation prevents a slow A→B assembly from overwriting B→A.
	useEffect(() => {
		void accountRevision;
		if (!clientId) return;
		let current = true;
		setIsInitialized(false);
		void accountSync
			.assemble({ clientId, activeAccountId })
			.then((resolved) => {
				if (!current) return;
				setAssembly(resolved);
				setIsInitialized(true);
			});
		return () => {
			current = false;
		};
	}, [accountSync, accountRevision, activeAccountId, clientId]);

	/** The UI half of an invalidation; the record half already happened in core. */
	const applyInvalidatedSession = useCallback(
		async (outcome: LifecycleOutcome) => {
			const invalidated = outcome.affected[0];
			if (!invalidated) {
				return null;
			}

			await queryClient.cancelQueries();
			queryClient.clear();

			if (outcome.wasActive) {
				window.location.href = "/unlock";
			}
			return invalidated;
		},
		[queryClient],
	);

	const handleAccountSessionInvalidation = useCallback(
		async (sessionId: string) => {
			await applyInvalidatedSession(
				await accountSync.invalidateSession({ sessionId }),
			);
			setAssembly(null);
		},
		[accountSync, applyInvalidatedSession],
	);

	const onSessionRevoked = useCallback(
		async (payload: { sessionId: string }) => {
			const revoked = await applyInvalidatedSession(
				await accountSync.invalidateSession(payload),
			);
			if (!revoked) {
				return;
			}
			setAssembly(null);
		},
		[accountSync, applyInvalidatedSession],
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

				const [token, url, sessionData] = await Promise.all([
					storage.getAuthToken(account.accountId),
					storage.getServerUrl(account.accountId),
					storage.getStoredSessionData(account.accountId),
				]);

				if (!token || !url || !sessionData?.sessionId) {
					continue;
				}

				try {
					await createAccountApiClient(token, url, undefined, undefined, {
						insecureTransportConfirmed:
							account.insecureTransportConfirmed === true,
					}).auth.me();
				} catch (error) {
					if (!isUnauthorizedApiError(error)) {
						continue;
					}

					await handleAccountSessionInvalidation(sessionData.sessionId);
				}
			}
		};

		void revalidateSessions();
		const interval = setInterval(() => {
			void revalidateSessions();
		}, SESSION_REVALIDATION_INTERVAL_MS);

		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [enabled, handleAccountSessionInvalidation, isInitialized]);

	const syncStorage = useMemo(() => new TauriSyncStorage(), []);
	const onTerminalCommandFailure = useCallback(() => {
		toast.error(m.sync_command_terminal_error(), {
			description: m.sync_command_terminal_error_description(),
		});
	}, [m]);

	const syncState = useSync({
		clientId,
		queryClient,
		sources: assembly?.sources ?? [],
		storage: syncStorage,
		enabled: enabled && isInitialized && !!clientId && assembly !== null,
		replicaStore: assembly?.replicaStore,
		commandProjection: assembly?.commandProjection,
		semanticCommandExecutor: assembly?.semanticCommandExecutor,
		getClientForAccount: assembly?.getClientForAccount,
		onSessionRevoked,
		onEventProcessed: assembly?.onEventProcessed,
		onTerminalCommandFailure,
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
