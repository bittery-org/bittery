import { useApiClient } from "@bittery/shared/api";
import type { AccountStore } from "@bittery/storage";
import type { TravelModeConfig } from "@bittery/storage/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	useCoreContext,
	usePlatformCrypto,
	usePlatformStorage,
} from "../context/platform-context";
import {
	type DefaultApiClient,
	getClientForAccount,
} from "../services/account-resolver";
import {
	deriveSrpLoginProof,
	type IAuthClient,
} from "../services/auth-service";
import { getTravelModeEnforcer } from "../services/travel-mode-enforcer";
import type { TravelModeApiClient } from "../services/travel-mode-service";
import { restoreAfterTravelModeDisabled } from "../services/travel-mode-sync";
import type { ApiVaultClient } from "../services/vault-service";

async function resolveAccountApiClient(
	storage: AccountStore,
	defaultClient: DefaultApiClient,
	accountId: string,
): Promise<{ accountId: string; apiClient: TravelModeApiClient }> {
	const apiClient = await getClientForAccount(
		storage,
		defaultClient,
		accountId,
	);
	return { accountId, apiClient: apiClient as TravelModeApiClient };
}

export function useTravelMode(accountId?: string) {
	const queryClient = useQueryClient();
	const apiClient = useApiClient() as DefaultApiClient;
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
			const { accountId: resolvedAccountId, apiClient: accountApiClient } =
				await resolveAccountApiClient(storage, apiClient, accountId);
			const enforcer = getTravelModeEnforcer(
				storage,
				itemCache,
				vaultCoordinator,
			);
			const config = await enforcer.fetchFromServer(
				resolvedAccountId,
				accountApiClient,
			);
			if (!config.enabled) {
				const localKeys = await storage.getVaultKeys(resolvedAccountId);
				const { data: serverVaults } = await (
					accountApiClient as unknown as ApiVaultClient
				).vaults.list();
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
							apiClient: accountApiClient as unknown as ApiVaultClient,
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
			const { accountId: resolvedAccountId, apiClient: accountApiClient } =
				await resolveAccountApiClient(storage, apiClient, accountId);
			const enforcer = getTravelModeEnforcer(
				storage,
				itemCache,
				vaultCoordinator,
			);
			return enforcer.setHiddenVaults(
				resolvedAccountId,
				hiddenVaultIds,
				accountApiClient,
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
			const { accountId: resolvedAccountId, apiClient: accountApiClient } =
				await resolveAccountApiClient(storage, apiClient, accountId);
			const enforcer = getTravelModeEnforcer(
				storage,
				itemCache,
				vaultCoordinator,
			);
			return enforcer.enable(
				resolvedAccountId,
				hiddenVaultIds,
				accountApiClient,
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
			const { accountId: resolvedAccountId, apiClient: accountApiClient } =
				await resolveAccountApiClient(storage, apiClient, accountId);
			const proof = await deriveSrpLoginProof(
				{ accountId: resolvedAccountId, password: input.password },
				{
					crypto,
					apiClient: accountApiClient as unknown as IAuthClient,
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
				accountApiClient,
				proof,
			);
			if (!config.enabled) {
				await restoreAfterTravelModeDisabled(
					resolvedAccountId,
					storage,
					vaultCoordinator,
					{
						apiClient: accountApiClient as unknown as ApiVaultClient,
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
