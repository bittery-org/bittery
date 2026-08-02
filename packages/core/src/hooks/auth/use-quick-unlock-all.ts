/**
 * useQuickUnlockAll Hook
 *
 * React hook for unlocking all accounts with a single password.
 * This is useful when user has multiple accounts that share the same password.
 * Each account's Master Unlock Key is derived from the password + that account's secret key.
 */

import { m } from "@bittery/i18n/paraglide/messages";
import {
	type UseMutationResult,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import {
	usePlatformCrypto,
	usePlatformItemCache,
	usePlatformStorage,
} from "../../context/platform-context";
import {
	type UnlockOutcome,
	unlockAllWithPassword,
} from "../../services/unlock";

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

/** Surfaced as-is: consumers read `unlocked` and `failed.length`. */
export type QuickUnlockAllResult = UnlockOutcome;

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
	const itemCache = usePlatformItemCache();
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (input: QuickUnlockAllInput) => {
			const outcome = await unlockAllWithPassword(
				{ password: input.password, emails: input.emails },
				{ crypto, storage, itemCache },
			);
			// The unlock reports rather than throws; React Query needs a rejection to
			// route a total failure to `onError`.
			if (outcome.unlocked.length === 0) {
				throw new Error(m.toast_auth_unlock_error_failed());
			}
			return outcome;
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
