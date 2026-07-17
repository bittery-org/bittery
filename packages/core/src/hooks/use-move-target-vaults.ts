/**
 * useMoveTargetVaults Hook
 *
 * View-mode-independent source of vault keys for the item Move dialog. Returns
 * the vault keys of EVERY currently-unlocked account (always populated with
 * account metadata), so the dialog can surface cross-account move targets while
 * a single account stays active.
 *
 * This deliberately does not touch the coordinator's active-account set, so the
 * normal single-account vault list / sidebar (see `useAllVaultKeys`) is
 * unaffected.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useCoreContext } from "../context/platform-context";
import type { VaultKeyWithAccount } from "./use-all-vault-keys";

export interface UseMoveTargetVaultsOptions {
	enabled?: boolean;
}

export function useMoveTargetVaults(options: UseMoveTargetVaultsOptions = {}) {
	const core = useCoreContext();
	const { enabled = true } = options;

	const { data: accountsInfo = [], isLoading } = useQuery({
		queryKey: ["move-target-vaults", "unlocked-accounts"],
		queryFn: () => core.accounts.resolveUnlockedAccounts(),
		enabled,
		staleTime: 0,
		// AccountInfo carries a live RPC client (a Proxy), which is not
		// JSON-serializable. Disable structural sharing to avoid throwing on it.
		structuralSharing: false,
	});

	// Hydrating repositories is an async side effect keyed off resolved account
	// data, so an effect is the appropriate tool here (mirrors
	// useVaultRepositorySync). It does not change the active-account set.
	useEffect(() => {
		if (!enabled || accountsInfo.length === 0) {
			return;
		}
		core.vaultCoordinator.hydrateAccountRepos(accountsInfo).catch((error) => {
			console.error("[useMoveTargetVaults] hydrate failed:", error);
		});
	}, [core.vaultCoordinator, enabled, accountsInfo]);

	const snapshot = useSyncExternalStore(
		core.vaultCoordinator.subscribe,
		core.vaultCoordinator.getSnapshot,
		core.vaultCoordinator.getSnapshot,
	);

	const vaultKeys = useMemo(() => {
		// Snapshot is an invalidation signal from the coordinator store.
		void snapshot;

		if (accountsInfo.length === 0) {
			return [] as VaultKeyWithAccount[];
		}

		return accountsInfo.flatMap((account) =>
			core.vaultCoordinator
				.getRepositoryForAccount(account.accountId)
				.getVaultKeys()
				.map((vaultKey) => ({
					...vaultKey,
					accountId: account.accountId,
					accountEmail: account.email,
					accountName: account.name,
					accountTeamName: account.teamName,
					accountTeamAvatarUrl: account.teamAvatarUrl,
				})),
		);
	}, [accountsInfo, snapshot, core.vaultCoordinator]);

	return {
		vaultKeys,
		isLoading,
		error: null,
	};
}
