/**
 * Team tRPC Router
 * Handles team management, members, and invitations
 */

import { db, team, teamInvitation, teamMember } from "@bittery/db";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { protectedProcedure, router } from "../index";

/**
 * Helper to check team membership and role
 */
async function getTeamMembership(userId: string, teamId: string) {
	return db.query.teamMember.findFirst({
		where: (tm, { and, eq }) =>
			and(eq(tm.teamId, teamId), eq(tm.userId, userId)),
	});
}

/**
 * Helper to require specific team roles
 */
async function requireTeamRole(
	userId: string,
	teamId: string,
	allowedRoles: ("owner" | "admin" | "member")[],
) {
	const membership = await getTeamMembership(userId, teamId);

	if (!membership) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "You are not a member of this team",
		});
	}

	if (!allowedRoles.includes(membership.role)) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Insufficient permissions",
		});
	}

	return membership;
}

export const teamRouter = router({
	/**
	 * List all teams the user belongs to
	 */
	list: protectedProcedure.query(async ({ ctx }) => {
		const memberships = await db.query.teamMember.findMany({
			where: (tm, { eq }) => eq(tm.userId, ctx.session.userId),
			with: {
				team: {
					with: {
						members: true,
					},
				},
			},
		});

		return memberships.map((m) => ({
			id: m.team.id,
			name: m.team.name,
			ownerId: m.team.ownerId,
			role: m.role,
			memberCount: m.team.members.length,
			createdAt: m.team.createdAt,
		}));
	}),

	/**
	 * Get team details with user's role
	 */
	get: protectedProcedure
		.input(z.object({ teamId: z.string() }))
		.query(async ({ ctx, input }) => {
			const membership = await getTeamMembership(
				ctx.session.userId,
				input.teamId,
			);

			if (!membership) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "You are not a member of this team",
				});
			}

			const teamData = await db.query.team.findFirst({
				where: (t, { eq }) => eq(t.id, input.teamId),
				with: {
					owner: true,
					members: true,
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
				ownerId: teamData.ownerId,
				ownerName: teamData.owner.name,
				userRole: membership.role,
				memberCount: teamData.members.length,
				createdAt: teamData.createdAt,
				updatedAt: teamData.updatedAt,
			};
		}),

	/**
	 * Create a new team
	 */
	create: protectedProcedure
		.input(z.object({ name: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const teamId = nanoid();

			// Create the team
			await db.insert(team).values({
				id: teamId,
				name: input.name,
				ownerId: ctx.session.userId,
			});

			// Add creator as owner
			await db.insert(teamMember).values({
				id: nanoid(),
				teamId,
				userId: ctx.session.userId,
				role: "owner",
				joinedAt: new Date(),
			});

			return { teamId };
		}),

	/**
	 * Update team name (owner/admin only)
	 */
	update: protectedProcedure
		.input(z.object({ teamId: z.string(), name: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			await requireTeamRole(ctx.session.userId, input.teamId, [
				"owner",
				"admin",
			]);

			await db
				.update(team)
				.set({ name: input.name, updatedAt: new Date() })
				.where(eq(team.id, input.teamId));

			return { success: true };
		}),

	/**
	 * Delete team (owner only)
	 */
	delete: protectedProcedure
		.input(z.object({ teamId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			await requireTeamRole(ctx.session.userId, input.teamId, ["owner"]);

			// Delete team (cascades to members and invitations)
			await db.delete(team).where(eq(team.id, input.teamId));

			return { success: true };
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
				await requireTeamRole(ctx.session.userId, input.teamId, [
					"owner",
					"admin",
					"member",
				]);

				const members = await db.query.teamMember.findMany({
					where: (tm, { eq }) => eq(tm.teamId, input.teamId),
					with: {
						user: true,
					},
				});

				return members.map((m) => ({
					id: m.id,
					userId: m.user.id,
					name: m.user.name,
					email: m.user.email,
					role: m.role,
					joinedAt: m.joinedAt,
				}));
			}),

		/**
		 * Update member role (owner/admin only)
		 * Admin cannot change other admins or the owner
		 */
		updateRole: protectedProcedure
			.input(
				z.object({
					teamId: z.string(),
					userId: z.string(),
					role: z.enum(["admin", "member"]),
				}),
			)
			.mutation(async ({ ctx, input }) => {
				const actorMembership = await requireTeamRole(
					ctx.session.userId,
					input.teamId,
					["owner", "admin"],
				);

				// Can't change your own role
				if (input.userId === ctx.session.userId) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Cannot change your own role",
					});
				}

				// Get target member
				const targetMembership = await getTeamMembership(
					input.userId,
					input.teamId,
				);

				if (!targetMembership) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Member not found",
					});
				}

				// Cannot change owner's role
				if (targetMembership.role === "owner") {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "Cannot change owner's role",
					});
				}

				// Admin can only change members, not other admins
				if (
					actorMembership.role === "admin" &&
					targetMembership.role === "admin"
				) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "Admins cannot change other admins",
					});
				}

				await db
					.update(teamMember)
					.set({ role: input.role })
					.where(
						and(
							eq(teamMember.teamId, input.teamId),
							eq(teamMember.userId, input.userId),
						),
					);

				return { success: true };
			}),

		/**
		 * Remove member from team (owner/admin only)
		 * Admin cannot remove other admins or the owner
		 */
		remove: protectedProcedure
			.input(z.object({ teamId: z.string(), userId: z.string() }))
			.mutation(async ({ ctx, input }) => {
				const actorMembership = await requireTeamRole(
					ctx.session.userId,
					input.teamId,
					["owner", "admin"],
				);

				// Can't remove yourself (use leave instead)
				if (input.userId === ctx.session.userId) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Cannot remove yourself. Use leave instead.",
					});
				}

				// Get target member
				const targetMembership = await getTeamMembership(
					input.userId,
					input.teamId,
				);

				if (!targetMembership) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Member not found",
					});
				}

				// Cannot remove owner
				if (targetMembership.role === "owner") {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "Cannot remove team owner",
					});
				}

				// Admin can only remove members, not other admins
				if (
					actorMembership.role === "admin" &&
					targetMembership.role === "admin"
				) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "Admins cannot remove other admins",
					});
				}

				await db
					.delete(teamMember)
					.where(
						and(
							eq(teamMember.teamId, input.teamId),
							eq(teamMember.userId, input.userId),
						),
					);

				return { success: true };
			}),
	}),

	/**
	 * Team invitation management
	 */
	invitations: router({
		/**
		 * List pending invitations for a team
		 */
		list: protectedProcedure
			.input(z.object({ teamId: z.string() }))
			.query(async ({ ctx, input }) => {
				await requireTeamRole(ctx.session.userId, input.teamId, [
					"owner",
					"admin",
					"member",
				]);

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
		 */
		send: protectedProcedure
			.input(
				z.object({
					teamId: z.string(),
					email: z.string().email(),
					role: z.enum(["admin", "member"]).default("member"),
				}),
			)
			.mutation(async ({ ctx, input }) => {
				await requireTeamRole(ctx.session.userId, input.teamId, [
					"owner",
					"admin",
				]);

				// Check if user is already a member
				const existingUser = await db.query.user.findFirst({
					where: (u, { eq }) => eq(u.email, input.email),
				});

				if (existingUser) {
					const existingMembership = await getTeamMembership(
						existingUser.id,
						input.teamId,
					);
					if (existingMembership) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "User is already a member of this team",
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
				});

				return { invitationId, token };
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
				const membership = await getTeamMembership(
					ctx.session.userId,
					invitation.teamId,
				);
				const isInviter = invitation.invitedById === ctx.session.userId;
				const isAdminOrOwner =
					membership?.role === "owner" || membership?.role === "admin";

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
				const membership = await getTeamMembership(
					ctx.session.userId,
					invitation.teamId,
				);
				const isInviter = invitation.invitedById === ctx.session.userId;
				const isAdminOrOwner =
					membership?.role === "owner" || membership?.role === "admin";

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

				// Check not already a member
				const existingMembership = await getTeamMembership(
					ctx.session.userId,
					invitation.teamId,
				);
				if (existingMembership) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "You are already a member of this team",
					});
				}

				// Create team membership
				await db.insert(teamMember).values({
					id: nanoid(),
					teamId: invitation.teamId,
					userId: ctx.session.userId,
					role: invitation.role,
					joinedAt: new Date(),
				});

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
