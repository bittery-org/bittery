import { useCoreContext, usePlatformCrypto } from "@bittery/core/hooks";
import { createVaultKeyRotationCeremony } from "@bittery/core/services/vault-key-rotation";
import { useApiClient } from "@bittery/shared/api";
import { useMemo } from "react";
import { storage } from "@/lib/storage";
import {
	createRotationLocalState,
	createWebRotationPlanClient,
} from "@/lib/vault-key-rotation-adapter";

export function useVaultKeyRotation() {
	const api = useApiClient();
	const crypto = usePlatformCrypto();
	const core = useCoreContext();

	return useMemo(() => {
		const localState = createRotationLocalState({
			getAccountId: () => storage.getActiveAccount(),
			getVaultKeys: (accountId) => storage.getVaultKeys(accountId),
			storeVaultKeys: (keys, accountId) =>
				storage.storeVaultKeys([...keys], accountId),
			removeCachedVault: (vaultId, accountId) =>
				core.vaultCoordinator
					.getRepositoryForAccount(accountId)
					.removeCachedVault(vaultId, accountId),
			refreshFromServer: async (accountId) => {
				const { accountsInfo } = await core.accounts.resolveAccounts(accountId);
				await core.vaultCoordinator.refreshFromServer(accountsInfo);
			},
		});
		return createVaultKeyRotationCeremony({
			crypto,
			openVaultKey: async (vaultId) => {
				const key = await core.vaultCrypto.getVaultKey({ vaultId });
				if (!key) throw new Error("vault_key_decrypt_failed");
				return key;
			},
			getMasterUnlockKey: () => storage.getMasterUnlockKey(),
			client: createWebRotationPlanClient(api, localState),
			onLock: (listener) => {
				let wasUnlocked = true;
				void storage.getActiveAccount().then(async (accountId) => {
					if (accountId)
						wasUnlocked = (await storage.getUnlockedAccounts()).includes(
							accountId,
						);
				});
				return storage.onUnlockStateChanged((unlocked) => {
					void storage.getActiveAccount().then((accountId) => {
						const isUnlocked = !!accountId && unlocked.includes(accountId);
						if (wasUnlocked && !isUnlocked) listener();
						wasUnlocked = isUnlocked;
					});
				});
			},
		});
	}, [api, core, crypto]);
}
