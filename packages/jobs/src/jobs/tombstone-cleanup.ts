import { db, item, syncEvent, vault } from "@bittery/db";
import { and, inArray, isNotNull, lt } from "drizzle-orm";
import { registerJob } from "../registry";
import type { JobDefinition } from "../types";

const RETENTION_DAYS = 90;
const BATCH_SIZE = 200;

const tombstoneCleanupJob: JobDefinition<void> = {
	options: {
		name: "tombstone-cleanup",
		description:
			"Hard-delete old tombstones and emit permanent-delete sync events",
		schedule: { cron: "15 3 * * *" },
		retry: { retryLimit: 2, retryDelay: 300, retryBackoff: false },
		expireInSeconds: 600,
	},
	handler: async () => {
		const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
		let totalDeleted = 0;
		let totalEvents = 0;

		while (true) {
			const candidates = await db.query.item.findMany({
				where: and(isNotNull(item.deletedAt), lt(item.deletedAt, cutoff)),
				columns: {
					id: true,
					vaultId: true,
					lastModifiedBy: true,
					version: true,
				},
				limit: BATCH_SIZE,
			});

			if (candidates.length === 0) {
				break;
			}

			const fallbackVaultIds = Array.from(
				new Set(
					candidates
						.filter((candidate) => !candidate.lastModifiedBy)
						.map((candidate) => candidate.vaultId),
				),
			);
			const fallbackUsers =
				fallbackVaultIds.length > 0
					? await db.query.vault.findMany({
							where: inArray(vault.id, fallbackVaultIds),
							columns: {
								id: true,
								createdById: true,
							},
						})
					: [];
			const fallbackUserByVaultId = new Map(
				fallbackUsers.map((entry) => [entry.id, entry.createdById]),
			);

			const candidateIds = candidates.map((candidate) => candidate.id);
			const eventRows = candidates
				.map((candidate) => {
					const eventUserId =
						candidate.lastModifiedBy ??
						fallbackUserByVaultId.get(candidate.vaultId) ??
						null;
					if (!eventUserId) {
						return null;
					}

					return {
						id: crypto.randomUUID(),
						eventType: "item_permanently_deleted" as const,
						entityId: candidate.id,
						entityType: "item" as const,
						vaultId: candidate.vaultId,
						userId: eventUserId,
						version: candidate.version ?? 1,
						metadata: JSON.stringify({
							reason: "tombstone_cleanup",
						}),
					};
				})
				.filter((row): row is NonNullable<typeof row> => row !== null);

			await db.transaction(async (tx) => {
				if (eventRows.length > 0) {
					await tx.insert(syncEvent).values(eventRows);
				}
				await tx.delete(item).where(inArray(item.id, candidateIds));
			});

			totalDeleted += candidateIds.length;
			totalEvents += eventRows.length;
		}

		if (totalDeleted > 0) {
			console.log(
				`[jobs:tombstone-cleanup] Deleted ${totalDeleted} items older than ${RETENTION_DAYS} days (${totalEvents} sync events emitted)`,
			);
		}
	},
};

registerJob(tombstoneCleanupJob);

export default tombstoneCleanupJob;
