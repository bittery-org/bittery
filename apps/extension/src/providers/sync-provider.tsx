import { createVaultCrypto } from "@bittery/core/services/vault-crypto";
import { getOrCreateVaultRepositoryCoordinator } from "@bittery/core/services/vault-repository-coordinator";
import type { ConnectionStatus, SyncCommandSummary } from "@bittery/sync";
import type { IPendingMutationQueue, IQueryInvalidator } from "@bittery/types";
import type { QueryClient } from "@tanstack/react-query";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { crypto } from "../lib/crypto";
import { createExtensionInvalidator } from "../lib/query-invalidation";
import { itemCache, storage } from "../lib/storage";
import {
	isWorkerItemCommandAcknowledgedMessage,
	reconcileWorkerItemCommandAcknowledgement,
} from "../lib/worker-item-acknowledgement";
import { createWorkerOwnedOutboundQueue } from "../lib/worker-owned-outbound-queue";

/**
 * Context for sync state
 */
interface SyncContextValue {
	status: ConnectionStatus;
	clientId: string;
	isConnected: boolean;
	isOnline: boolean;
	isInitialized: boolean;
	commandSummary: SyncCommandSummary;
	invalidator: IQueryInvalidator;
	outboundQueue: IPendingMutationQueue;
}

const SyncContext = createContext<SyncContextValue | null>(null);

/**
 * Message types from background worker
 */
interface SyncStatusMessage {
	type: "SYNC_STATUS_CHANGED";
	status: ConnectionStatus;
}

interface SyncFullRefreshMessage {
	type: "SYNC_FULL_REFRESH_REQUIRED";
}

interface SyncCommandStatusMessage {
	type: "SYNC_COMMAND_STATUS_CHANGED";
	summary: SyncCommandSummary;
}

type BackgroundMessage =
	| SyncStatusMessage
	| SyncFullRefreshMessage
	| SyncCommandStatusMessage;

function isBackgroundMessage(message: unknown): message is BackgroundMessage {
	if (!message || typeof message !== "object") {
		return false;
	}
	const typed = message as Partial<BackgroundMessage>;
	return (
		typed.type === "SYNC_STATUS_CHANGED" ||
		typed.type === "SYNC_FULL_REFRESH_REQUIRED" ||
		typed.type === "SYNC_COMMAND_STATUS_CHANGED"
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
	const [commandSummary, setCommandSummary] = useState<SyncCommandSummary>({
		pending: 0,
		retrying: 0,
		conflicted: 0,
		failed: 0,
	});
	const [invalidator] = useState(() => createExtensionInvalidator(queryClient));
	const vaultCoordinator = useMemo(
		() =>
			getOrCreateVaultRepositoryCoordinator(
				crypto,
				createVaultCrypto({ crypto, storage }),
				storage,
				itemCache,
			),
		[],
	);
	const outboundQueue = useMemo(
		() =>
			createWorkerOwnedOutboundQueue({
				sendMessage: (message) => chrome.runtime.sendMessage(message),
				applyProjection: (command) =>
					vaultCoordinator.applyItemCommand(command),
				discardProjection: (command) =>
					vaultCoordinator.discardItemCommandAcknowledgedElsewhere(command),
			}),
		[vaultCoordinator],
	);

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
				const commandResponse = await chrome.runtime.sendMessage({
					type: "GET_SYNC_COMMAND_SUMMARY",
				});
				if (commandResponse?.summary) {
					setCommandSummary(commandResponse.summary as SyncCommandSummary);
				}
				await outboundQueue.recoverStaged();

				setIsInitialized(true);
			} catch (error) {
				console.error("Failed to initialize sync context:", error);
				setIsInitialized(true); // Still mark as initialized to prevent blocking
			}
		})();
	}, [outboundQueue]);

	const handleFullRefresh = useCallback(async () => {
		await queryClient.invalidateQueries();
	}, [queryClient]);

	// Listen for messages from background worker
	useEffect(() => {
		const handleMessage = (
			message: unknown,
			_sender: chrome.runtime.MessageSender,
			sendResponse: (response?: unknown) => void,
		) => {
			if (
				_sender.id === chrome.runtime.id &&
				!_sender.tab &&
				isWorkerItemCommandAcknowledgedMessage(message)
			) {
				void reconcileWorkerItemCommandAcknowledgement(
					message,
					vaultCoordinator,
				).then(
					() => sendResponse({ success: true }),
					(error) => sendResponse({ success: false, error: String(error) }),
				);
				return true;
			}
			if (!isBackgroundMessage(message)) {
				return;
			}

			if (message.type === "SYNC_STATUS_CHANGED") {
				setStatus(message.status);
			} else if (message.type === "SYNC_FULL_REFRESH_REQUIRED") {
				void handleFullRefresh();
			} else if (message.type === "SYNC_COMMAND_STATUS_CHANGED") {
				setCommandSummary(message.summary);
			}
		};

		chrome.runtime.onMessage.addListener(handleMessage);

		return () => {
			chrome.runtime.onMessage.removeListener(handleMessage);
		};
	}, [handleFullRefresh, vaultCoordinator]);

	const contextValue: SyncContextValue = {
		status,
		clientId,
		isConnected: status === "connected",
		isOnline: status === "connected", // Extension is always online if connected
		isInitialized,
		commandSummary,
		invalidator,
		outboundQueue,
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
