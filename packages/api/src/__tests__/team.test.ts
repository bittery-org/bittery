/**
 * Integration Tests for Team tRPC Router
 *
 * Tests cover:
 * - Team operations (list, get, create [deprecated], update, delete)
 * - Team membership (leave [deprecated])
 * - Member management (list)
 * - Invitation workflow (send, list, cancel, resend, pending, accept, decline, getByToken)
 * - Role-based permissions (owner, admin, member)
 *
 * Note: In the new architecture, each user belongs to exactly one team
 * via user.teamId and user.role (one-to-one relationship).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { teamRouter } from "../routers/team";
import {
	addTeamMember,
	cleanupTestData,
	createAuthenticatedContext,
	createPublicContext,
	createTestInvitation,
	createTestSession,
	createTestTeam,
	createTestUser,
	generateTestEmail,
	getTeam,
	getTeamMember,
} from "./test-utils";

describe("Team Router", () => {
	const testUserIds: string[] = [];

	afterEach(async () => {
		await cleanupTestData(testUserIds);
		testUserIds.length = 0;
	});

	describe("list", () => {
		test("should return the user's team", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			await createTestTeam(userId, { name: "My Team" });

			const sessionId = await createTestSession(userId);
			const caller = teamRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId),
			);

			const result = await caller.list();

			expect(result.name).toBe("My Team");
			expect(result.role).toBe("owner");
			expect(result.memberCount).toBe(1);
		});

		test("should throw NOT_FOUND for user with no team", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const sessionId = await createTestSession(userId);
			const caller = teamRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId),
			);

			await expect(caller.list()).rejects.toThrow("User has no team");
		});

		test("should return team info for a member", async () => {
			const email1 = generateTestEmail();
			const email2 = generateTestEmail();
			const { userId: ownerId } = await createTestUser({ email: email1 });
			const { userId: memberId } = await createTestUser({ email: email2 });
			testUserIds.push(ownerId, memberId);

			const teamId = await createTestTeam(ownerId, { name: "Owner Team" });
			await addTeamMember(teamId, memberId, "member");

			const sessionId = await createTestSession(memberId);
			const caller = teamRouter.createCaller(
				createAuthenticatedContext(memberId, email2, sessionId),
			);

			const result = await caller.list();

			expect(result.name).toBe("Owner Team");
			expect(result.role).toBe("member");
		});
	});

	describe("get", () => {
		test("should return team details with user role", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email, name: "Team Owner" });
			testUserIds.push(userId);

			const teamId = await createTestTeam(userId, { name: "My Team" });

			const sessionId = await createTestSession(userId);
			const caller = teamRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId),
			);

			const result = await caller.get({ teamId });

			expect(result.id).toBe(teamId);
			expect(result.name).toBe("My Team");
			expect(result.userRole).toBe("owner");
			expect(result.ownerName).toBe("Team Owner");
			expect(result.memberCount).toBe(1);
		});

		test("should deny access to non-members", async () => {
			const email1 = generateTestEmail();
			const email2 = generateTestEmail();
			const { userId: ownerId } = await createTestUser({ email: email1 });
			const { userId: otherId } = await createTestUser({ email: email2 });
			testUserIds.push(ownerId, otherId);

			const teamId = await createTestTeam(ownerId);

			const sessionId = await createTestSession(otherId);
			const caller = teamRouter.createCaller(
				createAuthenticatedContext(otherId, email2, sessionId),
			);

			await expect(caller.get({ teamId })).rejects.toThrow(
				"You are not a member of this team",
			);
		});
	});

	describe("create", () => {
		test("should reject team creation (teams are auto-created on signup)", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const sessionId = await createTestSession(userId);
			const caller = teamRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId),
			);

			await expect(caller.create({ name: "New Team" })).rejects.toThrow(
				"Teams are automatically created on signup",
			);
		});
	});

	describe("update", () => {
		test("should allow owner to update team name", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const teamId = await createTestTeam(userId, { name: "Old Name" });

			const sessionId = await createTestSession(userId);
			const caller = teamRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId),
			);

			const result = await caller.update({ teamId, name: "New Name" });

			expect(result.success).toBe(true);

			const team = await getTeam(teamId);
			expect(team?.name).toBe("New Name");
		});

		test("should allow admin to update team name", async () => {
			const email1 = generateTestEmail();
			const email2 = generateTestEmail();
			const { userId: ownerId } = await createTestUser({ email: email1 });
			const { userId: adminId } = await createTestUser({ email: email2 });
			testUserIds.push(ownerId, adminId);

			const teamId = await createTestTeam(ownerId, { name: "Old Name" });
			await addTeamMember(teamId, adminId, "admin");

			const sessionId = await createTestSession(adminId);
			const caller = teamRouter.createCaller(
				createAuthenticatedContext(adminId, email2, sessionId),
			);

			const result = await caller.update({ teamId, name: "Admin Updated" });

			expect(result.success).toBe(true);
		});

		test("should deny regular member from updating team", async () => {
			const email1 = generateTestEmail();
			const email2 = generateTestEmail();
			const { userId: ownerId } = await createTestUser({ email: email1 });
			const { userId: memberId } = await createTestUser({ email: email2 });
			testUserIds.push(ownerId, memberId);

			const teamId = await createTestTeam(ownerId);
			await addTeamMember(teamId, memberId, "member");

			const sessionId = await createTestSession(memberId);
			const caller = teamRouter.createCaller(
				createAuthenticatedContext(memberId, email2, sessionId),
			);

			await expect(
				caller.update({ teamId, name: "Hacked Name" }),
			).rejects.toThrow("Insufficient permissions");
		});
	});

	describe("delete", () => {
		test("should allow owner to delete non-personal team", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const teamId = await createTestTeam(userId, { type: "organization" });

			const sessionId = await createTestSession(userId);
			const caller = teamRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId),
			);

			const result = await caller.delete({ teamId });

			expect(result.success).toBe(true);

			const team = await getTeam(teamId);
			expect(team).toBeUndefined();
		});

		test("should deny non-owner from deleting team", async () => {
			const email1 = generateTestEmail();
			const email2 = generateTestEmail();
			const { userId: ownerId } = await createTestUser({ email: email1 });
			const { userId: adminId } = await createTestUser({ email: email2 });
			testUserIds.push(ownerId, adminId);

			const teamId = await createTestTeam(ownerId, { type: "organization" });
			await addTeamMember(teamId, adminId, "admin");

			const sessionId = await createTestSession(adminId);
			const caller = teamRouter.createCaller(
				createAuthenticatedContext(adminId, email2, sessionId),
			);

			await expect(caller.delete({ teamId })).rejects.toThrow(
				"Only the team owner can delete the team",
			);
		});

		test("should not allow deleting personal team", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			// Default type is "personal"
			const teamId = await createTestTeam(userId);

			const sessionId = await createTestSession(userId);
			const caller = teamRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId),
			);

			await expect(caller.delete({ teamId })).rejects.toThrow(
				"Personal teams cannot be deleted",
			);
		});
	});

	describe("leave", () => {
		test("should reject leaving team (not allowed in new architecture)", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const teamId = await createTestTeam(userId);

			const sessionId = await createTestSession(userId);
			const caller = teamRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId),
			);

			await expect(caller.leave({ teamId })).rejects.toThrow(
				"You cannot leave your team",
			);
		});
	});

	describe("members.list", () => {
		test("should return all team members", async () => {
			const email1 = generateTestEmail();
			const email2 = generateTestEmail();
			const email3 = generateTestEmail();
			const { userId: ownerId } = await createTestUser({
				email: email1,
				name: "Owner",
			});
			const { userId: adminId } = await createTestUser({
				email: email2,
				name: "Admin",
			});
			const { userId: memberId } = await createTestUser({
				email: email3,
				name: "Member",
			});
			testUserIds.push(ownerId, adminId, memberId);

			const teamId = await createTestTeam(ownerId);
			await addTeamMember(teamId, adminId, "admin");
			await addTeamMember(teamId, memberId, "member");

			const sessionId = await createTestSession(ownerId);
			const caller = teamRouter.createCaller(
				createAuthenticatedContext(ownerId, email1, sessionId),
			);

			const result = await caller.members.list({ teamId });

			expect(result.length).toBe(3);
			expect(result.map((m) => m.role)).toContain("owner");
			expect(result.map((m) => m.role)).toContain("admin");
			expect(result.map((m) => m.role)).toContain("member");
		});
	});

	describe("invitations.send", () => {
		test("should create invitation for new email", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const teamId = await createTestTeam(userId);

			const sessionId = await createTestSession(userId);
			const caller = teamRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId),
			);

			const inviteeEmail = generateTestEmail();
			const result = await caller.invitations.send({
				teamId,
				email: inviteeEmail,
				role: "member",
			});

			expect(result.invitationId).toBeDefined();
			expect(result.token).toBeDefined();
			expect(result.existingUserPublicKey).toBeNull();
		});

		test("should return public key for existing user", async () => {
			const email1 = generateTestEmail();
			const email2 = generateTestEmail();
			const { userId: ownerId } = await createTestUser({ email: email1 });
			const { userId: existingId } = await createTestUser({ email: email2 });
			testUserIds.push(ownerId, existingId);

			const teamId = await createTestTeam(ownerId);

			const sessionId = await createTestSession(ownerId);
			const caller = teamRouter.createCaller(
				createAuthenticatedContext(ownerId, email1, sessionId),
			);

			const result = await caller.invitations.send({
				teamId,
				email: email2,
				role: "admin",
			});

			expect(result.existingUserPublicKey).toBeDefined();
		});

		test("should reject invitation for user who already belongs to a team", async () => {
			const email1 = generateTestEmail();
			const email2 = generateTestEmail();
			const { userId: ownerId } = await createTestUser({ email: email1 });
			const { userId: memberId } = await createTestUser({ email: email2 });
			testUserIds.push(ownerId, memberId);

			const teamId = await createTestTeam(ownerId);
			await addTeamMember(teamId, memberId, "member");

			const sessionId = await createTestSession(ownerId);
			const caller = teamRouter.createCaller(
				createAuthenticatedContext(ownerId, email1, sessionId),
			);

			await expect(
				caller.invitations.send({
					teamId,
					email: email2,
					role: "admin",
				}),
			).rejects.toThrow("This user already belongs to a team");
		});

		test("should reject duplicate pending invitation", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const teamId = await createTestTeam(userId);
			const inviteeEmail = generateTestEmail();

			const sessionId = await createTestSession(userId);
			const caller = teamRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId),
			);

			// First invitation
			await caller.invitations.send({
				teamId,
				email: inviteeEmail,
				role: "member",
			});

			// Duplicate invitation
			await expect(
				caller.invitations.send({
					teamId,
					email: inviteeEmail,
					role: "member",
				}),
			).rejects.toThrow("An invitation is already pending for this email");
		});
	});

	describe("invitations.list", () => {
		test("should return pending invitations for a team", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const teamId = await createTestTeam(userId);
			await createTestInvitation(teamId, userId, "invite1@example.com");
			await createTestInvitation(teamId, userId, "invite2@example.com");

			const sessionId = await createTestSession(userId);
			const caller = teamRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId),
			);

			const result = await caller.invitations.list({ teamId });

			expect(result.length).toBe(2);
		});
	});

	describe("invitations.getByToken", () => {
		test("should return invitation details by token (public)", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email, name: "Inviter" });
			testUserIds.push(userId);

			const teamId = await createTestTeam(userId, { name: "Cool Team" });
			const { token } = await createTestInvitation(
				teamId,
				userId,
				"invitee@example.com",
				{ role: "admin" },
			);

			const caller = teamRouter.createCaller(createPublicContext());

			const result = await caller.invitations.getByToken({ token });

			expect(result.teamName).toBe("Cool Team");
			expect(result.email).toBe("invitee@example.com");
			expect(result.role).toBe("admin");
			expect(result.invitedByName).toBe("Inviter");
			expect(result.status).toBe("pending");
		});

		test("should return expired status for expired invitation", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const teamId = await createTestTeam(userId);
			const { token } = await createTestInvitation(
				teamId,
				userId,
				"invitee@example.com",
				{ expiresAt: new Date(Date.now() - 1000) }, // Expired
			);

			const caller = teamRouter.createCaller(createPublicContext());

			const result = await caller.invitations.getByToken({ token });

			expect(result.status).toBe("expired");
		});
	});

	describe("invitations.cancel", () => {
		test("should allow inviter to cancel invitation", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const teamId = await createTestTeam(userId);
			const { invitationId } = await createTestInvitation(
				teamId,
				userId,
				"invitee@example.com",
			);

			const sessionId = await createTestSession(userId);
			const caller = teamRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId),
			);

			const result = await caller.invitations.cancel({ invitationId });

			expect(result.success).toBe(true);
		});
	});

	describe("invitations.resend", () => {
		test("should reset expiration date", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const teamId = await createTestTeam(userId);
			const { invitationId } = await createTestInvitation(
				teamId,
				userId,
				"invitee@example.com",
				{ expiresAt: new Date(Date.now() + 1000) }, // About to expire
			);

			const sessionId = await createTestSession(userId);
			const caller = teamRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId),
			);

			const result = await caller.invitations.resend({ invitationId });

			expect(result.success).toBe(true);
		});
	});

	describe("invitations.pending", () => {
		test("should return pending invitations for current user", async () => {
			const email1 = generateTestEmail();
			const email2 = generateTestEmail();
			const { userId: ownerId } = await createTestUser({ email: email1 });
			const { userId: inviteeId } = await createTestUser({ email: email2 });
			testUserIds.push(ownerId, inviteeId);

			const teamId = await createTestTeam(ownerId, { name: "Inviting Team" });
			await createTestInvitation(teamId, ownerId, email2, { role: "member" });

			const sessionId = await createTestSession(inviteeId);
			const caller = teamRouter.createCaller(
				createAuthenticatedContext(inviteeId, email2, sessionId),
			);

			const result = await caller.invitations.pending();

			expect(result.length).toBe(1);
			expect(result[0]?.teamName).toBe("Inviting Team");
		});
	});

	describe("invitations.accept", () => {
		test("should accept invitation and join team", async () => {
			const email1 = generateTestEmail();
			const email2 = generateTestEmail();
			const { userId: ownerId } = await createTestUser({ email: email1 });
			const { userId: inviteeId } = await createTestUser({ email: email2 });
			testUserIds.push(ownerId, inviteeId);

			const teamId = await createTestTeam(ownerId, { name: "Join Me" });
			const { token } = await createTestInvitation(teamId, ownerId, email2, {
				role: "admin",
			});

			const sessionId = await createTestSession(inviteeId);
			const caller = teamRouter.createCaller(
				createAuthenticatedContext(inviteeId, email2, sessionId),
			);

			const result = await caller.invitations.accept({ token });

			expect(result.teamId).toBe(teamId);
			expect(result.teamName).toBe("Join Me");

			const membership = await getTeamMember(teamId, inviteeId);
			expect(membership?.role).toBe("admin");
		});

		test("should reject expired invitation", async () => {
			const email1 = generateTestEmail();
			const email2 = generateTestEmail();
			const { userId: ownerId } = await createTestUser({ email: email1 });
			const { userId: inviteeId } = await createTestUser({ email: email2 });
			testUserIds.push(ownerId, inviteeId);

			const teamId = await createTestTeam(ownerId);
			const { token } = await createTestInvitation(teamId, ownerId, email2, {
				expiresAt: new Date(Date.now() - 1000), // Expired
			});

			const sessionId = await createTestSession(inviteeId);
			const caller = teamRouter.createCaller(
				createAuthenticatedContext(inviteeId, email2, sessionId),
			);

			await expect(caller.invitations.accept({ token })).rejects.toThrow(
				"Invitation has expired",
			);
		});

		test("should reject if invitation is for different email", async () => {
			const email1 = generateTestEmail();
			const email2 = generateTestEmail();
			const email3 = generateTestEmail();
			const { userId: ownerId } = await createTestUser({ email: email1 });
			const { userId: wrongUserId } = await createTestUser({ email: email3 });
			testUserIds.push(ownerId, wrongUserId);

			const teamId = await createTestTeam(ownerId);
			const { token } = await createTestInvitation(teamId, ownerId, email2);

			const sessionId = await createTestSession(wrongUserId);
			const caller = teamRouter.createCaller(
				createAuthenticatedContext(wrongUserId, email3, sessionId),
			);

			await expect(caller.invitations.accept({ token })).rejects.toThrow(
				"This invitation is not for you",
			);
		});
	});

	describe("invitations.decline", () => {
		test("should decline invitation", async () => {
			const email1 = generateTestEmail();
			const email2 = generateTestEmail();
			const { userId: ownerId } = await createTestUser({ email: email1 });
			const { userId: inviteeId } = await createTestUser({ email: email2 });
			testUserIds.push(ownerId, inviteeId);

			const teamId = await createTestTeam(ownerId);
			const { token } = await createTestInvitation(teamId, ownerId, email2);

			const sessionId = await createTestSession(inviteeId);
			const caller = teamRouter.createCaller(
				createAuthenticatedContext(inviteeId, email2, sessionId),
			);

			const result = await caller.invitations.decline({ token });

			expect(result.success).toBe(true);

			// User should not be a member
			const membership = await getTeamMember(teamId, inviteeId);
			expect(membership).toBeUndefined();
		});
	});
});
