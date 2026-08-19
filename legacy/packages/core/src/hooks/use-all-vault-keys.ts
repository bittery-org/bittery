/**
 * useAllVaultKeys Hook
 *
 * Fetches all vault keys with account metadata from VaultRepository.
 */

import type { VaultKeyData } from "@bittery/storage/types";
import { useMemo } from "react";
import { useVaultRepositoryState } from "./use-vault-repository-state";

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
	const { accountsInfo, isLoading, error, snapshot, vaultRepository } =
		useVaultRepositoryState({
			enabled: options.enabled,
		});

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
				// Cross-account metadata is intentionally left undefined for the
				// single-account view. Consumers that need it (the Move dialog)
				// use `useMoveTargetVaults`.
				accountEmail: undefined,
				accountName: undefined,
				accountTeamName: undefined,
				accountTeamAvatarUrl: undefined,
			})),
		);
	}, [accountsInfo, snapshot, vaultRepository]);

	return {
		vaultKeys,
		isLoading,
		error,
	};
}
