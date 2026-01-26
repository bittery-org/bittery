/**
 * Authentication tRPC Router
 * Handles signup, login with SRP, session management
 */
/** biome-ignore-all lint/style/noNonNullAssertion: we need that here */

import {
	createUser,
	createUserSession,
	deleteAllUserSessions,
	deleteSession,
	deleteUserAccount,
	finishLogin,
	getUserByEmail,
	getUserById,
	getUserSessions,
	renameSession,
	revokeSession,
	startLogin,
	updateSessionActivity,
	updateUserEmail,
	updateUserPassword,
	updateUserSecretKey,
} from "@bittery/auth";
import {
	db,
	team,
	teamInvitation,
	user,
	vault,
	vaultKey,
} from "@bittery/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { protectedProcedure, publicProcedure, router } from "../index";
import { getStoragePublicUrl } from "../storage/s3";
import { parseUserAgent } from "../utils/device";

export const authRouter = router({
	/**
	 * Signup: Create new user with zero-knowledge authentication
	 */
	signup: publicProcedure
		.input(
			z.object({
				email: z.string().email(),
				name: z.string().min(2),
				secretKeyHint: z.string(),
				srpSalt: z.string(),
				srpVerifier: z.string(),
				publicKey: z.string(),
				encryptedPrivateKey: z.string(),
				encryptedVaultKey: z.string(), // Encrypted default vault key
			}),
		)
		.mutation(async ({ ctx, input }) => {
			// Check if user already exists
			const existingUser = await getUserByEmail(input.email);
			if (existingUser) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "User with this email already exists",
				});
			}

			// Create personal team first
			const teamId = nanoid();
			await db.insert(team).values({
				id: teamId,
				name: `${input.name}'s Team`,
				ownerId: "temp", // Temporary, will be updated
				type: "personal",
				memberLimit: 1,
			});

			// Create user with teamId
			const userId = await createUser({
				email: input.email,
				name: input.name,
				secretKeyHint: input.secretKeyHint,
				srpSalt: input.srpSalt,
				srpVerifier: input.srpVerifier,
				publicKey: input.publicKey,
				encryptedPrivateKey: input.encryptedPrivateKey,
			});

			// Update team ownerId with actual userId
			await db.update(team).set({ ownerId: userId }).where(eq(team.id, teamId));

			// Link user to team
			await db.update(user).set({ teamId, role: "owner" }).where(eq(user.id, userId));

			// Create default "Personal" vault
			const vaultId = nanoid();
			await db.insert(vault).values({
				id: vaultId,
				name: "Personal",
				type: "personal",
				icon: "lock",
				createdById: userId,
			});

			// Store encrypted vault key
			await db.insert(vaultKey).values({
				id: nanoid(),
				vaultId,
				userId,
				encryptedVaultKey: input.encryptedVaultKey,
				role: "owner",
			});

			// Parse device info from context
			const deviceInfo = parseUserAgent(ctx.device.userAgent);

			// Create session and generate token with device info
			const sessionData = await createUserSession(userId, {
				...deviceInfo,
				userAgent: ctx.device.userAgent,
				ipAddress: ctx.device.ipAddress,
			});

			// Get vault keys
			const vaultKeys = await db.query.vaultKey.findMany({
				where: (vaultKey, { eq }) => eq(vaultKey.userId, userId),
				with: {
					vault: true,
				},
			});

			// Get team data
			const teamData = await db.query.team.findFirst({
				where: (team, { eq }) => eq(team.id, teamId),
			});

			return {
				success: true,
				userId,
				token: sessionData.token,
				sessionId: sessionData.sessionId,
				user: {
					...sessionData.user,
					teamId,
					teamName: teamData?.name,
					teamType: teamData?.type,
					role: "owner",
				},
				vaultKeys: vaultKeys.map((vk) => ({
					vaultId: vk.vaultId,
					vaultName: vk.vault.name,
					vaultType: vk.vault.type,
					vaultIcon: vk.vault.icon,
					vaultImageUrl: vk.vault.imageKey
						? getStoragePublicUrl(vk.vault.imageKey)
						: null,
					encryptedVaultKey: vk.encryptedVaultKey,
					role: vk.role,
				})),
			};
		}),

	/**
	 * Signup with invitation: Create user account and join invited team
	 */
	signupWithInvitation: publicProcedure
		.input(
			z.object({
				token: z.string(),
				email: z.string().email(),
				name: z.string().min(2),
				secretKeyHint: z.string(),
				srpSalt: z.string(),
				srpVerifier: z.string(),
				publicKey: z.string(),
				encryptedPrivateKey: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			// 1. Validate invitation
			const invitation = await db.query.teamInvitation.findFirst({
				where: (inv, { and, eq }) =>
					and(
						eq(inv.token, input.token),
						eq(inv.status, "pending"),
					),
				with: { team: true },
			});

			if (!invitation) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Invitation not found or already used",
				});
			}

			// Check expiry
			if (invitation.expiresAt < new Date()) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invitation has expired",
				});
			}

			// Verify email matches invitation
			if (invitation.email.toLowerCase() !== input.email.toLowerCase()) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Email does not match invitation",
				});
			}

			// Check if user already exists
			const existingUser = await getUserByEmail(input.email);
			if (existingUser) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "User with this email already exists",
				});
			}

			// Check team capacity (family teams have limits)
			if (invitation.team.type === "family" && invitation.team.memberLimit) {
				const currentMembers = await db.query.user.findMany({
					where: (user, { eq }) => eq(user.teamId, invitation.teamId),
				});

				if (currentMembers.length >= invitation.team.memberLimit) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Team has reached member limit",
					});
				}
			}

			// 2. Create user account
			const userId = await createUser({
				email: input.email,
				name: input.name,
				secretKeyHint: input.secretKeyHint,
				srpSalt: input.srpSalt,
				srpVerifier: input.srpVerifier,
				publicKey: input.publicKey,
				encryptedPrivateKey: input.encryptedPrivateKey,
			});

			// Link user to invited team
			await db
				.update(user)
				.set({ teamId: invitation.teamId, role: invitation.role })
				.where(eq(user.id, userId));

			// 3. Grant vault access if pendingVaultKeys were provided
			if (invitation.pendingVaultKeys) {
				try {
					const pendingKeys = JSON.parse(invitation.pendingVaultKeys) as Array<{
						vaultId: string;
						encryptedVaultKey: string;
					}>;

					// Convert invitation role to vault role
					const vaultRole = invitation.role === "admin" ? "admin" : "member";

					// Create vault key entries
					for (const keyData of pendingKeys) {
						await db.insert(vaultKey).values({
							id: nanoid(),
							vaultId: keyData.vaultId,
							userId,
							encryptedVaultKey: keyData.encryptedVaultKey,
							role: vaultRole,
						});
					}
				} catch (e) {
					console.error("Failed to provision vault keys:", e);
				}
			}

			// 4. Mark invitation as accepted
			await db
				.update(teamInvitation)
				.set({ status: "accepted", acceptedAt: new Date() })
				.where(eq(teamInvitation.id, invitation.id));

			// Parse device info from context
			const deviceInfo = parseUserAgent(ctx.device.userAgent);

			// Create session
			const sessionData = await createUserSession(userId, {
				...deviceInfo,
				userAgent: ctx.device.userAgent,
				ipAddress: ctx.device.ipAddress,
			});

			// Get vault keys
			const vaultKeys = await db.query.vaultKey.findMany({
				where: (vaultKey, { eq }) => eq(vaultKey.userId, userId),
				with: { vault: true },
			});

			return {
				success: true,
				userId,
				token: sessionData.token,
				sessionId: sessionData.sessionId,
				user: {
					...sessionData.user,
					teamId: invitation.teamId,
					teamName: invitation.team.name,
					teamType: invitation.team.type,
					role: invitation.role,
				},
				vaultKeys: vaultKeys.map((vk) => ({
					vaultId: vk.vaultId,
					vaultName: vk.vault.name,
					vaultType: vk.vault.type,
					vaultIcon: vk.vault.icon,
					vaultImageUrl: vk.vault.imageKey
						? getStoragePublicUrl(vk.vault.imageKey)
						: null,
					encryptedVaultKey: vk.encryptedVaultKey,
					role: vk.role,
				})),
			};
		}),

	/**
	 * Start Login: Initiate SRP authentication
	 * Client sends their public ephemeral key, server responds with challenge
	 */
	startLogin: publicProcedure
		.input(
			z.object({
				email: z.string().email(),
				clientPublicKey: z.string(),
			}),
		)
		.mutation(async ({ input }) => {
			try {
				const { userId, challenge, serverEphemeralSecret } = await startLogin(
					input.email,
					input.clientPublicKey,
				);

				return {
					userId,
					salt: challenge.salt,
					serverPublicKey: challenge.serverPublicKey,
					serverSecret: serverEphemeralSecret, // Temporary storage for next request
				};
			} catch (error) {
				console.error(error);

				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "Invalid credentials",
				});
			}
		}),

	/**
	 * Finish Login: Complete SRP authentication and create session
	 * Client sends proof, server verifies and returns session token
	 */
	finishLogin: publicProcedure
		.input(
			z.object({
				userId: z.string(),
				serverSecret: z.string(), // Server ephemeral secret from previous step
				clientPublicKey: z.string(),
				clientProof: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			// Parse device info from request context
			const deviceInfo = parseUserAgent(ctx.device.userAgent);

			const result = await finishLogin(
				input.userId,
				input.serverSecret,
				input.clientPublicKey,
				input.clientProof,
				{
					...deviceInfo,
					userAgent: ctx.device.userAgent,
					ipAddress: ctx.device.ipAddress,
				},
			);

			if (!result.success || !result.user) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "Invalid credentials",
				});
			}

			// Get user's vault keys
			const vaultKeys = await db.query.vaultKey.findMany({
				// biome-ignore lint/suspicious/noNonNullAssertedOptionalChain: we need that here
				where: (vaultKey, { eq }) => eq(vaultKey.userId, result.user?.id!),
				with: {
					vault: true,
				},
			});

			// Get user with team (direct relation)
			const userData = await db.query.user.findFirst({
				where: (user, { eq }) => eq(user.id, result.user!.id),
				with: { team: true },
			});

			return {
				token: result.token!,
				sessionId: result.sessionId!,
				serverProof: result.serverProof!, // For client to verify server
				user: {
					...result.user,
					teamId: userData?.teamId,
					teamName: userData?.team?.name,
					teamType: userData?.team?.type,
					role: userData?.role,
				},
				vaultKeys: vaultKeys.map((vk) => ({
					vaultId: vk.vaultId,
					vaultName: vk.vault.name,
					vaultType: vk.vault.type,
					vaultIcon: vk.vault.icon,
					vaultImageUrl: vk.vault.imageKey
						? getStoragePublicUrl(vk.vault.imageKey)
						: null,
					encryptedVaultKey: vk.encryptedVaultKey,
					role: vk.role,
				})),
			};
		}),

	/**
	 * Quick Unlock: Fast login with password only (uses stored secret key)
	 * Same as full login but client provides secret key from localStorage
	 */
	quickUnlock: publicProcedure
		.input(
			z.object({
				email: z.string().email(),
				userId: z.string(),
				serverSecret: z.string(),
				clientPublicKey: z.string(),
				clientProof: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			// Parse device info from request context
			const deviceInfo = parseUserAgent(ctx.device.userAgent);

			const result = await finishLogin(
				input.userId,
				input.serverSecret,
				input.clientPublicKey,
				input.clientProof,
				{
					...deviceInfo,
					userAgent: ctx.device.userAgent,
					ipAddress: ctx.device.ipAddress,
				},
			);

			console.log(result);

			if (!result.success || !result.user) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "Invalid credentials",
				});
			}

			// Get user's vault keys
			const vaultKeys = await db.query.vaultKey.findMany({
				// biome-ignore lint/suspicious/noNonNullAssertedOptionalChain: we need that here
				where: (vaultKey, { eq }) => eq(vaultKey.userId, result.user?.id!),
				with: {
					vault: true,
				},
			});

			// Get user with team (direct relation)
			const userData = await db.query.user.findFirst({
				where: (user, { eq }) => eq(user.id, result.user!.id),
				with: { team: true },
			});

			return {
				token: result.token!,
				sessionId: result.sessionId!,
				user: {
					...result.user,
					teamId: userData?.teamId,
					teamName: userData?.team?.name,
					teamType: userData?.team?.type,
					role: userData?.role,
				},
				vaultKeys: vaultKeys.map((vk) => ({
					vaultId: vk.vaultId,
					vaultName: vk.vault.name,
					vaultType: vk.vault.type,
					vaultIcon: vk.vault.icon,
					vaultImageUrl: vk.vault.imageKey
						? getStoragePublicUrl(vk.vault.imageKey)
						: null,
					encryptedVaultKey: vk.encryptedVaultKey,
					role: vk.role,
				})),
			};
		}),

	/**
	 * Check if email exists
	 */
	checkEmail: publicProcedure
		.input(
			z.object({
				email: z.string().email(),
			}),
		)
		.query(async ({ input }) => {
			const user = await getUserByEmail(input.email);
			return {
				exists: !!user,
				secretKeyHint: user?.secretKeyHint || null,
			};
		}),

	/**
	 * Get current user data
	 */
	me: protectedProcedure.query(async ({ ctx }) => {
		const user = await getUserById(ctx.session.userId);

		if (!user) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "User not found",
			});
		}

		return {
			id: user.id,
			email: user.email,
			name: user.name,
			secretKeyHint: user.secretKeyHint,
			publicKey: user.publicKey,
			encryptedPrivateKey: user.encryptedPrivateKey,
			createdAt: user.createdAt,
		};
	}),

	/**
	 * Logout from current session
	 */
	logout: publicProcedure
		.input(
			z.object({
				sessionId: z.string(),
			}),
		)
		.mutation(async ({ input }) => {
			await deleteSession(input.sessionId);
			return { success: true };
		}),

	/**
	 * Logout from all sessions
	 */
	logoutAll: publicProcedure
		.input(
			z.object({
				userId: z.string(),
			}),
		)
		.mutation(async ({ input }) => {
			await deleteAllUserSessions(input.userId);
			return { success: true };
		}),

	/**
	 * Update user email
	 */
	updateEmail: protectedProcedure
		.input(
			z.object({
				newEmail: z.string().email(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			// Check if email already exists
			const existingUser = await getUserByEmail(input.newEmail);
			if (existingUser && existingUser.id !== ctx.session.userId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Email already in use",
				});
			}

			await updateUserEmail(ctx.session.userId, input.newEmail);

			// Logout all sessions to force re-login with new email
			await deleteAllUserSessions(ctx.session.userId);

			return { success: true };
		}),

	/**
	 * Change password with re-encrypted private key and vault keys
	 * Client must re-derive keys with new password and re-encrypt the private key and all vault keys
	 */
	changePassword: protectedProcedure
		.input(
			z.object({
				srpSalt: z.string(),
				srpVerifier: z.string(),
				encryptedPrivateKey: z.string(),
				encryptedVaultKeys: z.array(
					z.object({
						vaultId: z.string(),
						encryptedVaultKey: z.string(),
					}),
				),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await updateUserPassword(ctx.session.userId, {
				srpSalt: input.srpSalt,
				srpVerifier: input.srpVerifier,
				encryptedPrivateKey: input.encryptedPrivateKey,
				encryptedVaultKeys: input.encryptedVaultKeys,
			});

			// Logout all sessions to force re-login with new password
			await deleteAllUserSessions(ctx.session.userId);

			return { success: true };
		}),

	/**
	 * Regenerate secret key with re-encrypted data and vault keys
	 * Client must generate new secret key, re-derive keys, and re-encrypt the private key and all vault keys
	 */
	regenerateSecretKey: protectedProcedure
		.input(
			z.object({
				secretKeyHint: z.string(),
				srpSalt: z.string(),
				srpVerifier: z.string(),
				encryptedPrivateKey: z.string(),
				encryptedVaultKeys: z.array(
					z.object({
						vaultId: z.string(),
						encryptedVaultKey: z.string(),
					}),
				),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await updateUserSecretKey(ctx.session.userId, {
				secretKeyHint: input.secretKeyHint,
				srpSalt: input.srpSalt,
				srpVerifier: input.srpVerifier,
				encryptedPrivateKey: input.encryptedPrivateKey,
				encryptedVaultKeys: input.encryptedVaultKeys,
			});

			// Logout all sessions to force re-login with new secret key
			await deleteAllUserSessions(ctx.session.userId);

			return { success: true };
		}),

	/**
	 * Delete user account and all associated data
	 */
	deleteAccount: protectedProcedure
		.input(
			z.object({
				confirmEmail: z.string().email(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			// Get user to verify email
			const user = await getUserById(ctx.session.userId);
			if (!user) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "User not found",
				});
			}

			// Verify email matches for confirmation
			if (user.email.toLowerCase() !== input.confirmEmail.toLowerCase()) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Email does not match",
				});
			}

			// Delete user account (cascading deletes will handle related data)
			await deleteUserAccount(ctx.session.userId);

			return { success: true };
		}),

	/**
	 * Get all active sessions/devices for the current user
	 */
	listDevices: protectedProcedure.query(async ({ ctx }) => {
		const sessions = await getUserSessions(ctx.session.userId);

		// Mark current session
		return sessions.map((s) => ({
			...s,
			isCurrentSession: s.id === ctx.session.sessionId,
		}));
	}),

	/**
	 * Revoke a specific session/device
	 * Cannot revoke the current session
	 */
	revokeDevice: protectedProcedure
		.input(
			z.object({
				sessionId: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			// Prevent revoking current session
			if (input.sessionId === ctx.session.sessionId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Cannot revoke current session. Use logout instead.",
				});
			}

			await revokeSession(input.sessionId, ctx.session.userId);
			return { success: true };
		}),

	/**
	 * Rename a device/session
	 */
	renameDevice: protectedProcedure
		.input(
			z.object({
				sessionId: z.string(),
				deviceName: z.string().min(1).max(100),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await renameSession(
				input.sessionId,
				ctx.session.userId,
				input.deviceName,
			);
			return { success: true };
		}),

	/**
	 * Update current session's last active timestamp
	 * Called periodically by clients to track activity
	 */
	heartbeat: protectedProcedure.mutation(async ({ ctx }) => {
		await updateSessionActivity(ctx.session.sessionId);
		return { success: true };
	}),
});
