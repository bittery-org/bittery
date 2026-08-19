import type { QueryInvalidator, SyncContextValue } from "@bittery/sync";
import type { QueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext } from "react";
import { useWebSync } from "../hooks/use-web-sync";
import { useAccountRuntime } from "./account-runtime-provider";

/** Web adds nothing to what `useSync` publishes; the shape lives in `@bittery/sync`. */
const SyncContext = createContext<SyncContextValue | null>(null);

/**
 * Provider component for sync functionality
 */
export function SyncProvider({
	children,
	queryClient,
	enabled = true,
}: {
	children: ReactNode;
	queryClient: QueryClient;
	enabled?: boolean;
}) {
	const { manager } = useAccountRuntime();
	const syncState = useWebSync(queryClient, manager, enabled);

	return (
		<SyncContext.Provider value={syncState}>{children}</SyncContext.Provider>
	);
}

/**
 * Hook to access sync state
 */
export function useSyncContext() {
	const context = useContext(SyncContext);
	if (!context) {
		throw new Error("useSyncContext must be used within a SyncProvider");
	}
	return context;
}

/**
 * Optional hook that returns null if outside provider
 */
export function useSyncContextOptional() {
	return useContext(SyncContext);
}

/**
 * Hook to get the query invalidator from sync context
 * Use this for centralized query invalidation in mutations
 */
export function useQueryInvalidator(): QueryInvalidator {
	const context = useContext(SyncContext);
	if (!context) {
		throw new Error("useQueryInvalidator must be used within a SyncProvider");
	}
	return context.invalidator;
}
