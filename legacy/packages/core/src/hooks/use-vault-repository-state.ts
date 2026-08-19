import { useSyncExternalStore } from "react";
import { useCoreContext } from "../context/platform-context";
import type { VaultRepository } from "../services/vault-repository";

export interface UseVaultRepositoryStateOptions {
	enabled?: boolean;
}

export interface UseVaultRepositoryStateResult {
	snapshot: number;
	isLoading: boolean;
	error: Error | null;
	refetch: () => Promise<void>;
	accountsInfo: ReturnType<
		ReturnType<typeof useCoreContext>["vaultRuntime"]["getSnapshot"]
	>["accounts"];
	unlockedAccountsInfo: ReturnType<
		ReturnType<typeof useCoreContext>["vaultRuntime"]["getSnapshot"]
	>["unlockedAccounts"];
	vaultRepository: VaultRepository;
	enabled: boolean;
}

/** Passive React selector over the framework-free account Vault runtime. */
export function useVaultRepositoryState(
	options: UseVaultRepositoryStateOptions = {},
): UseVaultRepositoryStateResult {
	const { vaultRuntime, vaultRepository, refreshActiveVaults } =
		useCoreContext();
	const state = useSyncExternalStore(
		vaultRuntime.subscribe,
		vaultRuntime.getSnapshot,
		vaultRuntime.getSnapshot,
	);
	const repositorySnapshot = useSyncExternalStore(
		vaultRepository.subscribe,
		vaultRepository.getSnapshot,
		vaultRepository.getSnapshot,
	);
	const enabled = options.enabled !== false;
	return {
		snapshot: repositorySnapshot,
		isLoading: enabled && state.isLoading,
		error: enabled ? state.error : null,
		refetch: enabled ? refreshActiveVaults : async () => {},
		accountsInfo: enabled ? state.accounts : [],
		unlockedAccountsInfo: enabled ? state.unlockedAccounts : [],
		vaultRepository,
		enabled,
	};
}
