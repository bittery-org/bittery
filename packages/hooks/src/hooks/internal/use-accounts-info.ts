/**
 * Utility hook for fetching complete account information for active accounts.
 * Handles both single account and "All Accounts" mode.
 */

import { useQuery } from "@tanstack/react-query";
import { createAccountTrpcClient } from "@bittery/shared/trpc-client-factory";
import { usePlatformStorage } from "../../context/platform-context";

/**
 * Complete account information including metadata, credentials, and tRPC client
 */
export interface AccountInfo {
	email: string;
	userId: string;
	name: string;
	teamName?: string;
	authToken: string;
	serverUrl: string;
	trpcClient: ReturnType<typeof createAccountTrpcClient>;
}

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

	// Get active account configuration
	const { data: activeAccount, isLoading: isLoadingActive } = useQuery({
		queryKey: ["accounts", "active"],
		queryFn: () => storage.getActiveAccount(),
		staleTime: 5000,
		enabled: options.enabled !== false,
	});

	// Get complete info for all accounts to fetch from
	const {
		data: accountsInfo = [],
		isLoading: isLoadingInfo,
		error,
	} = useQuery({
		queryKey: ["accounts", "info", activeAccount],
		queryFn: async (): Promise<AccountInfo[]> => {
			if (!activeAccount) return [];

			// Determine which account emails to fetch
			let emails: string[];
			if (activeAccount.type === "single") {
				emails = [activeAccount.email];
			} else {
				// All accounts mode - get all unlocked
				emails = (await storage.getUnlockedAccounts?.()) ?? [];
			}

			// Fetch complete info for all accounts IN PARALLEL
			const infos = await Promise.all(
				emails.map(async (email): Promise<AccountInfo | null> => {
					try {
						// Fetch all account data in parallel
						const [metadata, authToken, serverUrl] = await Promise.all([
							storage.getAccountMetadata?.(email),
							storage.getAuthToken(email),
							storage.getServerUrl(email),
						]);

						if (!metadata || !authToken) {
							console.warn(`Missing data for account ${email}`);
							return null;
						}

						// Create tRPC client for this account
						const trpcClient = createAccountTrpcClient(
							authToken,
							serverUrl || "http://localhost:3000",
						);

						return {
							email: metadata.email,
							userId: metadata.userId,
							name: metadata.name,
							teamName: metadata.teamName,
							authToken,
							serverUrl: serverUrl || "http://localhost:3000",
							trpcClient,
						};
					} catch (error) {
						console.error(`Failed to load info for account ${email}:`, error);
						return null;
					}
				}),
			);

			return infos.filter((info): info is AccountInfo => info !== null);
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
