/**
 * useQuickUnlockAll Hook
 *
 * React hook for unlocking all accounts with a single password.
 * This is useful when user has multiple accounts that share the same password.
 * Each account's Master Unlock Key is derived from the password + that account's secret key.
 */

import { getDefaultServerUrl } from "@bittery/shared/rpc-client-factory";
import {
	type UseMutationResult,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { performSRPUnlock, storeUnlockSession } from "../../auth";
import {
	usePlatformCrypto,
	usePlatformStorage,
} from "../../context/platform-context";
import { createStaticStoredAccountRpcClient } from "../../services/rpc-client";

/**
 * Input for quick unlock all operation
 */
export interface QuickUnlockAllInput {
	/**
	 * Master password to use for unlocking all accounts.
	 * Each account will be unlocked using this password + that account's secret key.
	 */
	password: string;

	/**
	 * Optional: specific accounts to unlock.
	 * If not provided, will attempt to unlock all accounts that have stored secret keys.
	 */
	emails?: string[];
}

/**
 * Result of quick unlock all operation
 */
export interface QuickUnlockAllResult {
	/**
	 * Emails of accounts that were successfully unlocked
	 */
	unlocked: string[];

	/**
	 * Emails of accounts that failed to unlock (with error messages)
	 */
	failed: Array<{ email: string; error: string }>;
}

/**
 * Options for useQuickUnlockAll hook
 */
export interface UseQuickUnlockAllOptions {
	/**
	 * Callback when unlock all succeeds (at least one account unlocked).
	 * Use this for navigation, showing success messages, etc.
	 */
	onSuccess?: (
		result: QuickUnlockAllResult,
		input: QuickUnlockAllInput,
	) => void | Promise<void>;

	/**
	 * Callback when unlock all fails (no accounts unlocked).
	 * Use this for showing error messages.
	 */
	onError?: (error: Error, input: QuickUnlockAllInput) => void;

	/**
	 * Callback when some accounts succeed and some fail.
	 */
	onPartialSuccess?: (
		result: QuickUnlockAllResult,
		input: QuickUnlockAllInput,
	) => void;
}

/**
 * Hook for unlocking all accounts with a single password.
 *
 * @example
 * ```tsx
 * const quickUnlockAll = useQuickUnlockAll({
 *   onSuccess: (result) => {
 *     toast.success(`Unlocked ${result.unlocked.length} accounts`);
 *     navigate('/vault');
 *   },
 *   onPartialSuccess: (result) => {
 *     toast.warning(`Unlocked ${result.unlocked.length} accounts, ${result.failed.length} failed`);
 *   },
 *   onError: (error) => toast.error(error.message),
 * });
 *
 * const handleSubmit = (password) => {
 *   quickUnlockAll.mutate({ password });
 * };
 * ```
 */
export function useQuickUnlockAll(
	options: UseQuickUnlockAllOptions = {},
): UseMutationResult<QuickUnlockAllResult, Error, QuickUnlockAllInput> {
	const crypto = usePlatformCrypto();
	const storage = usePlatformStorage();
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (
			input: QuickUnlockAllInput,
		): Promise<QuickUnlockAllResult> => {
			const { password, emails } = input;

			// Get list of accounts to unlock
			const accounts = await storage.getAccountsList();
			const accountsToUnlock = emails
				? accounts.filter((a) => emails.includes(a.email))
				: accounts;

			if (accountsToUnlock.length === 0) {
				throw new Error("No accounts found to unlock");
			}

			const unlocked: string[] = [];
			const failed: Array<{ email: string; error: string }> = [];

			// Attempt to unlock each account
			for (const account of accountsToUnlock) {
				try {
					// Check if account has stored secret key
					const hasSecretKey = await storage.hasStoredSecretKey?.(
						account.accountId,
					);
					if (!hasSecretKey) {
						failed.push({
							email: account.email,
							error:
								"No stored Secret Key. Please sign in with full credentials.",
						});
						continue;
					}

					const serverUrl =
						(await storage.getServerUrl?.(account.accountId)) ||
						getDefaultServerUrl();
					const accountRpcClient = await createStaticStoredAccountRpcClient(
						storage,
						account.accountId,
					);
					if (!accountRpcClient) {
						failed.push({
							email: account.email,
							error: "No auth token found for account",
						});
						continue;
					}

					// Perform SRP unlock for this account
					const result = await performSRPUnlock(
						{
							accountId: account.accountId,
							password,
						},
						{ crypto, rpcClient: accountRpcClient, storage },
					);

					// Store unlock session data
					await storeUnlockSession(result, storage, account.accountId, {
						travelModeRpcClient: accountRpcClient,
						serverUrl,
					});

					unlocked.push(account.email);
				} catch (error) {
					failed.push({
						email: account.email,
						error: error instanceof Error ? error.message : "Unknown error",
					});
				}
			}

			// If no accounts were unlocked, throw error
			if (unlocked.length === 0) {
				throw new Error(
					`Failed to unlock any accounts. ${failed.map((f) => `${f.email}: ${f.error}`).join("; ")}`,
				);
			}

			return { unlocked, failed };
		},
		onSuccess: (result, input) => {
			// Invalidate all account-related queries
			queryClient.invalidateQueries({ queryKey: ["accounts", "unlocked"] });
			queryClient.invalidateQueries({ queryKey: ["auth"] });
			queryClient.invalidateQueries({ queryKey: ["vaults"] });
			queryClient.invalidateQueries({ queryKey: ["items"] });

			// Call appropriate callback based on result
			if (result.failed.length > 0 && options.onPartialSuccess) {
				options.onPartialSuccess(result, input);
			} else if (options.onSuccess) {
				options.onSuccess(result, input);
			}
		},
		onError: (error, input) => {
			options.onError?.(error, input);
		},
	});
}
