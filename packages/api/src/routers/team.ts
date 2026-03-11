/**
 * Team tRPC Router
 * Handles team management, members, and invitations
 */

import { deleteAllUserSessions } from "@bittery/auth";
import { db, team, teamInvitation, user, vaultKey } from "@bittery/db";
import { item, vault, vaultKeyRotation } from "@bittery/db/schema/vault";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { resolveEffectiveEntitlements } from "../billing/entitlements";
import { syncTeamSeatQuantity } from "../billing/stripe";
import { getBitteryMode, isSelfHostedMode } from "../config/mode";
import { createPersonalTeamForUser } from "../helpers/team";
import { protectedProcedure, publicProcedure, router } from "../index";
import {
	createPresignedUpload,
	createTeamImageKey,
	getStoragePublicUrl,
} from "../storage/s3";
import {
	broadcastSyncPayloads,
	createSyncEvent,
	type SyncBroadcastPayload,
} from "../sync-helper";
import { logAuditEvent } from "../utils/audit";
import {
	assertInvitationPendingVaultKeysAreAuthorized,
	normalizePendingVaultKeys,
	parsePendingVaultKeys,
} from "../utils/pending-vault-keys";

/**
 * Helper function to get image URL from imageKey
 */
function getTeamImageUrl(imageKey: string | null): string | null {
	if (!imageKey) return null;
	return getStoragePublicUrl(imageKey);
}

async function syncSeatsBestEffort(teamId: string, billingPlan: string) {
	if (billingPlan !== "team") return;

	try {
		await syncTeamSeatQuantity(teamId);
	} catch (error) {
		console.error("Failed to sync Stripe seats:", error);
	}
}

function assertTeamManagementEntitlement(teamData: {
	id: string;
	billingPlan: "free" | "personal" | "family" | "team";
	billingStatus:
		| "none"
		| "incomplete"
		| "trialing"
		| "active"
		| "past_due"
		| "canceled"
		| "unpaid";
}) {
	const entitlements = resolveEffectiveEntitlements({
		mode: getBitteryMode(),
		billingPlan: teamData.billingPlan,
		billingStatus: teamData.billingStatus,
	});

	if (!entitlements.team_management) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message:
				"Team management is only available on Family or Team plans with active billing.",
		});
	}
}

async function getTeamVaultsWithUserAccess(teamId: string, userId: string) {
	const teamVaults = await db.query.vault.findMany({
		where: (record, { eq: eqFn }) => eqFn(record.teamId, teamId),
	});
	if (teamVaults.length === 0) {
		return [];
	}

	const teamVaultIds = teamVaults.map((record) => record.id);
	const userVaultKeys = await db.query.vaultKey.findMany({
		where: (record, { and: andFn, eq: eqFn, inArray: inArrayFn }) =>
			andFn(
				eqFn(record.userId, userId),
				inArrayFn(record.vaultId, teamVaultIds),
			),
	});
	const accessibleVaultIds = new Set(userVaultKeys.map((record) => record.vaultId));

	return teamVaults.filter((record) => accessibleVaultIds.has(record.id));
}

async function getTeamRemovalScope(input: {
	teamId: string;
	actorUserId: string;
	targetUserId: string;
}) {
	const teamVaults = await db.query.vault.findMany({
		where: (record, { eq: eqFn }) => eqFn(record.teamId, input.teamId),
	});
	if (teamVaults.length === 0) {
		return {
			removableVaults: [] as typeof teamVaults,
			inaccessibleTargetVaultIds: [] as string[],
		};
	}

	const teamVaultIds = teamVaults.map((record) => record.id);
	const [actorVaultKeys, targetVaultKeys] = await Promise.all([
		db.query.vaultKey.findMany({
			where: (record, { and: andFn, eq: eqFn, inArray: inArrayFn }) =>
				andFn(
					eqFn(record.userId, input.actorUserId),
					inArrayFn(record.vaultId, teamVaultIds),
				),
		}),
		db.query.vaultKey.findMany({
			where: (record, { and: andFn, eq: eqFn, inArray: inArrayFn }) =>
				andFn(
					eqFn(record.userId, input.targetUserId),
					inArrayFn(record.vaultId, teamVaultIds),
				),
		}),
	]);

	const actorAdminVaultIds = new Set(
		actorVaultKeys
			.filter((record) => ["owner", "admin"].includes(record.role))
			.map((record) => record.vaultId),
	);
	const targetVaultIds = new Set(targetVaultKeys.map((record) => record.vaultId));
	const inaccessibleTargetVaultIds = [...targetVaultIds].filter(
		(vaultId) => !actorAdminVaultIds.has(vaultId),
	);
	const removableVaults = teamVaults.filter(
		(record) =>
			targetVaultIds.has(record.id) && actorAdminVaultIds.has(record.id),
	);

	return {
		removableVaults,
		inaccessibleTargetVaultIds,
	};
}

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
			where: (user, { eq }) => eq(user.teamId, userData.teamId as string),
		});

		return {
			id: userData.team.id,
			name: userData.team.name,
			type: userData.team.type,
			ownerId: userData.team.ownerId,
			role: userData.role,
			memberCount: members.length,
			memberLimit: userData.team.memberLimit,
			imageUrl: getTeamImageUrl(userData.team.imageKey),
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
				imageUrl: getTeamImageUrl(teamData.imageKey),
				createdAt: teamData.createdAt,
				updatedAt: teamData.updatedAt,
			};
		}),

	/**
	 * Create a new team (not allowed - users get personal team on signup)
	 * @deprecated Teams are auto-created on signup
	 */
	create: protectedProcedure
		.input(
			z.object({
				name: z.string().min(1),
				type: z.enum(["family", "organization"]).optional(),
			}),
		)
		.mutation(async () => {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message:
					"Teams are automatically created on signup. Contact support to upgrade your team type.",
			});
		}),

	/**
	 * Update team name and/or imageKey (owner/admin only)
	 */
	update: protectedProcedure
		.input(
			z.object({
				teamId: z.string(),
				name: z.string().min(1).optional(),
				imageKey: z.string().nullable().optional(),
			}),
		)
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

			const updateData: {
				name?: string;
				imageKey?: string | null;
				updatedAt: Date;
			} = {
				updatedAt: new Date(),
			};

			if (input.name !== undefined) {
				updateData.name = input.name;
			}

			if (input.imageKey !== undefined) {
				updateData.imageKey = input.imageKey;
			}

			await db.update(team).set(updateData).where(eq(team.id, input.teamId));

			return { success: true };
		}),

	/**
	 * Create presigned upload URL for team avatar (owner/admin only)
	 */
	createImageUpload: protectedProcedure
		.input(
			z.object({
				teamId: z.string(),
				fileName: z.string(),
				contentType: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			// Validate image MIME type
			if (!input.contentType.startsWith("image/")) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Only image files are allowed",
				});
			}

			// Verify user has owner or admin role in their team
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

			const key = createTeamImageKey({
				teamId: input.teamId,
				fileName: input.fileName,
			});

			const result = await createPresignedUpload({
				key,
				contentType: input.contentType,
			});

			return result;
		}),

	/**
	 * Delete team (owner only, personal teams cannot be deleted)
	 */
	delete: protectedProcedure
		.input(z.object({ teamId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			if (isSelfHostedMode()) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						"Team deletion is disabled in self-hosted mode. This instance uses a single team.",
				});
			}

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
					message:
						"Personal teams cannot be deleted. To close your account, use Account Settings.",
				});
			}

			await db.transaction(async (tx) => {
				const actor = await tx.query.user.findFirst({
					where: (record, { eq: eqFn }) => eqFn(record.id, ctx.session.userId),
					with: { team: true },
				});

				if (
					!actor ||
					actor.teamId !== input.teamId ||
					actor.role !== "owner" ||
					!actor.team ||
					actor.team.type === "personal"
				) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "Only the team owner can delete the team",
					});
				}

				const [members, teamVaults] = await Promise.all([
					tx.query.user.findMany({
						where: (record, { eq: eqFn }) => eqFn(record.teamId, input.teamId),
						columns: { id: true },
					}),
					tx.query.vault.findMany({
						where: (record, { eq: eqFn }) => eqFn(record.teamId, input.teamId),
						columns: { id: true },
					}),
				]);

				if (members.length !== 1 || members[0]?.id !== ctx.session.userId) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							"Team deletion is blocked until the owner is the only remaining member.",
					});
				}

				if (teamVaults.length > 0) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							"Team deletion is blocked until all team vaults have been removed or converted.",
					});
				}

				await createPersonalTeamForUser(ctx.session.userId, actor.name, tx);
				await tx
					.delete(teamInvitation)
					.where(eq(teamInvitation.teamId, input.teamId));
				await tx.delete(team).where(eq(team.id, input.teamId));
			});

			return { success: true };
		}),

	/**
	 * Leave a non-personal team with mandatory vault key rotation.
	 *
	 * The leaving user must provide re-encrypted vault keys and items for ALL
	 * team vaults they have access to. After leaving, they get a new personal
	 * team with a free plan.
	 *
	 * Owners cannot leave their own team — they must transfer ownership first.
	 */
	leave: protectedProcedure
		.input(
			z.object({
				teamId: z.string(),
				vaultRotations: z.array(
					z.object({
						vaultId: z.string(),
						keyRotation: z.object({
							memberKeys: z.array(
								z.object({
									userId: z.string(),
									encryptedVaultKey: z.string(),
								}),
							),
							reEncryptedItems: z.array(
								z.object({
									itemId: z.string(),
									encryptedData: z.string(),
									encryptionIv: z.string(),
								}),
							),
						}),
					}),
				),
				clientId: z.string().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const userData = await db.query.user.findFirst({
				where: (u, { eq: eqFn }) => eqFn(u.id, ctx.session.userId),
				with: { team: true },
			});

			if (!userData || userData.teamId !== input.teamId) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "You are not a member of this team",
				});
			}

			if (userData.role === "owner") {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "The team owner cannot leave. Transfer ownership first.",
				});
			}

			if (userData.team?.type === "personal") {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "You cannot leave a personal team.",
				});
			}

			// Get team vaults with user's access
			const teamVaults = await db.query.vault.findMany({
				where: (v, { eq: eqFn }) => eqFn(v.teamId, input.teamId),
			});

			const teamVaultIds = teamVaults.map((v) => v.id);
			const userVaultKeys =
				teamVaultIds.length > 0
					? await db.query.vaultKey.findMany({
							where: (vk, { and, eq: eqFn, inArray: inArrayFn }) =>
								and(
									eqFn(vk.userId, ctx.session.userId),
									inArrayFn(vk.vaultId, teamVaultIds),
								),
						})
					: [];

			const vaultsWithAccess = new Set(userVaultKeys.map((vk) => vk.vaultId));
			const rotationVaultIds = new Set(
				input.vaultRotations.map((vr) => vr.vaultId),
			);

			// Ensure rotation data for every vault the leaving user has access to
			for (const vaultId of vaultsWithAccess) {
				if (!rotationVaultIds.has(vaultId)) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: `Missing key rotation data for vault ${vaultId}. Rotation is required for all team vaults.`,
					});
				}
			}

			const vaultMap = new Map(teamVaults.map((v) => [v.id, v]));

			// Create rotation records
			const rotationRecords: Array<{
				vaultId: string;
				rotationId: string;
				newKeyVersion: number;
			}> = [];
			for (const vaultRotation of input.vaultRotations) {
				const vaultData = vaultMap.get(vaultRotation.vaultId);
				if (!vaultData) continue;

				const rotationId = nanoid();
				const newKeyVersion = vaultData.keyVersion + 1;

				await db.insert(vaultKeyRotation).values({
					id: rotationId,
					vaultId: vaultRotation.vaultId,
					keyVersion: newKeyVersion,
					reason: "member_removed",
					initiatedById: ctx.session.userId,
					removedUserId: ctx.session.userId,
					itemsReEncrypted: vaultRotation.keyRotation.reEncryptedItems.length,
					membersUpdated: vaultRotation.keyRotation.memberKeys.length,
					status: "in_progress",
				});

				rotationRecords.push({
					vaultId: vaultRotation.vaultId,
					rotationId,
					newKeyVersion,
				});
			}

			try {
				const broadcasts: SyncBroadcastPayload[] = [];

				await db.transaction(async (tx) => {
					for (const vaultRotation of input.vaultRotations) {
						const record = rotationRecords.find(
							(r) => r.vaultId === vaultRotation.vaultId,
						);
						if (!record) continue;

						// Delete leaving user's vault key
						await tx
							.delete(vaultKey)
							.where(
								and(
									eq(vaultKey.vaultId, vaultRotation.vaultId),
									eq(vaultKey.userId, ctx.session.userId),
								),
							);

						// Update remaining members' vault keys
						for (const memberKey of vaultRotation.keyRotation.memberKeys) {
							await tx
								.update(vaultKey)
								.set({ encryptedVaultKey: memberKey.encryptedVaultKey })
								.where(
									and(
										eq(vaultKey.vaultId, vaultRotation.vaultId),
										eq(vaultKey.userId, memberKey.userId),
									),
								);
						}

						// Re-encrypt items
						for (const reEncryptedItem of vaultRotation.keyRotation
							.reEncryptedItems) {
							await tx
								.update(item)
								.set({
									encryptedData: reEncryptedItem.encryptedData,
									encryptionIv: reEncryptedItem.encryptionIv,
									updatedAt: new Date(),
								})
								.where(
									and(
										eq(item.id, reEncryptedItem.itemId),
										eq(item.vaultId, vaultRotation.vaultId),
									),
								);
						}

						// Update vault key version
						await tx
							.update(vault)
							.set({
								keyVersion: record.newKeyVersion,
								updatedAt: new Date(),
							})
							.where(eq(vault.id, vaultRotation.vaultId));

						// Mark rotation completed
						await tx
							.update(vaultKeyRotation)
							.set({ status: "completed", completedAt: new Date() })
							.where(eq(vaultKeyRotation.id, record.rotationId));

						// Create sync events
						broadcasts.push(
							await createSyncEvent(
								{
									eventType: "vault_access_revoked",
									entityId: vaultRotation.vaultId,
									entityType: "vault",
									vaultId: vaultRotation.vaultId,
									userId: ctx.session.userId,
									clientId: input.clientId,
									version: record.newKeyVersion,
									metadata: {
										removedUserId: ctx.session.userId,
										reason: "member_left",
									},
								},
								tx,
								ctx.clientId,
							),
						);

						broadcasts.push(
							await createSyncEvent(
								{
									eventType: "vault_member_removed",
									entityId: ctx.session.userId,
									entityType: "vault_member",
									vaultId: vaultRotation.vaultId,
									userId: ctx.session.userId,
									clientId: input.clientId,
									version: record.newKeyVersion,
									metadata: {
										removedUserId: ctx.session.userId,
										reason: "member_left",
									},
								},
								tx,
								ctx.clientId,
							),
						);

						broadcasts.push(
							await createSyncEvent(
								{
									eventType: "vault_key_rotated",
									entityId: vaultRotation.vaultId,
									entityType: "vault_key",
									vaultId: vaultRotation.vaultId,
									userId: ctx.session.userId,
									clientId: input.clientId,
									version: record.newKeyVersion,
									metadata: {
										reason: "member_left",
										keyRotationId: record.rotationId,
									},
								},
								tx,
								ctx.clientId,
							),
						);
					}

					// Create personal team for the leaving user
					await createPersonalTeamForUser(
						ctx.session.userId,
						userData.name,
						tx,
					);
				});

				// After transaction: invalidate sessions, broadcast
				await deleteAllUserSessions(ctx.session.userId);
				await broadcastSyncPayloads(broadcasts);

				await logAuditEvent({
					userId: ctx.session.userId,
					action: "team_member_removed",
					device: ctx.device,
					entityType: "user",
					entityId: ctx.session.userId,
					metadata: {
						teamId: input.teamId,
						reason: "voluntary_leave",
						vaultsRotated: rotationRecords.length,
					},
				});

				await syncSeatsBestEffort(
					input.teamId,
					userData.team?.billingPlan || "free",
				);

				return { success: true };
			} catch (error) {
				for (const record of rotationRecords) {
					await db
						.update(vaultKeyRotation)
						.set({
							status: "failed",
							errorMessage:
								error instanceof Error ? error.message : "Unknown error",
						})
						.where(eq(vaultKeyRotation.id, record.rotationId));
				}

				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message:
						"Failed to leave team during key rotation. Please try again.",
				});
			}
		}),

	/**
	 * Get data needed for key rotation when a member is leaving a team.
	 * Returns remaining members' public keys and all items per team vault.
	 */
	getLeaveRotationData: protectedProcedure
		.input(z.object({ teamId: z.string() }))
		.query(async ({ ctx, input }) => {
			const userData = await db.query.user.findFirst({
				where: (u, { eq: eqFn }) => eqFn(u.id, ctx.session.userId),
				with: { team: true },
			});

			const teamId = userData?.teamId;
			if (!teamId || teamId !== input.teamId) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "You are not a member of this team",
				});
			}

			const teamVaults = await getTeamVaultsWithUserAccess(
				teamId,
				ctx.session.userId,
			);

			const vaultRotationData = await Promise.all(
				teamVaults.map(async (v) => {
					const members = await db.query.vaultKey.findMany({
						where: (vk, { and, eq: eqFn, ne }) =>
							and(eqFn(vk.vaultId, v.id), ne(vk.userId, ctx.session.userId)),
						with: { user: true },
					});

					const items = await db.query.item.findMany({
						where: (i, { eq: eqFn }) => eqFn(i.vaultId, v.id),
					});

					return {
						vaultId: v.id,
						vaultName: v.name,
						keyVersion: v.keyVersion,
						members: members.map((m) => ({
							userId: m.userId,
							publicKey: m.user.publicKey,
							role: m.role,
						})),
						items: items.map((i) => ({
							id: i.id,
							encryptedData: i.encryptedData,
							encryptionIv: i.encryptionIv,
							encryptionAlgorithm: i.encryptionAlgorithm,
						})),
					};
				}),
			);

			return { vaults: vaultRotationData };
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

		/**
		 * Get data needed for key rotation across all team vaults.
		 * Called before removing a member to prepare for key rotation.
		 * Returns remaining members' public keys and all items per vault.
		 */
		getTeamRotationData: protectedProcedure
			.input(
				z.object({
					teamId: z.string(),
					excludeUserId: z.string(), // The user being removed
				}),
			)
			.query(async ({ ctx, input }) => {
				const actor = await db.query.user.findFirst({
					where: (member, { eq }) => eq(member.id, ctx.session.userId),
					with: { team: true },
				});

				if (actor?.teamId !== input.teamId) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "You are not a member of this team",
					});
				}

				if (!["owner", "admin"].includes(actor.role)) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "Only owner or admin can perform key rotation",
					});
				}

				if (actor.team) {
					assertTeamManagementEntitlement(actor.team);
				}

				const { removableVaults, inaccessibleTargetVaultIds } =
					await getTeamRemovalScope({
						teamId: input.teamId,
						actorUserId: ctx.session.userId,
						targetUserId: input.excludeUserId,
					});

				if (inaccessibleTargetVaultIds.length > 0) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message:
							"You cannot remove this member from only part of their team vault access.",
					});
				}

				const vaultRotationData = await Promise.all(
					removableVaults.map(async (v) => {
						// Get remaining members (excluding the user being removed)
						const members = await db.query.vaultKey.findMany({
							where: (vk, { and, eq: eqFn, ne }) =>
								and(eqFn(vk.vaultId, v.id), ne(vk.userId, input.excludeUserId)),
							with: { user: true },
						});

						// Get all items in the vault
						const items = await db.query.item.findMany({
							where: (i, { eq: eqFn }) => eqFn(i.vaultId, v.id),
						});

						return {
							vaultId: v.id,
							vaultName: v.name,
							keyVersion: v.keyVersion,
							members: members.map((m) => ({
								userId: m.userId,
								publicKey: m.user.publicKey,
								role: m.role,
							})),
							items: items.map((i) => ({
								id: i.id,
								encryptedData: i.encryptedData,
								encryptionIv: i.encryptionIv,
								encryptionAlgorithm: i.encryptionAlgorithm,
							})),
						};
					}),
				);

				return { vaults: vaultRotationData };
			}),

		/**
		 * Remove a team member with mandatory vault key rotation.
		 *
		 * When removing a member from a team, the client must provide re-encrypted data
		 * for ALL team vaults that the member had access to:
		 * - New encrypted vault keys for all remaining members
		 * - Re-encrypted items using the new vault key
		 *
		 * The removed user gets a new personal team with a free plan so they
		 * aren't left in an orphaned state.
		 */
		remove: protectedProcedure
			.input(
				z.object({
					teamId: z.string(),
					userId: z.string(),
					vaultRotations: z.array(
						z.object({
							vaultId: z.string(),
							keyRotation: z.object({
								memberKeys: z.array(
									z.object({
										userId: z.string(),
										encryptedVaultKey: z.string(),
									}),
								),
								reEncryptedItems: z.array(
									z.object({
										itemId: z.string(),
										encryptedData: z.string(),
										encryptionIv: z.string(),
									}),
								),
							}),
						}),
					),
					clientId: z.string().optional(),
				}),
			)
			.mutation(async ({ ctx, input }) => {
				const actor = await db.query.user.findFirst({
					where: (member, { eq }) => eq(member.id, ctx.session.userId),
					with: { team: true },
				});

				if (actor?.teamId !== input.teamId) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "You are not a member of this team",
					});
				}

				if (!["owner", "admin"].includes(actor.role)) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "Insufficient permissions",
					});
				}
				if (actor.team) {
					assertTeamManagementEntitlement(actor.team);
				}

				if (ctx.session.userId === input.userId) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "You cannot remove yourself from the team",
					});
				}

				const targetUser = await db.query.user.findFirst({
					where: (member, { eq }) => eq(member.id, input.userId),
				});

				if (!targetUser || targetUser.teamId !== input.teamId) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Team member not found",
					});
				}

				if (targetUser.role === "owner") {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "The team owner cannot be removed",
					});
				}

				const { removableVaults, inaccessibleTargetVaultIds } =
					await getTeamRemovalScope({
						teamId: input.teamId,
						actorUserId: ctx.session.userId,
						targetUserId: input.userId,
					});

				if (inaccessibleTargetVaultIds.length > 0) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message:
							"You cannot remove this member from only part of their team vault access.",
					});
				}

				const expectedVaultIds = new Set(
					removableVaults.map((record) => record.id),
				);
				const providedVaultIds = new Set(
					input.vaultRotations.map((record) => record.vaultId),
				);

				if (providedVaultIds.size !== input.vaultRotations.length) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Duplicate vault rotation entries are not allowed.",
					});
				}

				const hasMissingVault = [...expectedVaultIds].some(
					(vaultId) => !providedVaultIds.has(vaultId),
				);
				const hasExtraVault = [...providedVaultIds].some(
					(vaultId) => !expectedVaultIds.has(vaultId),
				);
				if (hasMissingVault || hasExtraVault) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							"Vault rotation data must exactly match the removable team vault set.",
					});
				}

				const vaultMap = new Map(removableVaults.map((record) => [record.id, record]));

				// Create key rotation records for each vault
				const rotationRecords: Array<{
					vaultId: string;
					rotationId: string;
					newKeyVersion: number;
				}> = [];
				for (const vaultRotation of input.vaultRotations) {
					const vaultData = vaultMap.get(vaultRotation.vaultId);
					if (!vaultData) continue;

					const rotationId = nanoid();
					const newKeyVersion = vaultData.keyVersion + 1;

					await db.insert(vaultKeyRotation).values({
						id: rotationId,
						vaultId: vaultRotation.vaultId,
						keyVersion: newKeyVersion,
						reason: "member_removed",
						initiatedById: ctx.session.userId,
						removedUserId: input.userId,
						itemsReEncrypted: vaultRotation.keyRotation.reEncryptedItems.length,
						membersUpdated: vaultRotation.keyRotation.memberKeys.length,
						status: "in_progress",
					});

					rotationRecords.push({
						vaultId: vaultRotation.vaultId,
						rotationId,
						newKeyVersion,
					});
				}

				try {
					const broadcasts: SyncBroadcastPayload[] = [];

					await db.transaction(async (tx) => {
						// Process key rotation for each team vault
						for (const vaultRotation of input.vaultRotations) {
							const record = rotationRecords.find(
								(r) => r.vaultId === vaultRotation.vaultId,
							);
							if (!record) continue;

							// Delete the removed user's vault key
							const removedKey = await tx
								.delete(vaultKey)
								.where(
									and(
										eq(vaultKey.vaultId, vaultRotation.vaultId),
										eq(vaultKey.userId, input.userId),
									),
								)
								.returning({ id: vaultKey.id });

							if (removedKey.length === 0) {
								throw new Error(
									`Vault key not found for user in vault ${vaultRotation.vaultId}`,
								);
							}

							// Update vault keys for all remaining members
							for (const memberKey of vaultRotation.keyRotation.memberKeys) {
								const updatedKey = await tx
									.update(vaultKey)
									.set({ encryptedVaultKey: memberKey.encryptedVaultKey })
									.where(
										and(
											eq(vaultKey.vaultId, vaultRotation.vaultId),
											eq(vaultKey.userId, memberKey.userId),
										),
									)
									.returning({ id: vaultKey.id });

								if (updatedKey.length === 0) {
									throw new Error(
										`Member key not found for user ${memberKey.userId} in vault ${vaultRotation.vaultId}`,
									);
								}
							}

							// Re-encrypt all items with new vault key
							for (const reEncryptedItem of vaultRotation.keyRotation
								.reEncryptedItems) {
								const updatedItem = await tx
									.update(item)
									.set({
										encryptedData: reEncryptedItem.encryptedData,
										encryptionIv: reEncryptedItem.encryptionIv,
										updatedAt: new Date(),
									})
									.where(
										and(
											eq(item.id, reEncryptedItem.itemId),
											eq(item.vaultId, vaultRotation.vaultId),
										),
									)
									.returning({ id: item.id });

								if (updatedItem.length === 0) {
									throw new Error(
										`Item not found in vault: ${reEncryptedItem.itemId}`,
									);
								}
							}

							// Update vault key version
							await tx
								.update(vault)
								.set({
									keyVersion: record.newKeyVersion,
									updatedAt: new Date(),
								})
								.where(eq(vault.id, vaultRotation.vaultId));

							// Mark rotation as completed
							await tx
								.update(vaultKeyRotation)
								.set({
									status: "completed",
									completedAt: new Date(),
								})
								.where(eq(vaultKeyRotation.id, record.rotationId));

							// Create sync events
							broadcasts.push(
								await createSyncEvent(
									{
										eventType: "vault_access_revoked",
										entityId: vaultRotation.vaultId,
										entityType: "vault",
										vaultId: vaultRotation.vaultId,
										userId: input.userId,
										clientId: input.clientId,
										version: record.newKeyVersion,
										metadata: {
											reason: "team_member_removed",
											removedUserId: input.userId,
										},
									},
									tx,
									ctx.clientId,
								),
							);

							broadcasts.push(
								await createSyncEvent(
									{
										eventType: "vault_member_removed",
										entityId: input.userId,
										entityType: "vault_member",
										vaultId: vaultRotation.vaultId,
										userId: ctx.session.userId,
										clientId: input.clientId,
										version: record.newKeyVersion,
										metadata: { removedUserId: input.userId },
									},
									tx,
									ctx.clientId,
								),
							);

							broadcasts.push(
								await createSyncEvent(
									{
										eventType: "vault_key_rotated",
										entityId: vaultRotation.vaultId,
										entityType: "vault_key",
										vaultId: vaultRotation.vaultId,
										userId: ctx.session.userId,
										clientId: input.clientId,
										version: record.newKeyVersion,
										metadata: {
											reason: "team_member_removed",
											keyRotationId: record.rotationId,
										},
									},
									tx,
									ctx.clientId,
								),
							);
						}

						// Create a personal team with free plan for the removed user
						await createPersonalTeamForUser(input.userId, targetUser.name, tx);
					});

					// After transaction commits: invalidate sessions and broadcast
					await deleteAllUserSessions(input.userId);
					await broadcastSyncPayloads(broadcasts);

					await logAuditEvent({
						userId: ctx.session.userId,
						action: "team_member_removed",
						device: ctx.device,
						entityType: "user",
						entityId: input.userId,
						metadata: {
							teamId: input.teamId,
							actorRole: actor.role,
							vaultsRotated: rotationRecords.length,
						},
					});

					await syncSeatsBestEffort(
						input.teamId,
						actor.team?.billingPlan || "free",
					);

					return {
						success: true,
						vaultRotations: rotationRecords.map((r) => ({
							vaultId: r.vaultId,
							rotationId: r.rotationId,
							newKeyVersion: r.newKeyVersion,
						})),
					};
				} catch (error) {
					// Mark all rotations as failed
					for (const record of rotationRecords) {
						await db
							.update(vaultKeyRotation)
							.set({
								status: "failed",
								errorMessage:
									error instanceof Error ? error.message : "Unknown error",
							})
							.where(eq(vaultKeyRotation.id, record.rotationId));
					}

					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message:
							"Team member removal failed during key rotation. Please try again.",
					});
				}
			}),

		/**
		 * @deprecated Account deletion by team admins is no longer supported.
		 * Team admins can only remove members from the team. The removed member
		 * manages their own account lifecycle via auth.deleteAccount.
		 */
		deleteAccount: protectedProcedure
			.input(
				z.object({
					teamId: z.string(),
					userId: z.string(),
					confirmation: z.literal("DELETE"),
				}),
			)
			.mutation(async () => {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						"Account deletion by team admins is no longer supported. Use 'Remove member' instead. The removed user can delete their own account.",
				});
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
			if (userData.team) {
				assertTeamManagementEntitlement(userData.team);
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
					with: { team: true },
				});

				if (userData?.teamId !== input.teamId) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "You are not a member of this team",
					});
				}
				if (!userData || !["owner", "admin"].includes(userData.role)) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "Insufficient permissions",
					});
				}
				if (userData?.team) {
					assertTeamManagementEntitlement(userData.team);
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
								vaultId: z.string().min(1),
								encryptedVaultKey: z.string().min(1),
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

				if (!userData.team) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Team not found",
					});
				}

				assertTeamManagementEntitlement(userData.team);

				// Check team capacity when a member limit is configured
				if (userData.team.memberLimit) {
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

				const normalizedPendingVaultKeys = normalizePendingVaultKeys(
					input.pendingVaultKeys,
				);
				await assertInvitationPendingVaultKeysAreAuthorized({
					teamId: input.teamId,
					inviterId: ctx.session.userId,
					pendingVaultKeys: normalizedPendingVaultKeys,
				});

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
					pendingVaultKeys: normalizedPendingVaultKeys.length
						? JSON.stringify(normalizedPendingVaultKeys)
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
					with: { team: true },
				});

				if (!invitation) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Invitation not found",
					});
				}

				// Must be current owner/admin in the invitation team
				const userData = await db.query.user.findFirst({
					where: (user, { eq }) => eq(user.id, ctx.session.userId),
				});

				const isAdminOrOwner =
					userData?.teamId === invitation.teamId &&
					(userData?.role === "owner" || userData?.role === "admin");

				if (!isAdminOrOwner) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "Insufficient permissions",
					});
				}
				assertTeamManagementEntitlement(invitation.team);

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
					with: { team: true },
				});

				if (!invitation) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Invitation not found",
					});
				}

				// Must be current owner/admin in the invitation team
				const userData = await db.query.user.findFirst({
					where: (user, { eq }) => eq(user.id, ctx.session.userId),
				});

				const isAdminOrOwner =
					userData?.teamId === invitation.teamId &&
					(userData?.role === "owner" || userData?.role === "admin");

				if (!isAdminOrOwner) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "Insufficient permissions",
					});
				}

				assertTeamManagementEntitlement(invitation.team);

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

				assertTeamManagementEntitlement(invitation.team);

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

				const pendingKeys = parsePendingVaultKeys(invitation.pendingVaultKeys);
				await assertInvitationPendingVaultKeysAreAuthorized({
					teamId: invitation.teamId,
					inviterId: invitation.invitedById,
					pendingVaultKeys: pendingKeys,
				});

				// Convert invitation role to vault role
				const vaultRole = invitation.role === "admin" ? "admin" : "member";

				await db.transaction(async (tx) => {
					// Link user to team
					await tx
						.update(user)
						.set({ teamId: invitation.teamId, role: invitation.role })
						.where(eq(user.id, ctx.session.userId));

					for (const keyData of pendingKeys) {
						// Skip duplicate provisioning if access already exists.
						const existingKey = await tx.query.vaultKey.findFirst({
							where: (vk, { and, eq }) =>
								and(
									eq(vk.vaultId, keyData.vaultId),
									eq(vk.userId, ctx.session.userId),
								),
						});
						if (!existingKey) {
							await tx.insert(vaultKey).values({
								id: nanoid(),
								vaultId: keyData.vaultId,
								userId: ctx.session.userId,
								encryptedVaultKey: keyData.encryptedVaultKey,
								role: vaultRole,
							});
						}
					}

					// Mark invitation as accepted
					await tx
						.update(teamInvitation)
						.set({ status: "accepted", acceptedAt: new Date() })
						.where(eq(teamInvitation.id, invitation.id));
				});

				await syncSeatsBestEffort(
					invitation.teamId,
					invitation.team.billingPlan,
				);

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
