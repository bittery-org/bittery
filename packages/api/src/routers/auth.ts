/**
 * Authentication tRPC Router
 * Handles signup, login with SRP, session management
 */

import {
	createUser,
	deleteAllUserSessions,
	deleteSession,
	finishLogin,
	getUserByEmail,
	startLogin,
} from "@bittery/auth";
import { db, vault, vaultKey } from "@bittery/db";
import { TRPCError } from "@trpc/server";
import { nanoid } from "nanoid";
import { z } from "zod";
import { publicProcedure, router } from "../index";

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

			return {
				success: true,
				userId,
			};
		}),

	/**
	 * Start Login: Initiate SRP authentication
	 */
	startLogin: publicProcedure
		.input(
			z.object({
				email: z.string().email(),
			}),
		)
		.mutation(async ({ input }) => {
			try {
				const { userId, challenge, serverSecret } = await startLogin(
					input.email,
				);

				return {
					userId,
					salt: challenge.salt,
					serverPublicKey: challenge.serverPublicKey,
					serverSecret, // Client will send this back
				};
			} catch (_error) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "Invalid credentials",
				});
			}
		}),

	/**
	 * Finish Login: Complete SRP authentication and create session
	 */
	finishLogin: publicProcedure
		.input(
			z.object({
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
