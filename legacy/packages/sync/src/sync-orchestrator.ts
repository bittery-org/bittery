import { type CatchUpApiClient, runCatchUp } from "./catch-up";
import { type DeltaSyncApiClient, performDeltaSync } from "./delta-sync";
import type { OutboundQueue, OutboundQueueApiClient } from "./outbound-queue";
import { createSyncManager, type SyncManager } from "./sync-manager";
import type {
	ConnectionStatus,
	SessionRevokedControlPayload,
	SyncCursor,
	SyncEvent,
	SyncManagerOptions,
	SyncOrchestratorReplica,
	SyncStatus,
} from "./types";

/**
 * Every API surface an orchestrator touches, as the union of what its three collaborators
 * ask for. It used to intersect a hand-written `{ sync: { events } }` on top; that member is
 * already in `CatchUpApiClient` (`Pick<AppApiClient, "sync">`), so restating it only created
 * a second place for the SSE signature to drift from the contract.
 */
export type SyncApiClient = CatchUpApiClient &
	DeltaSyncApiClient &
	OutboundQueueApiClient;

export interface SyncOrchestratorOptions {
	syncManager: Omit<
		SyncManagerOptions,
		"onStatusChange" | "onSessionRevoked" | "onSyncPing" | "openSyncEvents"
	>;
	apiClient: SyncApiClient;
	itemCache: SyncOrchestratorReplica;
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
	initializeFromServer?: (
		apiClient: SyncApiClient,
		accountId: string,
		currentCursor: SyncCursor | null,
	) => Promise<SyncCursor | null>;
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
		commandSummary: {
			pending: 0,
			retrying: 0,
			conflicted: 0,
			failed: 0,
		},
		error: null,
	};
	private readonly unsubscribeQueue: () => void;

	private catchUpInFlight = false;
	private catchUpRequested = false;
	private initialBaselineValidated = false;
	private drainingInFlight = false;
	private drainRequested = false;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;

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
			const previousPendingChanges = this.status.pendingChanges;
			this.setStatus({
				pendingChanges,
				commandSummary: this.options.outboundQueue.getCommandSummary(),
			});

			// The event stream is a read-path hint only: gating writes on it strands
			// every mutation while the stream is down, connecting, or never opened.
			// A failed push stays queued and retries on the next drain trigger.
			// Only a grown queue triggers a drain here: retry bookkeeping also emits,
			// and draining on it re-runs the same failing mutation in a tight loop.
			if (
				this.shouldDrainOutboundQueue() &&
				pendingChanges > previousPendingChanges
			) {
				void this.drainQueue().catch((error) => {
					console.error("[SyncOrchestrator] Queue drain failed:", error);
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
	 * collection after an email and made the repository open a replica keyed by one.
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
				let baseline = await this.syncManager.getStoredSyncBaseline();
				if (
					this.options.initializeFromServer &&
					(!this.initialBaselineValidated || !baseline)
				) {
					const cursor = await this.options.initializeFromServer(
						this.options.apiClient,
						this.getDeltaSyncAccountScope(),
						baseline?.cursor ?? null,
					);
					await this.syncManager.setStoredSyncBaseline(cursor);
					baseline = { initialized: true, cursor };
					this.initialBaselineValidated = true;
				}
				const cursor = baseline?.cursor;

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

				if (result.cursor.id) {
					await this.syncManager.setStoredLastSyncCursor(result.cursor);
				} else if (baseline) {
					await this.syncManager.setStoredSyncBaseline(null);
				}
			} while (this.catchUpRequested);
		} finally {
			this.catchUpInFlight = false;
		}
	}

	private async drainQueue(): Promise<void> {
		// `compact()` swaps the queue arrays a running drain is shifting from, so a
		// concurrent drain could resurrect an already-sent mutation. Overlapping
		// callers are coalesced into a follow-up pass instead of being dropped,
		// otherwise a mutation enqueued mid-drain never gets pushed.
		if (this.drainingInFlight) {
			this.drainRequested = true;
			return;
		}
		this.drainingInFlight = true;

		try {
			do {
				this.drainRequested = false;
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
			} while (this.drainRequested);
		} finally {
			this.drainingInFlight = false;
			this.scheduleRetry();
		}
	}

	private scheduleRetry(): void {
		if (this.retryTimer !== undefined) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
		const retryAt = this.options.outboundQueue.getNextRetryAt();
		if (retryAt === undefined) {
			return;
		}
		this.retryTimer = setTimeout(
			() => {
				this.retryTimer = undefined;
				void this.drainQueue().catch((error) => {
					console.error("[SyncOrchestrator] Scheduled retry failed:", error);
				});
			},
			Math.max(0, retryAt - Date.now()),
		);
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
		this.initialBaselineValidated = false;
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
		if (this.retryTimer !== undefined) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
		this.unsubscribeQueue();
		this.disconnect();
		this.listeners.clear();
	}
}
