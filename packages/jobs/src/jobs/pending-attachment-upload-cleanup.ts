import { db, pendingAttachmentUpload } from "@bittery/db";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { and, isNull, lt } from "drizzle-orm";
import { registerJob } from "../registry";
import type { JobDefinition } from "../types";

const BATCH_SIZE = 100;

let storageClient: S3Client | null = null;

function getStorageClient(): S3Client {
	if (storageClient) {
		return storageClient;
	}

	const endpoint = process.env.BITTERY_STORAGE_ENDPOINT;
	const bucket = process.env.BITTERY_STORAGE_BUCKET;
	const accessKeyId = process.env.BITTERY_STORAGE_ACCESS_KEY_ID;
	const secretAccessKey = process.env.BITTERY_STORAGE_SECRET_ACCESS_KEY;
	const region = process.env.BITTERY_STORAGE_REGION || "auto";
	if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
		throw new Error(
			"Missing storage config. Set BITTERY_STORAGE_ENDPOINT, BITTERY_STORAGE_BUCKET, BITTERY_STORAGE_ACCESS_KEY_ID, and BITTERY_STORAGE_SECRET_ACCESS_KEY.",
		);
	}

	storageClient = new S3Client({
		region,
		endpoint,
		credentials: {
			accessKeyId,
			secretAccessKey,
		},
	});
	return storageClient;
}

async function deleteStorageObject(key: string): Promise<void> {
	const bucket = process.env.BITTERY_STORAGE_BUCKET;
	if (!bucket) {
		throw new Error("Missing BITTERY_STORAGE_BUCKET for cleanup job");
	}

	await getStorageClient().send(
		new DeleteObjectCommand({
			Bucket: bucket,
			Key: key,
		}),
	);
}

const pendingAttachmentUploadCleanupJob: JobDefinition<void> = {
	options: {
		name: "pending-attachment-upload-cleanup",
		description:
			"Delete expired, unconsumed attachment uploads from storage and the reservation table",
		schedule: { cron: "*/15 * * * *" },
		retry: { retryLimit: 2, retryDelay: 300, retryBackoff: false },
		expireInSeconds: 300,
	},
	handler: async () => {
		const now = new Date();
		let totalDeleted = 0;

		while (true) {
			const expiredReservations = await db.query.pendingAttachmentUpload.findMany({
				where: and(
					isNull(pendingAttachmentUpload.consumedAt),
					lt(pendingAttachmentUpload.expiresAt, now),
				),
				columns: {
					id: true,
					storageKey: true,
				},
				limit: BATCH_SIZE,
			});

			if (expiredReservations.length === 0) {
				break;
			}

			for (const reservation of expiredReservations) {
				try {
					await deleteStorageObject(reservation.storageKey);
				} catch (error) {
					console.error(
						`[jobs:pending-attachment-upload-cleanup] Failed to delete ${reservation.storageKey}:`,
						error,
					);
				}
			}

			await db
				.delete(pendingAttachmentUpload)
				.where(
					and(
						isNull(pendingAttachmentUpload.consumedAt),
						lt(pendingAttachmentUpload.expiresAt, now),
					),
				);

			totalDeleted += expiredReservations.length;

			if (expiredReservations.length < BATCH_SIZE) {
				break;
			}
		}

		if (totalDeleted > 0) {
			console.log(
				`[jobs:pending-attachment-upload-cleanup] Removed ${totalDeleted} expired attachment upload reservations`,
			);
		}
	},
};

registerJob(pendingAttachmentUploadCleanupJob);

export default pendingAttachmentUploadCleanupJob;
