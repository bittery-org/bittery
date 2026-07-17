import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useCoreContext } from "../context/platform-context";
import type { VaultRepositoryCoordinator } from "../services/vault-repository-coordinator";
import { useAccountsInfo } from "./use-accounts-info";

export interface UseVaultRepositorySyncOptions {
	enabled?: boolean;
	requiredId?: string;
}

interface UseVaultRepositorySyncResult {
	snapshot: number;
	isLoading: boolean;
	refetch: () => Promise<void>;
	accountsInfo: ReturnType<typeof useAccountsInfo>["accountsInfo"];
	vaultCoordinator: VaultRepositoryCoordinator;
}

export function useVaultRepositorySync(
	options: UseVaultRepositorySyncOptions = {},
): UseVaultRepositorySyncResult {
	const core = useCoreContext();
	const { enabled = true, requiredId } = options;
	const { accountsInfo, isLoading: isLoadingAccounts } = useAccountsInfo({
		enabled,
	});

	useEffect(() => {
		if (!enabled || isLoadingAccounts || accountsInfo.length === 0) {
			return;
		}
		if (typeof requiredId !== "undefined" && !requiredId) {
			return;
		}
		core.vaultCoordinator.hydrate(accountsInfo).catch((error) => {
			console.error("[useVaultRepositorySync] hydrate failed:", error);
		});
	}, [
		core.vaultCoordinator,
		enabled,
		isLoadingAccounts,
		accountsInfo,
		requiredId,
	]);

	const snapshot = useSyncExternalStore(
		core.vaultCoordinator.subscribe,
		core.vaultCoordinator.getSnapshot,
		core.vaultCoordinator.getSnapshot,
	);

	const refetch = useCallback(async () => {
		if (accountsInfo.length === 0) {
			return;
		}
		await core.vaultCoordinator.refreshFromServer(accountsInfo);
	}, [core.vaultCoordinator, accountsInfo]);

	return {
		snapshot,
		isLoading: isLoadingAccounts || core.vaultCoordinator.isHydrating(),
		refetch,
		accountsInfo,
		vaultCoordinator: core.vaultCoordinator,
	};
}
