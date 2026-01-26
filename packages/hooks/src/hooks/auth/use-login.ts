/**
 * useLogin Hook
 *
 * React hook for performing SRP login with password + secret key.
 * Wraps the core performSRPLogin utility with React Query mutation.
 */

import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { useTRPCClient } from "@bittery/shared/trpc";
import { usePlatformCrypto, usePlatformStorage } from "../../context/platform-context";
import {
	performSRPLogin,
	storeLoginSession,
	type LoginResult,
	type SRPLoginInput,
} from "../../auth";

/**
 * Options for useLogin hook
 */
export interface UseLoginOptions {
	/**
	 * Callback when login succeeds.
	 * Use this for navigation, showing success messages, etc.
	 */
	onSuccess?: (result: LoginResult, input: SRPLoginInput) => void | Promise<void>;

	/**
	 * Callback when login fails.
	 * Use this for showing error messages.
	 */
	onError?: (error: Error, input: SRPLoginInput) => void;

	/**
	 * Whether to enable biometric after login.
	 * Only applicable on platforms that support biometric (desktop/mobile).
	 * Defaults to false.
	 */
	enableBiometric?: boolean;
}

/**
 * Extended login input with additional options
 */
export interface LoginInput extends SRPLoginInput {
	/**
	 * Override enableBiometric option for this specific login.
	 */
	enableBiometric?: boolean;
}

/**
 * Hook for performing SRP login.
 *
 * @example
 * ```tsx
 * const login = useLogin({
 *   onSuccess: () => navigate('/vault'),
 *   onError: (error) => toast.error(error.message),
 * });
 *
 * const handleSubmit = (email, password, secretKey) => {
 *   login.mutate({ email, password, secretKey });
 * };
 * ```
 */
export function useLogin(
	options: UseLoginOptions = {},
): UseMutationResult<LoginResult, Error, LoginInput> {
	const trpcClient = useTRPCClient();
	const crypto = usePlatformCrypto();
	const storage = usePlatformStorage();

	return useMutation({
		mutationFn: async (input: LoginInput) => {
			// Perform SRP login
			const result = await performSRPLogin(
				{
					email: input.email,
					password: input.password,
					secretKey: input.secretKey,
				},
				{ crypto, trpcClient, storage },
			);

			// Enable biometric if requested and supported
			const shouldEnableBiometric =
				input.enableBiometric ?? options.enableBiometric;
			if (shouldEnableBiometric && storage.supportsBiometric && storage.enableBiometric) {
				await storage.enableBiometric(input.email);
			}

			// Store session data
			await storeLoginSession(result, input.secretKey, storage, input.email);

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
