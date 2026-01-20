import { getAuthToken, getServerUrl } from "@bittery/crypto/session-storage";
import { getOrCreateClientId, useSync } from "@bittery/sync";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

/**
 * Get or create a unique client ID for this browser session
 */
function getClientId(): string {
	if (typeof window === "undefined") {
		return "server";
	}
	return getOrCreateClientId(window.sessionStorage);
}

/**
 * Web-specific sync hook that integrates with existing auth system
 */
export function useWebSync(queryClient: QueryClient, enabled = true) {
	const serverUrl = getServerUrl() || "";
	const clientId = useMemo(() => getClientId(), []);

	const getAuthTokenAsync = useCallback(async () => {
		return getAuthToken() || null;
	}, []);

	return useSync({
		serverUrl,
		getAuthToken: getAuthTokenAsync,
		clientId,
		queryClient,
		enabled: enabled && !!serverUrl,
	});
}

/**
 * Get the client ID for use in mutations
 */
export function useSyncClientId(): string {
	return useMemo(() => getClientId(), []);
}
