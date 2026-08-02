import type { useRPCClient } from "@bittery/shared/rpc";
import { toVaultKeyEntry } from "@bittery/shared/vault-mapping";
import { storage } from "@/lib/storage";

export async function refreshVaultKeys(
	rpcClient: ReturnType<typeof useRPCClient>,
): Promise<void> {
	const vaultList = await rpcClient.vault.list.query();
	await storage.storeVaultKeys(vaultList.map(toVaultKeyEntry));
}
