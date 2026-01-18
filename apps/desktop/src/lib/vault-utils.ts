import * as tauriStorage from "@bittery/crypto/storage-tauri";
import type { useTRPCClient } from "@bittery/shared/trpc";

export async function refreshVaultKeys(
  trpcClient: ReturnType<typeof useTRPCClient>,
): Promise<void> {
  const vaultList = await trpcClient.vault.list.query();
  await tauriStorage.storeVaultKeys(
    vaultList.map((v) => ({
      vaultId: v.id,
      vaultName: v.name,
      vaultType: v.type,
      vaultIcon: v.icon,
      vaultImageUrl: v.imageUrl,
      encryptedVaultKey: v.encryptedVaultKey,
      role: v.role,
    })),
  );
}
