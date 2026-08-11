import { type CatchUpApiClient, runCatchUp } from "./catch-up";
import { type DeltaSyncApiClient, performDeltaSync } from "./delta-sync";
import type { OutboundQueue, OutboundQueueApiClient } from "./outbound-queue";
import { createSyncManager, type SyncManager } from "./sync-manager";
import type {
	ConnectionStatus,
	SessionRevokedControlPayload,
	SyncEvent,
	SyncItemCache,
	SyncManagerOptions,
	SyncStatus,
} from "./types";

export type SyncApiClient = CatchUpApiClient &
	DeltaSyncApiClient &
	OutboundQueueApiClient & {
		sync: {
			events(signal?: AbortSignal): Promise<Response>;
		};
	};

export interface SyncOrchestratorOptions {
	syncManager: Omit<
		SyncManagerOptions,
		"onStatusChange" | "onSessionRevoked" | "onSyncPing" | "openSyncEvents"
	>;
	apiClient: SyncApiClient;
	itemCache: SyncItemCache;
	outboundQueue: OutboundQueue;
	itemCacheAccountId?: string | null;
	itemCacheAccountEmail?: string | null;
	itemCacheServerUrl?: string | null;
	getClientForAccount?: (
		accountId: string,
	) => OutboundQueueApiClient | Promise<OutboundQueueApiClient>;
	refreshFromServer?: (
		apiClient: SyncApiClient,
		accountId: string,
	) => Promise<void>;
	onEventProcessed?: (event: SyncEvent) => Promise<void>;
	onSessionRevoked?: (
		payload: SessionRevokedControlPayload,
	) => void | Promise<void>;
	drainOutboundQueue?: boolean;
}

export class SyncOrchestrator {
	private readonly syncManager: SyncManager;
	private readonly listeners = new Set<(status: SyncStatus) => void>();
	private readonly itemCacheAccountEmail?: string | null;
	private readonly itemCacheAccountId?: string | null;
	private readonly itemCacheServerUrl?: string | null;
	private readonly getClientForAccount?: (
		accountId: string,
	) => OutboundQueueApiClient | Promise<OutboundQueueApiClient>;
	private readonly onEventProcessed?: (event: SyncEvent) => Promise<void>;

	private status: SyncStatus = {
		connectionStatus: "disconnected",
		lastSyncTime: null,
		pendingChanges: 0,
		error: null,
	};
	private readonly unsubscribeQueue: () => void;

	private catchUpInFlight = false;
	private catchUpRequested = false;
	private drainingInFlight = false;

	constructor(private readonly options: SyncOrchestratorOptions) {
		this.itemCacheAccountId = options.itemCacheAccountId;
		this.itemCacheAccountEmail = options.itemCacheAccountEmail;
		this.itemCacheServerUrl = options.itemCacheServerUrl;
		this.getClientForAccount = options.getClientForAccount;
		this.onEventProcessed = options.onEventProcessed;

		this.syncManager = createSyncManager({
			...options.syncManager,
			openSyncEvents: (signal) => options.apiClient.sync.events(signal),
			onStatusChange: (connectionStatus) => {
				void this.handleStatusChange(connectionStatus);
			},
			onSessionRevoked: (payload) => {
				void options.onSessionRevoked?.(payload);
			},
			onSyncPing: () => {
				void this.handleSyncPing();
			},
		});

		this.unsubscribeQueue = this.options.outboundQueue.subscribe(() => {
			const pendingChanges = this.options.outboundQueue.getPendingCount();
			this.setStatus({ pendingChanges });

			// Drain newly enqueued mutations immediately when already connected.
			if (
				this.shouldDrainOutboundQueue() &&
				pendingChanges > 0 &&
				this.status.connectionStatus === "connected"
			) {
				void this.drainQueue().catch((error) => {
					console.error(
						"[SyncOrchestrator] Queue drain failed while connected:",
						error,
					);
				});
			}
		});
	}

	private emit(): void {
		for (const listener of this.listeners) {
			listener(this.status);
		}
	}

	private setStatus(patch: Partial<SyncStatus>): void {
		this.status = {
			...this.status,
			...patch,
		};
		this.emit();
	}

	subscribe(listener: (status: SyncStatus) => void): () => void {
		this.listeners.add(listener);
		listener(this.status);
		return () => {
			this.listeners.delete(listener);
		};
	}

	getStatus(): SyncStatus {
		return this.status;
	}

	private getDeltaSyncAccountEmail(): string | undefined {
		return this.itemCacheAccountEmail ?? undefined;
	}

	/**
	 * An email is not an account identity. Falling back to one named an `ItemCache`
	 * collection after an email and made the coordinator mint a repo keyed by one.
	 */
	private getDeltaSyncAccountScope(): string {
		if (!this.itemCacheAccountId) {
			throw new Error("Sync requires an accountId scope");
		}
		return this.itemCacheAccountId;
	}

	private getDeltaSyncServerUrl(): string | undefined {
		return this.itemCacheServerUrl ?? undefined;
	}

	private shouldDrainOutboundQueue(): boolean {
		return this.options.drainOutboundQueue !== false;
	}

	private async acknowledgeEvent(event: SyncEvent): Promise<void> {
		await this.syncManager.setStoredLastSyncCursor({ id: event.id });
		this.setStatus({
			lastSyncTime: event.timestamp,
		});
	}

	private async applyEvent(event: SyncEvent): Promise<void> {
		await performDeltaSync(
			this.options.apiClient,
			this.options.itemCache,
			event,
			this.getDeltaSyncAccountScope(),
			this.getDeltaSyncServerUrl(),
			this.getDeltaSyncAccountEmail(),
		);
		await this.onEventProcessed?.(event);
		await this.acknowledgeEvent(event);
	}

	private async handleSyncPing(): Promise<void> {
		try {
			await this.runCatchUp();
			if (this.shouldDrainOutboundQueue()) {
				await this.drainQueue();
			}
		} catch (error) {
			console.error("[SyncOrchestrator] Sync ping handling failed:", error);
		}
	}

	private async runCatchUp(): Promise<void> {
		if (this.catchUpInFlight) {
			this.catchUpRequested = true;
			return;
		}
		this.catchUpInFlight = true;

		try {
			do {
				this.catchUpRequested = false;
				const cursor = await this.syncManager.getStoredLastSyncCursor();

				const result = await runCatchUp({
					client: this.options.apiClient,
					initialCursor: cursor ?? { id: "" },
					onEvent: async (event) => {
						await this.applyEvent(event);
					},
					onRequiresFullRefresh: async () => {
						if (!this.options.refreshFromServer) {
							throw new Error("Sync requires a staged full-refresh handler");
						}
						await this.options.refreshFromServer(
							this.options.apiClient,
							this.getDeltaSyncAccountScope(),
						);
					},
				});

				await this.syncManager.setStoredLastSyncCursor(result.cursor);
			} while (this.catchUpRequested);
		} finally {
			this.catchUpInFlight = false;
		}
	}

	private async drainQueue(): Promise<void> {
		if (this.drainingInFlight) {
			return;
		}
		this.drainingInFlight = true;

		try {
			this.options.outboundQueue.compact();
			await this.options.outboundQueue.drain((accountId) => {
				if (this.getClientForAccount) {
					return this.getClientForAccount(accountId);
				}
				return this.options.apiClient;
			});

			for (const mapping of this.options.outboundQueue.consumeTempIdMappings()) {
				this.options.itemCache.replaceItemId(
					mapping.tempId,
					mapping.realId,
					mapping.accountId,
				);
			}
		} finally {
			this.drainingInFlight = false;
		}
	}

	private async handleStatusChange(
		connectionStatus: ConnectionStatus,
	): Promise<void> {
		this.setStatus({
			connectionStatus,
			error: connectionStatus === "error" ? "Connection failed" : null,
		});

		if (connectionStatus === "connected") {
			try {
				await this.runCatchUp();
				if (this.shouldDrainOutboundQueue()) {
					await this.drainQueue();
				}
			} catch (error) {
				console.error("[SyncOrchestrator] Reconnect flow failed:", error);
			}
		}
	}

	async connect(): Promise<void> {
		await this.syncManager.connect();
	}

	disconnect(): void {
		this.syncManager.disconnect();
		this.setStatus({
			connectionStatus: "disconnected",
			error: null,
		});
	}

	async reconnect(): Promise<void> {
		this.syncManager.disconnect();
		await this.syncManager.connect();
	}

	dispose(): void {
		this.unsubscribeQueue();
		this.disconnect();
		this.listeners.clear();
	}
}
