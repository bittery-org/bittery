/** biome-ignore-all lint/style/noNonNullAssertion: Its fine */
import { db } from "@bittery/db";
import { item, vault, vaultKey } from "@bittery/db/schema/vault";
import {
	createPresignedUpload,
	createVaultImageKey,
	getStoragePublicUrl,
} from "@bittery/storage";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { protectedProcedure, router } from "../index";

export const vaultRouter = router({
	/**
	 * Get a single vault by ID
	 */
	get: protectedProcedure
		.input(z.object({ vaultId: z.string() }))
		.query(async ({ ctx, input }) => {
			const userVaultKey = await db.query.vaultKey.findFirst({
				where: (vk, { and, eq }) =>
					and(eq(vk.vaultId, input.vaultId), eq(vk.userId, ctx.session.userId)),
				with: {
					vault: {
						with: {
							items: {
								where: (item, { isNull }) => isNull(item.deletedAt),
							},
						},
					},
				},
			});

			if (!userVaultKey) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Vault not found or access denied",
				});
			}

			// Get member count
			const members = await db.query.vaultKey.findMany({
				where: (vk, { eq }) => eq(vk.vaultId, input.vaultId),
			});

			return {
				id: userVaultKey.vault.id,
				name: userVaultKey.vault.name,
				type: userVaultKey.vault.type,
				icon: userVaultKey.vault.icon,
				imageUrl: userVaultKey.vault.imageKey
					? getStoragePublicUrl(userVaultKey.vault.imageKey)
					: null,
				userRole: userVaultKey.role,
				itemCount: userVaultKey.vault.items.length,
				memberCount: members.length,
				createdAt: userVaultKey.vault.createdAt,
			};
		}),

	/**
	 * List all vaults for the current user
	 */
	list: protectedProcedure.query(async ({ ctx }) => {
		const userVaults = await db.query.vaultKey.findMany({
			where: (vaultKey, { eq }) => eq(vaultKey.userId, ctx.session.userId),
			with: {
				vault: {
					with: {
						items: true,
					},
				},
			},
		});

		return userVaults.map((vk) => ({
			id: vk.vault.id,
			name: vk.vault.name,
			type: vk.vault.type,
			icon: vk.vault.icon,
			imageUrl: vk.vault.imageKey
				? getStoragePublicUrl(vk.vault.imageKey)
				: null,
			role: vk.role,
			items: vk.vault.items,
			encryptedVaultKey: vk.encryptedVaultKey,
		}));
	}),

	/**
	 * Create a presigned upload URL for vault images
	 */
	createImageUpload: protectedProcedure
		.input(
			z.object({
				vaultId: z.string().optional(),
				fileName: z.string().min(1),
				contentType: z.string().min(1),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			if (!input.contentType.startsWith("image/")) {
				throw new Error("Only image uploads are allowed");
			}

			if (input.vaultId) {
				const userVaultKey = await db.query.vaultKey.findFirst({
					where: (vaultKey, { and, eq }) =>
						and(
							eq(vaultKey.vaultId, input.vaultId!),
							eq(vaultKey.userId, ctx.session.userId),
						),
				});

				if (!userVaultKey || !["owner", "admin"].includes(userVaultKey.role)) {
					throw new Error("Access denied");
				}
			}

			const key = createVaultImageKey({
				userId: ctx.session.userId,
				vaultId: input.vaultId,
				fileName: input.fileName,
			});

			return createPresignedUpload({
				key,
				contentType: input.contentType,
			});
		}),

	/**
	 * Create a new vault
	 */
	create: protectedProcedure
		.input(
			z.object({
				name: z.string().min(1),
				type: z.enum(["personal", "team"]),
				encryptedVaultKey: z.string(),
				icon: z.string().min(1).optional(),
				imageKey: z.string().min(1).optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const vaultId = nanoid();

			// Create vault
			await db.insert(vault).values({
				id: vaultId,
				name: input.name,
				type: input.type,
				...(input.icon && { icon: input.icon }),
				...(input.imageKey && { imageKey: input.imageKey }),
				createdById: ctx.session.userId,
			});

			// Store encrypted vault key for the creator
			await db.insert(vaultKey).values({
				id: nanoid(),
				vaultId,
				userId: ctx.session.userId,
				encryptedVaultKey: input.encryptedVaultKey,
				role: "owner",
			});

			return { vaultId };
		}),

	/**
	 * Update vault metadata (name/icon/image)
	 */
	update: protectedProcedure
		.input(
			z.object({
				vaultId: z.string(),
				name: z.string().min(1).optional(),
				icon: z.string().nullable().optional(),
				imageKey: z.string().nullable().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const userVaultKey = await db.query.vaultKey.findFirst({
				where: (vaultKey, { and, eq }) =>
					and(
						eq(vaultKey.vaultId, input.vaultId),
						eq(vaultKey.userId, ctx.session.userId),
					),
			});

			if (!userVaultKey || !["owner", "admin"].includes(userVaultKey.role)) {
				throw new Error("Access denied");
			}

			await db
				.update(vault)
				.set({
					...(input.name !== undefined && { name: input.name }),
					...(input.icon !== undefined && { icon: input.icon }),
					...(input.imageKey !== undefined && { imageKey: input.imageKey }),
					updatedAt: new Date(),
				})
				.where(eq(vault.id, input.vaultId));

			const updatedVault = await db.query.vault.findFirst({
				where: (vault, { eq }) => eq(vault.id, input.vaultId),
			});

			if (!updatedVault) {
				throw new Error("Vault not found");
			}

			return {
				id: updatedVault.id,
				name: updatedVault.name,
				icon: updatedVault.icon,
				imageUrl: updatedVault.imageKey
					? getStoragePublicUrl(updatedVault.imageKey)
					: null,
			};
		}),

	/**
	 * Delete a vault (owner only)
	 */
	delete: protectedProcedure
		.input(z.object({ vaultId: z.string() }))
		.mutation(async ({ input, ctx }) => {
			const userVaultKey = await db.query.vaultKey.findFirst({
				where: (vk, { and, eq }) =>
					and(eq(vk.vaultId, input.vaultId), eq(vk.userId, ctx.session.userId)),
			});

			if (!userVaultKey || userVaultKey.role !== "owner") {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Only the vault owner can delete the vault",
				});
			}

			// Delete all items in the vault
			await db.delete(item).where(eq(item.vaultId, input.vaultId));

			// Delete all vault keys (member access)
			await db.delete(vaultKey).where(eq(vaultKey.vaultId, input.vaultId));

			// Delete the vault itself
			await db.delete(vault).where(eq(vault.id, input.vaultId));

			return { success: true };
		}),

	/**
	 * List items in a vault
	 */
	listItems: protectedProcedure
		.input(
			z.object({
				vaultId: z.string(),
			}),
		)
		.query(async ({ input, ctx }) => {
			// Check user has access to this vault
			const userVaultKey = await db.query.vaultKey.findFirst({
				where: (vaultKey, { and, eq }) =>
					and(
						eq(vaultKey.vaultId, input.vaultId),
						eq(vaultKey.userId, ctx.session.userId),
					),
			});

			if (!userVaultKey) {
				throw new Error("Access denied to this vault");
			}

			// Get items (exclude soft-deleted)
			const items = await db.query.item.findMany({
				where: (item, { and, eq, isNull }) =>
					and(eq(item.vaultId, input.vaultId), isNull(item.deletedAt)),
				orderBy: (item, { desc }) => [desc(item.updatedAt)],
			});

			return items;
		}),

	getItem: protectedProcedure
		.input(
			z.object({
				itemId: z.string(),
			}),
		)
		.query(async ({ input, ctx }) => {
			// Get the item first
			const existingItem = await db.query.item.findFirst({
				where: (item, { eq }) => eq(item.id, input.itemId),
			});

			if (!existingItem) {
				throw new Error("Item not found");
			}

			// Check user has access to this vault
			const userVaultKey = await db.query.vaultKey.findFirst({
				where: (vaultKey, { and, eq }) =>
					and(
						eq(vaultKey.vaultId, existingItem.vaultId),
						eq(vaultKey.userId, ctx.session.userId),
					),
			});

			if (!userVaultKey) {
				throw new Error("Access denied");
			}

			return existingItem;
		}),

	/**
	 * Create a new item
	 */
	createItem: protectedProcedure
		.input(
			z.object({
				vaultId: z.string(),
				category: z.enum(["login", "secure-note", "credit-card", "identity"]),
				encryptedData: z.string(),
				encryptionIv: z.string(),
				encryptionAlgorithm: z.string().default("AES-GCM"),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			// Check user has access to this vault
			const userVaultKey = await db.query.vaultKey.findFirst({
				where: (vaultKey, { and, eq }) =>
					and(
						eq(vaultKey.vaultId, input.vaultId),
						eq(vaultKey.userId, ctx.session.userId),
					),
			});

			if (!userVaultKey) {
				throw new Error("Access denied to this vault");
			}

			// Check user has write permissions (read-only can't create)
			if (userVaultKey.role === "read-only") {
				throw new Error("Read-only access cannot create items");
			}

			const itemId = nanoid();

			await db.insert(item).values({
				id: itemId,
				vaultId: input.vaultId,
				category: input.category,
				encryptedData: input.encryptedData,
				encryptionIv: input.encryptionIv,
				encryptionAlgorithm: input.encryptionAlgorithm,
			});

			return { itemId, id: input.vaultId };
		}),

	/**
	 * Bulk import items into a vault
	 */
	bulkImportItems: protectedProcedure
		.input(
			z.object({
				vaultId: z.string(),
				items: z.array(
					z.object({
						category: z.enum(["login", "secure-note", "credit-card", "identity"]),
						favorite: z.boolean().optional(),
						encryptedData: z.string(),
						encryptionIv: z.string(),
						encryptionAlgorithm: z.string().default("AES-GCM"),
					}),
				),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			// Check user has access to this vault
			const userVaultKey = await db.query.vaultKey.findFirst({
				where: (vaultKey, { and, eq }) =>
					and(
						eq(vaultKey.vaultId, input.vaultId),
						eq(vaultKey.userId, ctx.session.userId),
					),
			});

			if (!userVaultKey) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Access denied to this vault",
				});
			}

			// Check user has write permissions (read-only can't create)
			if (userVaultKey.role === "read-only") {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Read-only access cannot create items",
				});
			}

			// Process items in batches to avoid overwhelming the database
			const batchSize = 50;
			const importedIds: string[] = [];

			for (let i = 0; i < input.items.length; i += batchSize) {
				const batch = input.items.slice(i, i + batchSize);
				const itemsToInsert = batch.map((itemData) => ({
					id: nanoid(),
					vaultId: input.vaultId,
					category: itemData.category,
					favorite: itemData.favorite ?? false,
					encryptedData: itemData.encryptedData,
					encryptionIv: itemData.encryptionIv,
					encryptionAlgorithm: itemData.encryptionAlgorithm,
				}));

				await db.insert(item).values(itemsToInsert);
				importedIds.push(...itemsToInsert.map((i) => i.id));
			}

			return {
				success: true,
				importedCount: importedIds.length,
				itemIds: importedIds,
			};
		}),

	/**
	 * Update an item
	 */
	updateItem: protectedProcedure
		.input(
			z.object({
				itemId: z.string(),
				encryptedData: z.string().optional(),
				encryptionIv: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			// Get the item first
			const existingItem = await db.query.item.findFirst({
				where: (item, { eq }) => eq(item.id, input.itemId),
			});

			if (!existingItem) {
				throw new Error("Item not found");
			}

			// Check user has access to this vault
			const userVaultKey = await db.query.vaultKey.findFirst({
				where: (vaultKey, { and, eq }) =>
					and(
						eq(vaultKey.vaultId, existingItem.vaultId),
						eq(vaultKey.userId, ctx.session.userId),
					),
			});

			if (!userVaultKey || userVaultKey.role === "read-only") {
				throw new Error("Access denied");
			}

			await db
				.update(item)
				.set({
					...(input.encryptedData && { encryptedData: input.encryptedData }),
					...(input.encryptionIv && { encryptionIv: input.encryptionIv }),
					updatedAt: new Date(),
				})
				.where(eq(item.id, input.itemId));

			return { success: true };
		}),

	/**
	 * Toggle favorite status of an item
	 */
	toggleFavorite: protectedProcedure
		.input(
			z.object({
				itemId: z.string(),
				favorite: z.boolean(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			// Get the item first
			const existingItem = await db.query.item.findFirst({
				where: (item, { eq }) => eq(item.id, input.itemId),
			});

			if (!existingItem) {
				throw new Error("Item not found");
			}

			// Check user has access to this vault
			const userVaultKey = await db.query.vaultKey.findFirst({
				where: (vaultKey, { and, eq }) =>
					and(
						eq(vaultKey.vaultId, existingItem.vaultId),
						eq(vaultKey.userId, ctx.session.userId),
					),
			});

			if (!userVaultKey || userVaultKey.role === "read-only") {
				throw new Error("Access denied");
			}

			// Update favorite status
			await db
				.update(item)
				.set({
					favorite: input.favorite,
					updatedAt: new Date(),
				})
				.where(eq(item.id, input.itemId));

			return { success: true };
		}),

	/**
	 * Soft delete an item
	 */
	deleteItem: protectedProcedure
		.input(
			z.object({
				itemId: z.string(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			// Get the item first
			const existingItem = await db.query.item.findFirst({
				where: (item, { eq }) => eq(item.id, input.itemId),
			});

			if (!existingItem) {
				throw new Error("Item not found");
			}

			// Check user has access
			const userVaultKey = await db.query.vaultKey.findFirst({
				where: (vaultKey, { and, eq }) =>
					and(
						eq(vaultKey.vaultId, existingItem.vaultId),
						eq(vaultKey.userId, ctx.session.userId),
					),
			});

			if (!userVaultKey || userVaultKey.role === "read-only") {
				throw new Error("Access denied");
			}

			await db
				.update(item)
				.set({ deletedAt: new Date() })
				.where(eq(item.id, input.itemId));

			return { success: true };
		}),

	/**
	 * List deleted items (trash) in a vault
	 */
	listDeletedItems: protectedProcedure
		.input(
			z.object({
				vaultId: z.string(),
			}),
		)
		.query(async ({ input, ctx }) => {
			// Check user has access to this vault
			const userVaultKey = await db.query.vaultKey.findFirst({
				where: (vaultKey, { and, eq }) =>
					and(
						eq(vaultKey.vaultId, input.vaultId),
						eq(vaultKey.userId, ctx.session.userId),
					),
			});

			if (!userVaultKey) {
				throw new Error("Access denied to this vault");
			}

			// Get deleted items
			const deletedItems = await db.query.item.findMany({
				where: (item, { and, eq, isNotNull }) =>
					and(eq(item.vaultId, input.vaultId), isNotNull(item.deletedAt)),
				orderBy: (item, { desc }) => [desc(item.deletedAt)],
			});

			return deletedItems;
		}),

	/**
	 * Restore a deleted item from trash
	 */
	restoreItem: protectedProcedure
		.input(
			z.object({
				itemId: z.string(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			// Get the item first
			const existingItem = await db.query.item.findFirst({
				where: (item, { eq }) => eq(item.id, input.itemId),
			});

			if (!existingItem) {
				throw new Error("Item not found");
			}

			// Verify item is actually deleted
			if (!existingItem.deletedAt) {
				throw new Error("Item is not deleted");
			}

			// Check user has access to this vault
			const userVaultKey = await db.query.vaultKey.findFirst({
				where: (vaultKey, { and, eq }) =>
					and(
						eq(vaultKey.vaultId, existingItem.vaultId),
						eq(vaultKey.userId, ctx.session.userId),
					),
			});

			if (!userVaultKey || userVaultKey.role === "read-only") {
				throw new Error("Access denied");
			}

			// Restore the item
			await db
				.update(item)
				.set({
					deletedAt: null,
					updatedAt: new Date(),
				})
				.where(eq(item.id, input.itemId));

			return { success: true };
		}),

	/**
	 * Permanently delete an item from trash
	 */
	permanentlyDeleteItem: protectedProcedure
		.input(
			z.object({
				itemId: z.string(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			// Get the item first
			const existingItem = await db.query.item.findFirst({
				where: (item, { eq }) => eq(item.id, input.itemId),
			});

			if (!existingItem) {
				throw new Error("Item not found");
			}

			// Safety check: only allow if item is deleted
			if (!existingItem.deletedAt) {
				throw new Error("Can only permanently delete items in trash");
			}

			// Check user has access to this vault
			const userVaultKey = await db.query.vaultKey.findFirst({
				where: (vaultKey, { and, eq }) =>
					and(
						eq(vaultKey.vaultId, existingItem.vaultId),
						eq(vaultKey.userId, ctx.session.userId),
					),
			});

			if (!userVaultKey || userVaultKey.role === "read-only") {
				throw new Error("Access denied");
			}

			// Permanently delete from database
			await db.delete(item).where(eq(item.id, input.itemId));

			return { success: true };
		}),

	/**
	 * Get dashboard stats for current user
	 */
	stats: protectedProcedure.query(async ({ ctx }) => {
		// Get team count
		const teamMemberships = await db.query.teamMember.findMany({
			where: (tm, { eq }) => eq(tm.userId, ctx.session.userId),
		});

		// Get vault count
		const userVaults = await db.query.vaultKey.findMany({
			where: (vk, { eq }) => eq(vk.userId, ctx.session.userId),
		});

		// Get item count (across all accessible vaults)
		const vaultIds = userVaults.map((vk) => vk.vaultId);
		let itemCount = 0;

		if (vaultIds.length > 0) {
			const items = await db.query.item.findMany({
				where: (item, { and, isNull, inArray }) =>
					and(inArray(item.vaultId, vaultIds), isNull(item.deletedAt)),
			});
			itemCount = items.length;
		}

		return {
			teamCount: teamMemberships.length,
			vaultCount: userVaults.length,
			itemCount,
		};
	}),

	/**
	 * Vault member management
	 */
	members: router({
		/**
		 * List vault members
		 */
		list: protectedProcedure
			.input(z.object({ vaultId: z.string() }))
			.query(async ({ ctx, input }) => {
				// Check user has access to this vault
				const userVaultKey = await db.query.vaultKey.findFirst({
					where: (vk, { and, eq }) =>
						and(
							eq(vk.vaultId, input.vaultId),
							eq(vk.userId, ctx.session.userId),
						),
				});

				if (!userVaultKey) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "Access denied to this vault",
					});
				}

				const members = await db.query.vaultKey.findMany({
					where: (vk, { eq }) => eq(vk.vaultId, input.vaultId),
					with: {
						user: true,
					},
				});

				return members.map((m) => ({
					userId: m.user.id,
					name: m.user.name,
					email: m.user.email,
					role: m.role,
				}));
			}),

		/**
		 * Update vault member role (owner/admin only)
		 */
		updateRole: protectedProcedure
			.input(
				z.object({
					vaultId: z.string(),
					userId: z.string(),
					role: z.enum(["admin", "member", "read-only"]),
				}),
			)
			.mutation(async ({ ctx, input }) => {
				// Check user has admin/owner access
				const userVaultKey = await db.query.vaultKey.findFirst({
					where: (vk, { and, eq }) =>
						and(
							eq(vk.vaultId, input.vaultId),
							eq(vk.userId, ctx.session.userId),
						),
				});

				if (!userVaultKey || !["owner", "admin"].includes(userVaultKey.role)) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "Only vault owner or admin can change roles",
					});
				}

				// Can't change your own role
				if (input.userId === ctx.session.userId) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Cannot change your own role",
					});
				}

				// Get target member
				const targetVaultKey = await db.query.vaultKey.findFirst({
					where: (vk, { and, eq }) =>
						and(eq(vk.vaultId, input.vaultId), eq(vk.userId, input.userId)),
				});

				if (!targetVaultKey) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Member not found",
					});
				}

				// Cannot change owner's role
				if (targetVaultKey.role === "owner") {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "Cannot change vault owner's role",
					});
				}

				// Admin can't change other admins
				if (userVaultKey.role === "admin" && targetVaultKey.role === "admin") {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "Admins cannot change other admins",
					});
				}

				await db
					.update(vaultKey)
					.set({ role: input.role })
					.where(
						and(
							eq(vaultKey.vaultId, input.vaultId),
							eq(vaultKey.userId, input.userId),
						),
					);

				return { success: true };
			}),

		/**
		 * Remove vault member (owner/admin only)
		 */
		remove: protectedProcedure
			.input(z.object({ vaultId: z.string(), userId: z.string() }))
			.mutation(async ({ ctx, input }) => {
				// Check user has admin/owner access
				const userVaultKey = await db.query.vaultKey.findFirst({
					where: (vk, { and, eq }) =>
						and(
							eq(vk.vaultId, input.vaultId),
							eq(vk.userId, ctx.session.userId),
						),
				});

				if (!userVaultKey || !["owner", "admin"].includes(userVaultKey.role)) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "Only vault owner or admin can remove members",
					});
				}

				// Can't remove yourself
				if (input.userId === ctx.session.userId) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Cannot remove yourself",
					});
				}

				// Get target member
				const targetVaultKey = await db.query.vaultKey.findFirst({
					where: (vk, { and, eq }) =>
						and(eq(vk.vaultId, input.vaultId), eq(vk.userId, input.userId)),
				});

				if (!targetVaultKey) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Member not found",
					});
				}

				// Cannot remove owner
				if (targetVaultKey.role === "owner") {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "Cannot remove vault owner",
					});
				}

				// Admin can't remove other admins
				if (userVaultKey.role === "admin" && targetVaultKey.role === "admin") {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "Admins cannot remove other admins",
					});
				}

				await db
					.delete(vaultKey)
					.where(
						and(
							eq(vaultKey.vaultId, input.vaultId),
							eq(vaultKey.userId, input.userId),
						),
					);

				return { success: true };
			}),

		/**
		 * Look up a user by email to get their public key for vault sharing
		 */
		lookupUser: protectedProcedure
			.input(z.object({ email: z.string().email() }))
			.query(async ({ ctx, input }) => {
				// Don't allow looking up yourself
				const currentUser = await db.query.user.findFirst({
					where: (u, { eq }) => eq(u.id, ctx.session.userId),
				});

				if (currentUser?.email.toLowerCase() === input.email.toLowerCase()) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Cannot add yourself as a member",
					});
				}

				const foundUser = await db.query.user.findFirst({
					where: (u, { eq }) => eq(u.email, input.email.toLowerCase()),
				});

				if (!foundUser) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "User not found",
					});
				}

				return {
					id: foundUser.id,
					name: foundUser.name,
					email: foundUser.email,
					publicKey: foundUser.publicKey,
				};
			}),

		/**
		 * Add a new member to a vault (owner/admin only)
		 * The encryptedVaultKey must be encrypted with the new member's RSA public key
		 */
		add: protectedProcedure
			.input(
				z.object({
					vaultId: z.string(),
					userId: z.string(),
					role: z.enum(["admin", "member", "read-only"]),
					encryptedVaultKey: z.string(),
				}),
			)
			.mutation(async ({ ctx, input }) => {
				// Check user has admin/owner access
				const userVaultKey = await db.query.vaultKey.findFirst({
					where: (vk, { and, eq }) =>
						and(
							eq(vk.vaultId, input.vaultId),
							eq(vk.userId, ctx.session.userId),
						),
				});

				if (!userVaultKey || !["owner", "admin"].includes(userVaultKey.role)) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "Only vault owner or admin can add members",
					});
				}

				// Check if target user exists
				const targetUser = await db.query.user.findFirst({
					where: (u, { eq }) => eq(u.id, input.userId),
				});

				if (!targetUser) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "User not found",
					});
				}

				// Check if user is already a member
				const existingMember = await db.query.vaultKey.findFirst({
					where: (vk, { and, eq }) =>
						and(eq(vk.vaultId, input.vaultId), eq(vk.userId, input.userId)),
				});

				if (existingMember) {
					throw new TRPCError({
						code: "CONFLICT",
						message: "User is already a member of this vault",
					});
				}

				// Add the new member
				await db.insert(vaultKey).values({
					id: nanoid(),
					vaultId: input.vaultId,
					userId: input.userId,
					encryptedVaultKey: input.encryptedVaultKey,
					role: input.role,
				});

				return { success: true };
			}),
	}),
});
