import type { AccountSessionManager } from "@bittery/core/services/account-session-manager";
import { createAccountSync } from "@bittery/core/services/account-sync";
import { AccountSyncLifecycle } from "@bittery/core/services/account-sync-lifecycle";
import type { SyncStorage } from "@bittery/sync";
import { useSync } from "@bittery/sync";
import type { QueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useToast } from "heroui-native";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { crypto } from "../lib/crypto";
import {
	getMobileSyncDb,
	getOrCreateMobileSyncClientId,
} from "../lib/sync-client-id";
import { useI18n } from "../providers/i18n-provider";
import { lifecycleDeps } from "../services/lifecycle";
import { vaultCrypto, vaultRepository } from "../services/vault-runtime";

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

	async update<T>(
		key: string,
		updater: (current: T | null) => T | null,
	): Promise<T | null> {
		const db = await getMobileSyncDb();
		let result: T | null = null;
		// The exclusive SQLite transaction owns coordination for every connection to this
		// database, not just calls made by this React hook instance.
		await db.withExclusiveTransactionAsync(async (transaction) => {
			const stored = await transaction.getFirstAsync<{ value: string }>(
				"SELECT value FROM sync_storage WHERE key = ?",
				[key],
			);
			let current: T | null = null;
			if (stored) {
				try {
					current = JSON.parse(stored.value) as T;
				} catch {
					current = null;
				}
			}
			result = updater(current);
			if (result === null) {
				await transaction.runAsync("DELETE FROM sync_storage WHERE key = ?", [
					key,
				]);
			} else {
				await transaction.runAsync(
					"INSERT OR REPLACE INTO sync_storage (key, value) VALUES (?, ?)",
					[key, JSON.stringify(result)],
				);
			}
		});
		return result;
	}
}

/**
 * Mobile-specific sync hook that integrates with React Native storage
 */
export function useMobileSync(
	queryClient: QueryClient,
	manager: AccountSessionManager,
	enabled = true,
) {
	const { m } = useI18n();
	const { toast } = useToast();
	const router = useRouter();
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
	const lifecycle = useMemo(
		() =>
			new AccountSyncLifecycle({
				resolveClientId: getOrCreateMobileSyncClientId,
				getActiveAccountId: () => manager.getActiveAccount(),
				subscribeAccountChanges: manager.subscribe,
				assemble: (input) => accountSync.assemble(input),
			}),
		[accountSync, manager],
	);
	useEffect(() => {
		lifecycle.start();
		return () => lifecycle.dispose();
	}, [lifecycle]);
	const {
		assembly,
		clientId,
		initialized: isInitialized,
	} = useSyncExternalStore(
		lifecycle.subscribe,
		lifecycle.getSnapshot,
		lifecycle.getSnapshot,
	);

	// Native account state may change while JavaScript is suspended.
	useEffect(() => {
		const subscription = AppState.addEventListener("change", (nextState) => {
			if (nextState === "active") void manager.refresh();
		});
		return () => subscription.remove();
	}, [manager]);

	const syncStorage = useMemo(() => new ReactNativeSyncStorage(), []);
	const onSessionRevoked = useCallback(
		async (payload: { sessionId: string }) => {
			const outcome = await accountSync.invalidateSession(payload);
			if (outcome.affected.length === 0) {
				return;
			}
			await queryClient.cancelQueries();
			queryClient.clear();
			lifecycle.clear();
			await manager.refresh();
			router.replace("/(auth)/login");
		},
		[accountSync, lifecycle, manager, queryClient, router],
	);
	const onTerminalCommandFailure = useCallback(() => {
		toast.show({
			variant: "danger",
			label: m.sync_command_terminal_error(),
			description: m.sync_command_terminal_error_description(),
			placement: "bottom",
		});
	}, [m, toast]);

	const syncState = useSync({
		clientId,
		queryClient,
		sources: assembly?.sources ?? [],
		storage: syncStorage,
		enabled: enabled && isInitialized && !!clientId && assembly !== null,
		realtimeEnabled: true,
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
