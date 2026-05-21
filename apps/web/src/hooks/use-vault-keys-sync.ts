import { useRPC } from "@bittery/shared/rpc";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { storage, type VaultKeyData } from "@/lib/storage";
import { normalizeVaultListEntry } from "@/lib/rpc-normalizers";

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
	const rpc = useRPC();

	const { data: vaults } = useQuery({
		...rpc.vault.list.queryOptions(),
		retry: false,
	});

	useEffect(() => {
		if (!vaults || vaults.length === 0) return;

		// Map vault.list response to VaultKeyData format
		const vaultKeys: VaultKeyData[] = vaults.map(normalizeVaultListEntry);

		// Update sessionStorage with the latest vault keys
		storage.storeVaultKeys(vaultKeys);
	}, [vaults]);
}
