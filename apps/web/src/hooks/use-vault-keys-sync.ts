import { useRPC, useRPCClient } from "@bittery/shared/rpc";
import { toVaultKeyEntry } from "@bittery/shared/vault-mapping";
import { useQuery } from "@tanstack/react-query";
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
	const rpc = useRPC();
	const rpcClient = useRPCClient();

	useQuery({
		...rpc.vault.list.queryOptions(),
		retry: false,
		queryFn: async () => {
			const vaults = await rpcClient.vault.list.query();
			if (vaults.length > 0) {
				const vaultKeys: VaultKeyData[] = vaults.map(toVaultKeyEntry);
				await storage.storeVaultKeys(vaultKeys);
			}
			return vaults;
		},
	});
}
