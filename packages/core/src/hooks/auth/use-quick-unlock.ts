/**
 * useQuickUnlock Hook
 *
 * React hook for performing password unlock with stored secret key.
 * Wraps the core performSRPUnlock utility with React Query mutation.
 */

import {
	createAccountRpcClient,
	getDefaultServerUrl,
} from "@bittery/shared/rpc-client-factory";
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
	const crypto = usePlatformCrypto();
	const storage = usePlatformStorage();

	return useMutation({
		mutationFn: async (input: QuickUnlockInput) => {
			// Build a per-account RPC client so travel mode can be re-verified
			// against the server during unlock. Without this, storeUnlockSession
			// silently trusts stale local cache (travel mode fail-open).
			const authToken = await storage.getAuthToken(input.accountId);
			const serverUrl =
				(await storage.getServerUrl?.(input.accountId)) ||
				getDefaultServerUrl();
			const accountRpcClient = authToken
				? createAccountRpcClient(authToken, serverUrl)
				: undefined;

			// Perform SRP unlock
			const result = await performSRPUnlock(
				{
					accountId: input.accountId,
					password: input.password,
				},
				{ crypto, rpcClient: accountRpcClient, storage },
			);

			// Store unlock session data, re-verifying travel mode against the
			// server via the account RPC client.
			await storeUnlockSession(result, storage, input.accountId, {
				travelModeRpcClient: accountRpcClient,
				serverUrl,
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
