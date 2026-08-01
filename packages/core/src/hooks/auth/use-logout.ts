/**
 * useLogout Hook
 *
 * React hook for logging out and clearing session data.
 */

import { useRPCClient } from "@bittery/shared/rpc";
import {
	clearAccountRpcClient,
	clearRpcClientCache,
} from "@bittery/shared/rpc-client-factory";
import { resolveAccountScopeId } from "@bittery/storage/account-id";
import {
	type UseMutationResult,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { clearSession } from "../../auth";
import {
	usePlatformItemCache,
	usePlatformStorage,
} from "../../context/platform-context";

/**
 * Options for useLogout hook
 */
export interface UseLogoutOptions {
	/**
	 * Callback when logout succeeds.
	 * Use this for navigation to login screen.
	 */
	onSuccess?: () => void | Promise<void>;

	/**
	 * Callback when logout fails.
	 */
	onError?: (error: Error) => void;
}

/**
 * Input for logout
 */
export interface LogoutInput {
	/**
	 * Email for multi-account platforms.
	 * Optional - uses active account if not provided.
	 */
	email?: string;

	/**
	 * Whether to clear the secret key as well (full logout).
	 * If false, only clears session data (allows quick unlock on next login).
	 * Defaults to true.
	 */
	clearSecretKey?: boolean;

	/**
	 * Whether to notify the server about logout.
	 * Set to false if already logged out server-side (e.g., session expired).
	 * Defaults to true.
	 */
	notifyServer?: boolean;
}

/**
 * Hook for logging out.
 *
 * @example
 * ```tsx
 * const logout = useLogout({
 *   onSuccess: () => navigate('/login'),
 *   onError: (error) => console.error('Logout failed:', error),
 * });
 *
 * // Full logout (clears secret key)
 * logout.mutate({ clearSecretKey: true });
 *
 * // Lock only (keeps secret key for quick unlock)
 * logout.mutate({ clearSecretKey: false });
 * ```
 */
export function useLogout(
	options: UseLogoutOptions = {},
): UseMutationResult<void, Error, LogoutInput> {
	const rpcClient = useRPCClient();
	const storage = usePlatformStorage();
	const itemCache = usePlatformItemCache();
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (input: LogoutInput) => {
			const { email, clearSecretKey = true, notifyServer = true } = input;

			// Notify server about logout (invalidate session)
			if (notifyServer) {
				try {
					await rpcClient.auth.logout.mutate();
				} catch {
					// Ignore server errors during logout
					// The user still wants to clear local data
				}
			}

			const resolvedAccountId = await resolveAccountScopeId(storage, email);

			// Clear local session data. A full sign-out also drops the account's
			// encrypted item cache — `clearSession` sequences both, because
			// `AccountStore` cannot reach the cache.
			await clearSession(storage, itemCache, resolvedAccountId, clearSecretKey);

			if (resolvedAccountId) {
				const authToken = await storage.getAuthToken(resolvedAccountId);
				const serverUrl = await storage.getServerUrl(resolvedAccountId);
				if (authToken && serverUrl) {
					clearAccountRpcClient(authToken, serverUrl);
				}
			} else {
				clearRpcClientCache();
			}
		},
		onSuccess: async () => {
			// Clear all cached queries
			queryClient.clear();
			await options.onSuccess?.();
		},
		onError: (error) => {
			options.onError?.(error);
		},
	});
}

/**
 * useLock Hook
 *
 * Convenience hook for locking without full logout.
 * Keeps secret key for quick unlock.
 */
export function useLock(
	options: Omit<UseLogoutOptions, "clearSecretKey"> = {},
): UseMutationResult<void, Error, Omit<LogoutInput, "clearSecretKey">> {
	const logout = useLogout(options);

	return useMutation({
		mutationFn: async (input: Omit<LogoutInput, "clearSecretKey">) => {
			await logout.mutateAsync({ ...input, clearSecretKey: false });
		},
		onSuccess: options.onSuccess,
		onError: options.onError,
	});
}
