import type { SyncOrchestratorOptions } from "./sync-orchestrator";

export interface SyncSource {
	id: string;
	serverUrl: string;
	getAuthToken: () => Promise<string | null>;
	apiClient: SyncOrchestratorOptions["apiClient"];
	refreshFromServer?: SyncOrchestratorOptions["refreshFromServer"];
	initializeFromServer?: SyncOrchestratorOptions["initializeFromServer"];
	itemCacheAccountId?: string | null;
	itemCacheAccountEmail?: string | null;
	itemCacheServerUrl?: string | null;
}

export interface SyncEventContext {
	sourceId: string;
	accountId?: string | null;
	accountEmail?: string | null;
	serverUrl?: string | null;
}

/** An orchestrator cannot connect until its Item cache has a real account scope. */
export function selectScopedSyncSources(sources: SyncSource[]): SyncSource[] {
	return sources.filter((source) => !!source.itemCacheAccountId);
}

export function buildDefaultSyncSourceId(
	serverUrl: string,
	accountId: string | null | undefined,
): string {
	if (!accountId) {
		return "unscoped";
	}
	let normalizedServerUrl = serverUrl.trim().replace(/\/+$/, "");
	try {
		normalizedServerUrl = new URL(serverUrl).toString().replace(/\/+$/, "");
	} catch {
		// A malformed URL still gets a deterministic isolated scope.
	}
	return `account:${encodeURIComponent(accountId)}:server:${encodeURIComponent(normalizedServerUrl)}`;
}
