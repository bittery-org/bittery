import { db, session } from "@bittery/db";
import { asc, inArray, lt } from "drizzle-orm";
import { registerJob } from "../registry";
import type { JobDefinition } from "../types";

const BATCH_SIZE = 1000;

const expiredSessionCleanupJob: JobDefinition<void> = {
	options: {
		name: "expired-session-cleanup",
		description: "Delete already-expired auth sessions in batches",
		schedule: { cron: "*/30 * * * *", tz: "UTC" },
		retry: { retryLimit: 2, retryDelay: 300, retryBackoff: false },
		expireInSeconds: 600,
	},
	handler: async () => {
		let totalDeleted = 0;

		while (true) {
			const now = new Date();
			const expiredSessions = await db
				.select({ id: session.id })
				.from(session)
				.where(lt(session.expiresAt, now))
				.orderBy(asc(session.expiresAt), asc(session.id))
				.limit(BATCH_SIZE);

			if (expiredSessions.length === 0) {
				break;
			}

			await db
				.delete(session)
				.where(inArray(session.id, expiredSessions.map((row) => row.id)));

			totalDeleted += expiredSessions.length;
		}

		if (totalDeleted > 0) {
			console.log(
				`[jobs:expired-session-cleanup] Deleted ${totalDeleted} expired sessions`,
			);
		}
	},
};

registerJob(expiredSessionCleanupJob);

export default expiredSessionCleanupJob;
