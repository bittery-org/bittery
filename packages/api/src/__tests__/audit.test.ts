import { afterEach, describe, expect, test } from "bun:test";
import { db } from "@bittery/db";
import { auditLog } from "@bittery/db/schema/auth";
import { shareAccessLog } from "@bittery/db/schema/sharing";
import { nanoid } from "nanoid";
import { auditRouter } from "../routers/audit";
import {
	addTeamMember,
	createTestItem,
	createTestShareLink,
	createTestTeam,
	createTestVault,
	setup,
	truncateAll,
} from "./test-utils";

const originalBitteryMode = process.env.BITTERY_MODE;

describe("Audit Router", () => {
	afterEach(async () => {
		await truncateAll();
		if (originalBitteryMode === undefined) {
			delete process.env.BITTERY_MODE;
		} else {
			process.env.BITTERY_MODE = originalBitteryMode;
		}
	});

	test("team owner can fetch merged audit and share access events", async () => {
		const { caller, userId } = await setup(auditRouter, {
			name: "Owner",
		});
		const teamId = await createTestTeam(userId, {
			type: "organization",
			billingPlan: "team",
			billingStatus: "active",
		});

		const vaultId = await createTestVault(userId, {
			teamId,
			type: "team",
		});
		const itemId = await createTestItem(vaultId, userId);
		const { shareLinkId } = await createTestShareLink(itemId, userId);

		await db.insert(auditLog).values({
			id: nanoid(),
			userId,
			action: "vault_member_added",
			entityType: "vault",
			entityId: vaultId,
			ipAddress: "10.0.0.1",
			userAgent: "Chrome Test Agent",
			metadata: JSON.stringify({ vaultId }),
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
		});

		await db.insert(shareAccessLog).values({
			id: nanoid(),
			shareLinkId,
			accessedByEmail: "viewer@example.com",
			ipAddress: "203.0.113.45",
			userAgent: "Mozilla/5.0 Chrome/132.0.0.0",
			success: false,
			failureReason: "code_invalid",
			accessedAt: new Date("2026-01-01T01:00:00.000Z"),
		});

		const result = await caller.teamEvents({ limit: 10, actionGroup: "all" });

		expect(result.events.length).toBe(2);
		expect(result.events[0]?.source).toBe("share_access_log");
		expect(result.events[0]?.result).toBe("failure");
		expect(result.events[0]?.network.maskedIp).toBe("203.0.x.x");
		expect(result.events[0]?.network.fullIp).toBe("203.0.113.45");
		expect(result.events[1]?.source).toBe("audit_log");
		expect(result.events[1]?.actor.userId).toBe(userId);
	});

	test("member cannot access team events", async () => {
		const [{ userId: ownerId }, { userId: memberId, caller: memberCaller }] =
			await Promise.all([setup(auditRouter), setup(auditRouter)]);

		const teamId = await createTestTeam(ownerId, {
			type: "organization",
			billingPlan: "team",
			billingStatus: "active",
		});
		await addTeamMember(teamId, memberId, "member");

		await expect(memberCaller.teamEvents({})).rejects.toThrow(
			"Only team owner or admin can access this console",
		);
	});

	test("family plans are denied even for team owners", async () => {
		const { caller, userId } = await setup(auditRouter);
		await createTestTeam(userId, {
			type: "family",
			billingPlan: "family",
			billingStatus: "active",
		});

		await expect(caller.teamEvents({})).rejects.toThrow(
			"This console is only available on Team plans",
		);
	});

	test("events are scoped to the actor's team", async () => {
		const [{ caller: callerA, userId: userA }, { userId: userB }] =
			await Promise.all([setup(auditRouter), setup(auditRouter)]);

		await Promise.all([
			createTestTeam(userA, {
				type: "organization",
				billingPlan: "team",
				billingStatus: "active",
			}),
			createTestTeam(userB, {
				type: "organization",
				billingPlan: "team",
				billingStatus: "active",
			}),
		]);

		await db.insert(auditLog).values([
			{
				id: nanoid(),
				userId: userA,
				action: "vault_member_added",
				createdAt: new Date("2026-01-02T00:00:00.000Z"),
			},
			{
				id: nanoid(),
				userId: userB,
				action: "vault_member_added",
				createdAt: new Date("2026-01-02T00:01:00.000Z"),
			},
		]);

		const result = await callerA.teamEvents({ actionGroup: "all", limit: 10 });

		expect(result.events.length).toBe(1);
		expect(result.events[0]?.actor.userId).toBe(userA);
	});

	test("cursor pagination returns deterministic next pages", async () => {
		const { caller, userId } = await setup(auditRouter);
		await createTestTeam(userId, {
			type: "organization",
			billingPlan: "team",
			billingStatus: "active",
		});

		await db.insert(auditLog).values([
			{
				id: nanoid(),
				userId,
				action: "vault_member_added",
				createdAt: new Date("2026-01-03T00:00:03.000Z"),
			},
			{
				id: nanoid(),
				userId,
				action: "vault_member_removed",
				createdAt: new Date("2026-01-03T00:00:02.000Z"),
			},
			{
				id: nanoid(),
				userId,
				action: "team_member_removed",
				createdAt: new Date("2026-01-03T00:00:01.000Z"),
			},
		]);

		const firstPage = await caller.teamEvents({ limit: 2 });
		expect(firstPage.events.length).toBe(2);
		expect(firstPage.nextCursor).toBeTruthy();

		const secondPage = await caller.teamEvents({
			limit: 2,
			cursor: firstPage.nextCursor ?? undefined,
		});

		expect(secondPage.events.length).toBe(1);
		expect(secondPage.events[0]?.id).not.toBe(firstPage.events[0]?.id);
		expect(secondPage.events[0]?.id).not.toBe(firstPage.events[1]?.id);
	});

	test("item action group filters item_* audit actions", async () => {
		const { caller, userId } = await setup(auditRouter);
		await createTestTeam(userId, {
			type: "organization",
			billingPlan: "team",
			billingStatus: "active",
		});

		await db.insert(auditLog).values([
			{
				id: nanoid(),
				userId,
				action: "item_deleted",
				entityType: "item",
				entityId: "item-1",
				createdAt: new Date("2026-01-04T00:00:02.000Z"),
			},
			{
				id: nanoid(),
				userId,
				action: "vault_member_added",
				entityType: "vault",
				entityId: "vault-1",
				createdAt: new Date("2026-01-04T00:00:01.000Z"),
			},
		]);

		const result = await caller.teamEvents({ actionGroup: "item", limit: 10 });

		expect(result.events.length).toBe(1);
		expect(result.events[0]?.action).toBe("item_deleted");
		expect(result.events[0]?.actionGroup).toBe("item");
	});

	test("inactive team billing blocks access", async () => {
		const { caller, userId } = await setup(auditRouter);
		await createTestTeam(userId, {
			type: "organization",
			billingPlan: "team",
			billingStatus: "incomplete",
		});

		await expect(caller.teamEvents({})).rejects.toThrow(
			"Team management is unavailable until billing is active",
		);
	});
});
