import { db } from "@bittery/db";
import { item, vault, vaultKey } from "@bittery/db/schema/vault";
import { eq, isNotNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { protectedProcedure, router } from "../index";

export const vaultRouter = router({
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
			role: vk.role,
			items: vk.vault.items,
			encryptedVaultKey: vk.encryptedVaultKey,
		}));
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
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const vaultId = nanoid();

			// Create vault
			await db.insert(vault).values({
				id: vaultId,
				name: input.name,
				type: input.type,
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
				category: z.enum(["login", "secure-note"]),
				overview: z.object({
					title: z.string(),
					url: z.string().optional(),
					username: z.string().optional(),
				}),
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
				overview: input.overview,
				encryptedData: input.encryptedData,
				encryptionIv: input.encryptionIv,
				encryptionAlgorithm: input.encryptionAlgorithm,
			});

			return { itemId, id: input.vaultId };
		}),

	/**
	 * Update an item
	 */
	updateItem: protectedProcedure
		.input(
			z.object({
				itemId: z.string(),
				overview: z
					.object({
						title: z.string(),
						url: z.string().optional(),
						username: z.string().optional(),
					})
					.optional(),
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
					...(input.overview && { overview: input.overview }),
					...(input.encryptedData && { encryptedData: input.encryptedData }),
					...(input.encryptionIv && { encryptionIv: input.encryptionIv }),
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
	 * Search across all vaults and items the user has access to
	 */
	search: protectedProcedure
		.input(
			z.object({
				query: z.string(),
			}),
		)
		.query(async ({ input, ctx }) => {
			if (!input.query || input.query.trim() === "") {
				return { vaults: [], items: [] };
			}

			const searchLower = input.query.toLowerCase();

			// Get all vaults user has access to
			const userVaults = await db.query.vaultKey.findMany({
				where: (vaultKey, { eq }) => eq(vaultKey.userId, ctx.session.userId),
				with: {
					vault: true,
				},
			});

			// Filter vaults by name
			const matchingVaults = userVaults
				.filter((vk) => vk.vault.name.toLowerCase().includes(searchLower))
				.map((vk) => ({
					id: vk.vault.id,
					name: vk.vault.name,
					type: vk.vault.type,
				}));

			// Get all items from accessible vaults
			const vaultIds = userVaults.map((vk) => vk.vault.id);

			const allItems = await db.query.item.findMany({
				where: (item, { and, isNull, inArray }) =>
					and(inArray(item.vaultId, vaultIds), isNull(item.deletedAt)),
			});

			// Filter items by title, username, or URL
			const matchingItems = allItems
				.filter((item) => {
					const overview = item.overview as {
						title?: string;
						url?: string;
						username?: string;
					};
					const titleMatch = overview.title
						?.toLowerCase()
						.includes(searchLower);
					const urlMatch = overview.url?.toLowerCase().includes(searchLower);
					const usernameMatch = overview.username
						?.toLowerCase()
						.includes(searchLower);
					return titleMatch || urlMatch || usernameMatch;
				})
				.map((item) => {
					const vault = userVaults.find((vk) => vk.vault.id === item.vaultId);
					return {
						id: item.id,
						vaultId: item.vaultId,
						vaultName: vault?.vault.name || "",
						category: item.category,
						overview: item.overview as {
							title: string;
							url?: string;
							username?: string;
						},
					};
				});

			return {
				vaults: matchingVaults,
				items: matchingItems.slice(0, 10), // Limit to 10 items
			};
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
});
