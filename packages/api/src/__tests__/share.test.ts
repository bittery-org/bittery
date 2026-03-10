/**
 * Integration Tests for Share tRPC Router
 *
 * Tests cover:
 * - Share link creation with different access modes (anyone, email-restricted)
 * - Share link management (listByItem, get, revoke, update, getAccessLogs)
 * - Public share access (getPublicInfo, accessPublic)
 * - Email verification flow (requestEmailVerification, verifyEmailAndAccess)
 * - Rate limiting
 * - Expiration and one-time use links
 */
/** biome-ignore-all lint/style/noNonNullAssertion: It's okay in test files */

import { afterEach, describe, expect, test } from "bun:test";
import { db } from "@bittery/db";
import { shareEmailVerification } from "@bittery/db/schema/sharing";
import { nanoid } from "nanoid";
import { shareRouter } from "../routers/share";
import {
	addShareLinkAllowedEmail,
	addVaultMember,
	createPublicContext,
	createTestItem,
	createTestShareLink,
	createTestTeam,
	createTestVault,
	mockShareData,
	setup,
	setupShareLink,
	truncateAll,
} from "./test-utils";

async function setupShareUser() {
	const result = await setup(shareRouter);
	await createTestTeam(result.userId, {
		billingPlan: "personal",
		billingStatus: "active",
		type: "personal",
	});
	return result;
}

describe("Share Router", () => {
	afterEach(async () => {
		await truncateAll();
	});

	describe("create", () => {
		test("should create share link with 'anyone' access mode", async () => {
			const { caller, userId } = await setupShareUser();
			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId);

			const result = await caller.create({
				itemId,
				accessMode: "anyone",
				isOneTimeUse: false,
				expiresIn: "7days",
				...mockShareData,
			});

			expect(result.id).toBeDefined();
			expect(result.token).toBeDefined();
			expect(result.expiresAt).toBeDefined();

			// Verify expiration is approximately 7 days from now
			const expectedExpiry = Date.now() + 7 * 24 * 60 * 60 * 1000;
			const actualExpiry = new Date(result.expiresAt).getTime();
			expect(Math.abs(actualExpiry - expectedExpiry)).toBeLessThan(10000); // Within 10 seconds

			const auditLogs = await db.query.auditLog.findMany({
				where: (log, { and, eq }) =>
					and(eq(log.userId, userId), eq(log.action, "share_created")),
			});
			expect(auditLogs.length).toBe(1);
			expect(auditLogs[0]?.entityType).toBe("share_link");
			expect(auditLogs[0]?.entityId).toBe(result.id);
		});

		test("should create share link with 'email-restricted' access mode", async () => {
			const { caller, userId } = await setupShareUser();
			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId);

			const result = await caller.create({
				itemId,
				accessMode: "email-restricted",
				isOneTimeUse: false,
				expiresIn: "1day",
				allowedEmails: ["allowed1@example.com", "allowed2@example.com"],
				...mockShareData,
			});

			expect(result.id).toBeDefined();
			expect(result.token).toBeDefined();
		});

		test("should require allowed emails for email-restricted mode", async () => {
			const { caller, userId } = await setupShareUser();
			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId);

			await expect(
				caller.create({
					itemId,
					accessMode: "email-restricted",
					isOneTimeUse: false,
					expiresIn: "1day",
					// Missing allowedEmails
					...mockShareData,
				}),
			).rejects.toThrow(
				"At least one email address is required for email-restricted sharing",
			);
		});

		test("should create one-time use link", async () => {
			const { caller, userId } = await setupShareUser();
			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId);

			const result = await caller.create({
				itemId,
				accessMode: "anyone",
				isOneTimeUse: true,
				expiresIn: "1hour",
				...mockShareData,
			});

			expect(result.id).toBeDefined();
		});

		test("should deny sharing for read-only members", async () => {
			const [{ userId: ownerId }, { userId: readOnlyId, caller }] =
				await Promise.all([setupShareUser(), setupShareUser()]);
			const vaultId = await createTestVault(ownerId);
			const itemId = await createTestItem(vaultId, ownerId);
			await addVaultMember(vaultId, readOnlyId, "read-only");

			await expect(
				caller.create({
					itemId,
					accessMode: "anyone",
					isOneTimeUse: false,
					expiresIn: "1day",
					...mockShareData,
				}),
			).rejects.toThrow("Read-only users cannot share items");
		});

		test("should deny access to non-member", async () => {
			const [{ userId: ownerId }, { caller }] = await Promise.all([
				setupShareUser(),
				setupShareUser(),
			]);
			const vaultId = await createTestVault(ownerId);
			const itemId = await createTestItem(vaultId, ownerId);

			await expect(
				caller.create({
					itemId,
					accessMode: "anyone",
					isOneTimeUse: false,
					expiresIn: "1day",
					...mockShareData,
				}),
			).rejects.toThrow("Access denied to this item");
		});

		test("should enforce share_links entitlement for free plan", async () => {
			const { caller, userId } = await setupShareUser();
			await createTestTeam(userId, {
				billingPlan: "free",
				billingStatus: "none",
				type: "personal",
			});
			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId);

			await expect(
				caller.create({
					itemId,
					accessMode: "anyone",
					isOneTimeUse: false,
					expiresIn: "1day",
					...mockShareData,
				}),
			).rejects.toThrow(
				"Share links are not available on your current plan. Upgrade to continue.",
			);
		});

		test("should fail closed for cloud users without a team", async () => {
			const { caller, userId } = await setup(shareRouter);
			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId);

			await expect(
				caller.create({
					itemId,
					accessMode: "anyone",
					isOneTimeUse: false,
					expiresIn: "1day",
					...mockShareData,
				}),
			).rejects.toThrow(
				"Share links are not available on your current plan. Upgrade to continue.",
			);
		});

		test("should enforce personal plan active share link limit", async () => {
			const { caller, userId } = await setupShareUser();
			await createTestTeam(userId, {
				billingPlan: "personal",
				billingStatus: "active",
				type: "personal",
			});
			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId);

			for (let i = 0; i < 5; i += 1) {
				await caller.create({
					itemId,
					accessMode: "anyone",
					isOneTimeUse: false,
					expiresIn: "1day",
					...mockShareData,
				});
			}

			await expect(
				caller.create({
					itemId,
					accessMode: "anyone",
					isOneTimeUse: false,
					expiresIn: "1day",
					...mockShareData,
				}),
			).rejects.toThrow(
				"Your plan allows up to 5 active share links. Revoke a link or upgrade to continue.",
			);
		});

		test("should enforce max active link cap under concurrent requests", async () => {
			const { caller, userId } = await setupShareUser();
			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId);

			for (let i = 0; i < 4; i += 1) {
				await caller.create({
					itemId,
					accessMode: "anyone",
					isOneTimeUse: false,
					expiresIn: "1day",
					...mockShareData,
				});
			}

			const attempts = await Promise.allSettled([
				caller.create({
					itemId,
					accessMode: "anyone",
					isOneTimeUse: false,
					expiresIn: "1day",
					...mockShareData,
				}),
				caller.create({
					itemId,
					accessMode: "anyone",
					isOneTimeUse: false,
					expiresIn: "1day",
					...mockShareData,
				}),
			]);

			const successCount = attempts.filter(
				(attempt) => attempt.status === "fulfilled",
			).length;
			const failureCount = attempts.filter(
				(attempt) => attempt.status === "rejected",
			).length;

			expect(successCount).toBe(1);
			expect(failureCount).toBe(1);

			const activeLinks = await db.query.shareLink.findMany({
				where: (link, { and, eq, gt }) =>
					and(
						eq(link.createdById, userId),
						eq(link.status, "active"),
						gt(link.expiresAt, new Date()),
					),
			});
			expect(activeLinks.length).toBe(5);
		});

		test("should enforce daily rate limit atomically under concurrent create requests", async () => {
			const { caller, userId } = await setupShareUser();
			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId);
			const originalLimit = process.env.SHARE_LINK_DAILY_LIMIT;
			process.env.SHARE_LINK_DAILY_LIMIT = "1";

			try {
				const results = await Promise.allSettled([
					caller.create({
						itemId,
						accessMode: "anyone",
						isOneTimeUse: false,
						expiresIn: "1day",
						...mockShareData,
					}),
					caller.create({
						itemId,
						accessMode: "anyone",
						isOneTimeUse: false,
						expiresIn: "1day",
						...mockShareData,
					}),
				]);

				const successCount = results.filter(
					(r) => r.status === "fulfilled",
				).length;
				const failureCount = results.filter(
					(r) => r.status === "rejected",
				).length;
				expect(successCount).toBe(1);
				expect(failureCount).toBe(1);
			} finally {
				if (originalLimit === undefined) {
					delete process.env.SHARE_LINK_DAILY_LIMIT;
				} else {
					process.env.SHARE_LINK_DAILY_LIMIT = originalLimit;
				}
			}
		});
	});

	describe("listByItem", () => {
		test("should return all share links for an item", async () => {
			const { caller, userId } = await setupShareUser();
			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId);
			await createTestShareLink(itemId, userId, { accessMode: "anyone" });
			await createTestShareLink(itemId, userId, {
				accessMode: "email-restricted",
			});

			const result = await caller.listByItem({ itemId });

			expect(result.links.length).toBe(2);
			expect(result.baseShareUrl).toBeDefined();
		});

		test("should only return own links for member", async () => {
			const [
				{ userId: ownerId, caller: ownerCaller },
				{ userId: memberId, caller },
			] = await Promise.all([setupShareUser(), setupShareUser()]);
			const vaultId = await createTestVault(ownerId);
			const itemId = await createTestItem(vaultId, ownerId);
			await addVaultMember(vaultId, memberId, "member");

			await ownerCaller.create({
				itemId,
				accessMode: "anyone",
				isOneTimeUse: false,
				expiresIn: "1day",
				...mockShareData,
			});
			const memberLink = await caller.create({
				itemId,
				accessMode: "anyone",
				isOneTimeUse: false,
				expiresIn: "1day",
				...mockShareData,
			});

			const result = await caller.listByItem({ itemId });

			expect(result.links.length).toBe(1);
			expect(result.links[0]?.id).toBe(memberLink.id);
		});

		test("should mark expired links correctly", async () => {
			const { caller, userId } = await setupShareUser();
			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId);
			await createTestShareLink(itemId, userId, {
				expiresAt: new Date(Date.now() - 1000), // Expired
			});

			const result = await caller.listByItem({ itemId });

			expect(result.links[0]?.status).toBe("expired");
		});

		test("should enforce share_links entitlement for listByItem", async () => {
			const { caller, userId } = await setupShareUser();
			await createTestTeam(userId, {
				billingPlan: "free",
				billingStatus: "none",
				type: "personal",
			});
			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId);
			await createTestShareLink(itemId, userId);

			await expect(caller.listByItem({ itemId })).rejects.toThrow(
				"Share links are not available on your current plan. Upgrade to continue.",
			);
		});
	});

	describe("get", () => {
		test("should return share link details", async () => {
			const { caller, userId } = await setupShareUser();
			const { shareLinkId, token } = await setupShareLink(userId, {
				shareLinkOverrides: { accessMode: "email-restricted" },
			});
			await addShareLinkAllowedEmail(shareLinkId, "allowed@example.com", true);

			const result = await caller.get({ linkId: shareLinkId });

			expect(result.id).toBe(shareLinkId);
			expect(result.token).toBe(token);
			expect(result.accessMode).toBe("email-restricted");
			expect(result.allowedEmails.length).toBe(1);
			expect(result.allowedEmails[0]?.email).toBe("allowed@example.com");
			expect(result.allowedEmails[0]?.verified).toBe(true);
		});

		test("should return NOT_FOUND to another regular vault member", async () => {
			const [
				{ userId: ownerId },
				{ userId: creatorId, caller: creatorCaller },
				{ userId: otherMemberId, caller: otherMemberCaller },
				{ userId: adminId, caller: adminCaller },
			] = await Promise.all([
				setupShareUser(),
				setupShareUser(),
				setupShareUser(),
				setupShareUser(),
			]);
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			const vaultId = await createTestVault(ownerId, {
				type: "team",
				teamId,
			});
			const itemId = await createTestItem(vaultId, ownerId);
			await addVaultMember(vaultId, creatorId, "member");
			await addVaultMember(vaultId, otherMemberId, "member");
			await addVaultMember(vaultId, adminId, "admin");

			const created = await creatorCaller.create({
				itemId,
				accessMode: "anyone",
				isOneTimeUse: false,
				expiresIn: "7days",
				...mockShareData,
			});

			const creatorResult = await creatorCaller.get({ linkId: created.id });
			expect(creatorResult.id).toBe(created.id);

			await expect(
				otherMemberCaller.get({ linkId: created.id }),
			).rejects.toThrow("Share link not found");

			const adminResult = await adminCaller.get({ linkId: created.id });
			expect(adminResult.id).toBe(created.id);
		});
	});

	describe("revoke", () => {
		test("should revoke a share link", async () => {
			const { caller, userId } = await setupShareUser();
			const { shareLinkId } = await setupShareLink(userId);

			const result = await caller.revoke({ linkId: shareLinkId });

			expect(result.success).toBe(true);

			// Verify status changed
			const link = await db.query.shareLink.findFirst({
				where: (sl, { eq }) => eq(sl.id, shareLinkId),
			});
			expect(link?.status).toBe("revoked");

			const auditLogs = await db.query.auditLog.findMany({
				where: (log, { and, eq }) =>
					and(eq(log.userId, userId), eq(log.action, "share_revoked")),
			});
			expect(auditLogs.length).toBe(1);
			expect(auditLogs[0]?.entityId).toBe(shareLinkId);
		});

		test("should deny revocation by read-only member", async () => {
			const [{ userId: ownerId }, { userId: readOnlyId, caller }] =
				await Promise.all([setupShareUser(), setupShareUser()]);
			const { shareLinkId, vaultId } = await setupShareLink(ownerId);
			await addVaultMember(vaultId, readOnlyId, "read-only");

			await expect(caller.revoke({ linkId: shareLinkId })).rejects.toThrow(
				"You do not have permission to revoke this link",
			);
		});

		test("should deny admin from revoking owner-created link", async () => {
			const [{ userId: ownerId }, { userId: adminId, caller }] =
				await Promise.all([setupShareUser(), setupShareUser()]);
			const { shareLinkId, vaultId } = await setupShareLink(ownerId);
			await addVaultMember(vaultId, adminId, "admin");

			await expect(caller.revoke({ linkId: shareLinkId })).rejects.toThrow(
				"You do not have permission to revoke this link",
			);
		});
	});

	describe("update", () => {
		test("should update one-time use setting", async () => {
			const { caller, userId } = await setupShareUser();
			const { shareLinkId } = await setupShareLink(userId, {
				shareLinkOverrides: { isOneTimeUse: false },
			});

			const result = await caller.update({
				linkId: shareLinkId,
				isOneTimeUse: true,
			});

			expect(result.success).toBe(true);

			const link = await db.query.shareLink.findFirst({
				where: (sl, { eq }) => eq(sl.id, shareLinkId),
			});
			expect(link?.isOneTimeUse).toBe(true);
			expect(link?.maxAccessCount).toBe(1);
		});

		test("should add and remove allowed emails", async () => {
			const { caller, userId } = await setupShareUser();
			const { shareLinkId } = await setupShareLink(userId, {
				shareLinkOverrides: { accessMode: "email-restricted" },
			});
			const emailId = await addShareLinkAllowedEmail(
				shareLinkId,
				"remove@example.com",
			);

			const result = await caller.update({
				linkId: shareLinkId,
				addEmails: ["new@example.com"],
				removeEmailIds: [emailId],
			});

			expect(result.success).toBe(true);
		});

		test("should not remove allowed emails from a different share link", async () => {
			const [{ caller: callerA, userId: userAId }, { userId: userBId }] =
				await Promise.all([setupShareUser(), setupShareUser()]);
			const { shareLinkId: linkAId } = await setupShareLink(userAId, {
				shareLinkOverrides: { accessMode: "email-restricted" },
			});
			const { shareLinkId: linkBId } = await setupShareLink(userBId, {
				shareLinkOverrides: { accessMode: "email-restricted" },
			});
			const foreignEmailId = await addShareLinkAllowedEmail(
				linkBId,
				"foreign@example.com",
			);

			await expect(
				callerA.update({
					linkId: linkAId,
					removeEmailIds: [foreignEmailId],
				}),
			).rejects.toThrow(
				"One or more removeEmailIds are invalid for this share link",
			);

			const foreignEmail = await db.query.shareLinkAllowedEmail.findFirst({
				where: (emailRow, { eq }) => eq(emailRow.id, foreignEmailId),
			});
			expect(foreignEmail).toBeDefined();
		});
	});

	describe("getPublicInfo", () => {
		test("should return valid share link info", async () => {
			const { userId } = await setupShareUser();
			const { token } = await setupShareLink(userId, {
				shareLinkOverrides: { accessMode: "anyone", isOneTimeUse: true },
			});

			const caller = shareRouter.createCaller(createPublicContext());

			const result = await caller.getPublicInfo({ token });

			expect(result.valid).toBe(true);
			expect(result.accessMode).toBe("anyone");
			expect(result.isOneTimeUse).toBe(true);
		});

		test("should return invalid for revoked link", async () => {
			const { userId } = await setupShareUser();
			const { token } = await setupShareLink(userId, {
				shareLinkOverrides: { status: "revoked" },
			});

			const caller = shareRouter.createCaller(createPublicContext());

			const result = await caller.getPublicInfo({ token });

			expect(result.valid).toBe(false);
			expect(result.reason).toBe("revoked");
		});

		test("should return invalid for expired link", async () => {
			const { userId } = await setupShareUser();
			const { token } = await setupShareLink(userId, {
				shareLinkOverrides: { expiresAt: new Date(Date.now() - 1000) },
			});

			const caller = shareRouter.createCaller(createPublicContext());

			const result = await caller.getPublicInfo({ token });

			expect(result.valid).toBe(false);
			expect(result.reason).toBe("expired");
		});

		test("should return invalid for exhausted link", async () => {
			const { userId } = await setupShareUser();
			const { token } = await setupShareLink(userId, {
				shareLinkOverrides: { maxAccessCount: 1, accessCount: 1 },
			});

			const caller = shareRouter.createCaller(createPublicContext());

			const result = await caller.getPublicInfo({ token });

			expect(result.valid).toBe(false);
			expect(result.reason).toBe("exhausted");
		});

		test("should return disabled when creator no longer has share links entitlement", async () => {
			const { userId } = await setupShareUser();
			await createTestTeam(userId, {
				billingPlan: "free",
				billingStatus: "none",
				type: "personal",
			});
			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId);
			const { token } = await createTestShareLink(itemId, userId, {
				accessMode: "anyone",
			});

			const caller = shareRouter.createCaller(createPublicContext());
			const result = await caller.getPublicInfo({ token });

			expect(result.valid).toBe(false);
			expect(result.reason).toBe("disabled");
		});
	});

	describe("accessPublic", () => {
		test("should return encrypted data for valid 'anyone' link", async () => {
			const { userId } = await setupShareUser();
			const { token } = await setupShareLink(userId, {
				shareLinkOverrides: { accessMode: "anyone" },
			});

			const caller = shareRouter.createCaller(createPublicContext());

			const result = await caller.accessPublic({ token });

			expect(result.encryptedItemData).toBe(mockShareData.encryptedItemData);
			expect(result.encryptionIv).toBe(mockShareData.encryptionIv);
			expect(result.encryptedShareKey).toBe(mockShareData.encryptedShareKey);
			expect(result.shareKeyIv).toBe(mockShareData.shareKeyIv);
		});

		test("should increment access count", async () => {
			const { userId } = await setupShareUser();
			const { shareLinkId, token } = await setupShareLink(userId, {
				shareLinkOverrides: { accessMode: "anyone", accessCount: 0 },
			});

			const caller = shareRouter.createCaller(createPublicContext());

			await caller.accessPublic({ token });

			const link = await db.query.shareLink.findFirst({
				where: (sl, { eq }) => eq(sl.id, shareLinkId),
			});
			expect(link?.accessCount).toBe(1);
		});

		test("should allow only one concurrent access for one-time links", async () => {
			const { userId } = await setupShareUser();
			const { shareLinkId, token } = await setupShareLink(userId, {
				shareLinkOverrides: {
					accessMode: "anyone",
					isOneTimeUse: true,
					maxAccessCount: 1,
					accessCount: 0,
				},
			});

			const caller = shareRouter.createCaller(createPublicContext());
			const attempts = await Promise.allSettled(
				Array.from({ length: 10 }, () => caller.accessPublic({ token })),
			);

			const successCount = attempts.filter(
				(a) => a.status === "fulfilled",
			).length;
			expect(successCount).toBe(1);

			const link = await db.query.shareLink.findFirst({
				where: (sl, { eq }) => eq(sl.id, shareLinkId),
			});
			expect(link?.accessCount).toBe(1);
		});

		test("should exhaust one-time use link after access", async () => {
			const { userId } = await setupShareUser();
			const { shareLinkId, token } = await setupShareLink(userId, {
				shareLinkOverrides: {
					accessMode: "anyone",
					isOneTimeUse: true,
					maxAccessCount: 1,
					accessCount: 0,
				},
			});

			const caller = shareRouter.createCaller(createPublicContext());

			// First access should succeed
			await caller.accessPublic({ token });

			const link = await db.query.shareLink.findFirst({
				where: (sl, { eq }) => eq(sl.id, shareLinkId),
			});
			expect(link?.status).toBe("exhausted");

			// Second access should fail
			await expect(caller.accessPublic({ token })).rejects.toThrow(
				"This share link has been exhausted",
			);
		});

		test("should reject revoked link", async () => {
			const { userId } = await setupShareUser();
			const { token } = await setupShareLink(userId, {
				shareLinkOverrides: { accessMode: "anyone", status: "revoked" },
			});

			const caller = shareRouter.createCaller(createPublicContext());

			await expect(caller.accessPublic({ token })).rejects.toThrow(
				"This share link has been revoked",
			);
		});

		test("should reject expired link", async () => {
			const { userId } = await setupShareUser();
			const { token } = await setupShareLink(userId, {
				shareLinkOverrides: {
					accessMode: "anyone",
					expiresAt: new Date(Date.now() - 1000),
				},
			});

			const caller = shareRouter.createCaller(createPublicContext());

			await expect(caller.accessPublic({ token })).rejects.toThrow(
				"This share link has expired",
			);
		});

		test("should reject access when creator no longer has share links entitlement", async () => {
			const { userId } = await setupShareUser();
			await createTestTeam(userId, {
				billingPlan: "free",
				billingStatus: "none",
				type: "personal",
			});
			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId);
			const { token } = await createTestShareLink(itemId, userId, {
				accessMode: "anyone",
			});

			const caller = shareRouter.createCaller(createPublicContext());
			await expect(caller.accessPublic({ token })).rejects.toThrow(
				"This share link is no longer valid",
			);
		});
	});

	describe("requestEmailVerification", () => {
		test("should send verification code for allowed email", async () => {
			const { userId } = await setupShareUser();
			const { shareLinkId, token } = await setupShareLink(userId, {
				shareLinkOverrides: { accessMode: "email-restricted" },
			});
			await addShareLinkAllowedEmail(shareLinkId, "allowed@example.com");

			const caller = shareRouter.createCaller(createPublicContext());

			const result = await caller.requestEmailVerification({
				token,
				email: "allowed@example.com",
			});

			expect(result.success).toBe(true);
			expect(result.message).toBe("Verification code sent to your email");
		});

		test("should reject email not in allowed list", async () => {
			const { userId } = await setupShareUser();
			const { shareLinkId, token } = await setupShareLink(userId, {
				shareLinkOverrides: { accessMode: "email-restricted" },
			});
			await addShareLinkAllowedEmail(shareLinkId, "allowed@example.com");

			const caller = shareRouter.createCaller(createPublicContext());

			await expect(
				caller.requestEmailVerification({
					token,
					email: "notallowed@example.com",
				}),
			).rejects.toThrow("This email is not authorized to access this link");
		});

		test("should reject expired link", async () => {
			const { userId } = await setupShareUser();
			const { shareLinkId, token } = await setupShareLink(userId, {
				shareLinkOverrides: {
					accessMode: "email-restricted",
					expiresAt: new Date(Date.now() - 1000),
				},
			});
			await addShareLinkAllowedEmail(shareLinkId, "allowed@example.com");

			const caller = shareRouter.createCaller(createPublicContext());

			await expect(
				caller.requestEmailVerification({
					token,
					email: "allowed@example.com",
				}),
			).rejects.toThrow("This share link is no longer valid");
		});

		test("should reject when total code request limit is reached", async () => {
			const { userId } = await setupShareUser();
			const { shareLinkId, token } = await setupShareLink(userId, {
				shareLinkOverrides: { accessMode: "email-restricted" },
			});
			await addShareLinkAllowedEmail(shareLinkId, "allowed@example.com");

			await db.insert(shareEmailVerification).values(
				Array.from({ length: 5 }, (_, index) => ({
					id: nanoid(),
					shareLinkId,
					email: "allowed@example.com",
					code: `${100000 + index}`,
					expiresAt: new Date(Date.now() + 15 * 60 * 1000),
				})),
			);

			const caller = shareRouter.createCaller(createPublicContext());
			await expect(
				caller.requestEmailVerification({
					token,
					email: "allowed@example.com",
				}),
			).rejects.toThrow(
				"Too many verification attempts for this email. Contact the link creator.",
			);
		});
	});

	describe("verifyEmailAndAccess", () => {
		test("should return encrypted data with valid verification code", async () => {
			const { userId } = await setupShareUser();
			const { shareLinkId, token } = await setupShareLink(userId, {
				shareLinkOverrides: { accessMode: "email-restricted" },
			});
			await addShareLinkAllowedEmail(shareLinkId, "allowed@example.com");

			const publicCaller = shareRouter.createCaller(createPublicContext());

			// Request verification code
			await publicCaller.requestEmailVerification({
				token,
				email: "allowed@example.com",
			});

			// Get the code from the database
			const verification = await db.query.shareEmailVerification.findFirst({
				where: (v, { eq }) => eq(v.shareLinkId, shareLinkId),
			});

			expect(verification).toBeDefined();

			// Verify with the code
			const result = await publicCaller.verifyEmailAndAccess({
				token,
				email: "allowed@example.com",
				code: verification!.code,
			});

			expect(result.encryptedItemData).toBeDefined();
			expect(result.encryptedShareKey).toBeDefined();
		});

		test("should reject wrong verification code", async () => {
			const { userId } = await setupShareUser();
			const { shareLinkId, token } = await setupShareLink(userId, {
				shareLinkOverrides: { accessMode: "email-restricted" },
			});
			await addShareLinkAllowedEmail(shareLinkId, "allowed@example.com");

			const publicCaller = shareRouter.createCaller(createPublicContext());

			// Request verification code
			await publicCaller.requestEmailVerification({
				token,
				email: "allowed@example.com",
			});

			// Verify with wrong code
			await expect(
				publicCaller.verifyEmailAndAccess({
					token,
					email: "allowed@example.com",
					code: "000000",
				}),
			).rejects.toThrow("Invalid or expired verification code");
		});

		test("should reject verification when email is removed after code issuance", async () => {
			const { caller, userId } = await setupShareUser();
			const { shareLinkId, token } = await setupShareLink(userId, {
				shareLinkOverrides: { accessMode: "email-restricted" },
			});
			const emailId = await addShareLinkAllowedEmail(
				shareLinkId,
				"allowed@example.com",
			);
			const publicCaller = shareRouter.createCaller(createPublicContext());

			await publicCaller.requestEmailVerification({
				token,
				email: "allowed@example.com",
			});
			const verification = await db.query.shareEmailVerification.findFirst({
				where: (v, { eq }) => eq(v.shareLinkId, shareLinkId),
			});
			expect(verification).toBeDefined();

			await caller.update({
				linkId: shareLinkId,
				removeEmailIds: [emailId],
			});

			await expect(
				publicCaller.verifyEmailAndAccess({
					token,
					email: "allowed@example.com",
					code: verification!.code,
				}),
			).rejects.toThrow("This email is not authorized to access this link");
		});

		test("should reject expired link", async () => {
			const { userId } = await setupShareUser();
			const { token } = await setupShareLink(userId, {
				shareLinkOverrides: {
					accessMode: "email-restricted",
					expiresAt: new Date(Date.now() - 1000),
				},
			});

			const publicCaller = shareRouter.createCaller(createPublicContext());

			await expect(
				publicCaller.verifyEmailAndAccess({
					token,
					email: "allowed@example.com",
					code: "123456",
				}),
			).rejects.toThrow("This share link is no longer valid");
		});

		test("should reject revoked link", async () => {
			const { userId } = await setupShareUser();
			const { token } = await setupShareLink(userId, {
				shareLinkOverrides: {
					accessMode: "email-restricted",
					status: "revoked",
				},
			});

			const publicCaller = shareRouter.createCaller(createPublicContext());

			await expect(
				publicCaller.verifyEmailAndAccess({
					token,
					email: "allowed@example.com",
					code: "123456",
				}),
			).rejects.toThrow("This share link is no longer valid");
		});
	});

	describe("getAccessLogs", () => {
		test("should return access logs for a share link", async () => {
			const { caller, userId } = await setupShareUser();
			const { shareLinkId, token } = await setupShareLink(userId, {
				shareLinkOverrides: { accessMode: "anyone" },
			});

			// Access the link to create a log entry
			const publicCaller = shareRouter.createCaller(createPublicContext());
			await publicCaller.accessPublic({
				token,
				ipAddress: "192.168.1.1",
				userAgent: "TestBrowser/1.0",
			});

			const result = await caller.getAccessLogs({ linkId: shareLinkId });

			expect(result.length).toBe(1);
			expect(result[0]?.success).toBe(true);
			expect(result[0]?.ipAddress).toBe("192.168.1.1");
		});

		test("should apply creator-only visibility to regular members and allow admins", async () => {
			const [
				{ userId: ownerId },
				{ userId: creatorId, caller: creatorCaller },
				{ userId: otherMemberId, caller: otherMemberCaller },
				{ userId: adminId, caller: adminCaller },
			] = await Promise.all([
				setupShareUser(),
				setupShareUser(),
				setupShareUser(),
				setupShareUser(),
			]);
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			const vaultId = await createTestVault(ownerId, {
				type: "team",
				teamId,
			});
			const itemId = await createTestItem(vaultId, ownerId);
			await addVaultMember(vaultId, creatorId, "member");
			await addVaultMember(vaultId, otherMemberId, "member");
			await addVaultMember(vaultId, adminId, "admin");

			const created = await creatorCaller.create({
				itemId,
				accessMode: "anyone",
				isOneTimeUse: false,
				expiresIn: "7days",
				...mockShareData,
			});

			const publicCaller = shareRouter.createCaller(createPublicContext());
			await publicCaller.accessPublic({
				token: created.token,
				ipAddress: "10.0.0.1",
				userAgent: "VisibilityTest/1.0",
			});

			const creatorLogs = await creatorCaller.getAccessLogs({ linkId: created.id });
			expect(creatorLogs).toHaveLength(1);

			await expect(
				otherMemberCaller.getAccessLogs({ linkId: created.id }),
			).rejects.toThrow("Share link not found");

			const adminLogs = await adminCaller.getAccessLogs({ linkId: created.id });
			expect(adminLogs).toHaveLength(1);
		});
	});
});
