import { useRPCClient } from "@bittery/shared/rpc";
import type { IStorageAdapter } from "@bittery/storage/adapter";
import type { TravelModeConfig } from "@bittery/storage/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deriveSrpLoginProof, type IAuthClient } from "../auth";
import {
	useCoreContext,
	usePlatformCrypto,
	usePlatformStorage,
} from "../context/platform-context";
import {
	getClientForAccount,
	type DefaultRpcClient,
} from "../services/account-resolver";
import { getTravelModeEnforcer } from "../services/travel-mode-enforcer";
import {
	getTravelModeService,
	type TravelModeRpcClient,
} from "../services/travel-mode-service";
import { restoreAfterTravelModeDisabled } from "../services/travel-mode-sync";
import type { RpcVaultClient } from "../services/vault-service";

async function resolveAccountIdByEmail(
	storage: IStorageAdapter,
	email: string,
): Promise<string> {
	const accounts = await storage.getAccountsList();
	const matches = accounts.filter(
		(account) => account.email.toLowerCase() === email.toLowerCase(),
	);
	if (matches.length === 0) {
		throw new Error("No active account");
	}
	if (matches.length === 1) {
		const [onlyMatch] = matches;
		if (!onlyMatch) {
			throw new Error("No active account");
		}
		return onlyMatch.accountId;
	}

	const active = await storage.getActiveAccount();
	if (active?.type === "single") {
		const activeMatch = matches.find(
			(account) => account.accountId === active.accountId,
		);
		if (activeMatch) {
			return activeMatch.accountId;
		}
	}

	throw new Error("Multiple accounts share this email");
}

async function resolveAccountRpcClient(
	storage: IStorageAdapter,
	defaultClient: DefaultRpcClient,
	email: string,
): Promise<{ accountId: string; rpcClient: TravelModeRpcClient }> {
	const accountId = await resolveAccountIdByEmail(storage, email);
	const rpcClient = await getClientForAccount(storage, defaultClient, accountId);
	return { accountId, rpcClient: rpcClient as TravelModeRpcClient };
}

export function useTravelMode(email?: string) {
	const queryClient = useQueryClient();
	const rpcClient = useRPCClient() as DefaultRpcClient;
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
			const { accountId, rpcClient: accountRpcClient } =
				await resolveAccountRpcClient(storage, rpcClient, email);
			const enforcer = getTravelModeEnforcer(storage, vaultCoordinator);
			const config = await enforcer.fetchFromServer(
				accountId,
				accountRpcClient,
			);
			if (!config.enabled) {
				const localKeys = await storage.getVaultKeys(accountId);
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
						accountId,
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
			if (!email) {
				throw new Error("No active account");
			}
			const { accountId, rpcClient: accountRpcClient } =
				await resolveAccountRpcClient(storage, rpcClient, email);
			return travelModeService.setHiddenVaults(
				accountId,
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
			if (!email) {
				throw new Error("No active account");
			}
			const { accountId, rpcClient: accountRpcClient } =
				await resolveAccountRpcClient(storage, rpcClient, email);
			const enforcer = getTravelModeEnforcer(storage, vaultCoordinator);
			return enforcer.enable(accountId, hiddenVaultIds, accountRpcClient);
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
			const { accountId, rpcClient: accountRpcClient } =
				await resolveAccountRpcClient(storage, rpcClient, email);
			const proof = await deriveSrpLoginProof(
				{ email, password: input.password },
				{
					crypto,
					rpcClient: accountRpcClient as unknown as IAuthClient,
					storage,
				},
			);
			const enforcer = getTravelModeEnforcer(storage, vaultCoordinator);
			const config = await enforcer.disable(accountId, accountRpcClient, proof);
			if (!config.enabled) {
				await restoreAfterTravelModeDisabled(
					accountId,
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
