import type { IPendingMutationQueue, IQueryInvalidator } from "@bittery/sync";
import {
	type ConnectionStatus,
	getNewTerminalCommandCount,
	type SyncCommandSummary,
} from "@bittery/sync";
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
import { sendMessage } from "../lib/messaging";
import "../lib/popup-account-runtime-bridge";
import { popupAccountVaultRuntime } from "../lib/popup-account-vault-runtime";
import { loadPopupWorkerState } from "../lib/popup-worker-state";
import { createExtensionInvalidator } from "../lib/query-invalidation";
import { vaultRepository } from "../lib/vault-runtime";
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
	const outboundQueue = useMemo(
		() =>
			createWorkerOwnedOutboundQueue({
				sendMessage,
				applyProjection: (command) => vaultRepository.applyItemCommand(command),
				discardProjection: (command) =>
					vaultRepository.discardItemCommandAcknowledgedElsewhere(command),
			}),
		[],
	);

	// Worker state is advisory for the popup. Each request settles independently,
	// while the account Vault runtime opens local reads outside this effect.
	useEffect(() => {
		let mounted = true;
		void loadPopupWorkerState({
			status: async () => {
				const response = await sendMessage({ type: "GET_SYNC_STATUS" });
				return response.success ? response.status : undefined;
			},
			clientId: async () => {
				const response = await sendMessage({ type: "GET_SYNC_CLIENT_ID" });
				return response.success ? response.clientId : undefined;
			},
			commandSummary: async () => {
				const response = await sendMessage({
					type: "GET_SYNC_COMMAND_SUMMARY",
				});
				return response.success ? response.summary : undefined;
			},
			recoverStaged: () => outboundQueue.recoverStaged(),
		}).then((workerState) => {
			if (!mounted) return;
			if (workerState.status) setStatus(workerState.status);
			if (workerState.clientId) setClientId(workerState.clientId);
			if (workerState.commandSummary) {
				commandSummaryRef.current = workerState.commandSummary;
				commandSummaryInitializedRef.current = true;
			}
			setIsInitialized(true);
		});
		return () => {
			mounted = false;
		};
	}, [outboundQueue]);

	const handleFullRefresh = useCallback(async () => {
		await popupAccountVaultRuntime.reloadFromCache();
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
					vaultRepository,
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
	}, [handleFullRefresh, m]);

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
