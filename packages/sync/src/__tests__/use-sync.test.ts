import { describe, expect, test } from "bun:test";
import { type SyncSource, selectScopedSyncSources } from "../use-sync";

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
