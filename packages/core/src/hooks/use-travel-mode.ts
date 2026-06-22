import { useRPCClient } from "@bittery/shared/rpc";
import type { TravelModeConfig } from "@bittery/storage/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deriveSrpLoginProof } from "../auth";
import {
	useCoreContext,
	usePlatformCrypto,
	usePlatformStorage,
} from "../context/platform-context";
import {
	getTravelModeService,
	type TravelModeRpcClient,
} from "../services/travel-mode-service";
import { restoreAfterTravelModeDisabled } from "../services/travel-mode-sync";
import type { RpcVaultClient } from "../services/vault-service";

export function useTravelMode(email?: string) {
	const queryClient = useQueryClient();
	const rpcClient = useRPCClient() as TravelModeRpcClient;
	const storage = usePlatformStorage();
	const crypto = usePlatformCrypto();
	const { vaultCoordinator, accounts } = useCoreContext();
	const travelModeService = getTravelModeService(storage);

	const query = useQuery({
		queryKey: ["travel-mode", email],
		enabled: Boolean(email),
		queryFn: async () => {
			if (!email) {
				return null;
			}
			const config = await travelModeService.fetchFromServer(email, rpcClient);
			if (config.enabled) {
				vaultCoordinator.purgeHiddenVaultsForEmail(
					email,
					config.hiddenVaultIds,
				);
			} else {
				const localKeys = await storage.getVaultKeys(email);
				const serverVaults = await (
					rpcClient as unknown as RpcVaultClient
				).vault.list.query();
				if ((localKeys?.length ?? 0) < serverVaults.length) {
					await restoreAfterTravelModeDisabled(
						email,
						storage,
						vaultCoordinator,
						{
							rpcClient: rpcClient as unknown as RpcVaultClient,
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
			if (!email) {
				throw new Error("No active account");
			}
			return travelModeService.setHiddenVaults(
				email,
				hiddenVaultIds,
				rpcClient,
			);
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["travel-mode"] });
			await queryClient.invalidateQueries({ queryKey: ["all-vault-keys"] });
		},
	});

	const enable = useMutation({
		mutationFn: async (hiddenVaultIds: string[]) => {
			if (!email) {
				throw new Error("No active account");
			}
			const config = await travelModeService.enable(
				email,
				hiddenVaultIds,
				rpcClient,
			);
			vaultCoordinator.purgeHiddenVaultsForEmail(email, config.hiddenVaultIds);
			return config;
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["travel-mode"] });
			await queryClient.invalidateQueries({ queryKey: ["all-vault-keys"] });
		},
	});

	const disable = useMutation({
		mutationFn: async (input: { password: string }) => {
			if (!email) {
				throw new Error("No active account");
			}
			const proof = await deriveSrpLoginProof(
				{ email, password: input.password },
				{ crypto, rpcClient, storage },
			);
			const config = await travelModeService.disable(email, rpcClient, proof);
			if (!config.enabled) {
				await restoreAfterTravelModeDisabled(email, storage, vaultCoordinator, {
					rpcClient: rpcClient as unknown as RpcVaultClient,
					accounts,
				});
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
