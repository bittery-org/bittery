/**
 * Utility hook for fetching complete account information for active accounts.
 * Handles both single account and "All Accounts" mode.
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";
import {
	useCoreContext,
	usePlatformStorage,
} from "../context/platform-context";
import type { AccountInfo as CoreAccountInfo } from "../services/account-resolver";
import { peekAccountSessionManager } from "../services/account-session-manager";

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
	const manager = peekAccountSessionManager();

	useSyncExternalStore(
		manager?.subscribe ?? (() => () => {}),
		manager?.getSnapshot ?? (() => 0),
		manager?.getSnapshot ?? (() => 0),
	);

	const { data: activeAccount, isLoading: isLoadingActive } = useQuery({
		queryKey: ["accounts", "active"],
		queryFn: () => storage.getActiveAccount(),
		staleTime: 5000,
		enabled: options.enabled !== false && !manager,
	});

	const effectiveActiveAccount = manager
		? manager.getActiveAccount()
		: activeAccount;

	const activeAccountKey = useMemo(
		() =>
			effectiveActiveAccount?.type === "single"
				? `single:${effectiveActiveAccount.accountId}`
				: (effectiveActiveAccount?.type ?? "none"),
		[effectiveActiveAccount],
	);

	const {
		data: accountsInfo = [],
		isLoading: isLoadingInfo,
		error,
	} = useQuery({
		queryKey: ["accounts", "info", activeAccountKey],
		queryFn: async (): Promise<AccountInfo[]> => {
			const resolved = await core.accounts.resolveAccounts(
				effectiveActiveAccount,
			);
			return resolved.accountsInfo;
		},
		enabled: !!effectiveActiveAccount && options.enabled !== false,
		staleTime: 0,
		// AccountInfo carries a live RPC client (a Proxy), which is not
		// JSON-serializable. React Query's default structural sharing throws on
		// proxies, so it must be disabled for this query.
		structuralSharing: false,
	});

	return {
		activeAccount: effectiveActiveAccount,
		accountsInfo,
		isLoading: (!manager && isLoadingActive) || isLoadingInfo,
		error,
		isAllAccountsMode: effectiveActiveAccount?.type === "all",
	};
}
