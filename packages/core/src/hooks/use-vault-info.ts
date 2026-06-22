/**
 * useVaultInfo Hook
 *
 * Fetches vault metadata for a specific vault.
 * Automatically handles single-account vs multi-account mode.
 */

import type { VaultKeyData } from "@bittery/storage/types";
import { useMemo } from "react";
import { useVaultRepositorySync } from "./use-vault-repository-sync";

/**
 * Vault info with associated account metadata
 */
export interface VaultInfoWithAccount extends VaultKeyData {
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
	const { accountsInfo, isLoading, snapshot, vaultCoordinator } =
		useVaultRepositorySync({
			enabled: options.enabled,
			requiredId: vaultId,
		});

	const vaultInfo = useMemo<VaultInfoWithAccount | null>(() => {
		void snapshot;

		if (!vaultId || accountsInfo.length === 0) {
			return null;
		}

		for (const account of accountsInfo) {
			try {
				const repo = vaultCoordinator.getRepositoryForAccount(
					account.accountId,
				);
				const vaultKey = repo
					.getVaultKeys()
					.find((candidate) => candidate.vaultId === vaultId);
				if (!vaultKey) {
					continue;
				}

				return {
					...vaultKey,
					accountEmail: account.email,
					accountName: account.name,
					accountTeamName: account.teamName,
					accountTeamAvatarUrl: account.teamAvatarUrl,
				};
			} catch {}
		}

		return null;
	}, [accountsInfo, snapshot, vaultCoordinator, vaultId]);

	return {
		vaultInfo,
		isLoading,
		error: null,
	};
}
