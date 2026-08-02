import { type CatchUpClient, runCatchUp } from "./catch-up";
import { type DeltaSyncClient, performDeltaSync } from "./delta-sync";
import type { OutboundQueue, OutboundQueueClient } from "./outbound-queue";
import { createSyncManager, type SyncManager } from "./sync-manager";
import type {
	ConnectionStatus,
	SessionRevokedControlPayload,
	SyncEvent,
	SyncItemCache,
	SyncManagerOptions,
	SyncStatus,
} from "./types";

export interface SyncOrchestratorOptions {
	syncManager: Omit<SyncManagerOptions, "onStatusChange">;
	rpcClient: DeltaSyncClient & CatchUpClient;
	itemCache: SyncItemCache;
	outboundQueue: OutboundQueue;
	itemCacheAccountId?: string | null;
	itemCacheAccountEmail?: string | null;
	itemCacheServerUrl?: string | null;
	getClientForAccount?: (
		accountId: string,
	) => OutboundQueueClient | Promise<OutboundQueueClient>;
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
	) => OutboundQueueClient | Promise<OutboundQueueClient>;
	private readonly onEventProcessed?: (event: SyncEvent) => Promise<void>;

	private status: SyncStatus = {
		connectionStatus: "disconnected",
		lastSyncTime: null,
		pendingChanges: 0,
		error: null,
	};
	private readonly unsubscribeQueue: () => void;

	private catchUpInFlight = false;
	private drainingInFlight = false;

	constructor(private readonly options: SyncOrchestratorOptions) {
		this.itemCacheAccountId = options.itemCacheAccountId;
		this.itemCacheAccountEmail = options.itemCacheAccountEmail;
		this.itemCacheServerUrl = options.itemCacheServerUrl;
		this.getClientForAccount = options.getClientForAccount;
		this.onEventProcessed = options.onEventProcessed;

		this.syncManager = createSyncManager({
			...options.syncManager,
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
		if (this.options.outboundQueue.hasPendingForItem(event.entityId)) {
			await this.acknowledgeEvent(event);
			return;
		}

		await performDeltaSync(
			this.options.rpcClient,
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
			return;
		}
		this.catchUpInFlight = true;

		try {
			const cursor = await this.syncManager.getStoredLastSyncCursor();

			const result = await runCatchUp({
				client: this.options.rpcClient,
				initialCursor: cursor ?? { id: "" },
				shouldProcessEvent: (event) =>
					event.clientId !== this.options.outboundQueue.getClientId() &&
					!this.options.outboundQueue.hasPendingForItem(event.entityId),
				onEvent: async (event) => {
					await this.applyEvent(event);
				},
				onRequiresFullRefresh: async () => {
					await this.options.itemCache.clearItemCache(
						this.getDeltaSyncAccountScope(),
					);
				},
			});

			await this.syncManager.setStoredLastSyncCursor(result.cursor);
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
				return this.options.rpcClient as unknown as OutboundQueueClient;
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
