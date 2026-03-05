/**
 * Authentication tRPC Router
 * Handles signup, login with SRP, session management
 */
/** biome-ignore-all lint/style/noNonNullAssertion: we need that here */

import { createHmac } from "node:crypto";
import {
	checkLoginRateLimit,
	checkRecoveryRateLimit,
	clearLoginRateLimit,
	clearRecoveryRateLimit,
	createRecoveryToken,
	createRecoveryVerification,
	createUser,
	createUserSession,
	deleteAllUserSessions,
	deleteOtherUserSessions,
	deleteSession,
	deleteUserAccount,
	finishLogin,
	getRecoveryData as getRecoveryDataForEmail,
	getUserByEmail,
	getUserById,
	getUserSessions,
	getUserVaultKeysForRecovery,
	LoginRateLimitError,
	normalizeEmail,
	refreshSession,
	RecoveryRateLimitError,
	recordFailedLoginAttempt,
	recordFailedRecoveryAttempt,
	renameSession,
	resetUserPassword as resetUserPasswordWithRecovery,
	revokeSession,
	startLogin,
	storeEncryptedMasterKey,
	updateSessionActivity,
	updateUserEmail,
	updateUserPassword,
	updateUserSecretKey,
	verifyRecoveryCode as verifyRecoveryCodeAttempt,
	verifyRecoveryToken,
} from "@bittery/auth";
import { db, team, teamInvitation, user, vault, vaultKey } from "@bittery/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { resolveEffectiveEntitlements } from "../billing/entitlements";
import { mapPlanToTeamType, planMemberLimits } from "../billing/plans";
import { syncTeamSeatQuantity } from "../billing/stripe";
import { getBitteryMode, isSelfHostedMode } from "../config/mode";
import { protectedProcedure, publicProcedure, router } from "../index";
import { broadcastSessionControlPayload } from "../sync-helper";
import { getStoragePublicUrl } from "../storage/s3";
import { logAuditEvent } from "../utils/audit";
import { parseUserAgent } from "../utils/device";
import {
	assertInvitationPendingVaultKeysAreAuthorized,
	parsePendingVaultKeys,
} from "../utils/pending-vault-keys";

/**
 * Helper function to get team avatar URL from imageKey
 */
function getTeamImageUrl(imageKey: string | null | undefined): string | null {
	if (!imageKey) return null;
	return getStoragePublicUrl(imageKey);
}

function mapRateLimitError(error: unknown): TRPCError {
	if (
		error instanceof LoginRateLimitError ||
		error instanceof RecoveryRateLimitError
	) {
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

async function sendRecoveryCode(email: string, code: string): Promise<void> {
	// TODO: Wire a production email provider (SES/Resend/etc.).
	console.info(
		`[recovery-code] email=${normalizeEmail(email)} code=${code} (dev stub)`,
	);
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
				userId: z.string().min(1).optional(),
				vaultId: z.string().min(1).optional(),
				email: z.string().email().max(255),
				name: z.string().min(2),
				plan: z.enum(["free", "personal", "family", "team"]).optional(),
				organizationName: z.string().optional(),
				secretKeyHint: z.string(),
				srpSalt: z.string(),
				srpVerifier: z.string(),
				publicKey: z.string(),
				encryptedPrivateKey: z.string(),
				encryptedMasterKey: z.string(),
				recoveryKeyHint: z.string(),
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
			const selectedPlan = selfHostedMode ? "free" : input.plan || "personal";
			const teamType = selfHostedMode
				? "organization"
				: mapPlanToTeamType(selectedPlan);
			const teamName = selfHostedMode
				? input.organizationName?.trim() || "Bittery Instance"
				: input.organizationName
					? input.organizationName
					: teamType === "family"
						? "My Family"
						: "My Team";

			const memberLimit = selfHostedMode
				? null
				: planMemberLimits[selectedPlan];

			// Create user first (without team)
			const userId = await createUser({
				id: input.userId,
				email: normalizedEmail,
				name: input.name,
				secretKeyHint: input.secretKeyHint,
				srpSalt: input.srpSalt,
				srpVerifier: input.srpVerifier,
				publicKey: input.publicKey,
				encryptedPrivateKey: input.encryptedPrivateKey,
				encryptedMasterKey: input.encryptedMasterKey,
				recoveryKeyHint: input.recoveryKeyHint,
			});

			// Create team with actual userId as owner
			const teamId = nanoid();
			await db.insert(team).values({
				id: teamId,
				name: teamName,
				ownerId: userId,
				type: teamType,
				memberLimit,
				billingPlan: selectedPlan,
				billingStatus: selectedPlan === "free" ? "none" : "incomplete",
			});

			// Link user to team
			await db
				.update(user)
				.set({ teamId, role: "owner" })
				.where(eq(user.id, userId));

			// Create default "Personal" vault
			const vaultId = input.vaultId ?? nanoid();
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
				userId: z.string().optional(),
				vaultId: z.string().optional(),
				email: z.string().email().max(255),
				name: z.string().min(2),
				secretKeyHint: z.string(),
				srpSalt: z.string(),
				srpVerifier: z.string(),
				publicKey: z.string(),
				encryptedPrivateKey: z.string(),
				encryptedMasterKey: z.string(),
				recoveryKeyHint: z.string(),
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

			const invitationEntitlements = resolveEffectiveEntitlements({
				mode: getBitteryMode(),
				billingPlan: invitation.team.billingPlan,
				billingStatus: invitation.team.billingStatus,
			});
			if (!invitationEntitlements.team_management) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message:
						"This team cannot accept invitations on its current plan or billing status.",
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

			// Check team capacity when a member limit is configured
			if (invitation.team.memberLimit) {
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

			const pendingKeys = parsePendingVaultKeys(invitation.pendingVaultKeys);
			await assertInvitationPendingVaultKeysAreAuthorized({
				teamId: invitation.teamId,
				inviterId: invitation.invitedById,
				pendingVaultKeys: pendingKeys,
			});

			// 2. Create user account
			const userId = await createUser({
				id: input.userId,
				email: normalizedEmail,
				name: input.name,
				secretKeyHint: input.secretKeyHint,
				srpSalt: input.srpSalt,
				srpVerifier: input.srpVerifier,
				publicKey: input.publicKey,
				encryptedPrivateKey: input.encryptedPrivateKey,
				encryptedMasterKey: input.encryptedMasterKey,
				recoveryKeyHint: input.recoveryKeyHint,
			});

			// Link user to invited team
			await db
				.update(user)
				.set({ teamId: invitation.teamId, role: invitation.role })
				.where(eq(user.id, userId));

			// Create default personal vault for the new user
			const personalVaultId = input.vaultId ?? nanoid();
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
			if (pendingKeys.length > 0) {
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
			}

			// 4. Mark invitation as accepted
			await db
				.update(teamInvitation)
				.set({ status: "accepted", acceptedAt: new Date() })
				.where(eq(teamInvitation.id, invitation.id));

			if (invitation.team.billingPlan === "team") {
				try {
					await syncTeamSeatQuantity(invitation.teamId);
				} catch (error) {
					console.error(
						"Failed to sync Stripe seats after invited signup:",
						error,
					);
				}
			}

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
					kdfParams: challenge.kdfParams,
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
				serverProof: result.serverProof!,
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
	 * Request recovery verification code.
	 * Response is intentionally non-enumerating.
	 */
	requestRecoveryVerification: publicProcedure
		.input(
			z.object({
				email: z.string().email().max(255),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const normalizedEmail = normalizeEmail(input.email);

			try {
				await checkRecoveryRateLimit(normalizedEmail, ctx.device.ipAddress);
			} catch (error) {
				throw mapRateLimitError(error);
			}

			const existingUser = await getUserByEmail(normalizedEmail);
			if (existingUser?.encryptedMasterKey) {
				const code = await createRecoveryVerification(normalizedEmail);
				await sendRecoveryCode(normalizedEmail, code);
			}

			return { success: true };
		}),

	/**
	 * Verify recovery code and return short-lived recovery token.
	 * Response is intentionally non-enumerating.
	 */
	verifyRecoveryCode: publicProcedure
		.input(
			z.object({
				email: z.string().email().max(255),
				code: z.string().length(6),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const normalizedEmail = normalizeEmail(input.email);

			try {
				await checkRecoveryRateLimit(normalizedEmail, ctx.device.ipAddress);
			} catch (error) {
				throw mapRateLimitError(error);
			}

			const isValid = await verifyRecoveryCodeAttempt(
				normalizedEmail,
				input.code,
			);

			if (!isValid) {
				try {
					await recordFailedRecoveryAttempt(
						normalizedEmail,
						ctx.device.ipAddress,
					);
				} catch (error) {
					throw mapRateLimitError(error);
				}

				return { success: false as const };
			}

			await clearRecoveryRateLimit(normalizedEmail, ctx.device.ipAddress);
			const recoveryToken = await createRecoveryToken(normalizedEmail);

			return {
				success: true as const,
				recoveryToken,
			};
		}),

	/**
	 * Get encrypted recovery metadata and vault keys using a verified recovery token.
	 */
	getRecoveryData: publicProcedure
		.input(
			z.object({
				recoveryToken: z.string().min(1),
			}),
		)
		.query(async ({ input }) => {
			const recoveryPayload = await verifyRecoveryToken(input.recoveryToken);
			if (!recoveryPayload) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "Invalid recovery session",
				});
			}

			const recoveryData = await getRecoveryDataForEmail(recoveryPayload.email);
			if (!recoveryData) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "Invalid recovery session",
				});
			}

			const vaultKeys = await getUserVaultKeysForRecovery(recoveryData.userId);

			return {
				userId: recoveryData.userId,
				encryptedMasterKey: recoveryData.encryptedMasterKey,
				encryptedPrivateKey: recoveryData.encryptedPrivateKey,
				secretKeyHint: recoveryData.secretKeyHint,
				recoveryKeyHint: recoveryData.recoveryKeyHint,
				vaultKeys,
			};
		}),

	/**
	 * Reset password via recovery flow and issue a fresh session.
	 */
	resetPassword: publicProcedure
		.input(
			z.object({
				recoveryToken: z.string().min(1),
				srpSalt: z.string(),
				srpVerifier: z.string(),
				encryptedPrivateKey: z.string(),
				encryptedMasterKey: z.string(),
				recoveryKeyHint: z.string(),
				secretKeyHint: z.string().optional(),
				encryptedVaultKeys: z.array(
					z.object({
						vaultId: z.string(),
						encryptedVaultKey: z.string(),
					}),
				),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const recoveryPayload = await verifyRecoveryToken(input.recoveryToken);
			if (!recoveryPayload) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "Invalid recovery session",
				});
			}

			let userId: string;
			try {
				userId = await resetUserPasswordWithRecovery(recoveryPayload.email, {
					srpSalt: input.srpSalt,
					srpVerifier: input.srpVerifier,
					encryptedPrivateKey: input.encryptedPrivateKey,
					encryptedMasterKey: input.encryptedMasterKey,
					recoveryKeyHint: input.recoveryKeyHint,
					secretKeyHint: input.secretKeyHint,
					encryptedVaultKeys: input.encryptedVaultKeys,
				});
			} catch {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "Invalid recovery session",
				});
			}

			const deviceInfo = parseUserAgent(ctx.device.userAgent);
			const sessionData = await createUserSession(userId, {
				...deviceInfo,
				userAgent: ctx.device.userAgent,
				ipAddress: ctx.device.ipAddress,
			});

			await logAuditEvent({
				userId,
				action: "password_reset_via_recovery",
				device: ctx.device,
				entityType: "user",
				entityId: userId,
				metadata: {
					vaultKeysUpdated: input.encryptedVaultKeys.length,
				},
			});

			return {
				token: sessionData.token,
				sessionId: sessionData.sessionId,
				userId,
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
			hasRecoveryKey: userData.encryptedMasterKey !== null,
			createdAt: userData.createdAt,
		};
	}),

	/**
	 * Logout from current session
	 */
	logout: protectedProcedure.mutation(async ({ ctx }) => {
			await deleteSession(ctx.session.sessionId);
			return { success: true };
		}),

	refreshSession: protectedProcedure.mutation(async ({ ctx }) => {
		try {
			const nextSession = await refreshSession(ctx.session.sessionId);

			return {
				token: nextSession.token,
				sessionId: nextSession.sessionId,
				expiresAt: nextSession.expiresAt,
			};
		} catch (error) {
			if (error instanceof Error && error.message === "Session not found") {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "Session expired",
				});
			}

			throw error;
		}
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
			const normalizedNewEmail = normalizeEmail(input.newEmail);

			// Check if email already exists
			const existingUser = await getUserByEmail(normalizedNewEmail);
			if (existingUser && existingUser.id !== ctx.session.userId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Email already in use",
				});
			}

			await updateUserEmail(ctx.session.userId, {
				newEmail: normalizedNewEmail,
				srpSalt: input.srpSalt,
				srpVerifier: input.srpVerifier,
				encryptedPrivateKey: input.encryptedPrivateKey,
				encryptedVaultKeys: input.encryptedVaultKeys,
			});

			// Logout all sessions to force re-login with new email
			await deleteAllUserSessions(ctx.session.userId);

			await logAuditEvent({
				userId: ctx.session.userId,
				action: "email_changed",
				device: ctx.device,
				entityType: "user",
				entityId: ctx.session.userId,
				metadata: {
					newEmail: normalizedNewEmail,
					vaultKeysUpdated: input.encryptedVaultKeys.length,
				},
			});

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

			// Invalidate all other sessions — those devices have stale MUKs.
			// The current session stays active so the client can update local state.
			await deleteOtherUserSessions(ctx.session.userId, ctx.session.sessionId);

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
	 * Store or regenerate recovery key metadata for current user
	 */
	storeRecoveryKey: protectedProcedure
		.input(
			z.object({
				encryptedMasterKey: z.string(),
				recoveryKeyHint: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const existingUser = await getUserById(ctx.session.userId);
			if (!existingUser) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "User not found",
				});
			}

			const hadRecoveryKey = existingUser.encryptedMasterKey !== null;

			await storeEncryptedMasterKey(
				ctx.session.userId,
				input.encryptedMasterKey,
				input.recoveryKeyHint,
			);

			await logAuditEvent({
				userId: ctx.session.userId,
				action: hadRecoveryKey
					? "recovery_key_regenerated"
					: "recovery_key_setup",
				device: ctx.device,
				entityType: "user",
				entityId: ctx.session.userId,
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
				await broadcastSessionControlPayload({
					type: "session_revoked",
					userId: ctx.session.userId,
					sessionId: input.sessionId,
					timestamp: Date.now(),
					reason: "device_revoked",
				});

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
