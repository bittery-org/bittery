/**
 * useLogin Hook
 *
 * React hook for performing SRP login with password + secret key.
 * Wraps the core performSRPLogin utility with React Query mutation.
 */

import { useRPCClient } from "@bittery/shared/rpc";
import { createRpcClientForServer } from "@bittery/shared/rpc-client-factory";
import { type UseMutationResult, useMutation } from "@tanstack/react-query";
import {
	type LoginResult,
	performSRPLogin,
	type SRPLoginInput,
	storeLoginSession,
} from "../../auth";
import {
	usePlatformCrypto,
	usePlatformStorage,
} from "../../context/platform-context";

/**
 * Options for useLogin hook
 */
export interface UseLoginOptions {
	/**
	 * Callback when login succeeds.
	 * Use this for navigation, showing success messages, etc.
	 */
	onSuccess?: (
		result: LoginResult,
		input: SRPLoginInput,
	) => void | Promise<void>;

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
	/**
	 * Server URL to use for this login request.
	 * When provided, a dedicated RPC client is created for this server URL
	 * instead of using the default client. Use this when the user can configure
	 * a custom server URL (e.g. self-hosted instances).
	 */
	serverUrl?: string;
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
	const rpcClient = useRPCClient();
	const crypto = usePlatformCrypto();
	const storage = usePlatformStorage();

	return useMutation({
		mutationFn: async (input: LoginInput) => {
			const rpcClientForRequest = input.serverUrl
				? createRpcClientForServer(input.serverUrl)
				: rpcClient;

			// Perform SRP login
			const result = await performSRPLogin(
				{
					email: input.email,
					password: input.password,
					secretKey: input.secretKey,
				},
				{ crypto, rpcClient: rpcClientForRequest, storage },
			);

			// Enable biometric if requested and supported
			const shouldEnableBiometric =
				input.enableBiometric ?? options.enableBiometric;
			if (
				shouldEnableBiometric &&
				storage.supportsBiometric &&
				storage.enableBiometric
			) {
				await storage.enableBiometric(input.email);
			}

			// Store session data
			await storeLoginSession(result, input.secretKey, storage, input.email);

			// For multi-account platforms, set this as the active account
			if (storage.supportsMultiAccount) {
				await storage.setActiveAccount({ type: "single", email: input.email });
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
