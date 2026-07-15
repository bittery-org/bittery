import type { SyncStorage } from "./types";

export interface PendingMutation {
	accountId: string;
	id: string;
	type:
		| "create"
		| "update"
		| "delete"
		| "permanent_delete"
		| "restore"
		| "move"
		| "toggle_favorite";
	entityId: string;
	vaultId: string;
	targetVaultId?: string;
	category?: string;
	encryptedPayload?: {
		encryptedData: string;
		encryptionIv: string;
		encryptionAlgorithm: string;
	};
	favorite?: boolean;
	baseVersion: number;
	accountEmail?: string;
	timestamp: number;
	retryCount: number;
}

export interface TempIdMapping {
	tempId: string;
	realId: string;
	accountId: string;
	accountEmail?: string;
}

export interface OutboundQueueClient {
	vault: {
		createItem: {
			mutate: (input: {
				itemId?: string;
				vaultId: string;
				category: string;
				encryptedData: string;
				encryptionIv: string;
				encryptionAlgorithm: string;
			}) => Promise<{ itemId?: string; id?: string }>;
		};
		updateItem: {
			mutate: (input: {
				itemId: string;
				encryptedData: string;
				encryptionIv: string;
				encryptionAlgorithm?: string;
			}) => Promise<unknown>;
		};
		deleteItem: {
			mutate: (input: { itemId: string }) => Promise<unknown>;
		};
		permanentlyDeleteItem: {
			mutate: (input: { itemId: string }) => Promise<unknown>;
		};
		restoreItem: {
			mutate: (input: { itemId: string }) => Promise<unknown>;
		};
		moveItem: {
			mutate: (input: {
				itemId: string;
				sourceVaultId: string;
				targetVaultId: string;
				encryptedData: string;
				encryptionIv: string;
				encryptionAlgorithm?: string;
			}) => Promise<unknown>;
		};
		toggleFavorite: {
			mutate: (input: {
				itemId: string;
				favorite: boolean;
			}) => Promise<unknown>;
		};
	};
}

const QUEUE_INDEX_KEY = "bittery_pending_mutation_account_ids_v2";
const LEGACY_QUEUE_INDEX_KEY = "bittery_pending_mutation_accounts";

function normalizeEmail(email: string): string {
	return email.toLowerCase();
}

function sanitizeEmailLegacy(email: string): string {
	return normalizeEmail(email).replace(/[^a-z0-9]/g, "_");
}

function getQueueKeyForEmail(email: string): string {
	return `bittery_pending_mutations_${encodeURIComponent(normalizeEmail(email))}`;
}

function getQueueKeyForAccountId(accountId: string): string {
	return `bittery_pending_mutations_v2_${encodeURIComponent(accountId)}`;
}

function getLegacyQueueKeyForEmail(email: string): string {
	return `bittery_pending_mutations_${sanitizeEmailLegacy(email)}`;
}

function getHttpStatus(error: unknown): number | null {
	if (!error || typeof error !== "object") {
		return null;
	}

	const maybeStatus = (error as { status?: unknown }).status;
	if (typeof maybeStatus === "number") {
		return maybeStatus;
	}

	const maybeDataStatus = (error as { data?: { httpStatus?: unknown } }).data
		?.httpStatus;
	if (typeof maybeDataStatus === "number") {
		return maybeDataStatus;
	}

	return null;
}

function isNetworkError(error: unknown): boolean {
	const status = getHttpStatus(error);
	if (status !== null) {
		return status >= 500;
	}

	const message = error instanceof Error ? error.message : String(error ?? "");
	return /network|fetch|offline|timeout|connection|abort/i.test(message);
}

function findLastIndexByEntityAndType(
	queue: PendingMutation[],
	entityId: string,
	type: PendingMutation["type"],
): number {
	for (let i = queue.length - 1; i >= 0; i--) {
		const entry = queue[i];
		if (!entry) {
			continue;
		}
		if (entry.entityId === entityId && entry.type === type) {
			return i;
		}
	}
	return -1;
}

export class OutboundQueue {
	private readonly queuesByAccountId = new Map<string, PendingMutation[]>();
	private readonly unresolvedLegacyEmails = new Set<string>();
	private readonly listeners = new Set<() => void>();
	private latestMappings: TempIdMapping[] = [];
	private draining = false;
	private drainRequested = false;

	constructor(
		private readonly storage: SyncStorage,
		private readonly clientId: string,
		private readonly resolveLegacyAccountId?: (
			email: string,
		) => string | undefined | Promise<string | undefined>,
	) {}

	private async persistIndex(): Promise<void> {
		const accountIds = Array.from(this.queuesByAccountId.keys());
		await this.storage.set(QUEUE_INDEX_KEY, accountIds);
	}

	private async persistQueue(accountId: string): Promise<void> {
		const queue = this.queuesByAccountId.get(accountId) ?? [];
		const queueKey = getQueueKeyForAccountId(accountId);
		if (queue.length === 0) {
			await this.storage.remove(queueKey);
			this.queuesByAccountId.delete(accountId);
		} else {
			await this.storage.set(queueKey, queue);
		}
		await this.persistIndex();
	}

	private emit(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	getClientId(): string {
		return this.clientId;
	}

	enqueue(mutation: PendingMutation): void {
		const queue = this.queuesByAccountId.get(mutation.accountId) ?? [];
		queue.push({ ...mutation });
		queue.sort((a, b) => a.timestamp - b.timestamp);
		this.queuesByAccountId.set(mutation.accountId, queue);
		void this.persistQueue(mutation.accountId);
		this.emit();
	}

	async restore(): Promise<void> {
		this.queuesByAccountId.clear();
		this.unresolvedLegacyEmails.clear();

		const accountIds =
			(await this.storage.get<string[]>(QUEUE_INDEX_KEY)) ?? [];
		for (const accountId of accountIds) {
			const queue =
				(await this.storage.get<PendingMutation[]>(
					getQueueKeyForAccountId(accountId),
				)) ?? [];
			if (queue.length > 0) {
				this.queuesByAccountId.set(
					accountId,
					queue
						.map((entry) => ({ ...entry, accountId }))
						.sort((a, b) => a.timestamp - b.timestamp),
				);
			}
		}

		const emails =
			(await this.storage.get<string[]>(LEGACY_QUEUE_INDEX_KEY))?.map(
				normalizeEmail,
			) ?? [];
		for (const email of emails) {
			const queueKey = getQueueKeyForEmail(email);
			const legacyQueueKey = getLegacyQueueKeyForEmail(email);
			let queue = (await this.storage.get<PendingMutation[]>(queueKey)) ?? [];
			if (queue.length === 0 && legacyQueueKey !== queueKey) {
				const legacyQueue =
					(await this.storage.get<PendingMutation[]>(legacyQueueKey)) ?? [];
				if (legacyQueue.length > 0) {
					queue = legacyQueue;
				}
			}
			if (queue.length > 0) {
				let accountId: string | undefined;
				try {
					accountId = await this.resolveLegacyAccountId?.(email);
				} catch {
					accountId = undefined;
				}
				if (!accountId) {
					this.unresolvedLegacyEmails.add(email);
					continue;
				}
				const migrated = queue.map((entry) => ({
					...entry,
					accountId,
					accountEmail: entry.accountEmail ?? email,
				}));
				const existing = this.queuesByAccountId.get(accountId) ?? [];
				this.queuesByAccountId.set(
					accountId,
					[...existing, ...migrated].sort((a, b) => a.timestamp - b.timestamp),
				);
				await this.persistQueue(accountId);
				await this.storage.remove(queueKey);
				if (legacyQueueKey !== queueKey)
					await this.storage.remove(legacyQueueKey);
			}
		}
		await this.storage.set(
			LEGACY_QUEUE_INDEX_KEY,
			Array.from(this.unresolvedLegacyEmails),
		);

		this.emit();
	}

	getPendingCount(): number {
		let count = 0;
		for (const queue of this.queuesByAccountId.values()) {
			count += queue.length;
		}
		return count;
	}

	hasPendingForItem(itemId: string): boolean {
		for (const queue of this.queuesByAccountId.values()) {
			if (queue.some((mutation) => mutation.entityId === itemId)) {
				return true;
			}
		}
		return false;
	}

	getPendingForItem(itemId: string): PendingMutation | undefined {
		for (const queue of this.queuesByAccountId.values()) {
			const found = queue.find((mutation) => mutation.entityId === itemId);
			if (found) {
				return found;
			}
		}
		return undefined;
	}

	rewritePendingIds(tempId: string, realId: string): void {
		for (const [accountId, queue] of this.queuesByAccountId.entries()) {
			let touched = false;
			for (const mutation of queue) {
				if (mutation.entityId === tempId) {
					mutation.entityId = realId;
					touched = true;
				}
			}
			if (touched) {
				void this.persistQueue(accountId);
			}
		}
		this.emit();
	}

	private async processMutation(
		client: OutboundQueueClient,
		mutation: PendingMutation,
	): Promise<void> {
		switch (mutation.type) {
			case "create": {
				const payload = mutation.encryptedPayload;
				if (!payload || !mutation.category) {
					throw new Error(
						`Invalid create mutation payload for ${mutation.entityId}`,
					);
				}
				const result = await client.vault.createItem.mutate({
					itemId: mutation.entityId,
					vaultId: mutation.vaultId,
					category: mutation.category,
					encryptedData: payload.encryptedData,
					encryptionIv: payload.encryptionIv,
					encryptionAlgorithm: payload.encryptionAlgorithm,
				});

				const fallbackId =
					result.id && result.id !== mutation.vaultId ? result.id : undefined;
				const realId = result.itemId ?? fallbackId;
				if (realId && realId !== mutation.entityId) {
					this.latestMappings.push({
						tempId: mutation.entityId,
						realId,
						accountId: mutation.accountId,
						accountEmail: mutation.accountEmail,
					});
					this.rewritePendingIds(mutation.entityId, realId);
				}
				break;
			}
			case "update": {
				const payload = mutation.encryptedPayload;
				if (!payload) {
					throw new Error(
						`Invalid update mutation payload for ${mutation.entityId}`,
					);
				}
				await client.vault.updateItem.mutate({
					itemId: mutation.entityId,
					encryptedData: payload.encryptedData,
					encryptionIv: payload.encryptionIv,
					encryptionAlgorithm: payload.encryptionAlgorithm,
				});
				break;
			}
			case "delete":
				await client.vault.deleteItem.mutate({ itemId: mutation.entityId });
				break;
			case "permanent_delete":
				await client.vault.permanentlyDeleteItem.mutate({
					itemId: mutation.entityId,
				});
				break;
			case "restore":
				await client.vault.restoreItem.mutate({ itemId: mutation.entityId });
				break;
			case "move": {
				const payload = mutation.encryptedPayload;
				if (!payload || !mutation.targetVaultId) {
					throw new Error(`Invalid move payload for ${mutation.entityId}`);
				}
				await client.vault.moveItem.mutate({
					itemId: mutation.entityId,
					sourceVaultId: mutation.vaultId,
					targetVaultId: mutation.targetVaultId,
					encryptedData: payload.encryptedData,
					encryptionIv: payload.encryptionIv,
					encryptionAlgorithm: payload.encryptionAlgorithm,
				});
				break;
			}
			case "toggle_favorite":
				await client.vault.toggleFavorite.mutate({
					itemId: mutation.entityId,
					favorite: mutation.favorite ?? false,
				});
				break;
		}
	}

	private async forcePushMutation(
		client: OutboundQueueClient,
		mutation: PendingMutation,
	): Promise<void> {
		await this.processMutation(client, mutation);
	}

	async drain(
		getClient: (
			accountId: string,
		) => OutboundQueueClient | Promise<OutboundQueueClient>,
	): Promise<void> {
		// Serialize drains across all callers (multiple sync sources may share
		// this queue). A drain triggered while another is in flight is coalesced
		// into a single follow-up pass so no request is lost.
		if (this.draining) {
			this.drainRequested = true;
			return;
		}

		this.draining = true;
		this.latestMappings = [];
		try {
			do {
				this.drainRequested = false;
				await this.drainOnce(getClient);
			} while (this.drainRequested);
		} finally {
			this.draining = false;
		}
	}

	private async drainOnce(
		getClient: (
			accountId: string,
		) => OutboundQueueClient | Promise<OutboundQueueClient>,
	): Promise<void> {
		if (this.unresolvedLegacyEmails.size > 0) {
			throw new Error(
				`Cannot drain ambiguous legacy queues: ${Array.from(this.unresolvedLegacyEmails).join(", ")}`,
			);
		}

		const accountEntries = Array.from(this.queuesByAccountId.entries()).sort(
			(a, b) => a[0].localeCompare(b[0]),
		);

		for (const [accountId, queue] of accountEntries) {
			while (queue.length > 0) {
				const mutation = queue[0];
				if (!mutation) {
					break;
				}
				const client = await getClient(accountId);

				try {
					await this.processMutation(client, mutation);
					queue.shift();
					await this.persistQueue(accountId);
					this.emit();
				} catch (error) {
					const status = getHttpStatus(error);

					if (status === 409) {
						try {
							await this.forcePushMutation(client, mutation);
							queue.shift();
							await this.persistQueue(accountId);
							this.emit();
							continue;
						} catch (forceError) {
							console.error(
								"[OutboundQueue] force-push retry failed:",
								forceError,
							);
							mutation.retryCount += 1;
							await this.persistQueue(accountId);
							this.emit();
							break;
						}
					}

					if (status === 400 || status === 404) {
						console.warn(
							`[OutboundQueue] Discarding mutation ${mutation.id} (${mutation.type}) due to ${status}`,
						);
						queue.shift();
						await this.persistQueue(accountId);
						this.emit();
						continue;
					}

					if (isNetworkError(error)) {
						mutation.retryCount += 1;
						await this.persistQueue(accountId);
						this.emit();
						break;
					}

					console.error(
						`[OutboundQueue] Unexpected error for mutation ${mutation.id}:`,
						error,
					);
					mutation.retryCount += 1;
					await this.persistQueue(accountId);
					this.emit();
					break;
				}
			}
		}
	}

	consumeTempIdMappings(): TempIdMapping[] {
		const mappings = [...this.latestMappings];
		this.latestMappings = [];
		return mappings;
	}

	compact(): void {
		for (const [accountId, sourceQueue] of this.queuesByAccountId.entries()) {
			const sourceWithIndex = sourceQueue.map((mutation, index) => ({
				mutation,
				index,
			}));
			let compacted = [...sourceWithIndex];

			// Drop updates/moves/favorite toggles for items that are subsequently deleted.
			for (const { mutation, index: mutationIndex } of sourceWithIndex) {
				if (
					mutation.type !== "delete" &&
					mutation.type !== "permanent_delete"
				) {
					continue;
				}
				compacted = compacted.filter((candidate) => {
					if (candidate.mutation.entityId !== mutation.entityId) {
						return true;
					}
					if (candidate.mutation.id === mutation.id) {
						return true;
					}
					if (candidate.index > mutationIndex) {
						return true;
					}
					return !(
						candidate.mutation.type === "update" ||
						candidate.mutation.type === "toggle_favorite" ||
						candidate.mutation.type === "move"
					);
				});
			}

			// Collapse sequential updates/toggles/moves for the same item, keep latest.
			const result: PendingMutation[] = [];
			for (const { mutation } of compacted) {
				if (
					mutation.type === "update" ||
					mutation.type === "toggle_favorite" ||
					mutation.type === "move"
				) {
					const previousIndex = findLastIndexByEntityAndType(
						result,
						mutation.entityId,
						mutation.type,
					);
					if (previousIndex >= 0) {
						result.splice(previousIndex, 1, mutation);
					} else {
						result.push(mutation);
					}
					continue;
				}

				if (mutation.type === "permanent_delete") {
					// delete + permanent_delete => keep only permanent_delete
					for (let i = result.length - 1; i >= 0; i--) {
						const candidate = result[i];
						if (!candidate) {
							continue;
						}
						if (
							candidate.entityId === mutation.entityId &&
							candidate.type === "delete"
						) {
							result.splice(i, 1);
						}
					}
				}

				result.push(mutation);
			}

			result.sort((a, b) => a.timestamp - b.timestamp);
			this.queuesByAccountId.set(accountId, result);
			void this.persistQueue(accountId);
		}

		this.emit();
	}

	clear(accountId?: string): void {
		if (accountId) {
			this.queuesByAccountId.delete(accountId);
			void this.persistQueue(accountId);
			this.emit();
			return;
		}

		const accountIds = Array.from(this.queuesByAccountId.keys());
		this.queuesByAccountId.clear();
		for (const queuedAccountId of accountIds) {
			void this.storage.remove(getQueueKeyForAccountId(queuedAccountId));
		}
		void this.storage.remove(QUEUE_INDEX_KEY);
		this.emit();
	}
}
