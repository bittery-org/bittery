/**
 * useSessionState Hook
 *
 * React hook for getting the current session state.
 * Useful for determining which unlock method to show.
 */

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { getSessionState, type SessionState } from "../../auth";
import { usePlatformStorage } from "../../context/platform-context";

/**
 * Options for useSessionState hook
 */
export interface UseSessionStateOptions {
	/**
	 * Whether to enable the query.
	 */
	enabled?: boolean;

	/**
	 * Refetch interval in milliseconds.
	 * Set to false to disable automatic refetching.
	 */
	refetchInterval?: number | false;
}

/**
 * Hook for getting the current session state.
 *
 * @param accountId - Stable account ID (optional, uses active account if not provided)
 * @param options - Query options
 * @returns Query result with session state
 *
 * @example
 * ```tsx
 * const { data: session, isLoading } = useSessionState();
 *
 * if (session?.canBiometricUnlock && !session.requiresPasswordReentry) {
 *   // Show biometric unlock button
 * } else if (session?.canQuickUnlock) {
 *   // Show password unlock form
 * } else {
 *   // Show full login form
 * }
 * ```
 */
export function useSessionState(
	accountId?: string,
	options: UseSessionStateOptions = {},
): UseQueryResult<SessionState, Error> {
	const storage = usePlatformStorage();

	return useQuery({
		queryKey: ["auth", "sessionState", accountId],
		queryFn: async () => {
			return getSessionState(storage, accountId);
		},
		enabled: options.enabled !== false,
		staleTime: 5 * 1000, // Cache for 5 seconds
		refetchInterval: options.refetchInterval,
	});
}
