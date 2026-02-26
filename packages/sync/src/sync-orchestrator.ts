import { type CatchUpClient, runCatchUp } from "./catch-up";
import { type DeltaSyncClient, performDeltaSync } from "./delta-sync";
import type { OutboundQueue, OutboundQueueClient } from "./outbound-queue";
import { createSyncManager, type SyncManager } from "./sync-manager";
import type {
	ConnectionStatus,
	ItemCacheAdapter,
	SyncEvent,
	SyncManagerOptions,
	SyncStatus,
} from "./types";

interface MutableItemCacheAdapter extends ItemCacheAdapter {
	replaceItemId?: (tempId: string, realId: string, email?: string) => void;
}

export interface SyncOrchestratorOptions {
	syncManager: Omit<SyncManagerOptions, "onEvent" | "onStatusChange">;
	trpcClient: DeltaSyncClient & CatchUpClient;
	itemCache: MutableItemCacheAdapter;
	outboundQueue: OutboundQueue;
	itemCacheAccountEmail?: string | null;
	getClientForAccount?: (email: string) => OutboundQueueClient;
	onEventProcessed?: (event: SyncEvent) => Promise<void>;
}

export class SyncOrchestrator {
	private readonly syncManager: SyncManager;
	private readonly listeners = new Set<(status: SyncStatus) => void>();
	private readonly itemCacheAccountEmail?: string | null;
	private readonly getClientForAccount?: (email: string) => OutboundQueueClient;
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
		this.itemCacheAccountEmail = options.itemCacheAccountEmail;
		this.getClientForAccount = options.getClientForAccount;
		this.onEventProcessed = options.onEventProcessed;

		this.syncManager = createSyncManager({
			...options.syncManager,
			onEvent: (event) => {
				void this.handleEvent(event);
			},
			onStatusChange: (connectionStatus) => {
				void this.handleStatusChange(connectionStatus);
			},
		});

		this.unsubscribeQueue = this.options.outboundQueue.subscribe(() => {
			const pendingChanges = this.options.outboundQueue.getPendingCount();
			this.setStatus({ pendingChanges });

			// Drain newly enqueued mutations immediately when already connected.
			if (pendingChanges > 0 && this.status.connectionStatus === "connected") {
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

	private async applyEvent(event: SyncEvent): Promise<void> {
		if (this.options.outboundQueue.hasPendingForItem(event.entityId)) {
			return;
		}

		await performDeltaSync(
			this.options.trpcClient,
			this.options.itemCache,
			event,
			this.getDeltaSyncAccountEmail(),
		);
		await this.onEventProcessed?.(event);
		await this.syncManager.setStoredLastSyncCursor({ seq: event.seq });
		this.setStatus({
			lastSyncTime: event.timestamp,
		});
	}

	private async handleEvent(event: SyncEvent): Promise<void> {
		try {
			await this.applyEvent(event);
		} catch (error) {
			console.error("[SyncOrchestrator] Failed to process sync event:", error);
		}
	}

	private async runCatchUp(): Promise<void> {
		if (this.catchUpInFlight) {
			return;
		}
		this.catchUpInFlight = true;

		try {
			const cursor = await this.syncManager.getStoredLastSyncCursor();
			if (!cursor) {
				await this.syncManager.setStoredLastSyncCursor({ seq: 0 });
				return;
			}

			const result = await runCatchUp({
				client: this.options.trpcClient,
				initialCursor: cursor,
				shouldProcessEvent: (event) =>
					event.clientId !== this.options.outboundQueue.getClientId() &&
					!this.options.outboundQueue.hasPendingForItem(event.entityId),
				onEvent: async (event) => {
					await this.applyEvent(event);
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
			await this.options.outboundQueue.drain((email) => {
				if (this.getClientForAccount) {
					return this.getClientForAccount(email);
				}
				return this.options.trpcClient as unknown as OutboundQueueClient;
			});

			for (const mapping of this.options.outboundQueue.consumeTempIdMappings()) {
				this.options.itemCache.replaceItemId?.(
					mapping.tempId,
					mapping.realId,
					mapping.accountEmail,
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
				await this.drainQueue();
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
