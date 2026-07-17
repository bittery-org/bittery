/**
 * useAllVaultKeys Hook
 *
 * Fetches all vault keys with account metadata from VaultRepositoryCoordinator.
 */

import type { VaultKeyData } from "@bittery/storage/types";
import { useMemo } from "react";
import { useVaultRepositorySync } from "./use-vault-repository-sync";

/**
 * Vault key with associated account metadata
 */
export interface VaultKeyWithAccount extends VaultKeyData {
	accountId: string;
	accountEmail?: string;
	accountName?: string;
	accountTeamName?: string;
	accountTeamAvatarUrl?: string | null;
}

export interface UseAllVaultKeysOptions {
	enabled?: boolean;
}

/**
 * Hook to fetch the active account's vault keys.
 *
 * This is the DEFAULT vault source powering the normal single-account vault
 * list and sidebar. It intentionally does NOT populate cross-account metadata
 * (`accountEmail`/`accountName`/...): the active-account view is never grouped
 * by account. For a view-mode-independent list of every unlocked account's
 * vaults (used by the item Move dialog to surface cross-account targets), use
 * `useMoveTargetVaults` instead.
 *
 * @param options - Query options
 * @returns Vault keys, loading state, and error
 *
 * @example
 * ```tsx
 * const { vaultKeys, isLoading } = useAllVaultKeys();
 *
 * vaultKeys.map(vault => (
 *   <VaultItem key={vault.vaultId} name={vault.vaultName} />
 * ))
 * ```
 */
export function useAllVaultKeys(options: UseAllVaultKeysOptions = {}) {
	const { accountsInfo, isLoading, snapshot, vaultCoordinator } =
		useVaultRepositorySync({
			enabled: options.enabled,
		});

	const vaultKeys = useMemo(() => {
		// Snapshot is an invalidation signal from the coordinator store.
		void snapshot;

		if (accountsInfo.length === 0) {
			return [] as VaultKeyWithAccount[];
		}

		return accountsInfo.flatMap((account) =>
			vaultCoordinator
				.getRepositoryForAccount(account.accountId)
				.getVaultKeys()
				.map((vaultKey) => ({
					...vaultKey,
					accountId: account.accountId,
					// Cross-account metadata is intentionally left undefined for the
					// single-account view. Consumers that need it (the Move dialog)
					// use `useMoveTargetVaults`.
					accountEmail: undefined,
					accountName: undefined,
					accountTeamName: undefined,
					accountTeamAvatarUrl: undefined,
				})),
		);
	}, [accountsInfo, snapshot, vaultCoordinator]);

	return {
		vaultKeys,
		isLoading,
		error: null,
	};
}
