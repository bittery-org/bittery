/**
 * useMoveTargetVaults Hook
 *
 * View-mode-independent source of vault keys for the item Move dialog. Returns
 * the vault keys of EVERY currently-unlocked account (always populated with
 * account metadata), so the dialog can surface cross-account move targets while
 * a single account stays active.
 *
 * This deliberately does not touch the repository's active-account set, so the
 * normal single-account vault list / sidebar (see `useAllVaultKeys`) is
 * unaffected.
 */

import { useMemo } from "react";
import type { VaultKeyWithAccount } from "./use-all-vault-keys";
import { useVaultRepositoryState } from "./use-vault-repository-state";

export interface UseMoveTargetVaultsOptions {
	enabled?: boolean;
}

export function useMoveTargetVaults(options: UseMoveTargetVaultsOptions = {}) {
	const {
		isLoading,
		error,
		snapshot,
		vaultRepository,
		unlockedAccountsInfo: accountsInfo,
	} = useVaultRepositoryState(options);

	const vaultKeys = useMemo(() => {
		// Snapshot is an invalidation signal from the repository.
		void snapshot;

		if (accountsInfo.length === 0) {
			return [] as VaultKeyWithAccount[];
		}

		return accountsInfo.flatMap((account) =>
			vaultRepository.getVaultKeys(account.accountId).map((vaultKey) => ({
				...vaultKey,
				accountId: account.accountId,
				accountEmail: account.email,
				accountName: account.name,
				accountTeamName: account.teamName,
				accountTeamAvatarUrl: account.teamAvatarUrl,
			})),
		);
	}, [accountsInfo, snapshot, vaultRepository]);

	return {
		vaultKeys,
		isLoading,
		error,
	};
}
