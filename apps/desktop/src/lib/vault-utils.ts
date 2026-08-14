import type { ApiClient } from "@bittery/api-contract";
import { toVaultKeyEntry } from "@bittery/shared/vault-mapping";
import { storage } from "@/lib/storage";

export async function refreshVaultKeys(apiClient: ApiClient): Promise<void> {
	const { data: vaultList } = await apiClient.vaults.list();
	await storage.storeVaultKeys(
		vaultList.map((vault) =>
			toVaultKeyEntry({
				...vault,
				icon: vault.icon ?? null,
				imageUrl: vault.imageUrl ?? null,
			}),
		),
	);
}
