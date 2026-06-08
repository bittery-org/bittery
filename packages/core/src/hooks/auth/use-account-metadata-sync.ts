/**
 * Hook to sync account metadata with server
 * Updates team avatar URLs and other account data that may change on the server
 */

import { useRPCClient } from "@bittery/shared/rpc";
import { createAccountRpcClient } from "@bittery/shared/rpc-client-factory";
import { useQueries, useQuery } from "@tanstack/react-query";
import { usePlatformStorage } from "../../context/platform-context";

export interface UseAccountMetadataSyncOptions {
	/** Email of the account to sync (optional - defaults to current active account) */
	email?: string;
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
 * useAccountMetadataSync({ email: activeAccount.email });
 * ```
 */
export function useAccountMetadataSync(
	options: UseAccountMetadataSyncOptions = {},
) {
	const { email, enabled = true, refetchInterval = 60000 } = options;
	const rpcClient = useRPCClient();
	const storage = usePlatformStorage();

	return useQuery({
		queryKey: ["account-metadata-sync", email],
		queryFn: async () => {
			// Only sync if we have an email
			if (!email) return null;

			try {
				// Fetch current user data from server
				const userData = await rpcClient.auth.me.query();

				// Get stored account metadata
				const accounts = await storage.getAccountsList();
				const storedAccount = accounts.find((a) => a.email === email);

				if (!storedAccount) {
					console.log(
						`[account-metadata-sync] No stored account found for ${email}`,
					);
					return null;
				}

				// Check if team avatar URL has changed
				const hasChanged =
					storedAccount.teamAvatarUrl !== userData.teamAvatarUrl;

				if (hasChanged) {
					console.log(
						`[account-metadata-sync] Team avatar changed for ${email}`,
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
						email,
						teamAvatarUrl: userData.teamAvatarUrl ?? undefined,
					};
				}

				return {
					updated: false,
					email,
					teamAvatarUrl: userData.teamAvatarUrl ?? undefined,
				};
			} catch (error) {
				console.error(
					`[account-metadata-sync] Failed to sync metadata for ${email}:`,
					error,
				);
				throw error;
			}
		},
		enabled: enabled && !!email,
		refetchInterval,
		// Refetch on window focus to catch changes when user returns to the app
		refetchOnWindowFocus: true,
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
 *   emails: unlockedEmails,
 *   refetchInterval: 60000,
 * });
 * ```
 */
export function useAccountMetadataSyncAll(options: {
	/** List of account emails to sync */
	emails?: string[];
	/** Whether the hook is enabled (default: true) */
	enabled?: boolean;
	/** Refetch interval in milliseconds (default: 60000 = 1 minute) */
	refetchInterval?: number;
}) {
	const { emails = [], enabled = true, refetchInterval = 60000 } = options;
	const storage = usePlatformStorage();

	return useQueries({
		queries: emails.map((email) => ({
			queryKey: ["account-metadata-sync", email],
			queryFn: async () => {
				try {
					// Get auth token for this specific account
					const authToken = await storage.getAuthToken(email);
					if (!authToken) {
						console.log(
							`[account-metadata-sync-all] No auth token found for ${email}`,
						);
						return null;
					}

					// Get server URL for this account (or use default)
					const serverUrl =
						(await storage.getServerUrl?.(email)) || "http://localhost:3000";

					// Create an account-specific RPC client.
					const accountClient = createAccountRpcClient(authToken, serverUrl);

					// Fetch current user data from server using account-specific client
					const userData = await accountClient.auth.me.query();

					// Get stored account metadata
					const accounts = await storage.getAccountsList();
					const storedAccount = accounts.find((a) => a.email === email);

					if (!storedAccount) {
						console.log(
							`[account-metadata-sync-all] No stored account found for ${email}`,
						);
						return null;
					}

					// Check if team avatar URL has changed
					const hasChanged =
						storedAccount.teamAvatarUrl !== userData.teamAvatarUrl;

					if (hasChanged) {
						console.log(
							`[account-metadata-sync-all] Team avatar changed for ${email}`,
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
							email,
							teamAvatarUrl: userData.teamAvatarUrl ?? undefined,
						};
					}

					return {
						updated: false,
						email,
						teamAvatarUrl: userData.teamAvatarUrl ?? undefined,
					};
				} catch (error) {
					console.error(
						`[account-metadata-sync-all] Failed to sync metadata for ${email}:`,
						error,
					);
					throw error;
				}
			},
			enabled: enabled && !!email,
			refetchInterval,
			refetchOnWindowFocus: true,
			placeholderData: (previousData: unknown) => previousData,
			retry: 3,
			retryDelay: (attemptIndex: number) =>
				Math.min(1000 * 2 ** attemptIndex, 30000),
		})),
	});
}
