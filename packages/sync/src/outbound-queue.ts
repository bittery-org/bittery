import {
	ApiError,
	type AppApiClient,
	isApiErrorStatus,
	isApiTransportError,
} from "@bittery/shared/api-client";
import { toCachedItem } from "@bittery/shared/item-mapping";
import type {
	CachedEncryptedItem,
	ItemSyncAcknowledgement,
	ItemSyncCommand,
	ItemSyncReconciler,
} from "@bittery/types";
import type { SyncCommandSummary, SyncStorage } from "./types";

export type PendingMutation = ItemSyncCommand;

export interface TempIdMapping {
	tempId: string;
	realId: string;
	accountId: string;
	accountEmail?: string;
}

export type ItemCommandAcknowledgement = ItemSyncAcknowledgement;
export type { ItemSyncReconciler };

export type OutboundQueueApiClient = Pick<AppApiClient, "items">;

const QUEUE_DOCUMENT_KEY = "bittery_pending_mutation_queues_v3";

type QueueDocument = Record<string, PendingMutation[]>;

function isNetworkError(error: unknown): boolean {
	// A request that never reached the server: retryable, and no longer identifiable
	// by the engine's rejection message once the transport has normalized it.
	if (isApiTransportError(error)) {
		return true;
	}

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

function isActiveMutation(mutation: PendingMutation): boolean {
	return (
		mutation.status === undefined ||
		mutation.status === "staged" ||
		mutation.status === "applying" ||
		mutation.status === "pending" ||
		mutation.status === "retrying"
	);
}

function isReadyMutation(mutation: PendingMutation, now: number): boolean {
	return (
		(mutation.status === undefined ||
			mutation.status === "pending" ||
			mutation.status === "retrying") &&
		(mutation.nextAttemptAt === undefined || mutation.nextAttemptAt <= now)
	);
}

function newAttemptId(mutation: PendingMutation): string {
	const suffix =
		globalThis.crypto?.randomUUID?.() ??
		`${Date.now()}-${Math.random().toString(36).slice(2)}`;
	return `${mutation.operationId ?? mutation.id}:attempt:${suffix}`;
}

/**
 * Whether the command carries ciphertext already sealed against a specific revision. The GCM AAD
 * binds `version`, and the server derives the stored `encryption_version` from the revision its
 * CAS-guarded write lands on — so moving `baseVersion` under such a command makes the two diverge
 * and the Item becomes permanently undecryptable. Metadata-only commands carry no ciphertext and
 * rebase freely.
 */
function carriesSealedCiphertext(mutation: PendingMutation): boolean {
	return (
		mutation.type === "create" ||
		mutation.type === "update" ||
		mutation.type === "move" ||
		mutation.type === "cross_account_move"
	);
}

function newConflictCopyId(): string {
	return (
		globalThis.crypto?.randomUUID?.() ??
		`conflict-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
}

const MAX_RETRY_COUNT = 5;
const BASE_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;

export class ItemSyncEngine {
	private readonly queuesByAccountId = new Map<string, PendingMutation[]>();
	private readonly listeners = new Set<() => void>();
	private latestMappings: TempIdMapping[] = [];
	private draining = false;
	private drainRequested = false;
	private persistenceTail: Promise<void> = Promise.resolve();
	private readonly persistedOperationIds = new Map<string, Set<string>>();
	private readonly persistedCommandSignatures = new Map<
		string,
		Map<string, string>
	>();

	constructor(
		private readonly storage: SyncStorage,
		private readonly clientId: string,
		private readonly reconciler?: ItemSyncReconciler,
		private readonly now: () => number = Date.now,
	) {}

	private markRetrying(mutation: PendingMutation, error: unknown): void {
		mutation.retryCount += 1;
		if (mutation.type === "cross_account_move") {
			mutation.attemptId = newAttemptId(mutation);
		}
		this.scheduleRetry(mutation, error);
	}

	private scheduleRetry(mutation: PendingMutation, error: unknown): void {
		if (mutation.retryCount >= MAX_RETRY_COUNT) {
			mutation.status = "failed";
			mutation.nextAttemptAt = undefined;
		} else {
			mutation.status = "retrying";
			mutation.nextAttemptAt =
				this.now() +
				Math.min(
					BASE_RETRY_DELAY_MS * 2 ** (mutation.retryCount - 1),
					MAX_RETRY_DELAY_MS,
				);
		}
		mutation.lastError = error instanceof Error ? error.message : String(error);
	}

	private markEncryptedConflict(
		mutation: PendingMutation,
		error: unknown,
	): void {
		mutation.status = "conflicted";
		mutation.nextAttemptAt = undefined;
		mutation.lastError = error instanceof Error ? error.message : String(error);
		mutation.conflictCopyId ??= newConflictCopyId();
	}

	/**
	 * Points a command that trailed an acknowledged one at the revision the server just landed on.
	 * A command whose ciphertext is already sealed cannot follow: it conflicts instead, so the
	 * edit is preserved as a copy rather than written under an AAD binding it never had.
	 */
	private rebaseChainedCommand(
		chained: PendingMutation,
		serverVersion: number,
	): void {
		if (chained.baseVersion === serverVersion) return;
		if (carriesSealedCiphertext(chained)) {
			this.markEncryptedConflict(
				chained,
				new Error("The Item changed before this edit was sent"),
			);
			return;
		}
		chained.baseVersion = serverVersion;
		chained.attemptId = newAttemptId(chained);
		chained.status = "pending";
		chained.nextAttemptAt = undefined;
	}

	private async preserveConflict(mutation: PendingMutation): Promise<void> {
		try {
			const copy = await this.reconciler?.preserveConflict?.(mutation);
			if (copy) await this.enqueue(copy);
		} catch (error) {
			mutation.lastError = `Conflict copy failed: ${error instanceof Error ? error.message : String(error)}`;
			await this.schedulePersistence(mutation.accountId);
			this.emit();
		}
	}

	private commandSignature(command: PendingMutation): string {
		return JSON.stringify(command);
	}

	private rememberPersistedCommands(
		accountId: string,
		commands: PendingMutation[],
	): void {
		this.persistedOperationIds.set(
			accountId,
			new Set(commands.map((command) => command.operationId ?? command.id)),
		);
		this.persistedCommandSignatures.set(
			accountId,
			new Map(
				commands.map((command) => [
					command.operationId ?? command.id,
					this.commandSignature(command),
				]),
			),
		);
	}

	/** Keep active drain/enqueue references aligned with the atomically reconciled document. */
	private adoptReconciledQueue(
		accountId: string,
		reconciled: PendingMutation[],
	): void {
		const current = this.queuesByAccountId.get(accountId);
		if (current && current !== reconciled) {
			current.splice(0, current.length, ...reconciled);
		}
		if (reconciled.length === 0) {
			this.queuesByAccountId.delete(accountId);
		} else {
			this.queuesByAccountId.set(accountId, current ?? reconciled);
		}
	}

	private toAuthoritativeItem(
		mutation: PendingMutation,
		item: Awaited<ReturnType<OutboundQueueApiClient["items"]["get"]>>["data"],
	): CachedEncryptedItem {
		return toCachedItem(item, {
			accountId: mutation.accountId,
			accountEmail: mutation.accountEmail,
		});
	}

	/**
	 * Writes are chained rather than fired in parallel: two overlapping writes of
	 * the same queue can land out of order and persist a stale snapshot.
	 */
	private persistQueue(accountId: string): Promise<void> {
		const persistence = this.persistenceTail
			.catch(() => undefined)
			.then(() => this.writeQueue(accountId));
		this.persistenceTail = persistence.catch(() => undefined);
		return persistence;
	}

	/**
	 * Resolves once every queued write has hit storage. A reader in another
	 * process (the extension's background worker) restores from storage, so it
	 * must not be told to drain before the mutation is durable.
	 */
	async whenPersisted(): Promise<void> {
		await this.persistenceTail;
	}

	private async writeQueue(accountId: string): Promise<void> {
		const queue = this.queuesByAccountId.get(accountId) ?? [];
		const desiredById = new Map(
			queue.map((command) => [command.operationId ?? command.id, command]),
		);
		const knownIds = this.persistedOperationIds.get(accountId) ?? new Set();
		const knownSignatures =
			this.persistedCommandSignatures.get(accountId) ?? new Map();
		const acknowledgedElsewhere: PendingMutation[] = [];
		const document = await this.storage.update<QueueDocument>(
			QUEUE_DOCUMENT_KEY,
			(current) => {
				const nextDocument = { ...(current ?? {}) };
				const mergedById = new Map(
					(nextDocument[accountId] ?? []).map((command) => [
						command.operationId ?? command.id,
						command,
					]),
				);
				for (const knownId of knownIds) {
					if (!desiredById.has(knownId)) {
						mergedById.delete(knownId);
					}
				}
				for (const [operationId, command] of desiredById) {
					if (knownIds.has(operationId) && !mergedById.has(operationId)) {
						acknowledgedElsewhere.push(command);
						continue;
					}
					const currentCommand = mergedById.get(operationId);
					const knownSignature = knownSignatures.get(operationId);
					if (
						currentCommand &&
						knownSignature &&
						this.commandSignature(currentCommand) !== knownSignature
					) {
						continue;
					}
					mergedById.set(operationId, command);
				}
				const next = Array.from(mergedById.values()).sort(
					(a, b) => a.timestamp - b.timestamp,
				);
				if (next.length > 0) {
					nextDocument[accountId] = next;
				} else {
					delete nextDocument[accountId];
				}
				return Object.keys(nextDocument).length > 0 ? nextDocument : null;
			},
		);
		for (const command of acknowledgedElsewhere) {
			await this.reconciler?.discardAcknowledgedElsewhere?.(command);
		}
		const reconciled = document?.[accountId] ?? [];
		if (
			reconciled.some(
				(command) => !desiredById.has(command.operationId ?? command.id),
			)
		) {
			this.drainRequested = true;
		}
		this.adoptReconciledQueue(accountId, reconciled);
		this.rememberPersistedCommands(accountId, reconciled);
	}

	private schedulePersistence(accountId: string): Promise<void> {
		return this.persistQueue(accountId);
	}

	/** Resolves with the chained command the acknowledgement pushed into conflict, if any. */
	private persistAcknowledgement(
		accountId: string,
		mutation: PendingMutation,
		serverVersion: number | undefined,
	): Promise<PendingMutation | undefined> {
		const persistence = this.persistenceTail
			.catch(() => undefined)
			.then(async () => {
				const operationId = mutation.operationId ?? mutation.id;
				let conflictedOperationId: string | undefined;
				const document =
					(await this.storage.update<QueueDocument>(
						QUEUE_DOCUMENT_KEY,
						(current) => {
							const nextDocument = { ...(current ?? {}) };
							const next = (nextDocument[accountId] ?? []).filter(
								(command) =>
									(command.operationId ?? command.id) !== operationId,
							);
							const chained =
								serverVersion === undefined
									? undefined
									: next.find(
											(command) =>
												command.entityId === mutation.entityId &&
												isActiveMutation(command),
										);
							if (chained && serverVersion !== undefined) {
								this.rebaseChainedCommand(chained, serverVersion);
								if (chained.status === "conflicted") {
									conflictedOperationId = chained.operationId ?? chained.id;
								}
							}
							if (next.length > 0) {
								nextDocument[accountId] = next;
							} else {
								delete nextDocument[accountId];
							}
							return Object.keys(nextDocument).length > 0 ? nextDocument : null;
						},
					)) ?? {};
				const reconciled = document[accountId] ?? [];
				this.adoptReconciledQueue(accountId, reconciled);
				this.rememberPersistedCommands(accountId, reconciled);
				return conflictedOperationId === undefined
					? undefined
					: reconciled.find(
							(command) =>
								(command.operationId ?? command.id) === conflictedOperationId,
						);
			});
		this.persistenceTail = persistence.then(
			() => undefined,
			() => undefined,
		);
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
		const hasProjection = !!applyOptimistic || !!this.reconciler;
		const terminalStatus =
			mutation.status === "conflicted" || mutation.status === "failed"
				? mutation.status
				: undefined;
		const normalized = normalizeMutation({
			...mutation,
			status: terminalStatus ?? (hasProjection ? "applying" : "pending"),
		});
		const operationId = normalized.operationId ?? normalized.id;
		if (
			queue.some(
				(command) => (command.operationId ?? command.id) === operationId,
			)
		) {
			return;
		}
		queue.push(normalized);
		queue.sort((a, b) => a.timestamp - b.timestamp);
		this.queuesByAccountId.set(mutation.accountId, queue);
		await this.schedulePersistence(mutation.accountId);
		const durableCommand = this.queuesByAccountId
			.get(mutation.accountId)
			?.find((command) => (command.operationId ?? command.id) === operationId);
		if (!durableCommand) return;
		if (
			durableCommand.status === "conflicted" ||
			durableCommand.status === "failed"
		) {
			this.emit();
			return;
		}
		try {
			if (applyOptimistic) {
				await applyOptimistic();
			} else if (this.reconciler) {
				await this.reconciler.apply(durableCommand);
			}
			durableCommand.status = "pending";
			durableCommand.lastError = undefined;
			await this.schedulePersistence(mutation.accountId);
			this.emit();
		} catch (error) {
			durableCommand.status = "failed";
			durableCommand.lastError =
				error instanceof Error ? error.message : String(error);
			await this.schedulePersistence(mutation.accountId);
			this.emit();
			throw error;
		}
	}

	async stage(
		mutation: PendingMutation,
		claim?: { id: string; expiresAt: number },
	): Promise<boolean> {
		const queue = this.queuesByAccountId.get(mutation.accountId) ?? [];
		const normalized = normalizeMutation({
			...mutation,
			status: "staged",
			projectionClaimId: claim?.id,
			projectionClaimExpiresAt: claim?.expiresAt,
		});
		const operationId = normalized.operationId ?? normalized.id;
		if (
			queue.some(
				(command) => (command.operationId ?? command.id) === operationId,
			)
		) {
			return false;
		}
		queue.push(normalized);
		queue.sort((a, b) => a.timestamp - b.timestamp);
		this.queuesByAccountId.set(mutation.accountId, queue);
		await this.schedulePersistence(mutation.accountId);
		this.emit();
		return true;
	}

	async claimStaged(
		claimId: string,
		leaseMs: number,
	): Promise<PendingMutation[]> {
		const expiresAt = this.now() + leaseMs;
		const claimed: PendingMutation[] = [];
		for (const [accountId, queue] of this.queuesByAccountId) {
			let changed = false;
			for (const command of queue) {
				if (
					command.status !== "staged" ||
					(command.projectionClaimId &&
						(command.projectionClaimExpiresAt ?? Number.POSITIVE_INFINITY) >
							this.now())
				) {
					continue;
				}
				command.projectionClaimId = claimId;
				command.projectionClaimExpiresAt = expiresAt;
				claimed.push({ ...command });
				changed = true;
			}
			if (changed) await this.schedulePersistence(accountId);
		}
		if (claimed.length > 0) this.emit();
		return claimed;
	}

	async activate(
		accountId: string,
		operationId: string,
		claimId: string,
	): Promise<boolean> {
		const command = this.queuesByAccountId
			.get(accountId)
			?.find(
				(candidate) => (candidate.operationId ?? candidate.id) === operationId,
			);
		if (
			!command ||
			command.status !== "staged" ||
			command.projectionClaimId !== claimId
		) {
			return false;
		}
		try {
			await this.reconciler?.apply(command);
			command.status = "pending";
			command.lastError = undefined;
			command.projectionClaimId = undefined;
			command.projectionClaimExpiresAt = undefined;
			await this.schedulePersistence(accountId);
			this.emit();
			return true;
		} catch (error) {
			command.status = "failed";
			command.lastError =
				error instanceof Error ? error.message : String(error);
			await this.schedulePersistence(accountId);
			this.emit();
			throw error;
		}
	}

	async cancel(
		accountId: string,
		operationId: string,
		claimId: string,
	): Promise<boolean> {
		const queue = this.queuesByAccountId.get(accountId);
		if (!queue) return false;
		const commandIndex = queue.findIndex(
			(command) => (command.operationId ?? command.id) === operationId,
		);
		if (
			commandIndex < 0 ||
			queue[commandIndex]?.status !== "staged" ||
			queue[commandIndex]?.projectionClaimId !== claimId
		) {
			return false;
		}
		queue.splice(commandIndex, 1);
		await this.schedulePersistence(accountId);
		this.emit();
		return true;
	}

	getStagedCommands(): PendingMutation[] {
		return this.getCommands().filter((command) => command.status === "staged");
	}

	getNextStagedClaimAt(): number | undefined {
		let next: number | undefined;
		for (const command of this.getStagedCommands()) {
			const expiresAt = command.projectionClaimExpiresAt;
			if (expiresAt === undefined || expiresAt <= this.now()) continue;
			next = next === undefined ? expiresAt : Math.min(next, expiresAt);
		}
		return next;
	}

	async restore(): Promise<void> {
		await this.whenPersisted();
		this.queuesByAccountId.clear();
		this.persistedOperationIds.clear();
		this.persistedCommandSignatures.clear();

		const document =
			(await this.storage.get<QueueDocument>(QUEUE_DOCUMENT_KEY)) ?? {};
		for (const [accountId, queue] of Object.entries(document)) {
			if (queue.length === 0) continue;
			const normalized = queue
				.map((entry) => normalizeMutation({ ...entry, accountId }))
				.sort((a, b) => a.timestamp - b.timestamp);
			if (normalized.length > 0) {
				this.queuesByAccountId.set(accountId, normalized);
			}
			this.rememberPersistedCommands(accountId, queue);
		}

		if (this.reconciler) {
			const conflicts: PendingMutation[] = [];
			for (const [accountId, queue] of this.queuesByAccountId) {
				let changed = false;
				for (const command of queue) {
					if (
						command.status === "staged" ||
						command.status === "conflicted" ||
						command.status === "failed"
					) {
						continue;
					}
					try {
						await this.reconciler.apply(command);
						if ((command as PendingMutation).status === "conflicted") {
							command.conflictCopyId ??= newConflictCopyId();
							conflicts.push(command);
							changed = true;
						}
						if (command.status === "applying") {
							command.status = "pending";
							command.lastError = undefined;
							changed = true;
						}
					} catch (error) {
						command.status = "failed";
						command.lastError =
							error instanceof Error ? error.message : String(error);
						changed = true;
					}
				}
				if (changed) {
					await this.persistQueue(accountId);
				}
			}
			for (const conflict of conflicts) {
				await this.preserveConflict(conflict);
			}
		}

		this.emit();
	}

	getPendingCount(): number {
		let count = 0;
		for (const queue of this.queuesByAccountId.values()) {
			count += queue.length;
		}
		return count;
	}

	getCommandSummary(): SyncCommandSummary {
		const summary: SyncCommandSummary = {
			pending: 0,
			retrying: 0,
			conflicted: 0,
			failed: 0,
		};
		for (const command of this.getCommands()) {
			switch (command.status) {
				case "retrying":
					summary.retrying += 1;
					break;
				case "conflicted":
					summary.conflicted += 1;
					break;
				case "failed":
					summary.failed += 1;
					break;
				default:
					summary.pending += 1;
			}
		}
		return summary;
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

	getNextRetryAt(): number | undefined {
		let next: number | undefined;
		for (const queue of this.queuesByAccountId.values()) {
			for (const command of queue) {
				if (
					command.status !== "retrying" ||
					command.nextAttemptAt === undefined
				) {
					continue;
				}
				next =
					next === undefined
						? command.nextAttemptAt
						: Math.min(next, command.nextAttemptAt);
			}
		}
		return next;
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
			case "cross_account_move":
				throw new Error(
					`Cross-account move ${mutation.operationId ?? mutation.id} requires a semantic executor`,
				);
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
		try {
			const current = await client.items.get(mutation.entityId);
			await this.reconciler?.reconcileAuthoritative?.(
				mutation,
				this.toAuthoritativeItem(mutation, current.data),
			);
			if (carriesSealedCiphertext(mutation)) {
				this.markEncryptedConflict(
					mutation,
					new Error("The Item changed on another device"),
				);
				return false;
			}

			mutation.retryCount += 1;
			if (mutation.retryCount >= MAX_RETRY_COUNT) {
				mutation.status = "failed";
				mutation.nextAttemptAt = undefined;
				mutation.lastError = "Conflict retry limit reached";
				return false;
			}
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
			mutation.nextAttemptAt = undefined;
			mutation.lastError = undefined;
			return true;
		} catch (error) {
			mutation.retryCount += 1;
			this.scheduleRetry(mutation, error);
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
		const accountEntries = Array.from(this.queuesByAccountId.entries()).sort(
			(a, b) => a[0].localeCompare(b[0]),
		);

		for (const [accountId, queue] of accountEntries) {
			const attemptedOperationIds = new Set<string>();
			const findRunnableMutationIndex = () =>
				queue.findIndex(
					(candidate, index) =>
						isReadyMutation(candidate, this.now()) &&
						!attemptedOperationIds.has(candidate.operationId ?? candidate.id) &&
						!queue
							.slice(0, index)
							.some(
								(earlier) =>
									earlier.entityId === candidate.entityId &&
									isActiveMutation(earlier),
							),
				);
			const firstRunnableIndex = findRunnableMutationIndex();
			if (firstRunnableIndex < 0) {
				continue;
			}
			let client: OutboundQueueApiClient;
			try {
				client = await getClient(accountId);
			} catch (error) {
				const mutation = queue[firstRunnableIndex];
				if (mutation) {
					this.markRetrying(mutation, error);
					await this.schedulePersistence(accountId);
					this.emit();
				}
				continue;
			}
			while (queue.length > 0) {
				const mutationIndex = findRunnableMutationIndex();
				if (mutationIndex < 0) break;
				const mutation = queue[mutationIndex];
				if (!mutation) {
					break;
				}

				try {
					const semanticAcknowledgement =
						mutation.type === "cross_account_move"
							? await this.reconciler?.executeSemanticCommand?.(mutation)
							: undefined;
					if (
						mutation.type === "cross_account_move" &&
						!semanticAcknowledgement
					) {
						throw new Error(
							`Cross-account move ${mutation.operationId ?? mutation.id} requires a semantic executor`,
						);
					}
					const result = semanticAcknowledgement
						? { etag: semanticAcknowledgement.etag }
						: await this.processMutation(client, mutation);
					const serverVersion =
						semanticAcknowledgement?.version ?? strongNumericEtag(result.etag);
					await this.reconciler?.acknowledge(mutation, {
						entityId: semanticAcknowledgement?.entityId ?? mutation.entityId,
						etag: result.etag,
						version: serverVersion,
					});
					queue.splice(mutationIndex, 1);
					const conflicted = await this.persistAcknowledgement(
						accountId,
						mutation,
						serverVersion,
					);
					if (conflicted) await this.preserveConflict(conflicted);
					this.emit();
				} catch (error) {
					if (isApiErrorStatus(error, 409) || isApiErrorStatus(error, 412)) {
						const retryImmediately = await this.rebaseMetadataMutation(
							client,
							mutation,
						);
						await this.schedulePersistence(accountId);
						this.emit();
						if (mutation.status === "conflicted") {
							await this.preserveConflict(mutation);
						}
						if (retryImmediately) continue;
						continue;
					}

					if (isApiErrorStatus(error, 400) || isApiErrorStatus(error, 404)) {
						if (
							isApiErrorStatus(error, 404) &&
							(mutation.type === "update" ||
								mutation.type === "move" ||
								mutation.type === "cross_account_move")
						) {
							this.markEncryptedConflict(mutation, error);
						} else {
							mutation.status = "failed";
							mutation.lastError = error.message;
						}
						await this.schedulePersistence(accountId);
						this.emit();
						if (mutation.status === "conflicted") {
							await this.preserveConflict(mutation);
						}
						continue;
					}

					if (isNetworkError(error)) {
						attemptedOperationIds.add(mutation.operationId ?? mutation.id);
						this.markRetrying(mutation, error);
						await this.schedulePersistence(accountId);
						this.emit();
						continue;
					}

					console.error(
						`[OutboundQueue] Unexpected error for mutation ${mutation.id}:`,
						error,
					);
					attemptedOperationIds.add(mutation.operationId ?? mutation.id);
					this.markRetrying(mutation, error);
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

		this.queuesByAccountId.clear();
		this.persistedOperationIds.clear();
		this.persistedCommandSignatures.clear();
		const persistence = this.persistenceTail
			.catch(() => undefined)
			.then(async () => {
				await this.storage.remove(QUEUE_DOCUMENT_KEY);
			});
		this.persistenceTail = persistence.catch(() => undefined);
		await persistence;
		this.emit();
	}
}

export { ItemSyncEngine as OutboundQueue };
