import {
	ApiError,
	type AppApiClient,
	isApiErrorStatus,
} from "@bittery/shared/api-client";
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
		encryptionVersion?: number;
		encryptedByUserId?: string;
	};
	favorite?: boolean;
	baseVersion: number;
	accountEmail?: string;
	timestamp: number;
	retryCount: number;
	operationId?: string;
	attemptId?: string;
	status?: "pending" | "retrying" | "conflicted" | "failed";
	lastError?: string;
}

export interface TempIdMapping {
	tempId: string;
	realId: string;
	accountId: string;
	accountEmail?: string;
}

export type OutboundQueueApiClient = Pick<AppApiClient, "items">;

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

function isNetworkError(error: unknown): boolean {
	if (error instanceof ApiError) {
		return error.status >= 500;
	}

	const message = error instanceof Error ? error.message : String(error ?? "");
	return /network|fetch|offline|timeout|connection|abort/i.test(message);
}

function writeOptions(mutation: PendingMutation): {
	etag: string;
	idempotencyKey: string;
} {
	return {
		etag: `"${mutation.baseVersion}"`,
		idempotencyKey: mutation.attemptId ?? mutation.id,
	};
}

function strongNumericEtag(
	etag: string | null | undefined,
): number | undefined {
	const match = /^"(\d+)"$/.exec(etag ?? "");
	if (!match?.[1]) return undefined;
	const version = Number(match[1]);
	return Number.isSafeInteger(version) ? version : undefined;
}

function normalizeMutation(mutation: PendingMutation): PendingMutation {
	return {
		...mutation,
		operationId: mutation.operationId ?? mutation.id,
		attemptId: mutation.attemptId ?? mutation.id,
		status: mutation.status ?? "pending",
	};
}

function newAttemptId(mutation: PendingMutation): string {
	const suffix =
		globalThis.crypto?.randomUUID?.() ??
		`${Date.now()}-${Math.random().toString(36).slice(2)}`;
	return `${mutation.operationId ?? mutation.id}:attempt:${suffix}`;
}

const MAX_RETRY_COUNT = 5;

export class OutboundQueue {
	private readonly queuesByAccountId = new Map<string, PendingMutation[]>();
	private readonly unresolvedLegacyEmails = new Set<string>();
	private readonly listeners = new Set<() => void>();
	private latestMappings: TempIdMapping[] = [];
	private draining = false;
	private drainRequested = false;
	private persistenceTail: Promise<void> = Promise.resolve();

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

	private schedulePersistence(accountId: string): Promise<void> {
		const persistence = this.persistenceTail
			.catch(() => undefined)
			.then(() => this.persistQueue(accountId));
		this.persistenceTail = persistence.catch(() => undefined);
		return persistence;
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

	async enqueue(
		mutation: PendingMutation,
		applyOptimistic?: () => Promise<void>,
	): Promise<void> {
		const queue = this.queuesByAccountId.get(mutation.accountId) ?? [];
		queue.push(normalizeMutation(mutation));
		queue.sort((a, b) => a.timestamp - b.timestamp);
		this.queuesByAccountId.set(mutation.accountId, queue);
		await this.schedulePersistence(mutation.accountId);
		try {
			await applyOptimistic?.();
		} finally {
			this.emit();
		}
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
						.map((entry) => normalizeMutation({ ...entry, accountId }))
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
				const migrated = queue.map((entry) =>
					normalizeMutation({
						...entry,
						accountId,
						accountEmail: entry.accountEmail ?? email,
					}),
				);
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

	getCommands(accountId?: string): PendingMutation[] {
		const queues = accountId
			? [this.queuesByAccountId.get(accountId) ?? []]
			: Array.from(this.queuesByAccountId.values());
		return queues.flat().map((mutation) => ({ ...mutation }));
	}

	async rewritePendingIds(tempId: string, realId: string): Promise<void> {
		const writes: Promise<void>[] = [];
		for (const [accountId, queue] of this.queuesByAccountId.entries()) {
			let touched = false;
			for (const mutation of queue) {
				if (mutation.entityId === tempId) {
					mutation.entityId = realId;
					touched = true;
				}
			}
			if (touched) {
				writes.push(this.schedulePersistence(accountId));
			}
		}
		await Promise.all(writes);
		this.emit();
	}

	private async processMutation(
		client: OutboundQueueApiClient,
		mutation: PendingMutation,
	): Promise<{ etag: string | null }> {
		switch (mutation.type) {
			case "create": {
				const payload = mutation.encryptedPayload;
				if (!payload || !mutation.category) {
					throw new Error(
						`Invalid create mutation payload for ${mutation.entityId}`,
					);
				}
				const response = await client.items.create(
					mutation.vaultId,
					mutation.entityId,
					{
						category: mutation.category,
						encryptedData: payload.encryptedData,
						encryptionIv: payload.encryptionIv,
						encryptionAlgorithm: payload.encryptionAlgorithm,
					},
					{ idempotencyKey: mutation.attemptId ?? mutation.id },
				);
				const result = response.data;

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
					await this.rewritePendingIds(mutation.entityId, realId);
				}
				return { etag: response.etag };
			}
			case "update": {
				const payload = mutation.encryptedPayload;
				if (!payload) {
					throw new Error(
						`Invalid update mutation payload for ${mutation.entityId}`,
					);
				}
				const response = await client.items.update(
					mutation.entityId,
					{
						encryptedData: payload.encryptedData,
						encryptionIv: payload.encryptionIv,
						encryptionAlgorithm: payload.encryptionAlgorithm,
					},
					writeOptions(mutation),
				);
				return { etag: response.etag };
			}
			case "delete": {
				const response = await client.items.trash(
					mutation.entityId,
					writeOptions(mutation),
				);
				return { etag: response.etag };
			}
			case "permanent_delete":
				return client.items
					.deletePermanently(mutation.entityId, writeOptions(mutation))
					.then((response) => ({ etag: response.etag }));
			case "restore":
				return client.items
					.restore(mutation.entityId, writeOptions(mutation))
					.then((response) => ({ etag: response.etag }));
			case "move": {
				const payload = mutation.encryptedPayload;
				if (!payload || !mutation.targetVaultId) {
					throw new Error(`Invalid move payload for ${mutation.entityId}`);
				}
				const response = await client.items.move(
					mutation.entityId,
					{
						sourceVaultId: mutation.vaultId,
						targetVaultId: mutation.targetVaultId,
						encryptedData: payload.encryptedData,
						encryptionIv: payload.encryptionIv,
						encryptionAlgorithm: payload.encryptionAlgorithm,
					},
					writeOptions(mutation),
				);
				return { etag: response.etag };
			}
			case "toggle_favorite": {
				const response = await client.items.setFavorite(
					mutation.entityId,
					{ favorite: mutation.favorite ?? false },
					writeOptions(mutation),
				);
				return { etag: response.etag };
			}
		}
	}

	private async rebaseMetadataMutation(
		client: OutboundQueueApiClient,
		mutation: PendingMutation,
	): Promise<boolean> {
		if (
			mutation.type === "update" ||
			mutation.type === "move" ||
			mutation.type === "create"
		) {
			mutation.status = "conflicted";
			mutation.lastError = "The Item changed on another device";
			return false;
		}

		mutation.retryCount += 1;
		if (mutation.retryCount >= MAX_RETRY_COUNT) {
			mutation.status = "failed";
			mutation.lastError = "Conflict retry limit reached";
			return false;
		}

		try {
			const current = await client.items.get(mutation.entityId);
			const version =
				strongNumericEtag(current.etag) ??
				(typeof current.data.version === "number"
					? current.data.version
					: undefined);
			if (version === undefined) {
				mutation.status = "failed";
				mutation.lastError = "Server returned no authoritative Item revision";
				return false;
			}
			mutation.baseVersion = version;
			mutation.attemptId = newAttemptId(mutation);
			mutation.status = "retrying";
			mutation.lastError = undefined;
			return true;
		} catch (error) {
			mutation.status = "retrying";
			mutation.lastError =
				error instanceof Error ? error.message : String(error);
			return false;
		}
	}

	async drain(
		getClient: (
			accountId: string,
		) => OutboundQueueApiClient | Promise<OutboundQueueApiClient>,
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
		) => OutboundQueueApiClient | Promise<OutboundQueueApiClient>,
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
			const attemptedOperationIds = new Set<string>();
			let client: OutboundQueueApiClient;
			try {
				client = await getClient(accountId);
			} catch (error) {
				const mutation = queue[0];
				if (mutation) {
					mutation.retryCount += 1;
					mutation.status =
						mutation.retryCount >= MAX_RETRY_COUNT ? "failed" : "retrying";
					mutation.lastError =
						error instanceof Error ? error.message : String(error);
					await this.schedulePersistence(accountId);
					this.emit();
				}
				continue;
			}
			while (queue.length > 0) {
				const mutationIndex = queue.findIndex(
					(candidate, index) =>
						(candidate.status === undefined ||
							candidate.status === "pending" ||
							candidate.status === "retrying") &&
						!attemptedOperationIds.has(candidate.operationId ?? candidate.id) &&
						!queue
							.slice(0, index)
							.some((earlier) => earlier.entityId === candidate.entityId),
				);
				if (mutationIndex < 0) break;
				const mutation = queue[mutationIndex];
				if (!mutation) {
					break;
				}

				try {
					const result = await this.processMutation(client, mutation);
					queue.splice(mutationIndex, 1);
					const serverVersion = strongNumericEtag(result.etag);
					const next =
						serverVersion === undefined
							? undefined
							: queue.find(
									(candidate) => candidate.entityId === mutation.entityId,
								);
					if (
						serverVersion !== undefined &&
						next &&
						next.baseVersion !== serverVersion
					) {
						next.baseVersion = serverVersion;
						next.attemptId = newAttemptId(next);
						next.status = "pending";
					}
					await this.schedulePersistence(accountId);
					this.emit();
				} catch (error) {
					if (isApiErrorStatus(error, 409) || isApiErrorStatus(error, 412)) {
						const retryImmediately = await this.rebaseMetadataMutation(
							client,
							mutation,
						);
						await this.schedulePersistence(accountId);
						this.emit();
						if (retryImmediately) continue;
						continue;
					}

					if (isApiErrorStatus(error, 400) || isApiErrorStatus(error, 404)) {
						mutation.status = "failed";
						mutation.lastError = error.message;
						await this.schedulePersistence(accountId);
						this.emit();
						continue;
					}

					if (isNetworkError(error)) {
						mutation.retryCount += 1;
						attemptedOperationIds.add(mutation.operationId ?? mutation.id);
						mutation.status =
							mutation.retryCount >= MAX_RETRY_COUNT ? "failed" : "retrying";
						mutation.lastError =
							error instanceof Error ? error.message : String(error);
						await this.schedulePersistence(accountId);
						this.emit();
						continue;
					}

					console.error(
						`[OutboundQueue] Unexpected error for mutation ${mutation.id}:`,
						error,
					);
					mutation.retryCount += 1;
					attemptedOperationIds.add(mutation.operationId ?? mutation.id);
					mutation.status =
						mutation.retryCount >= MAX_RETRY_COUNT ? "failed" : "retrying";
					mutation.lastError =
						error instanceof Error ? error.message : String(error);
					await this.schedulePersistence(accountId);
					this.emit();
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
		// Semantic commands are retained until an equivalence-preserving compactor exists.
	}

	async clear(accountId?: string): Promise<void> {
		if (accountId) {
			this.queuesByAccountId.delete(accountId);
			await this.schedulePersistence(accountId);
			this.emit();
			return;
		}

		const accountIds = Array.from(this.queuesByAccountId.keys());
		this.queuesByAccountId.clear();
		const persistence = this.persistenceTail
			.catch(() => undefined)
			.then(async () => {
				await Promise.all(
					accountIds.map((queuedAccountId) =>
						this.storage.remove(getQueueKeyForAccountId(queuedAccountId)),
					),
				);
				await this.storage.remove(QUEUE_INDEX_KEY);
			});
		this.persistenceTail = persistence.catch(() => undefined);
		await persistence;
		this.emit();
	}
}
