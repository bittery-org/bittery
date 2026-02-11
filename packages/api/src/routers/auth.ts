/**
 * Authentication tRPC Router
 * Handles signup, login with SRP, session management
 */
/** biome-ignore-all lint/style/noNonNullAssertion: we need that here */

import { createHmac } from "node:crypto";
import {
	checkLoginRateLimit,
	clearLoginRateLimit,
	createUser,
	createUserSession,
	deleteAllUserSessions,
	deleteSession,
	deleteUserAccount,
	finishLogin,
	getSessionById,
	getUserByEmail,
	getUserById,
	getUserSessions,
	LoginRateLimitError,
	normalizeEmail,
	recordFailedLoginAttempt,
	renameSession,
	revokeSession,
	startLogin,
	updateSessionActivity,
	updateUserEmail,
	updateUserPassword,
	updateUserSecretKey,
} from "@bittery/auth";
import { db, team, teamInvitation, user, vault, vaultKey } from "@bittery/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { getBitteryMode, isSelfHostedMode } from "../config/mode";
import { protectedProcedure, publicProcedure, router } from "../index";
import { getStoragePublicUrl } from "../storage/s3";
import { logAuditEvent } from "../utils/audit";
import { parseUserAgent } from "../utils/device";

/**
 * Helper function to get team avatar URL from imageKey
 */
function getTeamImageUrl(imageKey: string | null | undefined): string | null {
	if (!imageKey) return null;
	return getStoragePublicUrl(imageKey);
}

function mapRateLimitError(error: unknown): TRPCError {
	if (error instanceof LoginRateLimitError) {
		return new TRPCError({
			code: "TOO_MANY_REQUESTS",
			message: error.message,
		});
	}

	throw error;
}

const hintSecret = process.env.JWT_SECRET;
if (!hintSecret) {
	throw new Error(
		"FATAL: JWT_SECRET environment variable is not set. " +
			"Email hint protection cannot be initialized.",
	);
}
const emailHintSecret = hintSecret;

function generateDeterministicFakeHint(email: string): string {
	const digest = createHmac("sha256", emailHintSecret)
		.update(normalizeEmail(email))
		.digest("hex")
		.toUpperCase();

	return `A3-${digest.slice(0, 8)}`;
}

async function hasAnyRegisteredUser(): Promise<boolean> {
	const existingUser = await db.query.user.findFirst({
		columns: { id: true },
	});
	return !!existingUser;
}

export const authRouter = router({
	registrationStatus: publicProcedure.query(async () => {
		const mode = getBitteryMode();
		if (mode === "cloud") {
			return {
				mode,
				allowPublicSignup: true,
			};
		}

		const allowPublicSignup = !(await hasAnyRegisteredUser());

		return {
			mode,
			allowPublicSignup,
			reason: allowPublicSignup ? undefined : "invite_only_after_bootstrap",
		};
	}),

	/**
	 * Signup: Create new user with zero-knowledge authentication
	 */
	signup: publicProcedure
		.input(
			z.object({
				email: z.string().email().max(255),
				name: z.string().min(2),
				organizationName: z.string().optional(),
				secretKeyHint: z.string(),
				srpSalt: z.string(),
				srpVerifier: z.string(),
				publicKey: z.string(),
				encryptedPrivateKey: z.string(),
				encryptedVaultKey: z.string(), // Encrypted default vault key
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const normalizedEmail = normalizeEmail(input.email);
			const selfHostedMode = isSelfHostedMode();

			if (selfHostedMode) {
				const allowPublicSignup = !(await hasAnyRegisteredUser());
				if (!allowPublicSignup) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message:
							"Public registration is disabled. Ask an admin for an invite link.",
					});
				}
			}

			// Check if user already exists
			const existingUser = await getUserByEmail(normalizedEmail);
			if (existingUser) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "User with this email already exists",
				});
			}

			// Determine team configuration by deployment mode
			const isOrganization = !!input.organizationName;
			const teamType = selfHostedMode
				? "organization"
				: isOrganization
					? "organization"
					: "personal";
			const teamName = selfHostedMode
				? input.organizationName?.trim() || "Bittery Instance"
				: input.organizationName || "My Team";
			const memberLimit = selfHostedMode ? null : isOrganization ? null : 1;

			// Create user first (without team)
			const userId = await createUser({
				email: normalizedEmail,
				name: input.name,
				secretKeyHint: input.secretKeyHint,
				srpSalt: input.srpSalt,
				srpVerifier: input.srpVerifier,
				publicKey: input.publicKey,
				encryptedPrivateKey: input.encryptedPrivateKey,
			});

			// Create team with actual userId as owner
			const teamId = nanoid();
			await db.insert(team).values({
				id: teamId,
				name: teamName,
				ownerId: userId,
				type: teamType,
				memberLimit,
			});

			// Link user to team
			await db
				.update(user)
				.set({ teamId, role: "owner" })
				.where(eq(user.id, userId));

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
					teamAvatarUrl: getTeamImageUrl(teamData?.imageKey),
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
				email: z.string().email().max(255),
				name: z.string().min(2),
				secretKeyHint: z.string(),
				srpSalt: z.string(),
				srpVerifier: z.string(),
				publicKey: z.string(),
				encryptedPrivateKey: z.string(),
				encryptedVaultKey: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const normalizedEmail = normalizeEmail(input.email);

			// 1. Validate invitation
			const invitation = await db.query.teamInvitation.findFirst({
				where: (inv, { and, eq }) =>
					and(eq(inv.token, input.token), eq(inv.status, "pending")),
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
			if (normalizeEmail(invitation.email) !== normalizedEmail) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Email does not match invitation",
				});
			}

			// Check if user already exists
			const existingUser = await getUserByEmail(normalizedEmail);
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
				email: normalizedEmail,
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

			// Create default personal vault for the new user
			const personalVaultId = nanoid();
			await db.insert(vault).values({
				id: personalVaultId,
				name: "Personal",
				type: "personal",
				icon: "lock",
				createdById: userId,
			});

			await db.insert(vaultKey).values({
				id: nanoid(),
				vaultId: personalVaultId,
				userId,
				encryptedVaultKey: input.encryptedVaultKey,
				role: "owner",
			});

			// 3. Grant shared vault access if pendingVaultKeys were provided
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
					teamAvatarUrl: getTeamImageUrl(invitation.team.imageKey),
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
				email: z.string().email().max(255),
				clientPublicKey: z.string().max(2048),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const normalizedEmail = normalizeEmail(input.email);

			try {
				await checkLoginRateLimit(normalizedEmail, ctx.device.ipAddress);
			} catch (error) {
				throw mapRateLimitError(error);
			}

			try {
				const { userId, challenge, serverEphemeralSecret } = await startLogin(
					normalizedEmail,
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

				try {
					await recordFailedLoginAttempt(normalizedEmail, ctx.device.ipAddress);
				} catch (rateLimitError) {
					throw mapRateLimitError(rateLimitError);
				}

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
				userId: z.string().max(64),
				serverSecret: z.string().max(2048), // Server ephemeral secret from previous step
				clientPublicKey: z.string().max(2048),
				clientProof: z.string().max(512),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const candidateUser = await getUserById(input.userId);
			const rateLimitEmail = normalizeEmail(
				candidateUser?.email || `${input.userId}@invalid.local`,
			);

			try {
				await checkLoginRateLimit(rateLimitEmail, ctx.device.ipAddress);
			} catch (error) {
				throw mapRateLimitError(error);
			}

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
				try {
					await recordFailedLoginAttempt(rateLimitEmail, ctx.device.ipAddress);
				} catch (rateLimitError) {
					throw mapRateLimitError(rateLimitError);
				}

				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "Invalid credentials",
				});
			}

			await clearLoginRateLimit(rateLimitEmail, ctx.device.ipAddress);

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
					teamAvatarUrl: getTeamImageUrl(userData?.team?.imageKey),
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
				email: z.string().email().max(255),
				userId: z.string().max(64),
				serverSecret: z.string().max(2048),
				clientPublicKey: z.string().max(2048),
				clientProof: z.string().max(512),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const normalizedEmail = normalizeEmail(input.email);

			try {
				await checkLoginRateLimit(normalizedEmail, ctx.device.ipAddress);
			} catch (error) {
				throw mapRateLimitError(error);
			}

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
				try {
					await recordFailedLoginAttempt(normalizedEmail, ctx.device.ipAddress);
				} catch (rateLimitError) {
					throw mapRateLimitError(rateLimitError);
				}

				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "Invalid credentials",
				});
			}

			await clearLoginRateLimit(normalizedEmail, ctx.device.ipAddress);

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
					teamAvatarUrl: getTeamImageUrl(userData?.team?.imageKey),
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
				email: z.string().email().max(255),
			}),
		)
		.query(async ({ input }) => {
			const normalizedEmail = normalizeEmail(input.email);
			const user = await getUserByEmail(normalizedEmail);
			const fakeHint = generateDeterministicFakeHint(normalizedEmail);

			return {
				exists: true,
				secretKeyHint: user?.secretKeyHint || fakeHint,
			};
		}),

	/**
	 * Get current user data
	 */
	me: protectedProcedure.query(async ({ ctx }) => {
		const userData = await db.query.user.findFirst({
			where: (user, { eq }) => eq(user.id, ctx.session.userId),
			with: { team: true },
		});

		if (!userData) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "User not found",
			});
		}

		return {
			id: userData.id,
			email: userData.email,
			name: userData.name,
			teamId: userData.teamId,
			teamName: userData.team?.name,
			teamType: userData.team?.type,
			teamAvatarUrl: getTeamImageUrl(userData.team?.imageKey),
			role: userData.role,
			secretKeyHint: userData.secretKeyHint,
			publicKey: userData.publicKey,
			encryptedPrivateKey: userData.encryptedPrivateKey,
			createdAt: userData.createdAt,
		};
	}),

	/**
	 * Logout from current session
	 */
	logout: protectedProcedure
		.input(
			z.object({
				sessionId: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const targetSession = await getSessionById(input.sessionId);
			if (!targetSession || targetSession.userId !== ctx.session.userId) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Session not found",
				});
			}

			await deleteSession(input.sessionId);
			return { success: true };
		}),

	/**
	 * Logout from all sessions
	 */
	logoutAll: protectedProcedure.mutation(async ({ ctx }) => {
		await deleteAllUserSessions(ctx.session.userId);

		await logAuditEvent({
			userId: ctx.session.userId,
			action: "logout_all",
			device: ctx.device,
			entityType: "session",
			entityId: ctx.session.sessionId,
		});

		return { success: true };
	}),

	/**
	 * Update user email
	 */
	updateEmail: protectedProcedure
		.input(
			z.object({
				newEmail: z.string().email().max(255),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const normalizedNewEmail = normalizeEmail(input.newEmail);

			// Check if email already exists
			const existingUser = await getUserByEmail(normalizedNewEmail);
			if (existingUser && existingUser.id !== ctx.session.userId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Email already in use",
				});
			}

			await updateUserEmail(ctx.session.userId, normalizedNewEmail);

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

			await logAuditEvent({
				userId: ctx.session.userId,
				action: "password_changed",
				device: ctx.device,
				entityType: "user",
				entityId: ctx.session.userId,
				metadata: {
					vaultKeysUpdated: input.encryptedVaultKeys.length,
				},
			});

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

			await logAuditEvent({
				userId: ctx.session.userId,
				action: "secret_key_regenerated",
				device: ctx.device,
				entityType: "user",
				entityId: ctx.session.userId,
				metadata: {
					vaultKeysUpdated: input.encryptedVaultKeys.length,
				},
			});

			return { success: true };
		}),

	/**
	 * Delete user account and all associated data
	 */
	deleteAccount: protectedProcedure
		.input(
			z.object({
				confirmEmail: z.string().email().max(255),
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
			if (normalizeEmail(user.email) !== normalizeEmail(input.confirmEmail)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Email does not match",
				});
			}

			await logAuditEvent({
				userId: ctx.session.userId,
				action: "account_deleted",
				device: ctx.device,
				entityType: "user",
				entityId: ctx.session.userId,
			});

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

			await logAuditEvent({
				userId: ctx.session.userId,
				action: "device_revoked",
				device: ctx.device,
				entityType: "session",
				entityId: input.sessionId,
			});

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
