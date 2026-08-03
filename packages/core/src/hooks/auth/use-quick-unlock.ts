/**
 * useQuickUnlock Hook
 *
 * React Query wrapper around the shared password unlock for a single account.
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
	type UnlockFailureReason,
	type UnlockOutcome,
	unlockAccountWithPassword,
} from "../../services/unlock";

/**
 * Input for quick unlock of a single account
 */
export interface QuickUnlockInput {
	/** Account to unlock; its stored Secret Key supplies the other half of the key. */
	accountId: string;
	password: string;
}

/** Surfaced as-is: consumers read `unlocked` and `failed.length`. */
export type QuickUnlockResult = UnlockOutcome;

/**
 * Options for useQuickUnlock hook
 */
export interface UseQuickUnlockOptions {
	/**
	 * Callback when unlock succeeds.
	 * Use this for navigation, showing success messages, etc.
	 */
	onSuccess?: (
		result: QuickUnlockResult,
		input: QuickUnlockInput,
	) => void | Promise<void>;

	/**
	 * Callback when unlock fails.
	 * Use this for showing error messages.
	 */
	onError?: (error: Error, input: QuickUnlockInput) => void;
}

/** Only the reasons a user can act on get their own copy. */
function failureMessage(reason: UnlockFailureReason | undefined): string {
	switch (reason) {
		case "no_stored_secret_key":
			return m.auth_error_no_stored_secret_key();
		case "travel_mode_unverified":
			return m.auth_error_travel_mode_verify_failed();
		default:
			return m.toast_auth_unlock_error_failed();
	}
}

/**
 * Hook for performing quick unlock of one account with its master password.
 *
 * @example
 * ```tsx
 * const quickUnlock = useQuickUnlock({
 *   onSuccess: () => navigate('/vault'),
 *   onError: (error) => toast.error(error.message),
 * });
 *
 * quickUnlock.mutate({ accountId, password });
 * ```
 */
export function useQuickUnlock(
	options: UseQuickUnlockOptions = {},
): UseMutationResult<QuickUnlockResult, Error, QuickUnlockInput> {
	const crypto = usePlatformCrypto();
	const storage = usePlatformStorage();
	const itemCache = usePlatformItemCache();
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (input: QuickUnlockInput) => {
			const outcome = await unlockAccountWithPassword(
				{ accountId: input.accountId, password: input.password },
				{ crypto, storage, itemCache },
			);
			// The unlock reports rather than throws; React Query needs a rejection to
			// route a total failure to `onError`.
			if (outcome.unlocked.length === 0) {
				throw new Error(failureMessage(outcome.failed[0]?.reason));
			}
			return outcome;
		},
		onSuccess: (result, input) => {
			queryClient.invalidateQueries({ queryKey: ["accounts", "unlocked"] });
			queryClient.invalidateQueries({ queryKey: ["auth"] });
			queryClient.invalidateQueries({ queryKey: ["vaults"] });
			queryClient.invalidateQueries({ queryKey: ["items"] });

			options.onSuccess?.(result, input);
		},
		onError: (error, input) => {
			options.onError?.(error, input);
		},
	});
}
