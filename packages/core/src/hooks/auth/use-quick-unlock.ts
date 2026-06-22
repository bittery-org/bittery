/**
 * useQuickUnlock Hook
 *
 * React hook for performing password unlock with stored secret key.
 * Wraps the core performSRPUnlock utility with React Query mutation.
 */

import { useRPCClient } from "@bittery/shared/rpc";
import { type UseMutationResult, useMutation } from "@tanstack/react-query";
import {
	performSRPUnlock,
	type SRPUnlockInput,
	storeUnlockSession,
	type UnlockResult,
} from "../../auth";
import {
	usePlatformCrypto,
	usePlatformStorage,
} from "../../context/platform-context";

/**
 * Options for useQuickUnlock hook
 */
export interface UseQuickUnlockOptions {
	/**
	 * Callback when unlock succeeds.
	 * Use this for navigation, showing success messages, etc.
	 */
	onSuccess?: (
		result: UnlockResult,
		input: SRPUnlockInput,
	) => void | Promise<void>;

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
	const rpcClient = useRPCClient();
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
				{ crypto, rpcClient, storage },
			);

			// Store unlock session data
			await storeUnlockSession(result, storage, input.email, {
				travelModeRpcClient: rpcClient,
			});

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
