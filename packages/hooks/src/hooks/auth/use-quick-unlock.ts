/**
 * useQuickUnlock Hook
 *
 * React hook for performing password unlock with stored secret key.
 * Wraps the core performSRPUnlock utility with React Query mutation.
 */

import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { useTRPCClient } from "@bittery/shared/trpc";
import { usePlatformCrypto, usePlatformStorage } from "../../context/platform-context";
import {
	performSRPUnlock,
	storeUnlockSession,
	type UnlockResult,
	type SRPUnlockInput,
} from "../../auth";

/**
 * Options for useQuickUnlock hook
 */
export interface UseQuickUnlockOptions {
	/**
	 * Callback when unlock succeeds.
	 * Use this for navigation, showing success messages, etc.
	 */
	onSuccess?: (result: UnlockResult, input: SRPUnlockInput) => void | Promise<void>;

	/**
	 * Callback when unlock fails.
	 * Use this for showing error messages.
	 */
	onError?: (error: Error, input: SRPUnlockInput) => void;
}

/**
 * Extended unlock input
 */
export interface QuickUnlockInput extends SRPUnlockInput {
	// No additional fields currently, but interface is here for future expansion
}

/**
 * Hook for performing password unlock with stored secret key.
 *
 * @example
 * ```tsx
 * const quickUnlock = useQuickUnlock({
 *   onSuccess: () => navigate('/vault'),
 *   onError: (error) => toast.error(error.message),
 * });
 *
 * const handleSubmit = (email, password) => {
 *   quickUnlock.mutate({ email, password });
 * };
 * ```
 */
export function useQuickUnlock(
	options: UseQuickUnlockOptions = {},
): UseMutationResult<UnlockResult, Error, QuickUnlockInput> {
	const trpcClient = useTRPCClient();
	const crypto = usePlatformCrypto();
	const storage = usePlatformStorage();

	return useMutation({
		mutationFn: async (input: QuickUnlockInput) => {
			// Perform SRP unlock
			const result = await performSRPUnlock(
				{
					email: input.email,
					password: input.password,
				},
				{ crypto, trpcClient, storage },
			);

			// Store unlock session data
			await storeUnlockSession(result, storage, input.email);

			// For multi-account platforms, set this as the active account
			if (storage.supportsMultiAccount) {
				await storage.setActiveAccount(input.email);
			}

			return result;
		},
		onSuccess: (result, input) => {
			options.onSuccess?.(result, input);
		},
		onError: (error, input) => {
			options.onError?.(error, input);
		},
	});
}
