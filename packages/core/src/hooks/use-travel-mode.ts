import { useRPCClient } from "@bittery/shared/rpc";
import type { AccountStore } from "@bittery/storage";
import type { TravelModeConfig } from "@bittery/storage/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deriveSrpLoginProof, type IAuthClient } from "../auth";
import {
	useCoreContext,
	usePlatformCrypto,
	usePlatformStorage,
} from "../context/platform-context";
import {
	type DefaultRpcClient,
	getClientForAccount,
} from "../services/account-resolver";
import { getTravelModeEnforcer } from "../services/travel-mode-enforcer";
import type { TravelModeRpcClient } from "../services/travel-mode-service";
import { restoreAfterTravelModeDisabled } from "../services/travel-mode-sync";
import type { RpcVaultClient } from "../services/vault-service";

async function resolveAccountRpcClient(
	storage: AccountStore,
	defaultClient: DefaultRpcClient,
	accountId: string,
): Promise<{ accountId: string; rpcClient: TravelModeRpcClient }> {
	const rpcClient = await getClientForAccount(
		storage,
		defaultClient,
		accountId,
	);
	return { accountId, rpcClient: rpcClient as TravelModeRpcClient };
}

export function useTravelMode(accountId?: string) {
	const queryClient = useQueryClient();
	const rpcClient = useRPCClient() as DefaultRpcClient;
	const storage = usePlatformStorage();
	const crypto = usePlatformCrypto();
	const { vaultCoordinator, accounts, itemCache } = useCoreContext();

	const query = useQuery({
		queryKey: ["travel-mode", accountId],
		enabled: Boolean(accountId),
		queryFn: async () => {
			if (!accountId) {
				return null;
			}
			const { accountId: resolvedAccountId, rpcClient: accountRpcClient } =
				await resolveAccountRpcClient(storage, rpcClient, accountId);
			const enforcer = getTravelModeEnforcer(
				storage,
				itemCache,
				vaultCoordinator,
			);
			const config = await enforcer.fetchFromServer(
				resolvedAccountId,
				accountRpcClient,
			);
			if (!config.enabled) {
				const localKeys = await storage.getVaultKeys(resolvedAccountId);
				const serverVaults = await (
					accountRpcClient as unknown as RpcVaultClient
				).vault.list.query();
				const localVaultIds = new Set(
					(localKeys ?? []).map((vaultKey) => vaultKey.vaultId),
				);
				const serverVaultIds = new Set(serverVaults.map((vault) => vault.id));
				const vaultIdsMismatch =
					localVaultIds.size !== serverVaultIds.size ||
					[...localVaultIds].some((vaultId) => !serverVaultIds.has(vaultId));
				if (vaultIdsMismatch) {
					await restoreAfterTravelModeDisabled(
						resolvedAccountId,
						storage,
						vaultCoordinator,
						{
							rpcClient: accountRpcClient as unknown as RpcVaultClient,
							accounts,
						},
					);
				}
			}
			return config;
		},
	});

	const setHiddenVaults = useMutation({
		mutationFn: async (hiddenVaultIds: string[]) => {
			if (!accountId) {
				throw new Error("No active account");
			}
			const { accountId: resolvedAccountId, rpcClient: accountRpcClient } =
				await resolveAccountRpcClient(storage, rpcClient, accountId);
			const enforcer = getTravelModeEnforcer(
				storage,
				itemCache,
				vaultCoordinator,
			);
			return enforcer.setHiddenVaults(
				resolvedAccountId,
				hiddenVaultIds,
				accountRpcClient,
			);
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["travel-mode"] });
			await queryClient.invalidateQueries({ queryKey: ["all-vault-keys"] });
		},
	});

	const enable = useMutation({
		mutationFn: async (hiddenVaultIds: string[]) => {
			if (!accountId) {
				throw new Error("No active account");
			}
			const { accountId: resolvedAccountId, rpcClient: accountRpcClient } =
				await resolveAccountRpcClient(storage, rpcClient, accountId);
			const enforcer = getTravelModeEnforcer(
				storage,
				itemCache,
				vaultCoordinator,
			);
			return enforcer.enable(
				resolvedAccountId,
				hiddenVaultIds,
				accountRpcClient,
			);
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["travel-mode"] });
			await queryClient.invalidateQueries({ queryKey: ["all-vault-keys"] });
		},
	});

	const disable = useMutation({
		mutationFn: async (input: { password: string }) => {
			if (!accountId) {
				throw new Error("No active account");
			}
			const { accountId: resolvedAccountId, rpcClient: accountRpcClient } =
				await resolveAccountRpcClient(storage, rpcClient, accountId);
			const proof = await deriveSrpLoginProof(
				{ accountId: resolvedAccountId, password: input.password },
				{
					crypto,
					rpcClient: accountRpcClient as unknown as IAuthClient,
					storage,
				},
			);
			const enforcer = getTravelModeEnforcer(
				storage,
				itemCache,
				vaultCoordinator,
			);
			const config = await enforcer.disable(
				resolvedAccountId,
				accountRpcClient,
				proof,
			);
			if (!config.enabled) {
				await restoreAfterTravelModeDisabled(
					resolvedAccountId,
					storage,
					vaultCoordinator,
					{
						rpcClient: accountRpcClient as unknown as RpcVaultClient,
						accounts,
					},
				);
			}
			return config;
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["travel-mode"] });
			await queryClient.invalidateQueries({ queryKey: ["all-vault-keys"] });
		},
	});

	const config: TravelModeConfig | null = query.data ?? null;

	return {
		config,
		isLoading: query.isLoading,
		isEnabled: config?.enabled ?? false,
		hiddenVaultIds: config?.hiddenVaultIds ?? [],
		setHiddenVaults,
		enable,
		disable,
		refetch: query.refetch,
	};
}
