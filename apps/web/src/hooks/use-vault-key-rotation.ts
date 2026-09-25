import { useCoreContext, usePlatformCrypto } from "@bittery/core/hooks";
import type { RotateVaultKeysInput } from "@bittery/core/services/vault-key-rotation";
import { createVaultKeyRotationCeremony } from "@bittery/core/services/vault-key-rotation";
import { useApiClient } from "@bittery/shared/api";
import { useMemo } from "react";
import { storage } from "@/lib/storage";
import {
	createRotationLocalState,
	createWebRotationPlanClient,
} from "@/lib/vault-key-rotation-adapter";
import { useRecipientKeyVerification } from "@/providers/recipient-key-verification-provider";

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
	const verification = useRecipientKeyVerification();

	return useMemo(
		() => ({
			rotate: (input: RotateVaultKeysInput) =>
				verification.run(async (gesture) => {
					// Labels are optional presentation data, never a prerequisite to revocation.
					const members = await api.teams
						.current()
						.then((team) => api.teams.members.list(team.data.id))
						.then((result) => result.data)
						.catch(() => []);
					await gesture.checkActive();
					const localState = createRotationLocalState({
						getAccountId: async () => gesture.accountId,
						getVaultKeys: (accountId) => storage.getVaultKeys(accountId),
						storeVaultKeys: (keys, accountId) =>
							storage.storeVaultKeys([...keys], accountId),
						removeCachedVault: (vaultId, accountId) =>
							core.vaultRepository.removeCachedVault(vaultId, accountId),
						refreshFromServer: async (accountId) => {
							const { accountsInfo } =
								await core.accounts.resolveAccounts(accountId);
							await core.vaultRepository.refreshFromServer(accountsInfo);
						},
					});
					const client = createWebRotationPlanClient(api, localState);
					return createVaultKeyRotationCeremony({
						crypto,
						verifiedMemberKey: (member) =>
							gesture.approvedKey({
								recipientUserId: member.userId,
								publicKey: member.publicKey,
								label: members.find((entry) => entry.userId === member.userId)
									?.email,
							}),
						openVaultKey: async (vaultId) => {
							await gesture.checkActive();
							const key = await core.vaultCrypto.getVaultKey({
								vaultId,
								accountId: gesture.accountId,
							});
							if (!key) throw new Error("vault_key_decrypt_failed");
							return key;
						},
						getMasterUnlockKey: () =>
							storage.getMasterUnlockKey(gesture.accountId),
						client: {
							...client,
							stage: async (...args) => {
								await gesture.checkActive();
								return client.stage(...args);
							},
							finalize: async (...args) => {
								await gesture.checkActive();
								return client.finalize(...args);
							},
						},
						onLock: (listener) =>
							subscribeToActiveAccountLock(storage, listener),
					}).rotate(input);
				}),
		}),
		[api, core, crypto, verification],
	);
}
