/**
 * useLogin Hook
 *
 * React hook for performing SRP login with password + secret key.
 * Wraps the core performSRPLogin utility with React Query mutation.
 */

import { useApiClient } from "@bittery/shared/api";
import {
	createApiClientForServer,
	getDefaultServerUrl,
} from "@bittery/shared/api-client-factory";
import { type UseMutationResult, useMutation } from "@tanstack/react-query";
import {
	usePlatformCrypto,
	usePlatformItemCache,
	usePlatformStorage,
} from "../../context/platform-context";
import {
	type LoginResult,
	performSRPLogin,
	type SRPLoginInput,
	storeLoginSessionOwned,
} from "../../services/auth-service";

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
	 * When provided, a dedicated API client is created for this server URL
	 * instead of using the default client. Use this when the user can configure
	 * a custom server URL (e.g. self-hosted instances).
	 */
	serverUrl: string;
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
	const apiClient = useApiClient();
	const crypto = usePlatformCrypto();
	const storage = usePlatformStorage();
	const itemCache = usePlatformItemCache();

	return useMutation({
		mutationFn: async (input: LoginInput) => {
			const serverUrl = (input.serverUrl || getDefaultServerUrl()).replace(
				/\/$/,
				"",
			);
			const apiClientForRequest = input.serverUrl
				? createApiClientForServer(serverUrl)
				: apiClient;

			// Perform SRP login
			const result = await performSRPLogin(
				{
					email: input.email,
					password: input.password,
					secretKey: input.secretKey,
					serverUrl,
				},
				{ crypto, apiClient: apiClientForRequest, storage },
			);

			const shouldEnableBiometric =
				input.enableBiometric ?? options.enableBiometric;

			// Store session data
			const accountId = await storeLoginSessionOwned(
				result,
				input.secretKey,
				storage,
				itemCache,
				crypto,
				input.email,
				{
					serverUrl,
				},
			);

			if (shouldEnableBiometric && (await storage.isBiometricAvailable())) {
				await storage.enableBiometric(accountId);
			}

			// storeLoginSession writes the new account + active selection directly
			// to storage, bypassing the in-memory AccountSessionManager. Refresh it
			// so the account switcher reflects the new account without requiring a
			// lock/unlock cycle.
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
