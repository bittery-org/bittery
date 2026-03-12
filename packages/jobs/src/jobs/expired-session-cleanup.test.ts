import { afterEach, describe, expect, test } from "bun:test";
import { db } from "@bittery/db";
import {
	createTestSession,
	createTestUser,
	getSession,
	truncateAll,
} from "@bittery/test-utils";
import expiredSessionCleanupJob from "./expired-session-cleanup";

describe("expired-session-cleanup job", () => {
	afterEach(async () => {
		await truncateAll();
	});

	test("should delete expired sessions and retain unexpired sessions", async () => {
		const { userId } = await createTestUser();
		const expiredSessionId = await createTestSession(userId, {
			expiresAt: new Date(Date.now() - 60_000),
		});
		const activeSessionId = await createTestSession(userId, {
			expiresAt: new Date(Date.now() + 60_000),
		});

		await expiredSessionCleanupJob.handler(undefined);

		expect(await getSession(expiredSessionId)).toBeUndefined();
		expect(await getSession(activeSessionId)).toBeDefined();
	});

	test("should process more than one batch of expired sessions", async () => {
		const { userId } = await createTestUser();

		for (let index = 0; index < 1005; index += 1) {
			await createTestSession(userId, {
				expiresAt: new Date(Date.now() - 60_000 - index),
			});
		}

		const activeSessionId = await createTestSession(userId, {
			expiresAt: new Date(Date.now() + 60_000),
		});

		await expiredSessionCleanupJob.handler(undefined);

		const remainingSessions = await db.query.session.findMany({
			where: (record, { eq }) => eq(record.userId, userId),
		});

		expect(remainingSessions).toHaveLength(1);
		expect(remainingSessions[0]?.id).toBe(activeSessionId);
	});
});
