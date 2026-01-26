/**
 * Team tRPC Router
 * Handles team management, members, and invitations
 */

import { db, team, teamInvitation, user, vaultKey } from "@bittery/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { protectedProcedure, publicProcedure, router } from "../index";

export const teamRouter = router({
	/**
	 * Get the user's team (one-to-one relationship)
	 */
	list: protectedProcedure.query(async ({ ctx }) => {
		const userData = await db.query.user.findFirst({
			where: (user, { eq }) => eq(user.id, ctx.session.userId),
			with: { team: true },
		});

		if (!userData || !userData.team || !userData.teamId) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "User has no team",
			});
		}

		// Get member count
		const members = await db.query.user.findMany({
			where: (user, { eq }) => eq(user.teamId, userData.teamId!),
		});

		return {
			id: userData.team.id,
			name: userData.team.name,
			type: userData.team.type,
			ownerId: userData.team.ownerId,
			role: userData.role,
			memberCount: members.length,
			memberLimit: userData.team.memberLimit,
			createdAt: userData.team.createdAt,
		};
	}),

	/**
	 * Get team details with user's role
	 */
	get: protectedProcedure
		.input(z.object({ teamId: z.string() }))
		.query(async ({ ctx, input }) => {
			const userData = await db.query.user.findFirst({
				where: (user, { eq }) => eq(user.id, ctx.session.userId),
			});

			if (userData?.teamId !== input.teamId) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "You are not a member of this team",
				});
			}

			const teamData = await db.query.team.findFirst({
				where: (t, { eq }) => eq(t.id, input.teamId),
				with: {
					owner: true,
					users: true,
				},
			});

			if (!teamData) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Team not found",
				});
			}

			return {
				id: teamData.id,
				name: teamData.name,
				type: teamData.type,
				ownerId: teamData.ownerId,
				ownerName: teamData.owner.name,
				userRole: userData.role,
				memberCount: teamData.users.length,
				memberLimit: teamData.memberLimit,
				createdAt: teamData.createdAt,
				updatedAt: teamData.updatedAt,
			};
		}),

	/**
	 * Create a new team (not allowed - users get personal team on signup)
	 * @deprecated Teams are auto-created on signup
	 */
	create: protectedProcedure
		.input(z.object({ name: z.string().min(1), type: z.enum(["family", "organization"]).optional() }))
		.mutation(async () => {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Teams are automatically created on signup. Contact support to upgrade your team type.",
			});
		}),

	/**
	 * Update team name (owner/admin only)
	 */
	update: protectedProcedure
		.input(z.object({ teamId: z.string(), name: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const userData = await db.query.user.findFirst({
				where: (user, { eq }) => eq(user.id, ctx.session.userId),
			});

			if (userData?.teamId !== input.teamId) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "You are not a member of this team",
				});
			}

			if (!["owner", "admin"].includes(userData.role)) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Insufficient permissions",
				});
			}

			await db
				.update(team)
				.set({ name: input.name, updatedAt: new Date() })
				.where(eq(team.id, input.teamId));

			return { success: true };
		}),

	/**
	 * Delete team (owner only, personal teams cannot be deleted)
	 */
	delete: protectedProcedure
		.input(z.object({ teamId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const userData = await db.query.user.findFirst({
				where: (user, { eq }) => eq(user.id, ctx.session.userId),
				with: { team: true },
			});

			if (userData?.teamId !== input.teamId) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "You are not a member of this team",
				});
			}

			if (userData.role !== "owner") {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Only the team owner can delete the team",
				});
			}

			// Personal teams cannot be deleted
			if (userData.team?.type === "personal") {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Personal teams cannot be deleted. To close your account, use Account Settings.",
				});
			}

			// Delete team (cascades to invitations)
			await db.delete(team).where(eq(team.id, input.teamId));

			return { success: true };
		}),

	/**
	 * Leave team (not allowed - users belong to exactly one team)
	 * @deprecated Users cannot leave teams in the new architecture
	 */
	leave: protectedProcedure
		.input(z.object({ teamId: z.string() }))
		.mutation(async () => {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "You cannot leave your team. Each user belongs to exactly one team.",
			});
		}),

	/**
	 * Team member management
	 */
	members: router({
		/**
		 * List team members
		 */
		list: protectedProcedure
			.input(z.object({ teamId: z.string() }))
			.query(async ({ ctx, input }) => {
				// Verify user has access to this team
				const userData = await db.query.user.findFirst({
					where: (user, { eq }) => eq(user.id, ctx.session.userId),
				});

				if (userData?.teamId !== input.teamId) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "You are not a member of this team",
					});
				}

				// Get all users in this team
				const members = await db.query.user.findMany({
					where: (user, { eq }) => eq(user.teamId, input.teamId),
				});

				return members.map((m) => ({
					userId: m.id,
					name: m.name,
					email: m.email,
					role: m.role,
					joinedAt: m.createdAt,
				}));
			}),
	}),

	/**
	 * Get vaults associated with a team (for encrypting vault keys during invite)
	 */
	vaults: protectedProcedure
		.input(z.object({ teamId: z.string() }))
		.query(async ({ ctx, input }) => {
			// Verify user has access to this team
			const userData = await db.query.user.findFirst({
				where: (user, { eq }) => eq(user.id, ctx.session.userId),
			});

			if (userData?.teamId !== input.teamId) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "You are not a member of this team",
				});
			}

			if (!["owner", "admin"].includes(userData.role)) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Insufficient permissions",
				});
			}

			// Get all vaults for this team
			const teamVaults = await db.query.vault.findMany({
				where: (v, { eq }) => eq(v.teamId, input.teamId),
			});

			// Get the current user's vault keys for these vaults
			const userVaultKeys = await db.query.vaultKey.findMany({
				where: (vk, { and, eq, inArray }) =>
					and(
						eq(vk.userId, ctx.session.userId),
						inArray(
							vk.vaultId,
							teamVaults.map((v) => v.id),
						),
					),
			});

			// Build a map for quick lookup
			const keyMap = new Map(userVaultKeys.map((vk) => [vk.vaultId, vk]));

			return teamVaults.map((v) => ({
				id: v.id,
				name: v.name,
				// The current user's encrypted vault key (they need this to re-encrypt for the invitee)
				encryptedVaultKey: keyMap.get(v.id)?.encryptedVaultKey || null,
			}));
		}),

	/**
	 * Team invitation management
	 */
	invitations: router({
		/**
		 * Get invitation details by token (public endpoint for invitation links)
		 */
		getByToken: publicProcedure
			.input(z.object({ token: z.string() }))
			.query(async ({ input }) => {
				const invitation = await db.query.teamInvitation.findFirst({
					where: (inv, { eq }) => eq(inv.token, input.token),
					with: {
						team: true,
						invitedBy: true,
					},
				});

				if (!invitation) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Invitation not found",
					});
				}

				// Check if expired
				const isExpired = invitation.expiresAt < new Date();

				return {
					id: invitation.id,
					email: invitation.email,
					teamId: invitation.team.id,
					teamName: invitation.team.name,
					role: invitation.role,
					status: isExpired ? "expired" : invitation.status,
					invitedByName: invitation.invitedBy.name,
					expiresAt: invitation.expiresAt,
					createdAt: invitation.createdAt,
				};
			}),

		/**
		 * List pending invitations for a team
		 */
		list: protectedProcedure
			.input(z.object({ teamId: z.string() }))
			.query(async ({ ctx, input }) => {
				// Verify user has access to this team
				const userData = await db.query.user.findFirst({
					where: (user, { eq }) => eq(user.id, ctx.session.userId),
				});

				if (userData?.teamId !== input.teamId) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "You are not a member of this team",
					});
				}

				const invitations = await db.query.teamInvitation.findMany({
					where: (inv, { and, eq }) =>
						and(eq(inv.teamId, input.teamId), eq(inv.status, "pending")),
					with: {
						invitedBy: true,
					},
				});

				return invitations.map((inv) => ({
					id: inv.id,
					email: inv.email,
					role: inv.role,
					status: inv.status,
					invitedBy: inv.invitedBy.name,
					createdAt: inv.createdAt,
					expiresAt: inv.expiresAt,
				}));
			}),

		/**
		 * Send invitation (owner/admin only)
		 * If the user already exists and pendingVaultKeys is provided, it will be stored
		 * for vault access provisioning when they accept the invitation.
		 */
		send: protectedProcedure
			.input(
				z.object({
					teamId: z.string(),
					email: z.string().email(),
					role: z.enum(["admin", "member"]).default("member"),
					// Encrypted vault keys for existing users (encrypted with their RSA public key)
					pendingVaultKeys: z
						.array(
							z.object({
								vaultId: z.string(),
								encryptedVaultKey: z.string(),
							}),
						)
						.optional(),
				}),
			)
			.mutation(async ({ ctx, input }) => {
				// Verify user has owner or admin role in their team
				const userData = await db.query.user.findFirst({
					where: (user, { eq }) => eq(user.id, ctx.session.userId),
					with: { team: true },
				});

				if (userData?.teamId !== input.teamId) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "You are not a member of this team",
					});
				}

				if (!["owner", "admin"].includes(userData.role)) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "Insufficient permissions",
					});
				}

				// Check team capacity (family teams have limits)
				if (userData.team && userData.team.type === "family" && userData.team.memberLimit) {
					const currentMembers = await db.query.user.findMany({
						where: (user, { eq }) => eq(user.teamId, input.teamId),
					});

					const pendingInvitations = await db.query.teamInvitation.findMany({
						where: (inv, { and, eq }) =>
							and(eq(inv.teamId, input.teamId), eq(inv.status, "pending")),
					});

					const totalCount = currentMembers.length + pendingInvitations.length;

					if (totalCount >= userData.team.memberLimit) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "Team has reached member limit",
						});
					}
				}

				// Check if user is already a member
				const existingUser = await db.query.user.findFirst({
					where: (u, { eq }) => eq(u.email, input.email),
				});

				if (existingUser) {
					// Check if they already have a team (cannot join multiple teams)
					if (existingUser.teamId) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "This user already belongs to a team",
						});
					}
				}

				// Check for existing pending invitation
				const existingInvitation = await db.query.teamInvitation.findFirst({
					where: (inv, { and, eq }) =>
						and(
							eq(inv.teamId, input.teamId),
							eq(inv.email, input.email),
							eq(inv.status, "pending"),
						),
				});

				if (existingInvitation) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "An invitation is already pending for this email",
					});
				}

				const invitationId = nanoid();
				const token = nanoid(32); // Longer token for security
				const expiresAt = new Date();
				expiresAt.setDate(expiresAt.getDate() + 7); // 7 days expiry

				await db.insert(teamInvitation).values({
					id: invitationId,
					teamId: input.teamId,
					email: input.email,
					role: input.role,
					invitedById: ctx.session.userId,
					token,
					expiresAt,
					// Store pending vault keys if provided (for existing users)
					pendingVaultKeys: input.pendingVaultKeys
						? JSON.stringify(input.pendingVaultKeys)
						: null,
				});

				// Return user's public key if they exist (so client can encrypt vault keys)
				return {
					invitationId,
					token,
					existingUserPublicKey: existingUser?.publicKey || null,
				};
			}),

		/**
		 * Cancel invitation
		 */
		cancel: protectedProcedure
			.input(z.object({ invitationId: z.string() }))
			.mutation(async ({ ctx, input }) => {
				const invitation = await db.query.teamInvitation.findFirst({
					where: (inv, { eq }) => eq(inv.id, input.invitationId),
				});

				if (!invitation) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Invitation not found",
					});
				}

				// Must be owner, admin, or the person who sent it
				const userData = await db.query.user.findFirst({
					where: (user, { eq }) => eq(user.id, ctx.session.userId),
				});

				const isInviter = invitation.invitedById === ctx.session.userId;
				const isAdminOrOwner =
					userData?.teamId === invitation.teamId &&
					(userData?.role === "owner" || userData?.role === "admin");

				if (!isInviter && !isAdminOrOwner) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "Insufficient permissions",
					});
				}

				await db
					.delete(teamInvitation)
					.where(eq(teamInvitation.id, input.invitationId));

				return { success: true };
			}),

		/**
		 * Resend invitation (reset expiry)
		 */
		resend: protectedProcedure
			.input(z.object({ invitationId: z.string() }))
			.mutation(async ({ ctx, input }) => {
				const invitation = await db.query.teamInvitation.findFirst({
					where: (inv, { eq }) => eq(inv.id, input.invitationId),
				});

				if (!invitation) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Invitation not found",
					});
				}

				// Must be owner, admin, or the person who sent it
				const userData = await db.query.user.findFirst({
					where: (user, { eq }) => eq(user.id, ctx.session.userId),
				});

				const isInviter = invitation.invitedById === ctx.session.userId;
				const isAdminOrOwner =
					userData?.teamId === invitation.teamId &&
					(userData?.role === "owner" || userData?.role === "admin");

				if (!isInviter && !isAdminOrOwner) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "Insufficient permissions",
					});
				}

				const newExpiry = new Date();
				newExpiry.setDate(newExpiry.getDate() + 7);

				await db
					.update(teamInvitation)
					.set({ expiresAt: newExpiry, status: "pending" })
					.where(eq(teamInvitation.id, input.invitationId));

				return { success: true };
			}),

		/**
		 * Get pending invitations for current user (by email)
		 */
		pending: protectedProcedure.query(async ({ ctx }) => {
			// Get user's email
			const userData = await db.query.user.findFirst({
				where: (u, { eq }) => eq(u.id, ctx.session.userId),
			});

			if (!userData) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "User not found",
				});
			}

			const invitations = await db.query.teamInvitation.findMany({
				where: (inv, { and, eq, gt }) =>
					and(
						eq(inv.email, userData.email),
						eq(inv.status, "pending"),
						gt(inv.expiresAt, new Date()),
					),
				with: {
					team: true,
					invitedBy: true,
				},
			});

			return invitations.map((inv) => ({
				id: inv.id,
				token: inv.token,
				teamId: inv.team.id,
				teamName: inv.team.name,
				role: inv.role,
				invitedBy: inv.invitedBy.name,
				expiresAt: inv.expiresAt,
			}));
		}),

		/**
		 * Accept invitation
		 * Handles vault access provisioning if pendingVaultKeys were provided during invite
		 */
		accept: protectedProcedure
			.input(z.object({ token: z.string() }))
			.mutation(async ({ ctx, input }) => {
				const invitation = await db.query.teamInvitation.findFirst({
					where: (inv, { and, eq }) =>
						and(eq(inv.token, input.token), eq(inv.status, "pending")),
					with: {
						team: true,
					},
				});

				if (!invitation) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Invitation not found or already used",
					});
				}

				// Check expiry
				if (invitation.expiresAt < new Date()) {
					await db
						.update(teamInvitation)
						.set({ status: "expired" })
						.where(eq(teamInvitation.id, invitation.id));

					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Invitation has expired",
					});
				}

				// Verify the invitation is for this user's email
				const userData = await db.query.user.findFirst({
					where: (u, { eq }) => eq(u.id, ctx.session.userId),
				});

				if (!userData || userData.email !== invitation.email) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "This invitation is not for you",
					});
				}

				// Check user doesn't already have a team
				if (userData.teamId) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "You already belong to a team",
					});
				}

				// Link user to team
				await db
					.update(user)
					.set({ teamId: invitation.teamId, role: invitation.role })
					.where(eq(user.id, ctx.session.userId));

				// Provision vault access if pendingVaultKeys were provided during invite
				if (invitation.pendingVaultKeys) {
					try {
						const pendingKeys = JSON.parse(
							invitation.pendingVaultKeys,
						) as Array<{
							vaultId: string;
							encryptedVaultKey: string;
						}>;

						// Convert invitation role to vault role
						const vaultRole = invitation.role === "admin" ? "admin" : "member";

						// Create vault key entries for each pending key
						for (const keyData of pendingKeys) {
							// Verify the vault belongs to this team
							const vaultData = await db.query.vault.findFirst({
								where: (v, { and, eq }) =>
									and(
										eq(v.id, keyData.vaultId),
										eq(v.teamId, invitation.teamId),
									),
							});

							if (vaultData) {
								// Check if user doesn't already have access
								const existingKey = await db.query.vaultKey.findFirst({
									where: (vk, { and, eq }) =>
										and(
											eq(vk.vaultId, keyData.vaultId),
											eq(vk.userId, ctx.session.userId),
										),
								});

								if (!existingKey) {
									await db.insert(vaultKey).values({
										id: nanoid(),
										vaultId: keyData.vaultId,
										userId: ctx.session.userId,
										encryptedVaultKey: keyData.encryptedVaultKey,
										role: vaultRole,
									});
								}
							}
						}
					} catch (e) {
						// Log error but don't fail the invitation acceptance
						console.error("Failed to provision vault keys:", e);
					}
				}

				// Mark invitation as accepted
				await db
					.update(teamInvitation)
					.set({ status: "accepted", acceptedAt: new Date() })
					.where(eq(teamInvitation.id, invitation.id));

				return {
					teamId: invitation.team.id,
					teamName: invitation.team.name,
				};
			}),

		/**
		 * Decline invitation
		 */
		decline: protectedProcedure
			.input(z.object({ token: z.string() }))
			.mutation(async ({ ctx, input }) => {
				const invitation = await db.query.teamInvitation.findFirst({
					where: (inv, { and, eq }) =>
						and(eq(inv.token, input.token), eq(inv.status, "pending")),
				});

				if (!invitation) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Invitation not found or already used",
					});
				}

				// Verify the invitation is for this user's email
				const userData = await db.query.user.findFirst({
					where: (u, { eq }) => eq(u.id, ctx.session.userId),
				});

				if (!userData || userData.email !== invitation.email) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "This invitation is not for you",
					});
				}

				await db
					.update(teamInvitation)
					.set({ status: "declined" })
					.where(eq(teamInvitation.id, invitation.id));

				return { success: true };
			}),
	}),
});
