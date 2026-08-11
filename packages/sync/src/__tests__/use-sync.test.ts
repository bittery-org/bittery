import { describe, expect, test } from "bun:test";
import {
	buildDefaultSyncSourceId,
	getOrCreateClientId,
	type SyncSource,
	selectScopedSyncSources,
} from "../use-sync";

class MemoryStorage implements Storage {
	private readonly values = new Map<string, string>();

	get length(): number {
		return this.values.size;
	}

	clear(): void {
		this.values.clear();
	}

	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	key(index: number): string | null {
		return Array.from(this.values.keys())[index] ?? null;
	}

	removeItem(key: string): void {
		this.values.delete(key);
	}

	setItem(key: string, value: string): void {
		this.values.set(key, value);
	}
}

function buildSource(overrides: Partial<SyncSource> = {}): SyncSource {
	return {
		id: "default",
		serverUrl: "http://localhost:3000",
		getAuthToken: async () => "token",
		apiClient: {} as SyncSource["apiClient"],
		...overrides,
	};
}

/**
 * Web reads its active accountId from an async-filled snapshot, so the first render
 * carries `null`. An orchestrator built from it connected and then threw
 * "Sync requires an accountId scope" on every catch-up.
 */
describe("selectScopedSyncSources", () => {
	test("drops a source whose accountId has not resolved yet", () => {
		expect(
			selectScopedSyncSources([buildSource({ itemCacheAccountId: null })]),
		).toEqual([]);
		expect(
			selectScopedSyncSources([buildSource({ itemCacheAccountId: undefined })]),
		).toEqual([]);
		expect(
			selectScopedSyncSources([buildSource({ itemCacheAccountId: "" })]),
		).toEqual([]);
	});

	test("keeps every source that names an account", () => {
		const scoped = buildSource({ id: "a", itemCacheAccountId: "acc_alice" });
		const unscoped = buildSource({ id: "b", itemCacheAccountId: null });

		expect(selectScopedSyncSources([scoped, unscoped])).toEqual([scoped]);
	});
});

describe("sync replica and cursor scopes", () => {
	test("scopes the default cursor by server and account", () => {
		const alice = buildDefaultSyncSourceId(
			"https://vault.example",
			"acc_alice",
		);

		expect(alice).not.toBe(
			buildDefaultSyncSourceId("https://vault.example", "acc_bob"),
		);
		expect(alice).not.toBe(
			buildDefaultSyncSourceId("https://other.example", "acc_alice"),
		);
	});

	test("keeps one replica id per tab-scoped storage", () => {
		const firstTab = new MemoryStorage();
		const secondTab = new MemoryStorage();

		const firstId = getOrCreateClientId(firstTab);
		expect(getOrCreateClientId(firstTab)).toBe(firstId);
		expect(getOrCreateClientId(secondTab)).not.toBe(firstId);
	});
});
