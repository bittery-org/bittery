import type { SyncCursor, SyncEvent } from "./types";

export interface CatchUpPageResponse {
	events: SyncEvent[];
	hasMore: boolean;
	requiresFullRefresh: boolean;
	cursor: SyncCursor | null;
}

export interface CatchUpClient {
	sync: {
		getEventsSince: {
			query: (input: {
				since: number;
				sinceId?: string;
				limit?: number;
			}) => Promise<CatchUpPageResponse>;
		};
	};
}

export interface RunCatchUpOptions {
	client: CatchUpClient;
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
		const previousCursorKey = `${cursor.timestamp}:${cursor.id}`;
		const page = await client.sync.getEventsSince.query({
			since: cursor.timestamp,
			sinceId: cursor.id,
			limit,
		});

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
			page.cursor ??
			(latestEvent
				? {
						timestamp: latestEvent.timestamp,
						id: latestEvent.id,
					}
				: null);
		if (nextCursor) {
			cursor = nextCursor;
		}

		if (!page.hasMore) {
			break;
		}

		const newCursorKey = `${cursor.timestamp}:${cursor.id}`;
		if (newCursorKey === previousCursorKey) {
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
