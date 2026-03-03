import { db } from "@bittery/db";
import {
	incrementRateLimitWindow,
	RATE_LIMIT_NAMESPACE,
	startOfLocalDay,
} from "@bittery/auth/rate-limit";
import { user } from "@bittery/db/schema/auth";
import {
	EXPIRATION_OPTIONS,
	type ExpirationOption,
	shareAccessLog,
	shareEmailVerification,
	shareLink,
	shareLinkAllowedEmail,
} from "@bittery/db/schema/sharing";
import { TRPCError } from "@trpc/server";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
	resolveEffectiveEntitlementLimits,
	resolveEffectiveEntitlements,
} from "../billing/entitlements";
import { getBitteryMode } from "../config/mode";
import { protectedProcedure, publicProcedure, router } from "../index";
import { logAuditEvent } from "../utils/audit";

// Email validation regex
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_VERIFICATION_CODES_PER_EMAIL = 5;
const SHARE_LINKS_UNAVAILABLE_MESSAGE =
	"Share links are not available on your current plan. Upgrade to continue.";
const DEFAULT_SHARE_LINK_DAILY_LIMIT = 50;

/**
 * Get the base share URL from the WEB_APP_URL environment variable
 */
function getBaseShareUrl(): string {
	const webAppUrl = process.env.WEB_APP_URL || "https://app.bittery.com";
	return `${webAppUrl.replace(/\/$/, "")}/share/`;
}

// Generate a cryptographically secure token
function generateSecureToken(): string {
	return nanoid(32);
}

// Generate a 6-digit verification code
function generateVerificationCode(): string {
	return Math.floor(100000 + Math.random() * 900000).toString();
}

export const shareRouter = router({
	/**
	 * Create a new share link for an item
	 */
	create: protectedProcedure
		.input(
			z.object({
				itemId: z.string(),
				accessMode: z.enum(["anyone", "email-restricted"]),
				isOneTimeUse: z.boolean().default(false),
				expiresIn: z.enum(["1hour", "1day", "7days", "14days", "30days"]),
				allowedEmails: z.array(z.string().email()).optional(),
				// Encrypted item data snapshot
				encryptedItemData: z.string(),
				encryptionIv: z.string(),
				// Share key encrypted for the link
				encryptedShareKey: z.string(),
				shareKeyIv: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			// Verify user has access to the item's vault
			const itemRecord = await db.query.item.findFirst({
				where: (i, { eq }) => eq(i.id, input.itemId),
			});

			if (!itemRecord) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Item not found",
				});
			}

			// Check user has access to this vault with appropriate permissions
			const userVaultKey = await db.query.vaultKey.findFirst({
				where: (vk, { and, eq }) =>
					and(
						eq(vk.vaultId, itemRecord.vaultId),
						eq(vk.userId, ctx.session.userId),
					),
			});

			if (!userVaultKey) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Access denied to this item",
				});
			}

			// Only owner, admin, or member can share (not read-only)
			if (userVaultKey.role === "read-only") {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Read-only users cannot share items",
				});
			}

				const shareLinksAccess = await assertShareLinksEntitlement(
					ctx.session.userId,
				);

			// Validate allowed emails for email-restricted mode
			if (input.accessMode === "email-restricted") {
				if (!input.allowedEmails || input.allowedEmails.length === 0) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							"At least one email address is required for email-restricted sharing",
					});
				}

				// Validate each email format
				for (const email of input.allowedEmails) {
					if (!EMAIL_REGEX.test(email)) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: `Invalid email format: ${email}`,
						});
					}
				}
			}

			// Atomically enforce daily creation limit.
			await checkAndIncrementRateLimit(ctx.session.userId);

			// Calculate expiration
			const expirationHours =
				EXPIRATION_OPTIONS[input.expiresIn as ExpirationOption];
			const expiresAt = new Date(Date.now() + expirationHours * 60 * 60 * 1000);

				// Generate secure token
				const token = generateSecureToken();
				const shareLinkId = nanoid();

				await db.transaction(async (tx) => {
					if (shareLinksAccess.maxActiveLinks !== null) {
						const lockScope = shareLinksAccess.teamId ?? ctx.session.userId;
						await tx.execute(
							sql`SELECT pg_advisory_xact_lock(hashtext(${`share-links:${lockScope}`}))`,
						);

						const now = new Date();
						const validityFilters = and(
							eq(shareLink.status, "active"),
							gt(shareLink.expiresAt, now),
							or(
								isNull(shareLink.maxAccessCount),
								sql`${shareLink.accessCount} < ${shareLink.maxAccessCount}`,
							),
						);
						const activeCountResult = shareLinksAccess.teamId
							? await tx
									.select({ count: sql<number>`count(*)::int` })
									.from(shareLink)
									.innerJoin(user, eq(shareLink.createdById, user.id))
									.where(
										and(
											eq(user.teamId, shareLinksAccess.teamId),
											validityFilters,
										),
									)
							: await tx
									.select({ count: sql<number>`count(*)::int` })
									.from(shareLink)
									.where(
										and(
											eq(shareLink.createdById, ctx.session.userId),
											validityFilters,
										),
									);

						const activeShareLinks = activeCountResult[0]?.count ?? 0;
						if (activeShareLinks >= shareLinksAccess.maxActiveLinks) {
							throw new TRPCError({
								code: "FORBIDDEN",
								message: `Your plan allows up to ${shareLinksAccess.maxActiveLinks} active share links. Revoke a link or upgrade to continue.`,
							});
						}
					}

					// Create share link
					await tx.insert(shareLink).values({
						id: shareLinkId,
						itemId: input.itemId,
						createdById: ctx.session.userId,
						token,
						accessMode: input.accessMode,
						isOneTimeUse: input.isOneTimeUse,
						encryptedItemData: input.encryptedItemData,
						encryptionIv: input.encryptionIv,
						encryptedShareKey: input.encryptedShareKey,
						shareKeyIv: input.shareKeyIv,
						maxAccessCount: input.isOneTimeUse ? 1 : null,
						expiresAt,
					});

					// Add allowed emails for email-restricted mode
					if (
						input.accessMode === "email-restricted" &&
						input.allowedEmails &&
						input.allowedEmails.length > 0
					) {
						await tx.insert(shareLinkAllowedEmail).values(
							input.allowedEmails.map((email) => ({
								id: nanoid(),
								shareLinkId,
								email: email.toLowerCase(),
							})),
						);
					}
				});

			await logAuditEvent({
				userId: ctx.session.userId,
				action: "share_created",
				device: ctx.device,
				entityType: "share_link",
				entityId: shareLinkId,
				metadata: {
					itemId: input.itemId,
					accessMode: input.accessMode,
					isOneTimeUse: input.isOneTimeUse,
					allowedEmailCount: input.allowedEmails?.length ?? 0,
					expiresAt: expiresAt.toISOString(),
				},
			});

			return {
				id: shareLinkId,
				token,
				expiresAt,
				baseShareUrl: getBaseShareUrl(),
			};
		}),

	/**
	 * List share links for an item
	 */
	listByItem: protectedProcedure
		.input(z.object({ itemId: z.string() }))
		.query(async ({ ctx, input }) => {
			await assertShareLinksEntitlement(ctx.session.userId);

			// Verify user has access to the item's vault
			const itemRecord = await db.query.item.findFirst({
				where: (i, { eq }) => eq(i.id, input.itemId),
			});

			if (!itemRecord) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Item not found",
				});
			}

			const userVaultKey = await db.query.vaultKey.findFirst({
				where: (vk, { and, eq }) =>
					and(
						eq(vk.vaultId, itemRecord.vaultId),
						eq(vk.userId, ctx.session.userId),
					),
			});

			if (!userVaultKey) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Access denied to this item",
				});
			}

			// Get share links for this item
			const links = await db.query.shareLink.findMany({
				where: (sl, { eq }) => eq(sl.itemId, input.itemId),
				with: {
					allowedEmails: true,
				},
				orderBy: (sl, { desc }) => [desc(sl.createdAt)],
			});

			const visibleLinks =
				userVaultKey.role === "owner" || userVaultKey.role === "admin"
					? links
					: links.filter((link) => link.createdById === ctx.session.userId);

			// Update expired links status
			const now = new Date();
			const result = visibleLinks.map((link) => {
				let status = link.status;
				if (status === "active" && link.expiresAt < now) {
					status = "expired";
				}
				if (
					status === "active" &&
					link.maxAccessCount &&
					link.accessCount >= link.maxAccessCount
				) {
					status = "exhausted";
				}

				return {
					id: link.id,
					token: link.token,
					status,
					accessMode: link.accessMode,
					isOneTimeUse: link.isOneTimeUse,
					accessCount: link.accessCount,
					maxAccessCount: link.maxAccessCount,
					allowedEmails: link.allowedEmails.map((e) => ({
						email: e.email,
						verified: e.verified,
					})),
					expiresAt: link.expiresAt,
					createdAt: link.createdAt,
					lastAccessedAt: link.lastAccessedAt,
				};
			});

			return { links: result, baseShareUrl: getBaseShareUrl() };
		}),

	/**
	 * Get share link details (for management)
	 */
	get: protectedProcedure
		.input(z.object({ linkId: z.string() }))
		.query(async ({ ctx, input }) => {
			await assertShareLinksEntitlement(ctx.session.userId);

			const link = await db.query.shareLink.findFirst({
				where: (sl, { eq }) => eq(sl.id, input.linkId),
				with: {
					item: true,
					allowedEmails: true,
				},
			});

			if (!link) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Share link not found",
				});
			}

			// Verify user has access
			const userVaultKey = await db.query.vaultKey.findFirst({
				where: (vk, { and, eq }) =>
					and(
						eq(vk.vaultId, link.item.vaultId),
						eq(vk.userId, ctx.session.userId),
					),
			});

			if (!userVaultKey) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Access denied",
				});
			}

			return {
				id: link.id,
				token: link.token,
				status: link.status,
				accessMode: link.accessMode,
				isOneTimeUse: link.isOneTimeUse,
				accessCount: link.accessCount,
				maxAccessCount: link.maxAccessCount,
				allowedEmails: link.allowedEmails.map((e) => ({
					id: e.id,
					email: e.email,
					verified: e.verified,
					verifiedAt: e.verifiedAt,
				})),
				expiresAt: link.expiresAt,
				createdAt: link.createdAt,
				lastAccessedAt: link.lastAccessedAt,
			};
		}),

	/**
	 * Revoke a share link
	 */
	revoke: protectedProcedure
		.input(z.object({ linkId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const link = await db.query.shareLink.findFirst({
				where: (sl, { eq }) => eq(sl.id, input.linkId),
				with: {
					item: true,
				},
			});

			if (!link) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Share link not found",
				});
			}

			// Verify user has access and appropriate permissions
			const userVaultKey = await db.query.vaultKey.findFirst({
				where: (vk, { and, eq }) =>
					and(
						eq(vk.vaultId, link.item.vaultId),
						eq(vk.userId, ctx.session.userId),
					),
			});

			if (!userVaultKey) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Access denied",
				});
			}

			const linkCreator = await db.query.vaultKey.findFirst({
				where: (vk, { and, eq }) =>
					and(
						eq(vk.vaultId, link.item.vaultId),
						eq(vk.userId, link.createdById),
					),
			});

			// Admins cannot revoke links created by owners.
			if (
				userVaultKey.role === "read-only" ||
				(userVaultKey.role === "member" &&
					link.createdById !== ctx.session.userId) ||
				(userVaultKey.role === "admin" && linkCreator?.role === "owner")
			) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "You do not have permission to revoke this link",
				});
			}

			await db
				.update(shareLink)
				.set({ status: "revoked" })
				.where(eq(shareLink.id, input.linkId));

			await logAuditEvent({
				userId: ctx.session.userId,
				action: "share_revoked",
				device: ctx.device,
				entityType: "share_link",
				entityId: input.linkId,
				metadata: {
					itemId: link.itemId,
					createdById: link.createdById,
				},
			});

			return { success: true };
		}),

	/**
	 * Update share link settings
	 */
	update: protectedProcedure
		.input(
			z.object({
				linkId: z.string(),
				isOneTimeUse: z.boolean().optional(),
				addEmails: z.array(z.string().email()).optional(),
				removeEmailIds: z.array(z.string()).optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await assertShareLinksEntitlement(ctx.session.userId);

			const link = await db.query.shareLink.findFirst({
				where: (sl, { eq }) => eq(sl.id, input.linkId),
				with: {
					item: true,
				},
			});

			if (!link) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Share link not found",
				});
			}

			// Verify user has access
			const userVaultKey = await db.query.vaultKey.findFirst({
				where: (vk, { and, eq }) =>
					and(
						eq(vk.vaultId, link.item.vaultId),
						eq(vk.userId, ctx.session.userId),
					),
			});

			if (
				!userVaultKey ||
				userVaultKey.role === "read-only" ||
				(userVaultKey.role === "member" &&
					link.createdById !== ctx.session.userId)
			) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Access denied",
				});
			}

			// Update link settings
			if (input.isOneTimeUse !== undefined) {
				await db
					.update(shareLink)
					.set({
						isOneTimeUse: input.isOneTimeUse,
						maxAccessCount: input.isOneTimeUse ? 1 : null,
					})
					.where(eq(shareLink.id, input.linkId));
			}

			// Add new emails
			if (input.addEmails && input.addEmails.length > 0) {
				// Validate emails
				for (const email of input.addEmails) {
					if (!EMAIL_REGEX.test(email)) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: `Invalid email format: ${email}`,
						});
					}
				}

				await db.insert(shareLinkAllowedEmail).values(
					input.addEmails.map((email) => ({
						id: nanoid(),
						shareLinkId: input.linkId,
						email: email.toLowerCase(),
					})),
				);
			}

				// Remove emails
				if (input.removeEmailIds && input.removeEmailIds.length > 0) {
					const uniqueRemoveEmailIds = [...new Set(input.removeEmailIds)];
					if (uniqueRemoveEmailIds.length !== input.removeEmailIds.length) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "Duplicate removeEmailIds are not allowed",
						});
					}

					const removedEmails = await db
						.delete(shareLinkAllowedEmail)
						.where(
							and(
								eq(shareLinkAllowedEmail.shareLinkId, input.linkId),
								inArray(shareLinkAllowedEmail.id, uniqueRemoveEmailIds),
							),
						)
						.returning({
							id: shareLinkAllowedEmail.id,
							email: shareLinkAllowedEmail.email,
						});

					if (removedEmails.length !== uniqueRemoveEmailIds.length) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "One or more removeEmailIds are invalid for this share link",
						});
					}

					const revokedEmails = [
						...new Set(removedEmails.map((removed) => removed.email.toLowerCase())),
					];
					if (revokedEmails.length > 0) {
						await db
							.update(shareEmailVerification)
							.set({ usedAt: new Date() })
							.where(
								and(
									eq(shareEmailVerification.shareLinkId, input.linkId),
									inArray(shareEmailVerification.email, revokedEmails),
									isNull(shareEmailVerification.usedAt),
								),
							);
					}
				}

			return { success: true };
		}),

	/**
	 * Get access logs for a share link
	 */
	getAccessLogs: protectedProcedure
		.input(z.object({ linkId: z.string() }))
		.query(async ({ ctx, input }) => {
			await assertShareLinksEntitlement(ctx.session.userId);

			const link = await db.query.shareLink.findFirst({
				where: (sl, { eq }) => eq(sl.id, input.linkId),
				with: {
					item: true,
				},
			});

			if (!link) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Share link not found",
				});
			}

			// Verify user has access
			const userVaultKey = await db.query.vaultKey.findFirst({
				where: (vk, { and, eq }) =>
					and(
						eq(vk.vaultId, link.item.vaultId),
						eq(vk.userId, ctx.session.userId),
					),
			});

			if (!userVaultKey) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Access denied",
				});
			}

			const logs = await db.query.shareAccessLog.findMany({
				where: (log, { eq }) => eq(log.shareLinkId, input.linkId),
				orderBy: (log, { desc }) => [desc(log.accessedAt)],
				limit: 100,
			});

			return logs.map((log) => ({
				id: log.id,
				accessedByEmail: log.accessedByEmail,
				ipAddress: log.ipAddress,
				userAgent: log.userAgent,
				success: log.success,
				failureReason: log.failureReason,
				accessedAt: log.accessedAt,
			}));
		}),

	// ===== PUBLIC ENDPOINTS FOR ACCESSING SHARED LINKS =====

	/**
	 * Get share link info (public endpoint)
	 */
	getPublicInfo: publicProcedure
		.input(z.object({ token: z.string() }))
		.query(async ({ input }) => {
			const link = await db.query.shareLink.findFirst({
				where: (sl, { eq }) => eq(sl.token, input.token),
			});

			if (!link) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Share link not found or invalid",
				});
			}

			if (!(await hasShareLinksEntitlement(link.createdById))) {
				return {
					valid: false,
					reason: "disabled",
					accessMode: link.accessMode,
				};
			}

			// Check if link is still valid
			const now = new Date();
			if (link.status === "revoked") {
				return {
					valid: false,
					reason: "revoked",
					accessMode: link.accessMode,
				};
			}

			if (link.expiresAt < now) {
				return {
					valid: false,
					reason: "expired",
					accessMode: link.accessMode,
				};
			}

			if (link.maxAccessCount && link.accessCount >= link.maxAccessCount) {
				return {
					valid: false,
					reason: "exhausted",
					accessMode: link.accessMode,
				};
			}

			return {
				valid: true,
				accessMode: link.accessMode,
				isOneTimeUse: link.isOneTimeUse,
				expiresAt: link.expiresAt,
			};
		}),

	/**
	 * Request email verification for restricted share link
	 */
	requestEmailVerification: publicProcedure
		.input(
			z.object({
				token: z.string(),
				email: z.string().email(),
			}),
		)
		.mutation(async ({ input }) => {
			const link = await db.query.shareLink.findFirst({
				where: (sl, { and, eq }) =>
					and(eq(sl.token, input.token), eq(sl.accessMode, "email-restricted")),
				with: {
					allowedEmails: true,
				},
			});

			if (!link) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Share link not found",
				});
			}

			if (!(await hasShareLinksEntitlement(link.createdById))) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "This share link is no longer valid",
				});
			}

			// Check if link is valid
			const now = new Date();
			if (
				link.status !== "active" ||
				link.expiresAt < now ||
				(link.maxAccessCount && link.accessCount >= link.maxAccessCount)
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "This share link is no longer valid",
				});
			}

			// Check if email is in allowed list
			const normalizedEmail = input.email.toLowerCase();
			const isAllowed = link.allowedEmails.some(
				(e) => e.email.toLowerCase() === normalizedEmail,
			);

			if (!isAllowed) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "This email is not authorized to access this link",
				});
			}

			const totalCodesResult = await db
				.select({ count: sql<number>`count(*)::int` })
				.from(shareEmailVerification)
				.where(
					and(
						eq(shareEmailVerification.shareLinkId, link.id),
						eq(shareEmailVerification.email, normalizedEmail),
					),
				);

			if (
				(totalCodesResult[0]?.count ?? 0) >= MAX_VERIFICATION_CODES_PER_EMAIL
			) {
				throw new TRPCError({
					code: "TOO_MANY_REQUESTS",
					message:
						"Too many verification attempts for this email. Contact the link creator.",
				});
			}

			// Check for existing unexpired verification
			const existingVerification =
				await db.query.shareEmailVerification.findFirst({
					where: (v, { and, eq, gt, isNull }) =>
						and(
							eq(v.shareLinkId, link.id),
							eq(v.email, normalizedEmail),
							gt(v.expiresAt, now),
							isNull(v.usedAt),
						),
				});

			if (existingVerification) {
				// Rate limit: don't send another code if one was sent recently
				const timeSinceCreation =
					now.getTime() - existingVerification.createdAt.getTime();
				if (timeSinceCreation < 60000) {
					// 1 minute cooldown
					throw new TRPCError({
						code: "TOO_MANY_REQUESTS",
						message: "Please wait before requesting another code",
					});
				}
			}

			// Generate verification code
			const code = generateVerificationCode();
			const expiresAt = new Date(now.getTime() + 15 * 60 * 1000); // 15 minutes

			await db.insert(shareEmailVerification).values({
				id: nanoid(),
				shareLinkId: link.id,
				email: normalizedEmail,
				code,
				expiresAt,
			});

			// TODO: Send via email service.
			// await emailService.sendVerificationCode(normalizedEmail, code);

			return {
				success: true,
				message: "Verification code sent to your email",
			};
		}),

	/**
	 * Verify email and get shared item data
	 */
	verifyEmailAndAccess: publicProcedure
		.input(
			z.object({
				token: z.string(),
				email: z.string().email(),
				code: z.string().length(6),
				ipAddress: z.string().optional(),
				userAgent: z.string().optional(),
			}),
		)
		.mutation(async ({ input }) => {
			const link = await db.query.shareLink.findFirst({
				where: (sl, { eq }) => eq(sl.token, input.token),
				with: {
					allowedEmails: true,
				},
			});

			if (!link) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Share link not found",
				});
			}

			if (!(await hasShareLinksEntitlement(link.createdById))) {
				await logAccess(link.id, {
					email: input.email,
					ipAddress: input.ipAddress,
					userAgent: input.userAgent,
					success: false,
					failureReason: "Share links disabled for creator plan",
				});

				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "This share link is no longer valid",
				});
			}

			// Check if link is valid
			const now = new Date();
			if (
				link.status !== "active" ||
				link.expiresAt < now ||
				(link.maxAccessCount && link.accessCount >= link.maxAccessCount)
			) {
				await logAccess(link.id, {
					email: input.email,
					ipAddress: input.ipAddress,
					userAgent: input.userAgent,
					success: false,
					failureReason: "Link no longer valid",
				});

				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "This share link is no longer valid",
				});
			}

				const normalizedEmail = input.email.toLowerCase();

				const isStillAllowed = link.allowedEmails.some(
					(emailEntry) => emailEntry.email.toLowerCase() === normalizedEmail,
				);
				if (!isStillAllowed) {
					await logAccess(link.id, {
						email: input.email,
						ipAddress: input.ipAddress,
						userAgent: input.userAgent,
						success: false,
						failureReason: "Email no longer authorized for this link",
					});

					throw new TRPCError({
						code: "FORBIDDEN",
						message: "This email is not authorized to access this link",
					});
				}

				// Find verification record
				const verification = await db.query.shareEmailVerification.findFirst({
				where: (v, { and, eq, gt, isNull }) =>
					and(
						eq(v.shareLinkId, link.id),
						eq(v.email, normalizedEmail),
						eq(v.code, input.code),
						gt(v.expiresAt, now),
						isNull(v.usedAt),
					),
			});

			if (!verification) {
				// Check for brute force (increment attempts)
				const anyVerification = await db.query.shareEmailVerification.findFirst(
					{
						where: (v, { and, eq, gt, isNull }) =>
							and(
								eq(v.shareLinkId, link.id),
								eq(v.email, normalizedEmail),
								gt(v.expiresAt, now),
								isNull(v.usedAt),
							),
					},
				);

				if (anyVerification) {
					await db
						.update(shareEmailVerification)
						.set({ attempts: anyVerification.attempts + 1 })
						.where(eq(shareEmailVerification.id, anyVerification.id));

					if (anyVerification.attempts + 1 >= anyVerification.maxAttempts) {
						// Mark as used (exhausted)
						await db
							.update(shareEmailVerification)
							.set({ usedAt: now })
							.where(eq(shareEmailVerification.id, anyVerification.id));
					}
				}

				await logAccess(link.id, {
					email: input.email,
					ipAddress: input.ipAddress,
					userAgent: input.userAgent,
					success: false,
					failureReason: "Invalid or expired verification code",
				});

				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid or expired verification code",
				});
			}

			// Check max attempts
			if (verification.attempts >= verification.maxAttempts) {
				await logAccess(link.id, {
					email: input.email,
					ipAddress: input.ipAddress,
					userAgent: input.userAgent,
					success: false,
					failureReason: "Max verification attempts exceeded",
				});

				throw new TRPCError({
					code: "TOO_MANY_REQUESTS",
					message:
						"Maximum verification attempts exceeded. Please request a new code.",
				});
			}

			const accessUpdate = await db
				.update(shareLink)
				.set({
					accessCount: sql`${shareLink.accessCount} + 1`,
					lastAccessedAt: now,
					status: sql`CASE
						WHEN ${shareLink.maxAccessCount} IS NOT NULL
							AND ${shareLink.accessCount} + 1 >= ${shareLink.maxAccessCount}
						THEN 'exhausted'::share_link_status
						ELSE ${shareLink.status}
					END`,
				})
				.where(
					and(
						eq(shareLink.id, link.id),
						eq(shareLink.status, "active"),
						gt(shareLink.expiresAt, now),
						or(
							isNull(shareLink.maxAccessCount),
							sql`${shareLink.accessCount} < ${shareLink.maxAccessCount}`,
						),
					),
				)
				.returning({ id: shareLink.id });

			if (accessUpdate.length === 0) {
				await logAccess(link.id, {
					email: input.email,
					ipAddress: input.ipAddress,
					userAgent: input.userAgent,
					success: false,
					failureReason: "Access limit reached",
				});

				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "This share link has reached its access limit",
				});
			}

			// Mark verification as used
			await db
				.update(shareEmailVerification)
				.set({ usedAt: now })
				.where(eq(shareEmailVerification.id, verification.id));

			// Mark email as verified in allowed emails
			const allowedEmail = link.allowedEmails.find(
				(e) => e.email.toLowerCase() === normalizedEmail,
			);
			if (allowedEmail) {
				await db
					.update(shareLinkAllowedEmail)
					.set({ verified: true, verifiedAt: now })
					.where(eq(shareLinkAllowedEmail.id, allowedEmail.id));
			}

			// Log successful access
			await logAccess(link.id, {
				email: input.email,
				ipAddress: input.ipAddress,
				userAgent: input.userAgent,
				success: true,
			});

			// Return encrypted data
			return {
				encryptedItemData: link.encryptedItemData,
				encryptionIv: link.encryptionIv,
				encryptedShareKey: link.encryptedShareKey,
				shareKeyIv: link.shareKeyIv,
			};
		}),

	/**
	 * Access shared item (for "anyone" mode)
	 */
	accessPublic: publicProcedure
		.input(
			z.object({
				token: z.string(),
				ipAddress: z.string().optional(),
				userAgent: z.string().optional(),
			}),
		)
		.mutation(async ({ input }) => {
			const link = await db.query.shareLink.findFirst({
				where: (sl, { and, eq }) =>
					and(eq(sl.token, input.token), eq(sl.accessMode, "anyone")),
			});

			if (!link) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Share link not found",
				});
			}

			if (!(await hasShareLinksEntitlement(link.createdById))) {
				await logAccess(link.id, {
					ipAddress: input.ipAddress,
					userAgent: input.userAgent,
					success: false,
					failureReason: "Share links disabled for creator plan",
				});

				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "This share link is no longer valid",
				});
			}

			// Check if link is valid
			const now = new Date();
			if (link.status !== "active") {
				await logAccess(link.id, {
					ipAddress: input.ipAddress,
					userAgent: input.userAgent,
					success: false,
					failureReason: `Link status: ${link.status}`,
				});

				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `This share link has been ${link.status}`,
				});
			}

			if (link.expiresAt < now) {
				await logAccess(link.id, {
					ipAddress: input.ipAddress,
					userAgent: input.userAgent,
					success: false,
					failureReason: "Link expired",
				});

				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "This share link has expired",
				});
			}

			if (link.maxAccessCount && link.accessCount >= link.maxAccessCount) {
				await logAccess(link.id, {
					ipAddress: input.ipAddress,
					userAgent: input.userAgent,
					success: false,
					failureReason: "Access limit reached",
				});

				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "This share link has reached its access limit",
				});
			}

			const accessUpdate = await db
				.update(shareLink)
				.set({
					accessCount: sql`${shareLink.accessCount} + 1`,
					lastAccessedAt: now,
					status: sql`CASE
						WHEN ${shareLink.maxAccessCount} IS NOT NULL
							AND ${shareLink.accessCount} + 1 >= ${shareLink.maxAccessCount}
						THEN 'exhausted'::share_link_status
						ELSE ${shareLink.status}
					END`,
				})
				.where(
					and(
						eq(shareLink.id, link.id),
						eq(shareLink.status, "active"),
						gt(shareLink.expiresAt, now),
						or(
							isNull(shareLink.maxAccessCount),
							sql`${shareLink.accessCount} < ${shareLink.maxAccessCount}`,
						),
					),
				)
				.returning({ id: shareLink.id });

			if (accessUpdate.length === 0) {
				await logAccess(link.id, {
					ipAddress: input.ipAddress,
					userAgent: input.userAgent,
					success: false,
					failureReason: "Access limit reached",
				});

				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "This share link has reached its access limit",
				});
			}

			// Log successful access
			await logAccess(link.id, {
				ipAddress: input.ipAddress,
				userAgent: input.userAgent,
				success: true,
			});

			// Return encrypted data
			return {
				encryptedItemData: link.encryptedItemData,
				encryptionIv: link.encryptionIv,
				encryptedShareKey: link.encryptedShareKey,
				shareKeyIv: link.shareKeyIv,
			};
		}),
});

// Helper functions

interface ShareLinksAccess {
	enabled: boolean;
	maxActiveLinks: number | null;
	teamId: string | null;
}

async function resolveShareLinksAccess(userId: string): Promise<ShareLinksAccess> {
	const mode = getBitteryMode();
	const actor = await db.query.user.findFirst({
		where: (u, { eq: eqFn }) => eqFn(u.id, userId),
		with: {
			team: true,
		},
	});

	// In cloud mode, fail closed for orphaned users with no team linkage.
	if (!actor?.team) {
		return {
			enabled: mode === "self-hosted",
			maxActiveLinks: mode === "self-hosted" ? null : 0,
			teamId: null,
		};
	}

	const entitlementInput = {
		mode,
		billingPlan: actor.team.billingPlan,
		billingStatus: actor.team.billingStatus,
	} as const;
	const entitlements = resolveEffectiveEntitlements(entitlementInput);
	const limits = resolveEffectiveEntitlementLimits(
		entitlementInput,
		entitlements,
	);

	return {
		enabled: entitlements.share_links,
		maxActiveLinks: limits.share_links,
		teamId: actor.team.id,
	};
}

async function assertShareLinksEntitlement(
	userId: string,
): Promise<ShareLinksAccess> {
	const access = await resolveShareLinksAccess(userId);
	if (!access.enabled) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: SHARE_LINKS_UNAVAILABLE_MESSAGE,
		});
	}
	return access;
}

async function hasShareLinksEntitlement(userId: string): Promise<boolean> {
	const access = await resolveShareLinksAccess(userId);
	return access.enabled;
}

function getShareLinkDailyLimit(): number {
	const raw = process.env.SHARE_LINK_DAILY_LIMIT;
	if (!raw) {
		return DEFAULT_SHARE_LINK_DAILY_LIMIT;
	}

	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0
		? parsed
		: DEFAULT_SHARE_LINK_DAILY_LIMIT;
}

async function checkAndIncrementRateLimit(userId: string): Promise<void> {
	const now = new Date();
	const result = await incrementRateLimitWindow({
		namespace: RATE_LIMIT_NAMESPACE.shareCreateDaily,
		key: userId,
		subject: userId,
		now,
		windowStart: startOfLocalDay(now),
		limit: getShareLinkDailyLimit(),
	});
	if (!result.allowed) {
		throw new TRPCError({
			code: "TOO_MANY_REQUESTS",
			message: "Daily share link limit reached",
		});
	}
}

async function logAccess(
	shareLinkId: string,
	details: {
		email?: string;
		ipAddress?: string;
		userAgent?: string;
		success: boolean;
		failureReason?: string;
	},
): Promise<void> {
	await db.insert(shareAccessLog).values({
		id: nanoid(),
		shareLinkId,
		accessedByEmail: details.email,
		ipAddress: details.ipAddress,
		userAgent: details.userAgent,
		success: details.success,
		failureReason: details.failureReason,
	});
}
