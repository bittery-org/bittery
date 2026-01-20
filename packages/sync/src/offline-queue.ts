import { nanoid } from "nanoid";
import type { OfflineOperation, SyncStorage } from "./types";

const QUEUE_STORAGE_KEY = "offline_sync_queue";
const MAX_RETRY_COUNT = 5;

/**
 * Default in-memory storage implementation
 */
class MemoryStorage implements SyncStorage {
	private data = new Map<string, unknown>();

	async get<T>(key: string): Promise<T | null> {
		return (this.data.get(key) as T) || null;
	}

	async set<T>(key: string, value: T): Promise<void> {
		this.data.set(key, value);
	}

	async remove(key: string): Promise<void> {
		this.data.delete(key);
	}
}

/**
 * OfflineQueue manages operations made while offline
 * - Queues operations when offline
 * - Persists queue to storage
 * - Processes queue when back online
 * - Handles retries with backoff
 */
export class OfflineQueue {
	private storage: SyncStorage;
	private queue: OfflineOperation[] = [];
	private isProcessing = false;
	private onQueueChange?: (count: number) => void;

	constructor(
		storage?: SyncStorage,
		onQueueChange?: (count: number) => void,
	) {
		this.storage = storage || new MemoryStorage();
		this.onQueueChange = onQueueChange;
	}

	/**
	 * Initialize queue from storage
	 */
	async init(): Promise<void> {
		const stored = await this.storage.get<OfflineOperation[]>(QUEUE_STORAGE_KEY);
		if (stored) {
			this.queue = stored;
			this.onQueueChange?.(this.queue.length);
		}
	}

	/**
	 * Add an operation to the queue
	 */
	async enqueue(operation: Omit<OfflineOperation, "id" | "timestamp" | "retryCount">): Promise<string> {
		const op: OfflineOperation = {
			...operation,
			id: nanoid(),
			timestamp: Date.now(),
			retryCount: 0,
		};

		this.queue.push(op);
		await this.persist();
		this.onQueueChange?.(this.queue.length);

		return op.id;
	}

	/**
	 * Remove an operation from the queue
	 */
	async dequeue(operationId: string): Promise<void> {
		this.queue = this.queue.filter((op) => op.id !== operationId);
		await this.persist();
		this.onQueueChange?.(this.queue.length);
	}

	/**
	 * Get all pending operations
	 */
	getAll(): OfflineOperation[] {
		return [...this.queue];
	}

	/**
	 * Get pending operations count
	 */
	count(): number {
		return this.queue.length;
	}

	/**
	 * Get pending operations for a specific vault
	 */
	getByVault(vaultId: string): OfflineOperation[] {
		return this.queue.filter((op) => op.vaultId === vaultId);
	}

	/**
	 * Get pending operations for a specific entity
	 */
	getByEntity(entityId: string): OfflineOperation[] {
		return this.queue.filter((op) => op.entityId === entityId);
	}

	/**
	 * Clear all operations
	 */
	async clear(): Promise<void> {
		this.queue = [];
		await this.persist();
		this.onQueueChange?.(0);
	}

	/**
	 * Process the queue with a processor function
	 * Returns true if all operations succeeded
	 */
	async process(
		processor: (operation: OfflineOperation) => Promise<boolean>,
	): Promise<boolean> {
		if (this.isProcessing || this.queue.length === 0) {
			return true;
		}

		this.isProcessing = true;
		let allSucceeded = true;

		// Process in order (oldest first)
		const operations = [...this.queue];

		for (const operation of operations) {
			try {
				const success = await processor(operation);

				if (success) {
					await this.dequeue(operation.id);
				} else {
					// Increment retry count
					operation.retryCount++;

					if (operation.retryCount >= MAX_RETRY_COUNT) {
						// Max retries reached, remove from queue
						console.error(
							`Operation ${operation.id} failed after ${MAX_RETRY_COUNT} retries`,
						);
						await this.dequeue(operation.id);
					} else {
						// Update operation in queue
						await this.persist();
					}

					allSucceeded = false;
				}
			} catch (error) {
				console.error(`Error processing operation ${operation.id}:`, error);
				operation.retryCount++;

				if (operation.retryCount >= MAX_RETRY_COUNT) {
					await this.dequeue(operation.id);
				} else {
					await this.persist();
				}

				allSucceeded = false;
			}
		}

		this.isProcessing = false;
		return allSucceeded;
	}

	/**
	 * Check if there are any conflicting operations for an entity
	 * (e.g., trying to update an entity that has a pending delete)
	 */
	hasConflict(entityId: string, operationType: "create" | "update" | "delete"): boolean {
		const entityOps = this.getByEntity(entityId);

		for (const op of entityOps) {
			// Delete conflicts with update
			if (op.type === "delete" && operationType === "update") {
				return true;
			}
			// Update conflicts with delete if delete is pending
			if (op.type === "update" && operationType === "delete") {
				// No conflict, delete should proceed
				return false;
			}
		}

		return false;
	}

	/**
	 * Merge a new operation with existing ones
	 * (e.g., if we have create + update, just keep the latest create data)
	 */
	async mergeOperation(operation: Omit<OfflineOperation, "id" | "timestamp" | "retryCount">): Promise<string> {
		const entityOps = this.getByEntity(operation.entityId);

		// If there's an existing create and we're updating, just update the create data
		if (operation.type === "update") {
			const existingCreate = entityOps.find((op) => op.type === "create");
			if (existingCreate) {
				existingCreate.data = operation.data;
				existingCreate.timestamp = Date.now();
				await this.persist();
				return existingCreate.id;
			}

			// If there's an existing update, replace it
			const existingUpdate = entityOps.find((op) => op.type === "update");
			if (existingUpdate) {
				existingUpdate.data = operation.data;
				existingUpdate.timestamp = Date.now();
				await this.persist();
				return existingUpdate.id;
			}
		}

		// If deleting, remove any pending creates/updates for this entity
		if (operation.type === "delete") {
			for (const op of entityOps) {
				if (op.type === "create" || op.type === "update") {
					await this.dequeue(op.id);
				}
			}

			// If there was a create, we can skip the delete entirely (item never existed on server)
			const hadCreate = entityOps.some((op) => op.type === "create");
			if (hadCreate) {
				return ""; // No operation needed
			}
		}

		// Add as new operation
		return this.enqueue(operation);
	}

	/**
	 * Persist queue to storage
	 */
	private async persist(): Promise<void> {
		await this.storage.set(QUEUE_STORAGE_KEY, this.queue);
	}
}

/**
 * Create an offline queue instance
 */
export function createOfflineQueue(
	storage?: SyncStorage,
	onQueueChange?: (count: number) => void,
): OfflineQueue {
	return new OfflineQueue(storage, onQueueChange);
}
