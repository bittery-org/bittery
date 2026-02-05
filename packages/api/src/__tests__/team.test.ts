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
	// addVaultMember,
	createPublicContext,
	createTestInvitation,
	createTestTeam,
	createTestVault,
	generateTestEmail,
	getTeam,
	getTeamMember,
	setup,
	setupTeamWithMembers,
	truncateAll,
} from "./test-utils";

describe("Team Router", () => {
	afterEach(async () => {
		await truncateAll();
	});

	describe("list", () => {
		test("should return the user's team", async () => {
			const { caller, userId } = await setup(teamRouter);
			await createTestTeam(userId, { name: "My Team" });

			const result = await caller.list();

			expect(result.name).toBe("My Team");
			expect(result.role).toBe("owner");
			expect(result.memberCount).toBe(1);
		});

		test("should throw NOT_FOUND for user with no team", async () => {
			const { caller } = await setup(teamRouter);

			await expect(caller.list()).rejects.toThrow("User has no team");
		});

		test("should return team info for a member", async () => {
			const [{ userId: ownerId }, { userId: memberId, caller }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId, { name: "Owner Team" });
			await addTeamMember(teamId, memberId, "member");

			const result = await caller.list();

			expect(result.name).toBe("Owner Team");
			expect(result.role).toBe("member");
		});
	});

	describe("get", () => {
		test("should return team details with user role", async () => {
			const { caller, userId } = await setup(teamRouter, {
				name: "Team Owner",
			});
			const teamId = await createTestTeam(userId, { name: "My Team" });

			const result = await caller.get({ teamId });

			expect(result.id).toBe(teamId);
			expect(result.name).toBe("My Team");
			expect(result.userRole).toBe("owner");
			expect(result.ownerName).toBe("Team Owner");
			expect(result.memberCount).toBe(1);
		});

		test("should deny access to non-members", async () => {
			const [{ userId: ownerId }, { caller }] = await Promise.all([
				setup(teamRouter),
				setup(teamRouter),
			]);
			const teamId = await createTestTeam(ownerId);

			await expect(caller.get({ teamId })).rejects.toThrow(
				"You are not a member of this team",
			);
		});
	});

	describe("create", () => {
		test("should reject team creation (teams are auto-created on signup)", async () => {
			const { caller } = await setup(teamRouter);

			await expect(caller.create({ name: "New Team" })).rejects.toThrow(
				"Teams are automatically created on signup",
			);
		});
	});

	describe("update", () => {
		test("should allow owner to update team name", async () => {
			const { caller, userId } = await setup(teamRouter);
			const teamId = await createTestTeam(userId, { name: "Old Name" });

			const result = await caller.update({ teamId, name: "New Name" });

			expect(result.success).toBe(true);

			const team = await getTeam(teamId);
			expect(team?.name).toBe("New Name");
		});

		test("should allow admin to update team name", async () => {
			const [{ userId: ownerId }, { userId: adminId, caller }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId, { name: "Old Name" });
			await addTeamMember(teamId, adminId, "admin");

			const result = await caller.update({ teamId, name: "Admin Updated" });

			expect(result.success).toBe(true);
		});

		test("should deny regular member from updating team", async () => {
			const [{ userId: ownerId }, { userId: memberId, caller }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId);
			await addTeamMember(teamId, memberId, "member");

			await expect(
				caller.update({ teamId, name: "Hacked Name" }),
			).rejects.toThrow("Insufficient permissions");
		});
	});

	describe("delete", () => {
		test("should allow owner to delete non-personal team", async () => {
			const { caller, userId } = await setup(teamRouter);
			const teamId = await createTestTeam(userId, { type: "organization" });

			const result = await caller.delete({ teamId });

			expect(result.success).toBe(true);

			const team = await getTeam(teamId);
			expect(team).toBeUndefined();
		});

		test("should deny non-owner from deleting team", async () => {
			const [{ userId: ownerId }, { userId: adminId, caller }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId, { type: "organization" });
			await addTeamMember(teamId, adminId, "admin");

			await expect(caller.delete({ teamId })).rejects.toThrow(
				"Only the team owner can delete the team",
			);
		});

		test("should not allow deleting personal team", async () => {
			const { caller, userId } = await setup(teamRouter);
			// Default type is "personal"
			const teamId = await createTestTeam(userId);

			await expect(caller.delete({ teamId })).rejects.toThrow(
				"Personal teams cannot be deleted",
			);
		});
	});

	describe("leave", () => {
		test("should reject leaving team (not allowed in new architecture)", async () => {
			const { caller, userId } = await setup(teamRouter);
			const teamId = await createTestTeam(userId);

			await expect(caller.leave({ teamId })).rejects.toThrow(
				"You cannot leave your team",
			);
		});
	});

	describe("members.list", () => {
		test("should return all team members", async () => {
			const { caller, userId: ownerId } = await setup(teamRouter, {
				name: "Owner",
			});
			const { teamId } = await setupTeamWithMembers(ownerId, [
				{ role: "admin", overrides: { name: "Admin" } },
				{ role: "member", overrides: { name: "Member" } },
			]);

			const result = await caller.members.list({ teamId });

			expect(result.length).toBe(3);
			expect(result.map((m) => m.role)).toContain("owner");
			expect(result.map((m) => m.role)).toContain("admin");
			expect(result.map((m) => m.role)).toContain("member");
		});
	});

	describe("invitations.send", () => {
		test("should create invitation for new email", async () => {
			const { caller, userId } = await setup(teamRouter);
			const teamId = await createTestTeam(userId);
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
			const [{ userId: ownerId, caller }, { email: existingEmail }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId);

			const result = await caller.invitations.send({
				teamId,
				email: existingEmail,
				role: "admin",
			});

			expect(result.existingUserPublicKey).toBeDefined();
		});

		test("should reject invitation for user who already belongs to a team", async () => {
			const [
				{ userId: ownerId, caller },
				{ userId: memberId, email: memberEmail },
			] = await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId);
			await addTeamMember(teamId, memberId, "member");

			await expect(
				caller.invitations.send({
					teamId,
					email: memberEmail,
					role: "admin",
				}),
			).rejects.toThrow("This user already belongs to a team");
		});

		test("should reject duplicate pending invitation", async () => {
			const { caller, userId } = await setup(teamRouter);
			const teamId = await createTestTeam(userId);
			const inviteeEmail = generateTestEmail();

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
			const { caller, userId } = await setup(teamRouter);
			const teamId = await createTestTeam(userId);
			await createTestInvitation(teamId, userId, "invite1@example.com");
			await createTestInvitation(teamId, userId, "invite2@example.com");

			const result = await caller.invitations.list({ teamId });

			expect(result.length).toBe(2);
		});
	});

	describe("invitations.getByToken", () => {
		test("should return invitation details by token (public)", async () => {
			const { userId } = await setup(teamRouter, { name: "Inviter" });
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
			const { userId } = await setup(teamRouter);
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
			const { caller, userId } = await setup(teamRouter);
			const teamId = await createTestTeam(userId);
			const { invitationId } = await createTestInvitation(
				teamId,
				userId,
				"invitee@example.com",
			);

			const result = await caller.invitations.cancel({ invitationId });

			expect(result.success).toBe(true);
		});
	});

	describe("invitations.resend", () => {
		test("should reset expiration date", async () => {
			const { caller, userId } = await setup(teamRouter);
			const teamId = await createTestTeam(userId);
			const { invitationId } = await createTestInvitation(
				teamId,
				userId,
				"invitee@example.com",
				{ expiresAt: new Date(Date.now() + 1000) }, // About to expire
			);

			const result = await caller.invitations.resend({ invitationId });

			expect(result.success).toBe(true);
		});
	});

	describe("invitations.pending", () => {
		test("should return pending invitations for current user", async () => {
			const [{ userId: ownerId }, { email: inviteeEmail, caller }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId, { name: "Inviting Team" });
			await createTestInvitation(teamId, ownerId, inviteeEmail, {
				role: "member",
			});

			const result = await caller.invitations.pending();

			expect(result.length).toBe(1);
			expect(result[0]?.teamName).toBe("Inviting Team");
		});
	});

	describe("invitations.accept", () => {
		test("should accept invitation and join team", async () => {
			const [
				{ userId: ownerId },
				{ userId: inviteeId, email: inviteeEmail, caller },
			] = await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId, { name: "Join Me" });
			const { token } = await createTestInvitation(
				teamId,
				ownerId,
				inviteeEmail,
				{ role: "admin" },
			);

			const result = await caller.invitations.accept({ token });

			expect(result.teamId).toBe(teamId);
			expect(result.teamName).toBe("Join Me");

			const membership = await getTeamMember(teamId, inviteeId);
			expect(membership?.role).toBe("admin");
		});

		test("should reject expired invitation", async () => {
			const [{ userId: ownerId }, { email: inviteeEmail, caller }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId);
			const { token } = await createTestInvitation(
				teamId,
				ownerId,
				inviteeEmail,
				{ expiresAt: new Date(Date.now() - 1000) }, // Expired
			);

			await expect(caller.invitations.accept({ token })).rejects.toThrow(
				"Invitation has expired",
			);
		});

		test("should reject if invitation is for different email", async () => {
			const [{ userId: ownerId }, { caller }] = await Promise.all([
				setup(teamRouter),
				setup(teamRouter),
			]);
			const teamId = await createTestTeam(ownerId);
			const { token } = await createTestInvitation(
				teamId,
				ownerId,
				generateTestEmail(), // Different email
			);

			await expect(caller.invitations.accept({ token })).rejects.toThrow(
				"This invitation is not for you",
			);
		});
	});

	describe("vaults", () => {
		test("should return team vaults for owner", async () => {
			const { caller, userId } = await setup(teamRouter);
			const teamId = await createTestTeam(userId);
			await createTestVault(userId, { name: "Team Vault", teamId });

			const result = await caller.vaults({ teamId });

			expect(result.length).toBe(1);
			expect(result[0]?.name).toBe("Team Vault");
		});

		test("should deny access to non-members", async () => {
			const [{ userId: ownerId }, { caller }] = await Promise.all([
				setup(teamRouter),
				setup(teamRouter),
			]);
			const teamId = await createTestTeam(ownerId);

			await expect(caller.vaults({ teamId })).rejects.toThrow(
				"You are not a member of this team",
			);
		});

		test("should deny access to regular members", async () => {
			const [{ userId: ownerId }, { userId: memberId, caller }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId);
			await addTeamMember(teamId, memberId, "member");

			await expect(caller.vaults({ teamId })).rejects.toThrow(
				"Insufficient permissions",
			);
		});

		test("should include encrypted vault keys for the requesting user", async () => {
			const { caller, userId } = await setup(teamRouter);
			const teamId = await createTestTeam(userId);
			// const vaultId = await createTestVault(userId, { teamId });

			const result = await caller.vaults({ teamId });

			expect(result[0]?.encryptedVaultKey).toBeDefined();
		});
	});

	describe("members.list - edge cases", () => {
		test("should deny access to non-members", async () => {
			const [{ userId: ownerId }, { caller }] = await Promise.all([
				setup(teamRouter),
				setup(teamRouter),
			]);
			const teamId = await createTestTeam(ownerId);

			await expect(caller.members.list({ teamId })).rejects.toThrow(
				"You are not a member of this team",
			);
		});
	});

	describe("invitations.send - edge cases", () => {
		test("should deny non-owner/admin from sending invitations", async () => {
			const [{ userId: ownerId }, { userId: memberId, caller }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId);
			await addTeamMember(teamId, memberId, "member");

			await expect(
				caller.invitations.send({
					teamId,
					email: generateTestEmail(),
					role: "member",
				}),
			).rejects.toThrow("Insufficient permissions");
		});
	});

	describe("invitations.accept - edge cases", () => {
		test("should reject if user already belongs to a team", async () => {
			const [
				{ userId: ownerId },
				{ userId: inviteeId, email: inviteeEmail, caller },
			] = await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId);
			const { token } = await createTestInvitation(
				teamId,
				ownerId,
				inviteeEmail,
			);

			// Give invitee their own team first
			await createTestTeam(inviteeId, { name: "Already Has Team" });

			await expect(caller.invitations.accept({ token })).rejects.toThrow(
				"You already belong to a team",
			);
		});
	});

	describe("invitations.cancel - edge cases", () => {
		test("should deny non-inviter non-admin from cancelling", async () => {
			const [{ userId: ownerId }, { userId: memberId, caller }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId);
			await addTeamMember(teamId, memberId, "member");
			const { invitationId } = await createTestInvitation(
				teamId,
				ownerId, // Owner sent it
				"someone@example.com",
			);

			await expect(caller.invitations.cancel({ invitationId })).rejects.toThrow(
				"Insufficient permissions",
			);
		});
	});

	describe("invitations.resend - edge cases", () => {
		test("should deny non-inviter non-admin from resending", async () => {
			const [{ userId: ownerId }, { userId: memberId, caller }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId);
			await addTeamMember(teamId, memberId, "member");
			const { invitationId } = await createTestInvitation(
				teamId,
				ownerId,
				"someone@example.com",
			);

			await expect(caller.invitations.resend({ invitationId })).rejects.toThrow(
				"Insufficient permissions",
			);
		});
	});

	describe("invitations.decline", () => {
		test("should decline invitation", async () => {
			const [
				{ userId: ownerId },
				{ userId: inviteeId, email: inviteeEmail, caller },
			] = await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId);
			const { token } = await createTestInvitation(
				teamId,
				ownerId,
				inviteeEmail,
			);

			const result = await caller.invitations.decline({ token });

			expect(result.success).toBe(true);

			// User should not be a member
			const membership = await getTeamMember(teamId, inviteeId);
			expect(membership).toBeUndefined();
		});
	});
});
