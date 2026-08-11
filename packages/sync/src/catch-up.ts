import type { AppApiClient } from "@bittery/shared/api-client";
import type { SyncCursor, SyncEvent } from "./types";

export interface CatchUpPageResponse {
	events: SyncEvent[];
	hasMore: boolean;
	requiresFullRefresh: boolean;
	cursor: SyncCursor | null;
}

export type CatchUpApiClient = Pick<AppApiClient, "sync">;

export interface RunCatchUpOptions {
	client: CatchUpApiClient;
	initialCursor: SyncCursor;
	limit?: number;
	shouldProcessEvent?: (event: SyncEvent) => boolean | Promise<boolean>;
	onEvent?: (event: SyncEvent) => Promise<void>;
	onRequiresFullRefresh?: (serverCursor: SyncCursor | null) => Promise<void>;
}

export interface RunCatchUpResult {
	cursor: SyncCursor;
	processedCount: number;
	requiresFullRefresh: boolean;
}

export async function runCatchUp({
	client,
	initialCursor,
	limit = 100,
	shouldProcessEvent,
	onEvent,
	onRequiresFullRefresh,
}: RunCatchUpOptions): Promise<RunCatchUpResult> {
	let cursor: SyncCursor = initialCursor;
	let processedCount = 0;
	let requiresFullRefresh = false;

	while (true) {
		const previousId = cursor.id;
		const { data: apiPage } = await client.sync.changes({
			sinceId: cursor.id || undefined,
			limit,
		});
		const page: CatchUpPageResponse = {
			events: apiPage.events.map((event) => ({
				...event,
				type: event.type as SyncEvent["type"],
				entityType: event.entityType as SyncEvent["entityType"],
				vaultId: event.vaultId ?? null,
				clientId: event.clientId ?? null,
				timestamp: Number(event.timestamp),
				metadata: event.metadata as SyncEvent["metadata"],
			})),
			hasMore: apiPage.hasMore,
			requiresFullRefresh: apiPage.requiresFullRefresh,
			cursor: apiPage.cursor ?? null,
		};

		if (page.requiresFullRefresh) {
			requiresFullRefresh = true;
			if (page.cursor) {
				cursor = page.cursor;
			}
			await onRequiresFullRefresh?.(page.cursor);
			break;
		}

		for (const event of page.events) {
			const shouldProcess = shouldProcessEvent
				? await shouldProcessEvent(event)
				: true;
			if (!shouldProcess) {
				continue;
			}

			await onEvent?.(event);
			processedCount++;
		}

		const latestEvent = page.events[page.events.length - 1];
		const nextCursor =
			page.cursor ?? (latestEvent ? { id: latestEvent.id } : null);
		if (nextCursor) {
			cursor = nextCursor;
		}

		if (!page.hasMore) {
			break;
		}

		if (cursor.id === previousId) {
			// Safety valve: avoid infinite loop if server claims hasMore but cursor does not advance.
			break;
		}
	}

	return {
		cursor,
		processedCount,
		requiresFullRefresh,
	};
}
