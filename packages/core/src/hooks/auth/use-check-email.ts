/**
 * useCheckEmail Hook
 *
 * React hook for checking if an email exists on the server.
 * Returns the secret key hint if the account exists.
 */

import { useApiClient } from "@bittery/shared/api";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type { CheckEmailResult } from "../../services/auth-service";

/**
 * Options for useCheckEmail hook
 */
export interface UseCheckEmailOptions {
	/**
	 * Whether to enable the query.
	 * Set to false to disable automatic fetching.
	 */
	enabled?: boolean;
}

/**
 * Hook for checking if an email exists on the server.
 *
 * @param email - Email to check (query is disabled if empty/undefined)
 * @param options - Query options
 * @returns Query result with exists flag and secret key hint
 *
 * @example
 * ```tsx
 * const [email, setEmail] = useState('');
 * const { data: emailCheck, isLoading } = useCheckEmail(email);
 *
 * if (emailCheck?.exists) {
 *   console.log('Account exists, hint:', emailCheck.secretKeyHint);
 * }
 * ```
 */
export function useCheckEmail(
	email?: string,
	options: UseCheckEmailOptions = {},
): UseQueryResult<CheckEmailResult, Error> {
	const apiClient = useApiClient();

	// Only enable if email is provided and looks valid
	const hasValidEmail = Boolean(email?.includes("@"));
	const enabled = options.enabled !== false && hasValidEmail;

	return useQuery({
		queryKey: ["auth", "checkEmail", email],
		queryFn: async (): Promise<CheckEmailResult> => {
			if (!email) {
				throw new Error("Email is required");
			}
			return (await apiClient.auth.checkEmail({ email })).data;
		},
		enabled,
		staleTime: 60 * 1000, // Cache for 1 minute
		retry: false, // Don't retry on failure
	});
}
