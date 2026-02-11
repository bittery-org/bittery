import type { ConnectionStatus, SyncEvent } from "@bittery/sync";
import type { IQueryInvalidator } from "@bittery/types";
import type { QueryClient } from "@tanstack/react-query";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";
import { createExtensionInvalidator } from "../lib/query-invalidation";
import { invalidateExtensionQueriesForSyncEvent } from "./sync-event-invalidation";

/**
 * Context for sync state
 */
interface SyncContextValue {
	status: ConnectionStatus;
	clientId: string;
	isConnected: boolean;
	isOnline: boolean;
	isInitialized: boolean;
	invalidator: IQueryInvalidator;
}

const SyncContext = createContext<SyncContextValue | null>(null);

/**
 * Message types from background worker
 */
interface SyncStatusMessage {
	type: "SYNC_STATUS_CHANGED";
	status: ConnectionStatus;
}

interface SyncEventMessage {
	type: "SYNC_EVENT";
	event: SyncEvent;
}

interface SyncFullRefreshMessage {
	type: "SYNC_FULL_REFRESH_REQUIRED";
}

type BackgroundMessage =
	| SyncStatusMessage
	| SyncEventMessage
	| SyncFullRefreshMessage;

function isBackgroundMessage(message: unknown): message is BackgroundMessage {
	if (!message || typeof message !== "object") {
		return false;
	}
	const typed = message as Partial<BackgroundMessage>;
	return (
		typed.type === "SYNC_STATUS_CHANGED" ||
		typed.type === "SYNC_EVENT" ||
		typed.type === "SYNC_FULL_REFRESH_REQUIRED"
	);
}

/**
 * Provider component for sync functionality (Extension)
 * Listens to background worker sync events via chrome.runtime.sendMessage
 */
export function ExtensionSyncProvider({
	children,
	queryClient,
}: {
	children: ReactNode;
	queryClient: QueryClient;
}) {
	const [status, setStatus] = useState<ConnectionStatus>("disconnected");
	const [clientId, setClientId] = useState<string>("");
	const [isInitialized, setIsInitialized] = useState(false);
	const [invalidator] = useState(() => createExtensionInvalidator(queryClient));

	// Initialize: request initial state from background worker
	useEffect(() => {
		(async () => {
			try {
				// Request initial sync status
				const statusResponse = await chrome.runtime.sendMessage({
					type: "GET_SYNC_STATUS",
				});
				if (statusResponse?.status) {
					setStatus(statusResponse.status as ConnectionStatus);
				}

				// Request client ID
				const clientIdResponse = await chrome.runtime.sendMessage({
					type: "GET_SYNC_CLIENT_ID",
				});
				if (clientIdResponse?.clientId) {
					setClientId(clientIdResponse.clientId as string);
				}

				setIsInitialized(true);
			} catch (error) {
				console.error("Failed to initialize sync context:", error);
				setIsInitialized(true); // Still mark as initialized to prevent blocking
			}
		})();
	}, []);

	// Handle sync events and invalidate queries
	const handleSyncEvent = useCallback(
		async (event: SyncEvent) => {
			await invalidateExtensionQueriesForSyncEvent(invalidator, event);
		},
		[invalidator],
	);

	const handleFullRefresh = useCallback(async () => {
		await queryClient.invalidateQueries();
	}, [queryClient]);

	// Listen for messages from background worker
	useEffect(() => {
		const handleMessage = (message: unknown) => {
			if (!isBackgroundMessage(message)) {
				return;
			}

			if (message.type === "SYNC_STATUS_CHANGED") {
				setStatus(message.status);
			} else if (message.type === "SYNC_EVENT") {
				void handleSyncEvent(message.event);
			} else if (message.type === "SYNC_FULL_REFRESH_REQUIRED") {
				void handleFullRefresh();
			}
		};

		chrome.runtime.onMessage.addListener(handleMessage);

		return () => {
			chrome.runtime.onMessage.removeListener(handleMessage);
		};
	}, [handleSyncEvent, handleFullRefresh]);

	const contextValue: SyncContextValue = {
		status,
		clientId,
		isConnected: status === "connected",
		isOnline: status === "connected", // Extension is always online if connected
		isInitialized,
		invalidator,
	};

	return (
		<SyncContext.Provider value={contextValue}>{children}</SyncContext.Provider>
	);
}

/**
 * Hook to access sync state
 */
export function useSyncContext() {
	const context = useContext(SyncContext);
	if (!context) {
		throw new Error(
			"useSyncContext must be used within an ExtensionSyncProvider",
		);
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
export function useQueryInvalidator(): IQueryInvalidator {
	const context = useContext(SyncContext);
	if (!context) {
		throw new Error(
			"useQueryInvalidator must be used within an ExtensionSyncProvider",
		);
	}
	return context.invalidator;
}
