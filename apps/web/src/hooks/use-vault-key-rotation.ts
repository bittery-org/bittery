import { useCoreContext, usePlatformCrypto } from "@bittery/core/hooks";
import { createVaultKeyRotationCeremony } from "@bittery/core/services/vault-key-rotation";
import { useApiClient } from "@bittery/shared/api";
import { useMemo } from "react";
import { storage } from "@/lib/storage";
import {
	createRotationLocalState,
	createWebRotationPlanClient,
} from "@/lib/vault-key-rotation-adapter";

interface LockStateSource {
	getActiveAccount(): Promise<string | null>;
	getUnlockedAccounts(): Promise<string[]>;
	onUnlockStateChanged(listener: (accounts: string[]) => void): () => void;
}

export function subscribeToActiveAccountLock(
	source: LockStateSource,
	listener: () => void,
): () => void {
	const activeAccount = source.getActiveAccount();
	let wasUnlocked = Promise.all([
		activeAccount,
		source.getUnlockedAccounts(),
	]).then(
		([accountId, unlocked]) =>
			accountId !== null && unlocked.includes(accountId),
	);
	return source.onUnlockStateChanged((unlocked) => {
		wasUnlocked = Promise.all([activeAccount, wasUnlocked]).then(
			([accountId, previous]) => {
				const current = accountId !== null && unlocked.includes(accountId);
				if (previous && !current) listener();
				return current;
			},
		);
	});
}

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
				core.vaultRepository.removeCachedVault(vaultId, accountId),
			refreshFromServer: async (accountId) => {
				const { accountsInfo } = await core.accounts.resolveAccounts(accountId);
				await core.vaultRepository.refreshFromServer(accountsInfo);
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
			onLock: (listener) => subscribeToActiveAccountLock(storage, listener),
		});
	}, [api, core, crypto]);
}
