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
import { db } from "@bittery/db";
import { user } from "@bittery/db/schema/auth";
import { eq } from "drizzle-orm";
import { teamRouter } from "../routers/team";
import {
	addTeamMember,
	addVaultMember,
	createPublicContext,
	createTestInvitation,
	createTestSession,
	createTestTeam,
	createTestVault,
	generateTestEmail,
	getSession,
	getTeam,
	getTeamMember,
	getUser,
	setup,
	setupTeamWithMembers,
	truncateAll,
} from "@bittery/test-utils";

const originalBitteryMode = process.env.BITTERY_MODE;

describe("Team Router", () => {
	afterEach(async () => {
		await truncateAll();
		if (originalBitteryMode === undefined) {
			delete process.env.BITTERY_MODE;
		} else {
			process.env.BITTERY_MODE = originalBitteryMode;
		}
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

		test("should reject deleting a non-personal team with extra members", async () => {
			const [{ caller, userId }, { userId: memberId }] = await Promise.all([
				setup(teamRouter),
				setup(teamRouter),
			]);
			const teamId = await createTestTeam(userId, { type: "organization" });
			await addTeamMember(teamId, memberId, "member");

			await expect(caller.delete({ teamId })).rejects.toThrow(
				"Team deletion is blocked until the owner is the only remaining member.",
			);
		});

		test("should reject deleting a non-personal team with team vaults", async () => {
			const { caller, userId } = await setup(teamRouter);
			const teamId = await createTestTeam(userId, { type: "organization" });
			await createTestVault(userId, {
				type: "team",
				teamId,
				name: "Shared Vault",
			});

			await expect(caller.delete({ teamId })).rejects.toThrow(
				"Team deletion is blocked until all team vaults have been removed or converted.",
			);
		});

		test("should move the owner onto a fresh personal team after deletion", async () => {
			const { caller, userId } = await setup(teamRouter);
			const teamId = await createTestTeam(userId, {
				type: "organization",
				name: "Old Team",
			});

			const result = await caller.delete({ teamId });

			expect(result.success).toBe(true);
			const deletedTeam = await getTeam(teamId);
			expect(deletedTeam).toBeUndefined();

			const updatedOwner = await getUser(userId);
			expect(updatedOwner?.teamId).toBeDefined();
			expect(updatedOwner?.teamId).not.toBe(teamId);
			if (!updatedOwner?.teamId) {
				throw new Error("Expected owner to be reassigned to a personal team");
			}

			const replacementTeam = await getTeam(updatedOwner.teamId);
			expect(replacementTeam?.type).toBe("personal");
			expect(replacementTeam?.ownerId).toBe(userId);
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

		test("should block team deletion in self-hosted mode", async () => {
			process.env.BITTERY_MODE = "self-hosted";
			const { caller, userId } = await setup(teamRouter);
			const teamId = await createTestTeam(userId, { type: "organization" });

			await expect(caller.delete({ teamId })).rejects.toThrow(
				"Team deletion is disabled in self-hosted mode",
			);
		});
	});

	describe("leave", () => {
		test("should reject owner from leaving team", async () => {
			const { caller, userId } = await setup(teamRouter);
			const teamId = await createTestTeam(userId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});

			await expect(
				caller.leave({ teamId, vaultRotations: [] }),
			).rejects.toThrow("The team owner cannot leave");
		});

		test("should reject leaving a personal team", async () => {
			const [{ userId: ownerId }, { userId: memberId, caller: memberCaller }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId, {
				type: "personal",
			});
			await addTeamMember(teamId, memberId, "member");

			await expect(
				memberCaller.leave({ teamId, vaultRotations: [] }),
			).rejects.toThrow("You cannot leave a personal team");
		});

		test("should reject oversized nested rotation arrays", async () => {
			const [{ userId: ownerId }, { userId: memberId, caller: memberCaller }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			await addTeamMember(teamId, memberId, "member");

			await expect(
				memberCaller.leave({
					teamId,
					vaultRotations: Array.from({ length: 101 }, (_, index) => ({
						vaultId: `rotation-vault-${index}`,
						keyRotation: { memberKeys: [], reEncryptedItems: [] },
					})),
				}),
			).rejects.toThrow();
		});
	});

	describe("getLeaveRotationData", () => {
		test("should exclude team vaults the leaving member cannot access", async () => {
			const [{ userId: ownerId }, { userId: memberId, caller }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			await addTeamMember(teamId, memberId, "member");
			const accessibleVaultId = await createTestVault(ownerId, {
				type: "team",
				teamId,
				name: "Accessible Vault",
			});
			await createTestVault(ownerId, {
				type: "team",
				teamId,
				name: "Hidden Vault",
			});
			await addVaultMember(accessibleVaultId, memberId, "member");

			const result = await caller.getLeaveRotationData({ teamId });

			expect(result.vaults.map((record) => record.vaultId)).toEqual([
				accessibleVaultId,
			]);
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

	describe("members.remove", () => {
		test("should remove member with empty vault rotations when no team vaults exist", async () => {
			const [{ userId: ownerId, caller }, { userId: memberId }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			await addTeamMember(teamId, memberId, "member");
			const sessionId = await createTestSession(memberId);

			const result = await caller.members.remove({
				teamId,
				userId: memberId,
				vaultRotations: [],
			});

			expect(result.success).toBe(true);
			expect(result.vaultRotations).toEqual([]);
			// Removed user should now have a personal team (not orphaned)
			const removedUser = await getUser(memberId);
			expect(removedUser).toBeDefined();
			expect(removedUser?.teamId).toBeDefined();
			expect(removedUser?.teamId).not.toBe(teamId);
			expect(removedUser?.role).toBe("owner");
			expect(await getTeamMember(teamId, memberId)).toBeUndefined();
			expect(await getSession(sessionId)).toBeUndefined();
		});

		test("should allow admin to remove admin", async () => {
			const [
				{ userId: ownerId },
				{ userId: adminActorId, caller: adminCaller },
				{ userId: adminTargetId },
			] = await Promise.all([
				setup(teamRouter),
				setup(teamRouter),
				setup(teamRouter),
			]);
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			await addTeamMember(teamId, adminActorId, "admin");
			await addTeamMember(teamId, adminTargetId, "admin");

			const result = await adminCaller.members.remove({
				teamId,
				userId: adminTargetId,
				vaultRotations: [],
			});

			expect(result.success).toBe(true);
			expect(await getTeamMember(teamId, adminTargetId)).toBeUndefined();
		});

		test("should deny removing owner", async () => {
			const [{ userId: ownerId }, { userId: adminId, caller: adminCaller }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			await addTeamMember(teamId, adminId, "admin");

			await expect(
				adminCaller.members.remove({
					teamId,
					userId: ownerId,
					vaultRotations: [],
				}),
			).rejects.toThrow("The team owner cannot be removed");
		});

		test("should deny removing yourself", async () => {
			const { userId, caller } = await setup(teamRouter);
			const teamId = await createTestTeam(userId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});

			await expect(
				caller.members.remove({ teamId, userId, vaultRotations: [] }),
			).rejects.toThrow("You cannot remove yourself from the team");
		});

		test("should reject partial team removal when target has inaccessible vault memberships", async () => {
			const [
				{ userId: ownerId },
				{ userId: adminId, caller: adminCaller },
				{ userId: memberId },
			] = await Promise.all([
				setup(teamRouter),
				setup(teamRouter),
				setup(teamRouter),
			]);
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			await addTeamMember(teamId, adminId, "admin");
			await addTeamMember(teamId, memberId, "member");
			const adminVaultId = await createTestVault(ownerId, {
				type: "team",
				teamId,
			});
			const hiddenVaultId = await createTestVault(ownerId, {
				type: "team",
				teamId,
			});
			await addVaultMember(adminVaultId, adminId, "admin");
			await addVaultMember(adminVaultId, memberId, "member");
			await addVaultMember(hiddenVaultId, memberId, "member");

			await expect(
				adminCaller.members.getTeamRotationData({
					teamId,
					excludeUserId: memberId,
				}),
			).rejects.toThrow(
				"You cannot remove this member from only part of their team vault access.",
			);

			await expect(
				adminCaller.members.remove({
					teamId,
					userId: memberId,
					vaultRotations: [
						{
							vaultId: adminVaultId,
							keyRotation: { memberKeys: [], reEncryptedItems: [] },
						},
					],
				}),
			).rejects.toThrow(
				"You cannot remove this member from only part of their team vault access.",
			);
		});

		test("should reject missing required vault rotations", async () => {
			const [{ userId: ownerId, caller }, { userId: memberId }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			await addTeamMember(teamId, memberId, "member");
			const vaultId = await createTestVault(ownerId, {
				type: "team",
				teamId,
			});
			await addVaultMember(vaultId, memberId, "member");

			await expect(
				caller.members.remove({
					teamId,
					userId: memberId,
					vaultRotations: [],
				}),
			).rejects.toThrow(
				"Vault rotation data must exactly match the removable team vault set.",
			);
		});

		test("should reject extra vault rotations", async () => {
			const [{ userId: ownerId, caller }, { userId: memberId }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			await addTeamMember(teamId, memberId, "member");
			const requiredVaultId = await createTestVault(ownerId, {
				type: "team",
				teamId,
			});
			const extraVaultId = await createTestVault(ownerId, {
				type: "team",
				teamId,
			});
			await addVaultMember(requiredVaultId, memberId, "member");

			await expect(
				caller.members.remove({
					teamId,
					userId: memberId,
					vaultRotations: [
						{
							vaultId: requiredVaultId,
							keyRotation: { memberKeys: [], reEncryptedItems: [] },
						},
						{
							vaultId: extraVaultId,
							keyRotation: { memberKeys: [], reEncryptedItems: [] },
						},
					],
				}),
			).rejects.toThrow(
				"Vault rotation data must exactly match the removable team vault set.",
			);
		});

		test("should reject oversized member key rotations", async () => {
			const [{ userId: ownerId, caller }, { userId: memberId }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			await addTeamMember(teamId, memberId, "member");
			const vaultId = await createTestVault(ownerId, {
				type: "team",
				teamId,
			});
			await addVaultMember(vaultId, memberId, "member");

			await expect(
				caller.members.remove({
					teamId,
					userId: memberId,
					vaultRotations: [
						{
							vaultId,
							keyRotation: {
								memberKeys: Array.from({ length: 101 }, (_, index) => ({
									userId: `rotation-user-${index}`,
									encryptedVaultKey: "wrapped-key",
								})),
								reEncryptedItems: [],
							},
						},
					],
				}),
			).rejects.toThrow();
		});
	});

	describe("members.deleteAccount", () => {
		test("should reject with deprecation message", async () => {
			const [{ userId: ownerId, caller }, { userId: memberId }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			await addTeamMember(teamId, memberId, "member");

			await expect(
				caller.members.deleteAccount({
					teamId,
					userId: memberId,
					confirmation: "DELETE",
				}),
			).rejects.toThrow(
				"Account deletion by team admins is no longer supported",
			);

			// User should still exist
			expect(await getUser(memberId)).toBeDefined();
		});
	});

	describe("invitations.send", () => {
		test("should create invitation for new email", async () => {
			const { caller, userId } = await setup(teamRouter);
			const teamId = await createTestTeam(userId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
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
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});

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
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
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
			const teamId = await createTestTeam(userId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
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

		test("should reject pendingVaultKeys for vaults outside the invited team", async () => {
			const [{ caller, userId }, { userId: otherOwnerId }] = await Promise.all([
				setup(teamRouter),
				setup(teamRouter),
			]);
			const teamId = await createTestTeam(userId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			const otherTeamId = await createTestTeam(otherOwnerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			const foreignVaultId = await createTestVault(otherOwnerId, {
				type: "team",
				teamId: otherTeamId,
			});

			await expect(
				caller.invitations.send({
					teamId,
					email: generateTestEmail(),
					role: "member",
					pendingVaultKeys: [
						{
							vaultId: foreignVaultId,
							encryptedVaultKey: "encrypted-key",
						},
					],
				}),
			).rejects.toThrow(
				"pendingVaultKeys contains vaults outside the invited team",
			);
		});

		test("should reject pendingVaultKeys when inviter lacks vault admin rights", async () => {
			const [{ userId: ownerId }, { userId: adminId, caller }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			await addTeamMember(teamId, adminId, "admin");
			const teamVaultId = await createTestVault(ownerId, {
				type: "team",
				teamId,
			});
			await addVaultMember(teamVaultId, adminId, "read-only");

			await expect(
				caller.invitations.send({
					teamId,
					email: generateTestEmail(),
					role: "member",
					pendingVaultKeys: [
						{
							vaultId: teamVaultId,
							encryptedVaultKey: "encrypted-key",
						},
					],
				}),
			).rejects.toThrow(
				"You do not have permission to grant access for one or more vaults",
			);
		});
	});

	describe("invitations.list", () => {
		test("should return pending invitations for owner/admin without exposing tokens", async () => {
			const { caller, userId } = await setup(teamRouter);
			const teamId = await createTestTeam(userId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			await createTestInvitation(teamId, userId, "invite1@example.com");
			await createTestInvitation(teamId, userId, "invite2@example.com");

			const result = await caller.invitations.list({ teamId });

			expect(result.length).toBe(2);
			expect("token" in (result[0] ?? {})).toBe(false);
		});

		test("should reject non-admin invitation listing", async () => {
			const [{ userId: ownerId }, { caller, userId: memberId }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			await addTeamMember(teamId, memberId, "member");

			await expect(caller.invitations.list({ teamId })).rejects.toThrow(
				"Insufficient permissions",
			);
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
			const teamId = await createTestTeam(userId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
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
			const teamId = await createTestTeam(userId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
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
			const teamId = await createTestTeam(ownerId, {
				name: "Inviting Team",
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
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
			const teamId = await createTestTeam(ownerId, {
				name: "Join Me",
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
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
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
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
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
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
			const teamId = await createTestTeam(userId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
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
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});

			await expect(caller.vaults({ teamId })).rejects.toThrow(
				"You are not a member of this team",
			);
		});

		test("should deny access to regular members", async () => {
			const [{ userId: ownerId }, { userId: memberId, caller }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			await addTeamMember(teamId, memberId, "member");

			await expect(caller.vaults({ teamId })).rejects.toThrow(
				"Insufficient permissions",
			);
		});

		test("should include encrypted vault keys for the requesting user", async () => {
			const { caller, userId } = await setup(teamRouter);
			const teamId = await createTestTeam(userId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			await createTestVault(userId, { teamId });

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
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
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
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
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

		test("should reject invitation with unauthorized pendingVaultKeys and leave membership unchanged", async () => {
			const [
				{ userId: ownerId },
				{ userId: inviteeId, email: inviteeEmail, caller },
				{ userId: otherOwnerId },
			] = await Promise.all([
				setup(teamRouter),
				setup(teamRouter),
				setup(teamRouter),
			]);
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			const otherTeamId = await createTestTeam(otherOwnerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			const foreignVaultId = await createTestVault(otherOwnerId, {
				type: "team",
				teamId: otherTeamId,
			});
			const { token } = await createTestInvitation(
				teamId,
				ownerId,
				inviteeEmail,
				{
					pendingVaultKeys: JSON.stringify([
						{
							vaultId: foreignVaultId,
							encryptedVaultKey: "malicious-key",
						},
					]),
				},
			);

			await expect(caller.invitations.accept({ token })).rejects.toThrow(
				"pendingVaultKeys contains vaults outside the invited team",
			);

			const invitee = await getUser(inviteeId);
			expect(invitee?.teamId).toBeNull();
		});
	});

	describe("invitations.cancel - edge cases", () => {
		test("should deny non-inviter non-admin from cancelling", async () => {
			const [{ userId: ownerId }, { userId: memberId, caller }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
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

		test("should deny inviter after they lose team membership", async () => {
			const [{ userId: ownerId }, { userId: inviterId, caller }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			await addTeamMember(teamId, inviterId, "admin");
			const { invitationId } = await createTestInvitation(
				teamId,
				inviterId,
				"someone@example.com",
			);

			await db
				.update(user)
				.set({ teamId: null, role: "member" })
				.where(eq(user.id, inviterId));

			await expect(caller.invitations.cancel({ invitationId })).rejects.toThrow(
				"Insufficient permissions",
			);
		});
	});

	describe("invitations.resend - edge cases", () => {
		test("should deny non-inviter non-admin from resending", async () => {
			const [{ userId: ownerId }, { userId: memberId, caller }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
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

		test("should deny inviter resend after they lose team membership", async () => {
			const [{ userId: ownerId }, { userId: inviterId, caller }] =
				await Promise.all([setup(teamRouter), setup(teamRouter)]);
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			await addTeamMember(teamId, inviterId, "admin");
			const { invitationId } = await createTestInvitation(
				teamId,
				inviterId,
				"someone@example.com",
			);

			await db
				.update(user)
				.set({ teamId: null, role: "member" })
				.where(eq(user.id, inviterId));

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
			const teamId = await createTestTeam(ownerId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
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
