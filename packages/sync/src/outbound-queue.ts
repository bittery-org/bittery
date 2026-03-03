import type { SyncStorage } from "./types";

export interface PendingMutation {
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
	accountEmail: string;
	timestamp: number;
	retryCount: number;
}

export interface TempIdMapping {
	tempId: string;
	realId: string;
	accountEmail: string;
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

const QUEUE_INDEX_KEY = "bittery_pending_mutation_accounts";

function normalizeEmail(email: string): string {
	return email.toLowerCase();
}

function sanitizeEmailLegacy(email: string): string {
	return normalizeEmail(email).replace(/[^a-z0-9]/g, "_");
}

function getQueueKeyForEmail(email: string): string {
	return `bittery_pending_mutations_${encodeURIComponent(normalizeEmail(email))}`;
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
	private readonly queuesByEmail = new Map<string, PendingMutation[]>();
	private readonly listeners = new Set<() => void>();
	private latestMappings: TempIdMapping[] = [];

	constructor(
		private readonly storage: SyncStorage,
		private readonly clientId: string,
	) {}

	private async persistIndex(): Promise<void> {
		const emails = Array.from(this.queuesByEmail.keys());
		await this.storage.set(QUEUE_INDEX_KEY, emails);
	}

	private async persistQueue(email: string): Promise<void> {
		const normalized = normalizeEmail(email);
		const queue = this.queuesByEmail.get(normalized) ?? [];
		const queueKey = getQueueKeyForEmail(normalized);
		const legacyQueueKey = getLegacyQueueKeyForEmail(normalized);
		if (queue.length === 0) {
			await this.storage.remove(queueKey);
			if (legacyQueueKey !== queueKey) {
				await this.storage.remove(legacyQueueKey);
			}
			this.queuesByEmail.delete(normalized);
		} else {
			await this.storage.set(queueKey, queue);
			if (legacyQueueKey !== queueKey) {
				await this.storage.remove(legacyQueueKey);
			}
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
		const normalized = normalizeEmail(mutation.accountEmail);
		const queue = this.queuesByEmail.get(normalized) ?? [];
		queue.push({
			...mutation,
			accountEmail: normalized,
		});
		queue.sort((a, b) => a.timestamp - b.timestamp);
		this.queuesByEmail.set(normalized, queue);
		void this.persistQueue(normalized);
		this.emit();
	}

	async restore(): Promise<void> {
		this.queuesByEmail.clear();

		const emails =
			(await this.storage.get<string[]>(QUEUE_INDEX_KEY))?.map(
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
					await this.storage.set(queueKey, legacyQueue);
					await this.storage.remove(legacyQueueKey);
				}
			}
			if (queue.length > 0) {
				this.queuesByEmail.set(
					email,
					queue
						.map((entry) => ({
							...entry,
							accountEmail: normalizeEmail(entry.accountEmail),
						}))
						.sort((a, b) => a.timestamp - b.timestamp),
				);
			}
		}

		this.emit();
	}

	getPendingCount(): number {
		let count = 0;
		for (const queue of this.queuesByEmail.values()) {
			count += queue.length;
		}
		return count;
	}

	hasPendingForItem(itemId: string): boolean {
		for (const queue of this.queuesByEmail.values()) {
			if (queue.some((mutation) => mutation.entityId === itemId)) {
				return true;
			}
		}
		return false;
	}

	getPendingForItem(itemId: string): PendingMutation | undefined {
		for (const queue of this.queuesByEmail.values()) {
			const found = queue.find((mutation) => mutation.entityId === itemId);
			if (found) {
				return found;
			}
		}
		return undefined;
	}

	rewritePendingIds(tempId: string, realId: string): void {
		for (const [email, queue] of this.queuesByEmail.entries()) {
			let touched = false;
			for (const mutation of queue) {
				if (mutation.entityId === tempId) {
					mutation.entityId = realId;
					touched = true;
				}
			}
			if (touched) {
				void this.persistQueue(email);
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
			email: string,
		) => OutboundQueueClient | Promise<OutboundQueueClient>,
	): Promise<void> {
		this.latestMappings = [];

		const accountEntries = Array.from(this.queuesByEmail.entries()).sort(
			(a, b) => a[0].localeCompare(b[0]),
		);

		for (const [email, queue] of accountEntries) {
			while (queue.length > 0) {
				const mutation = queue[0];
				if (!mutation) {
					break;
				}
				const client = await getClient(email);

				try {
					await this.processMutation(client, mutation);
					queue.shift();
					await this.persistQueue(email);
					this.emit();
				} catch (error) {
					const status = getHttpStatus(error);

					if (status === 409) {
						try {
							await this.forcePushMutation(client, mutation);
							queue.shift();
							await this.persistQueue(email);
							this.emit();
							continue;
						} catch (forceError) {
							console.error(
								"[OutboundQueue] force-push retry failed:",
								forceError,
							);
							mutation.retryCount += 1;
							await this.persistQueue(email);
							this.emit();
							return;
						}
					}

					if (status === 400 || status === 404) {
						console.warn(
							`[OutboundQueue] Discarding mutation ${mutation.id} (${mutation.type}) due to ${status}`,
						);
						queue.shift();
						await this.persistQueue(email);
						this.emit();
						continue;
					}

					if (isNetworkError(error)) {
						mutation.retryCount += 1;
						await this.persistQueue(email);
						this.emit();
						return;
					}

					console.error(
						`[OutboundQueue] Unexpected error for mutation ${mutation.id}:`,
						error,
					);
					mutation.retryCount += 1;
					await this.persistQueue(email);
					this.emit();
					return;
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
		for (const [email, sourceQueue] of this.queuesByEmail.entries()) {
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
			this.queuesByEmail.set(email, result);
			void this.persistQueue(email);
		}

		this.emit();
	}

	clear(email?: string): void {
		if (email) {
			const normalized = normalizeEmail(email);
			this.queuesByEmail.delete(normalized);
			void this.persistQueue(normalized);
			this.emit();
			return;
		}

		const emails = Array.from(this.queuesByEmail.keys());
		this.queuesByEmail.clear();
		for (const accountEmail of emails) {
			void this.storage.remove(getQueueKeyForEmail(accountEmail));
			void this.storage.remove(getLegacyQueueKeyForEmail(accountEmail));
		}
		void this.storage.remove(QUEUE_INDEX_KEY);
		this.emit();
	}
}
