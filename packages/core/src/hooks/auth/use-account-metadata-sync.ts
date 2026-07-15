/**
 * Hook to sync account metadata with server
 * Updates team avatar URLs and other account data that may change on the server
 */

import { useQueries, useQuery } from "@tanstack/react-query";
import { usePlatformStorage } from "../../context/platform-context";
import { createStoredAccountRpcClient } from "../../services/account-resolver";

const ACCOUNT_METADATA_STALE_TIME_MS = 10 * 60 * 1000;
const ACCOUNT_METADATA_REFETCH_INTERVAL_MS = 10 * 60 * 1000;

export interface UseAccountMetadataSyncOptions {
	/** Stable ID of the account to sync. */
	accountId?: string;
	/** Whether the hook is enabled (default: true) */
	enabled?: boolean;
	/** Refetch interval in milliseconds (default: 60000 = 1 minute) */
	refetchInterval?: number;
}

/**
 * Syncs account metadata with the server to keep team avatar and other data up-to-date.
 *
 * This hook:
 * 1. Periodically fetches user data from the server
 * 2. Compares with locally stored account metadata
 * 3. Updates local storage if team avatar URL has changed
 *
 * Usage:
 * ```tsx
 * // In your app layout/root component
 * useAccountMetadataSync({ accountId: activeAccount.accountId });
 * ```
 */
export function useAccountMetadataSync(
	options: UseAccountMetadataSyncOptions = {},
) {
	const {
		accountId,
		enabled = true,
		refetchInterval = ACCOUNT_METADATA_REFETCH_INTERVAL_MS,
	} = options;
	const storage = usePlatformStorage();

	return useQuery({
		queryKey: ["account-metadata-sync", accountId],
		queryFn: async () => {
			if (!accountId) return null;

			try {
				const rpcClient = await createStoredAccountRpcClient(
					storage,
					accountId,
				);
				if (!rpcClient) return null;

				// Fetch current user data from server
				const userData = await rpcClient.auth.me.query();

				// Get stored account metadata
				const accounts = await storage.getAccountsList();
				const storedAccount = accounts.find((a) => a.accountId === accountId);

				if (!storedAccount) {
					console.log(
						`[account-metadata-sync] No stored account found for ${accountId}`,
					);
					return null;
				}

				// Check if team avatar URL has changed
				const hasChanged =
					storedAccount.teamAvatarUrl !== userData.teamAvatarUrl;

				if (hasChanged) {
					console.log(
						`[account-metadata-sync] Team avatar changed for ${accountId}`,
						{
							old: storedAccount.teamAvatarUrl,
							new: userData.teamAvatarUrl,
						},
					);

					// Update account metadata with new team avatar URL
					await storage.addAccount({
						...storedAccount,
						teamName: userData.teamName ?? undefined,
						teamAvatarUrl: userData.teamAvatarUrl ?? undefined,
					});

					return {
						updated: true,
						accountId,
						email: storedAccount.email,
						teamAvatarUrl: userData.teamAvatarUrl ?? undefined,
					};
				}

				return {
					updated: false,
					accountId,
					email: storedAccount.email,
					teamAvatarUrl: userData.teamAvatarUrl ?? undefined,
				};
			} catch (error) {
				console.error(
					`[account-metadata-sync] Failed to sync metadata for ${accountId}:`,
					error,
				);
				throw error;
			}
		},
		enabled: enabled && !!accountId,
		refetchInterval,
		staleTime: ACCOUNT_METADATA_STALE_TIME_MS,
		refetchOnWindowFocus: false,
		refetchOnMount: false,
		// Keep previous data while fetching to avoid flicker
		placeholderData: (previousData) => previousData,
		// Retry with exponential backoff
		retry: 3,
		retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
	});
}

/**
 * Syncs metadata for all unlocked accounts.
 * Useful in "All Accounts" mode to keep all account metadata up-to-date.
 *
 * Usage:
 * ```tsx
 * useAccountMetadataSyncAll({
 *   accountIds: unlockedAccountIds,
 *   refetchInterval: 60000,
 * });
 * ```
 */
export function useAccountMetadataSyncAll(options: {
	/** List of stable account IDs to sync */
	accountIds?: string[];
	/** Whether the hook is enabled (default: true) */
	enabled?: boolean;
	/** Refetch interval in milliseconds (default: 60000 = 1 minute) */
	refetchInterval?: number;
}) {
	const {
		accountIds = [],
		enabled = true,
		refetchInterval = ACCOUNT_METADATA_REFETCH_INTERVAL_MS,
	} = options;
	const storage = usePlatformStorage();

	return useQueries({
		queries: accountIds.map((accountId) => ({
			queryKey: ["account-metadata-sync", accountId],
			queryFn: async () => {
				try {
					const accountClient = await createStoredAccountRpcClient(
						storage,
						accountId,
					);
					if (!accountClient) {
						console.log(
							`[account-metadata-sync-all] No auth session found for ${accountId}`,
						);
						return null;
					}

					// Fetch current user data from server using account-specific client
					const userData = await accountClient.auth.me.query();

					// Get stored account metadata
					const accounts = await storage.getAccountsList();
					const storedAccount = accounts.find((a) => a.accountId === accountId);

					if (!storedAccount) {
						console.log(
							`[account-metadata-sync-all] No stored account found for ${accountId}`,
						);
						return null;
					}

					// Check if team avatar URL has changed
					const hasChanged =
						storedAccount.teamAvatarUrl !== userData.teamAvatarUrl;

					if (hasChanged) {
						console.log(
							`[account-metadata-sync-all] Team avatar changed for ${accountId}`,
							{
								old: storedAccount.teamAvatarUrl,
								new: userData.teamAvatarUrl,
							},
						);

						// Update account metadata with new team avatar URL
						await storage.addAccount({
							...storedAccount,
							teamName: userData.teamName ?? undefined,
							teamAvatarUrl: userData.teamAvatarUrl ?? undefined,
						});

						return {
							updated: true,
							accountId,
							email: storedAccount.email,
							teamAvatarUrl: userData.teamAvatarUrl ?? undefined,
						};
					}

					return {
						updated: false,
						accountId,
						email: storedAccount.email,
						teamAvatarUrl: userData.teamAvatarUrl ?? undefined,
					};
				} catch (error) {
					console.error(
						`[account-metadata-sync-all] Failed to sync metadata for ${accountId}:`,
						error,
					);
					throw error;
				}
			},
			enabled: enabled && !!accountId,
			refetchInterval,
			staleTime: ACCOUNT_METADATA_STALE_TIME_MS,
			refetchOnWindowFocus: false,
			refetchOnMount: false,
			placeholderData: (previousData: unknown) => previousData,
			retry: 3,
			retryDelay: (attemptIndex: number) =>
				Math.min(1000 * 2 ** attemptIndex, 30000),
		})),
	});
}
