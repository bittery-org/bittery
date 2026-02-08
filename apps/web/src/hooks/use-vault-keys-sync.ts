import { useTRPC } from "@bittery/shared/trpc";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { storage, type VaultKeyData } from "@/lib/storage";

/**
 * Hook that keeps sessionStorage vault keys in sync with the vault.list API data.
 *
 * When a new vault is created on another device, the sync system invalidates the vault.list query,
 * which triggers a refetch. This hook ensures that the new vault keys are stored in sessionStorage
 * so that item decryption can work properly.
 *
 * This hook should be used in a component that renders when the user is authenticated.
 */
export function useVaultKeysSync() {
	const trpc = useTRPC();

	const { data: vaults } = useQuery({
		...trpc.vault.list.queryOptions(),
		// Only run when authenticated (the query will fail without auth)
		retry: false,
	});

	useEffect(() => {
		if (!vaults || vaults.length === 0) return;

		// Map vault.list response to VaultKeyData format
		const vaultKeys: VaultKeyData[] = vaults.map((vault) => ({
			vaultId: vault.id,
			vaultName: vault.name,
			vaultType: vault.type,
			vaultIcon: vault.icon,
			vaultImageUrl: vault.imageUrl,
			encryptedVaultKey: vault.encryptedVaultKey,
			role: vault.role,
		}));

		// Update sessionStorage with the latest vault keys
		storage.storeVaultKeys(vaultKeys);
	}, [vaults]);
}
