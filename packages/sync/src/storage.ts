import type { SyncStorage } from "./types";

/**
 * Process-local storage used when a platform does not provide durable Sync storage.
 *
 * JavaScript runs each updater to completion without an await, so overlapping calls on
 * this instance cannot observe the same pre-update value.
 */
export class MemorySyncStorage implements SyncStorage {
	private readonly data = new Map<string, unknown>();

	async get<T>(key: string): Promise<T | null> {
		return (this.data.get(key) as T | undefined) ?? null;
	}

	async set<T>(key: string, value: T): Promise<void> {
		this.data.set(key, value);
	}

	async remove(key: string): Promise<void> {
		this.data.delete(key);
	}

	async update<T>(
		key: string,
		updater: (current: T | null) => T | null,
	): Promise<T | null> {
		const current = (this.data.get(key) as T | undefined) ?? null;
		const next = updater(current);
		if (next === null) {
			this.data.delete(key);
		} else {
			this.data.set(key, next);
		}
		return next;
	}
}

/** Prefixes every key while preserving the backing adapter's atomic mutation semantics. */
export class NamespacedSyncStorage implements SyncStorage {
	constructor(
		private readonly storage: SyncStorage,
		private readonly namespace: string,
	) {}

	private key(key: string): string {
		return `${this.namespace}:${key}`;
	}

	get<T>(key: string): Promise<T | null> {
		return this.storage.get<T>(this.key(key));
	}

	set<T>(key: string, value: T): Promise<void> {
		return this.storage.set(this.key(key), value);
	}

	remove(key: string): Promise<void> {
		return this.storage.remove(this.key(key));
	}

	update<T>(
		key: string,
		updater: (current: T | null) => T | null,
	): Promise<T | null> {
		return this.storage.update(this.key(key), updater);
	}
}
