import { db, syncEvent } from "@bittery/db";
import { lt } from "drizzle-orm";
import { registerJob } from "../registry";
import type { JobDefinition } from "../types";

const RETENTION_DAYS = 30;

const syncPruningJob: JobDefinition<void> = {
	options: {
		name: "sync-event-pruning",
		description: "Delete sync events older than the retention period",
		schedule: { cron: "0 3 * * *" },
		retry: { retryLimit: 2, retryDelay: 300, retryBackoff: false },
		expireInSeconds: 300,
	},
	handler: async () => {
		const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

		const deleted = await db
			.delete(syncEvent)
			.where(lt(syncEvent.createdAt, cutoff))
			.returning({ id: syncEvent.id });

		if (deleted.length > 0) {
			console.log(
				`[jobs:sync-pruning] Pruned ${deleted.length} sync events older than ${RETENTION_DAYS} days`,
			);
		}
	},
};

registerJob(syncPruningJob);

export default syncPruningJob;
