import type { QueryInvalidator, SyncContextValue } from "@bittery/sync";
import type { QueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext } from "react";
import { useMobileAccountRuntime } from "../contexts/account-context";
import { useMobileSync } from "../hooks/use-mobile-sync";

/**
 * Mobile resolves its client id and active account asynchronously at boot, so like desktop it
 * publishes one member `useSync` cannot: whether that resolution has run yet. Everything else
 * is the shared shape.
 */
interface MobileSyncContextValue extends SyncContextValue {
	isInitialized: boolean;
}

const SyncContext = createContext<MobileSyncContextValue | null>(null);

/**
 * Provider component for sync functionality (Mobile)
 */
export function MobileSyncProvider({
	children,
	queryClient,
	enabled = true,
}: {
	children: ReactNode;
	queryClient: QueryClient;
	enabled?: boolean;
}) {
	const { manager } = useMobileAccountRuntime();
	const syncState = useMobileSync(queryClient, manager, enabled);

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
		throw new Error("useSyncContext must be used within a MobileSyncProvider");
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
		throw new Error(
			"useQueryInvalidator must be used within a MobileSyncProvider",
		);
	}
	return context.invalidator;
}
