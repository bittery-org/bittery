import type { SyncStorage } from "@bittery/sync";

/**
 * Backing store for the outbound mutation queue. The popup enqueues and the
 * background worker drains, so both must address the exact same keys — hence a
 * single shared implementation with no namespacing.
 */
export class ChromeSyncStorage implements SyncStorage {
	async get<T>(key: string): Promise<T | null> {
		const result = await chrome.storage.local.get(key);
		return (result[key] as T | undefined) ?? null;
	}

	async set<T>(key: string, value: T): Promise<void> {
		await chrome.storage.local.set({ [key]: value });
	}

	async remove(key: string): Promise<void> {
		await chrome.storage.local.remove(key);
	}

	async update<T>(
		key: string,
		updater: (current: T | null) => T | null,
	): Promise<T | null> {
		// Web Locks coordinate the popup and extension service worker, the two contexts that
		// can mutate the outbound queue document.
		return navigator.locks.request(`bittery-sync:${key}`, async () => {
			const current = await this.get<T>(key);
			const next = updater(current);
			if (next === null) {
				await this.remove(key);
			} else {
				await this.set(key, next);
			}
			return next;
		});
	}
}
