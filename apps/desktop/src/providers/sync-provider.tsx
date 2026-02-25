import type {
	OutboundQueue,
	QueryInvalidator,
	SyncStatus,
} from "@bittery/sync";
import type { QueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext } from "react";
import { useDesktopClientId, useDesktopSync } from "../hooks/use-desktop-sync";

/**
 * Context for sync state
 */
interface SyncContextValue {
	status: SyncStatus;
	clientId: string;
	isConnected: boolean;
	isOnline: boolean;
	isInitialized: boolean;
	reconnect: () => Promise<void>;
	disconnect: () => void;
	invalidator: QueryInvalidator;
	outboundQueue: OutboundQueue;
}

const SyncContext = createContext<SyncContextValue | null>(null);

/**
 * Provider component for sync functionality (Desktop)
 */
export function DesktopSyncProvider({
	children,
	queryClient,
	enabled = true,
}: {
	children: ReactNode;
	queryClient: QueryClient;
	enabled?: boolean;
}) {
	const syncState = useDesktopSync(queryClient, enabled);

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
		throw new Error("useSyncContext must be used within a DesktopSyncProvider");
	}
	return context;
}

/**
 * Hook to get client ID without needing the full context
 * Useful for mutations that need to pass clientId
 */
export function useClientId(): string {
	return useDesktopClientId();
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
			"useQueryInvalidator must be used within a DesktopSyncProvider",
		);
	}
	return context.invalidator;
}
