import { getOrCreateClientId, useSync } from "@bittery/sync";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { storage } from "@/lib/storage";

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
	const [serverUrl, setServerUrl] = useState("");
	const clientId = useMemo(() => getClientId(), []);

	useEffect(() => {
		storage.getServerUrl().then((url) => setServerUrl(url || ""));
	}, []);

	const getAuthTokenAsync = useCallback(async () => {
		return (await storage.getAuthToken()) || null;
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
