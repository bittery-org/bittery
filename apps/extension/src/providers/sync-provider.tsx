import { createVaultCrypto } from "@bittery/core/services/vault-crypto";
import { getOrCreateVaultRepositoryCoordinator } from "@bittery/core/services/vault-repository-coordinator";
import {
	type ConnectionStatus,
	getNewTerminalCommandCount,
	type SyncCommandSummary,
} from "@bittery/sync";
import type { IPendingMutationQueue, IQueryInvalidator } from "@bittery/types";
import { toast } from "@bittery/ui";
import type { QueryClient } from "@tanstack/react-query";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { isBackgroundEvent } from "../background/events";
import { crypto } from "../lib/crypto";
import { sendMessage } from "../lib/messaging";
import { createExtensionInvalidator } from "../lib/query-invalidation";
import { itemCache, storage } from "../lib/storage";
import {
	isWorkerItemCommandAcknowledgedMessage,
	reconcileWorkerItemCommandAcknowledgement,
} from "../lib/worker-item-acknowledgement";
import { createWorkerOwnedOutboundQueue } from "../lib/worker-owned-outbound-queue";
import { useI18n } from "./i18n-provider";

/**
 * Context for sync state.
 *
 * Deliberately NOT `SyncContextValue` from `@bittery/sync`, which web, desktop and mobile
 * share. This provider does not run a sync engine — the background service worker does, and
 * this is a view of it assembled from runtime messages. Three differences follow, and each
 * would be a lie if it were typed the shared way:
 *
 * - `status` is the worker's {@link ConnectionStatus}, not a `SyncStatus`. The popup never
 *   sees `lastSyncTime` or `pendingChanges`; those live in the worker.
 * - There is no `reconnect`/`disconnect`. A popup closing must not tear down the worker's
 *   connection, so it is not offered the handles.
 * - `invalidator` and `outboundQueue` are the `@bittery/types` seam interfaces rather than
 *   the concrete sync classes, because the implementations here are extension-local: one
 *   invalidates a popup-scoped query client, the other forwards mutations to the worker.
 */
interface SyncContextValue {
	status: ConnectionStatus;
	clientId: string;
	isConnected: boolean;
	isOnline: boolean;
	isInitialized: boolean;
	invalidator: IQueryInvalidator;
	outboundQueue: IPendingMutationQueue;
}

const SyncContext = createContext<SyncContextValue | null>(null);

/**
 * Provider component for sync functionality (Extension)
 * Listens to background worker sync events via runtime messages
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
	const { m } = useI18n();
	const commandSummaryRef = useRef<SyncCommandSummary>({
		pending: 0,
		retrying: 0,
		conflicted: 0,
		failed: 0,
	});
	const commandSummaryInitializedRef = useRef(false);
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
				sendMessage,
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
				const statusResponse = await sendMessage({ type: "GET_SYNC_STATUS" });
				if (statusResponse.success) {
					setStatus(statusResponse.status);
				}

				// Request client ID
				const clientIdResponse = await sendMessage({
					type: "GET_SYNC_CLIENT_ID",
				});
				if (clientIdResponse.success && clientIdResponse.clientId) {
					setClientId(clientIdResponse.clientId);
				}
				const commandResponse = await sendMessage({
					type: "GET_SYNC_COMMAND_SUMMARY",
				});
				if (commandResponse.success) {
					commandSummaryRef.current = commandResponse.summary;
					commandSummaryInitializedRef.current = true;
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
			if (!isBackgroundEvent(message)) {
				return;
			}

			if (message.type === "SYNC_STATUS_CHANGED") {
				setStatus(message.status);
			} else if (message.type === "SYNC_FULL_REFRESH_REQUIRED") {
				void handleFullRefresh();
			} else if (message.type === "SYNC_COMMAND_STATUS_CHANGED") {
				const newTerminalCount = getNewTerminalCommandCount(
					commandSummaryRef.current,
					message.summary,
				);
				commandSummaryRef.current = message.summary;
				if (commandSummaryInitializedRef.current && newTerminalCount > 0) {
					toast.error(m.sync_command_terminal_error(), {
						description: m.sync_command_terminal_error_description(),
					});
				}
				commandSummaryInitializedRef.current = true;
			}
		};

		chrome.runtime.onMessage.addListener(handleMessage);

		return () => {
			chrome.runtime.onMessage.removeListener(handleMessage);
		};
	}, [handleFullRefresh, m, vaultCoordinator]);

	const contextValue: SyncContextValue = {
		status,
		clientId,
		isConnected: status === "connected",
		isOnline: status === "connected", // Extension is always online if connected
		isInitialized,
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
