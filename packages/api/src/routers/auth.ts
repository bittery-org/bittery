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
	finishLogin,
	getUserByEmail,
	getUserById,
	startLogin,
} from "@bittery/auth";
import { db, vault, vaultKey } from "@bittery/db";
import { TRPCError } from "@trpc/server";
import { nanoid } from "nanoid";
import { z } from "zod";
import { protectedProcedure, publicProcedure, router } from "../index";

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
		.mutation(async ({ input }) => {
			// Check if user already exists
			const existingUser = await getUserByEmail(input.email);
			if (existingUser) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "User with this email already exists",
				});
			}

			// Create user
			const userId = await createUser({
				email: input.email,
				name: input.name,
				secretKeyHint: input.secretKeyHint,
				srpSalt: input.srpSalt,
				srpVerifier: input.srpVerifier,
				publicKey: input.publicKey,
				encryptedPrivateKey: input.encryptedPrivateKey,
			});

			// Create default "Personal" vault
			const vaultId = nanoid();
			await db.insert(vault).values({
				id: vaultId,
				name: "Personal",
				type: "personal",
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

			// Create session and generate token
			const sessionData = await createUserSession(userId);

			// Get vault keys
			const vaultKeys = await db.query.vaultKey.findMany({
				where: (vaultKey, { eq }) => eq(vaultKey.userId, userId),
				with: {
					vault: true,
				},
			});

			return {
				success: true,
				userId,
				token: sessionData.token,
				sessionId: sessionData.sessionId,
				user: sessionData.user,
				vaultKeys: vaultKeys.map((vk) => ({
					vaultId: vk.vaultId,
					vaultName: vk.vault.name,
					vaultType: vk.vault.type,
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
		.mutation(async ({ input }) => {
			const result = await finishLogin(
				input.userId,
				input.serverSecret,
				input.clientPublicKey,
				input.clientProof,
			);

			if (!result.success || !result.user) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "Invalid credentials",
				});
			}

			// Get user's vault keys
			const vaultKeys = await db.query.vaultKey.findMany({
				where: (vaultKey, { eq }) => eq(vaultKey.userId, result.user?.id),
				with: {
					vault: true,
				},
			});

			return {
				token: result.token!,
				sessionId: result.sessionId!,
				serverProof: result.serverProof!, // For client to verify server
				user: result.user,
				vaultKeys: vaultKeys.map((vk) => ({
					vaultId: vk.vaultId,
					vaultName: vk.vault.name,
					vaultType: vk.vault.type,
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
		.mutation(async ({ input }) => {
			const result = await finishLogin(
				input.userId,
				input.serverSecret,
				input.clientPublicKey,
				input.clientProof,
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
				where: (vaultKey, { eq }) => eq(vaultKey.userId, result.user?.id),
				with: {
					vault: true,
				},
			});

			return {
				token: result.token!,
				sessionId: result.sessionId!,
				user: result.user,
				vaultKeys: vaultKeys.map((vk) => ({
					vaultId: vk.vaultId,
					vaultName: vk.vault.name,
					vaultType: vk.vault.type,
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
});
