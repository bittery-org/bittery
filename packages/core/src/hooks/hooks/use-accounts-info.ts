/**
 * Utility hook for fetching complete account information for active accounts.
 * Handles both single account and "All Accounts" mode.
 */

import type { AccountInfo as CoreAccountInfo } from "../../services/account-resolver";
import { useQuery } from "@tanstack/react-query";
import {
	useCoreContext,
	usePlatformStorage,
} from "../context/platform-context";

/**
 * Complete account information including metadata, credentials, and tRPC client
 */
export type AccountInfo = CoreAccountInfo;

export interface UseAccountsInfoOptions {
	enabled?: boolean;
}

/**
 * Utility hook that fetches complete account information for active accounts.
 * Handles both single account and "All Accounts" mode.
 * Returns all data needed to make API calls and decrypt items.
 */
export function useAccountsInfo(options: UseAccountsInfoOptions = {}) {
	const storage = usePlatformStorage();
	const core = useCoreContext();

	const { data: activeAccount, isLoading: isLoadingActive } = useQuery({
		queryKey: ["accounts", "active"],
		queryFn: () => storage.getActiveAccount(),
		staleTime: 5000,
		enabled: options.enabled !== false,
	});

	const {
		data: accountsInfo = [],
		isLoading: isLoadingInfo,
		error,
	} = useQuery({
		queryKey: ["accounts", "info", activeAccount],
		queryFn: async (): Promise<AccountInfo[]> => {
			const resolved = await core.accounts.resolveAccounts(activeAccount);
			return resolved.accountsInfo;
		},
		enabled: !!activeAccount && options.enabled !== false,
		staleTime: 5000,
	});

	return {
		activeAccount,
		accountsInfo,
		isLoading: isLoadingActive || isLoadingInfo,
		error,
		isAllAccountsMode: activeAccount?.type === "all",
	};
}
