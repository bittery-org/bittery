/**
 * useVaultInfo Hook
 *
 * Fetches vault metadata for a specific vault.
 * Automatically handles single-account vs multi-account mode.
 */

import type { VaultKeyData } from "@bittery/storage/types";
import { useMemo } from "react";
import { useVaultRepositoryState } from "./use-vault-repository-state";

/**
 * Vault info with associated account metadata
 */
export interface VaultInfoWithAccount extends VaultKeyData {
	accountId: string;
	accountEmail?: string;
	accountName?: string;
	accountTeamName?: string;
	accountTeamAvatarUrl?: string | null;
}

export interface UseVaultInfoOptions {
	enabled?: boolean;
}

/**
 * Hook to get vault information from local repositories.
 * Automatically handles single-account vs "All Accounts" mode.
 *
 * @param vaultId - The ID of the vault to get info for
 * @param options - Query options
 * @returns Vault key data with account metadata, loading state, and error
 *
 * @example
 * ```tsx
 * const { vaultInfo, isLoading } = useVaultInfo(vaultId);
 *
 * if (vaultInfo) {
 *   console.log('Vault name:', vaultInfo.vaultName);
 *   console.log('Role:', vaultInfo.role);
 *   console.log('Team:', vaultInfo.accountTeamName);
 * }
 * ```
 */
export function useVaultInfo(
	vaultId: string,
	options: UseVaultInfoOptions = {},
) {
	const { accountsInfo, isLoading, error, snapshot, vaultRepository } =
		useVaultRepositoryState({
			enabled: options.enabled,
		});

	const vaultInfo = useMemo<VaultInfoWithAccount | null>(() => {
		void snapshot;

		if (!vaultId || accountsInfo.length === 0) {
			return null;
		}

		for (const account of accountsInfo) {
			const vaultKey = vaultRepository
				.getVaultKeys(account.accountId)
				.find((candidate) => candidate.vaultId === vaultId);
			if (!vaultKey) continue;

			return {
				...vaultKey,
				accountId: account.accountId,
				accountEmail: account.email,
				accountName: account.name,
				accountTeamName: account.teamName,
				accountTeamAvatarUrl: account.teamAvatarUrl,
			};
		}

		return null;
	}, [accountsInfo, snapshot, vaultRepository, vaultId]);

	return {
		vaultInfo,
		isLoading,
		error,
	};
}
