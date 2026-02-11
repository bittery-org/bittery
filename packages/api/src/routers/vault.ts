/** biome-ignore-all lint/style/noNonNullAssertion: Its fine */
import { db } from "@bittery/db";
import {
	item,
	vault,
	vaultKey,
	vaultKeyRotation,
} from "@bittery/db/schema/vault";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { protectedProcedure, router } from "../index";
import {
	createPresignedUpload,
	createVaultImageKey,
	deleteObject,
	getStoragePublicUrl,
} from "../storage/s3";
import {
	broadcastSyncPayload,
	broadcastSyncPayloads,
	createSyncEvent,
	type SyncBroadcastPayload,
} from "../sync-helper";
import { logAuditEvent } from "../utils/audit";

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
			createdById: vk.vault.createdById,
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
				clientId: z.string().optional(), // For sync event correlation
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const vaultId = nanoid();
			let teamId: string | null = null;

			if (input.type === "team") {
				const currentUser = await db.query.user.findFirst({
					where: (member, { eq }) => eq(member.id, ctx.session.userId),
					columns: { teamId: true },
				});

				if (!currentUser?.teamId) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "You must belong to a team to create a team vault",
					});
				}

				teamId = currentUser.teamId;
			}

			let broadcast: SyncBroadcastPayload;
			await db.transaction(async (tx) => {
				// Create vault
				await tx.insert(vault).values({
					id: vaultId,
					name: input.name,
					type: input.type,
					...(input.icon && { icon: input.icon }),
					...(input.imageKey && { imageKey: input.imageKey }),
					createdById: ctx.session.userId,
					...(teamId && { teamId }),
				});

				// Store encrypted vault key for the creator
				await tx.insert(vaultKey).values({
					id: nanoid(),
					vaultId,
					userId: ctx.session.userId,
					encryptedVaultKey: input.encryptedVaultKey,
					role: "owner",
				});

				// Create sync event inside transaction
				broadcast = await createSyncEvent(
					{
						eventType: "vault_created",
						entityId: vaultId,
						entityType: "vault",
						vaultId,
						userId: ctx.session.userId,
						clientId: input.clientId,
						version: 1,
					},
					tx,
					ctx.clientId,
				);
			});

			// Broadcast AFTER transaction commits
			await broadcastSyncPayload(broadcast!);

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
				clientId: z.string().optional(), // For sync event correlation
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const userVaultKey = await db.query.vaultKey.findFirst({
				where: (vaultKey, { and, eq }) =>
					and(
						eq(vaultKey.vaultId, input.vaultId),
						eq(vaultKey.userId, ctx.session.userId),
					),
				with: {
					vault: true,
				},
			});

			if (!userVaultKey || !["owner", "admin"].includes(userVaultKey.role)) {
				throw new Error("Access denied");
			}

			// Get the old image key before updating (for cleanup)
			const oldImageKey = userVaultKey.vault.imageKey;

			// Delete old image from S3 if we're replacing or removing it
			if (
				input.imageKey !== undefined &&
				oldImageKey &&
				oldImageKey !== input.imageKey
			) {
				try {
					await deleteObject(oldImageKey);
				} catch (error) {
					// Log but don't fail the update if deletion fails
					console.error("Failed to delete old vault image from S3:", error);
				}
			}

			let broadcast: SyncBroadcastPayload;
			const updatedVault = await db.transaction(async (tx) => {
				await tx
					.update(vault)
					.set({
						...(input.name !== undefined && { name: input.name }),
						...(input.icon !== undefined && { icon: input.icon }),
						...(input.imageKey !== undefined && { imageKey: input.imageKey }),
						updatedAt: new Date(),
					})
					.where(eq(vault.id, input.vaultId));

				const result = await tx.query.vault.findFirst({
					where: (vault, { eq }) => eq(vault.id, input.vaultId),
				});

				if (!result) {
					throw new Error("Vault not found");
				}

				broadcast = await createSyncEvent(
					{
						eventType: "vault_updated",
						entityId: input.vaultId,
						entityType: "vault",
						vaultId: input.vaultId,
						userId: ctx.session.userId,
						clientId: input.clientId,
						version: 1,
					},
					tx,
					ctx.clientId,
				);

				return result;
			});

			await broadcastSyncPayload(broadcast!);

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
		.input(z.object({ vaultId: z.string(), clientId: z.string().optional() }))
		.mutation(async ({ input, ctx }) => {
			const userVaultKey = await db.query.vaultKey.findFirst({
				where: (vk, { and, eq }) =>
					and(eq(vk.vaultId, input.vaultId), eq(vk.userId, ctx.session.userId)),
				with: {
					vault: true,
				},
			});

			if (!userVaultKey || userVaultKey.role !== "owner") {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Only the vault owner can delete the vault",
				});
			}

			// Get image key before deleting (for S3 cleanup)
			const imageKey = userVaultKey.vault.imageKey;
			const currentMembers = await db.query.vaultKey.findMany({
				where: (vk, { eq }) => eq(vk.vaultId, input.vaultId),
			});
			const broadcasts: SyncBroadcastPayload[] = [];

			// Wrap deletes and event creation in the same transaction for atomicity
			await db.transaction(async (tx) => {
				broadcasts.push(
					await createSyncEvent(
						{
							eventType: "vault_deleted",
							entityId: input.vaultId,
							entityType: "vault",
							vaultId: input.vaultId,
							userId: ctx.session.userId,
							clientId: input.clientId,
							version: 1,
						},
						tx,
						ctx.clientId,
					),
				);

				for (const member of currentMembers) {
					if (member.userId === ctx.session.userId) {
						continue;
					}

					broadcasts.push(
						await createSyncEvent(
							{
								eventType: "vault_access_revoked",
								entityId: input.vaultId,
								entityType: "vault",
								vaultId: input.vaultId,
								userId: member.userId,
								clientId: input.clientId,
								version: 1,
								metadata: {
									reason: "vault_deleted",
									vaultId: input.vaultId,
								},
							},
							tx,
							ctx.clientId,
						),
					);
				}

				// Delete all items in the vault
				await tx.delete(item).where(eq(item.vaultId, input.vaultId));

				// Delete all vault keys (member access)
				await tx.delete(vaultKey).where(eq(vaultKey.vaultId, input.vaultId));

				// Delete the vault itself
				await tx.delete(vault).where(eq(vault.id, input.vaultId));
			});

			await broadcastSyncPayloads(broadcasts);

			// Delete vault image from S3 if it exists
			if (imageKey) {
				try {
					await deleteObject(imageKey);
				} catch (error) {
					// Log but don't fail the delete if S3 cleanup fails
					console.error("Failed to delete vault image from S3:", error);
				}
			}

			await logAuditEvent({
				userId: ctx.session.userId,
				action: "vault_deleted",
				device: ctx.device,
				entityType: "vault",
				entityId: input.vaultId,
				metadata: {
					vaultName: userVaultKey.vault.name,
					vaultType: userVaultKey.vault.type,
				},
			});

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

	/**
	 * List all items from all accessible vaults
	 * Returns items with vault metadata and encrypted vault keys
	 */
	listAllItems: protectedProcedure.query(async ({ ctx }) => {
		// Get all vaults the user has access to
		const userVaults = await db.query.vaultKey.findMany({
			where: (vaultKey, { eq }) => eq(vaultKey.userId, ctx.session.userId),
			with: {
				vault: true,
			},
		});

		if (userVaults.length === 0) {
			return [];
		}

		// Get all vault IDs
		const vaultIds = userVaults.map((vk) => vk.vaultId);

		// Get all items from all vaults (exclude soft-deleted)
		const allItems = await db.query.item.findMany({
			where: (item, { and }) =>
				and(inArray(item.vaultId, vaultIds), isNull(item.deletedAt)),
			orderBy: (item, { desc }) => [desc(item.updatedAt)],
		});

		// Build a map of vault metadata for quick lookup
		const vaultMap = new Map(
			userVaults.map((vk) => [
				vk.vaultId,
				{
					id: vk.vault.id,
					name: vk.vault.name,
					type: vk.vault.type,
					icon: vk.vault.icon,
					imageUrl: vk.vault.imageKey
						? getStoragePublicUrl(vk.vault.imageKey)
						: null,
					encryptedVaultKey: vk.encryptedVaultKey,
					role: vk.role,
				},
			]),
		);

		// Return items with vault metadata
		return allItems.map((item) => {
			const vaultMeta = vaultMap.get(item.vaultId)!;
			return {
				...item,
				vault: vaultMeta,
			};
		});
	}),

	/**
	 * List all deleted items from all accessible vaults (cross-vault trash)
	 * Returns items with vault metadata and encrypted vault keys
	 */
	listAllDeletedItems: protectedProcedure.query(async ({ ctx }) => {
		// Get all vaults the user has access to
		const userVaults = await db.query.vaultKey.findMany({
			where: (vaultKey, { eq }) => eq(vaultKey.userId, ctx.session.userId),
			with: {
				vault: true,
			},
		});

		if (userVaults.length === 0) {
			return [];
		}

		// Get all vault IDs
		const vaultIds = userVaults.map((vk) => vk.vaultId);

		// Get all deleted items from all vaults
		const allDeletedItems = await db.query.item.findMany({
			where: (item, { and }) =>
				and(inArray(item.vaultId, vaultIds), isNotNull(item.deletedAt)),
			orderBy: (item, { desc }) => [desc(item.deletedAt)],
		});

		// Build a map of vault metadata for quick lookup
		const vaultMap = new Map(
			userVaults.map((vk) => [
				vk.vaultId,
				{
					id: vk.vault.id,
					name: vk.vault.name,
					type: vk.vault.type,
					icon: vk.vault.icon,
					imageUrl: vk.vault.imageKey
						? getStoragePublicUrl(vk.vault.imageKey)
						: null,
					encryptedVaultKey: vk.encryptedVaultKey,
					role: vk.role,
				},
			]),
		);

		// Return items with vault metadata
		return allDeletedItems.map((item) => {
			const vaultMeta = vaultMap.get(item.vaultId)!;
			return {
				...item,
				vault: vaultMeta,
			};
		});
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
				category: z.enum([
					"login",
					"secure-note",
					"credit-card",
					"identity",
					"totp",
				]),
				encryptedData: z.string(),
				encryptionIv: z.string(),
				encryptionAlgorithm: z.string().default("AES-GCM"),
				clientId: z.string().optional(), // For sync event correlation
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

			let broadcast: SyncBroadcastPayload;
			await db.transaction(async (tx) => {
				await tx.insert(item).values({
					id: itemId,
					vaultId: input.vaultId,
					category: input.category,
					encryptedData: input.encryptedData,
					encryptionIv: input.encryptionIv,
					encryptionAlgorithm: input.encryptionAlgorithm,
					version: 1,
					lastModifiedBy: ctx.session.userId,
				});

				broadcast = await createSyncEvent(
					{
						eventType: "item_created",
						entityId: itemId,
						entityType: "item",
						vaultId: input.vaultId,
						userId: ctx.session.userId,
						clientId: input.clientId,
						version: 1,
					},
					tx,
					ctx.clientId,
				);
			});

			await broadcastSyncPayload(broadcast!);

			return { itemId, id: input.vaultId };
		}),

	/**
	 * Bulk import items into a vault
	 */
	bulkImportItems: protectedProcedure
		.input(
			z.object({
				vaultId: z.string(),
				clientId: z.string().optional(),
				items: z.array(
					z.object({
						category: z.enum([
							"login",
							"secure-note",
							"credit-card",
							"identity",
							"totp",
						]),
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
				const batchBroadcasts: SyncBroadcastPayload[] = [];
				const itemsToInsert = batch.map((itemData) => ({
					id: nanoid(),
					vaultId: input.vaultId,
					category: itemData.category,
					favorite: itemData.favorite ?? false,
					encryptedData: itemData.encryptedData,
					encryptionIv: itemData.encryptionIv,
					encryptionAlgorithm: itemData.encryptionAlgorithm,
					version: 1,
					lastModifiedBy: ctx.session.userId,
				}));

				await db.transaction(async (tx) => {
					await tx.insert(item).values(itemsToInsert);

					for (const insertedItem of itemsToInsert) {
						batchBroadcasts.push(
							await createSyncEvent(
								{
									eventType: "item_created",
									entityId: insertedItem.id,
									entityType: "item",
									vaultId: input.vaultId,
									userId: ctx.session.userId,
									clientId: input.clientId,
									version: 1,
								},
								tx,
								ctx.clientId,
							),
						);
					}
				});

				await broadcastSyncPayloads(batchBroadcasts);
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
				expectedVersion: z.number().optional(), // For conflict detection
				clientId: z.string().optional(), // For sync event correlation
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

			// Check for version conflict
			const currentVersion = existingItem.version || 1;
			if (
				input.expectedVersion !== undefined &&
				input.expectedVersion !== currentVersion
			) {
				throw new TRPCError({
					code: "CONFLICT",
					message: "Item has been modified by another client",
					cause: {
						currentVersion,
						expectedVersion: input.expectedVersion,
					},
				});
			}

			const newVersion = currentVersion + 1;

			let broadcast: SyncBroadcastPayload;
			await db.transaction(async (tx) => {
				await tx
					.update(item)
					.set({
						...(input.encryptedData && { encryptedData: input.encryptedData }),
						...(input.encryptionIv && { encryptionIv: input.encryptionIv }),
						version: newVersion,
						lastModifiedBy: ctx.session.userId,
						updatedAt: new Date(),
					})
					.where(eq(item.id, input.itemId));

				broadcast = await createSyncEvent(
					{
						eventType: "item_updated",
						entityId: input.itemId,
						entityType: "item",
						vaultId: existingItem.vaultId,
						userId: ctx.session.userId,
						clientId: input.clientId,
						version: newVersion,
					},
					tx,
					ctx.clientId,
				);
			});

			await broadcastSyncPayload(broadcast!);

			return { success: true, version: newVersion };
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
			let broadcast: SyncBroadcastPayload;
			await db.transaction(async (tx) => {
				await tx
					.update(item)
					.set({
						favorite: input.favorite,
						updatedAt: new Date(),
					})
					.where(eq(item.id, input.itemId));

				broadcast = await createSyncEvent(
					{
						eventType: "item_updated",
						entityId: input.itemId,
						entityType: "item",
						vaultId: existingItem.vaultId,
						userId: ctx.session.userId,
						version: existingItem.version,
					},
					tx,
					ctx.clientId,
				);
			});

			await broadcastSyncPayload(broadcast!);

			return { success: true };
		}),

	/**
	 * Soft delete an item
	 */
	deleteItem: protectedProcedure
		.input(
			z.object({
				itemId: z.string(),
				clientId: z.string().optional(), // For sync event correlation
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

			const newVersion = (existingItem.version || 1) + 1;

			let broadcast: SyncBroadcastPayload;
			await db.transaction(async (tx) => {
				await tx
					.update(item)
					.set({
						deletedAt: new Date(),
						version: newVersion,
						lastModifiedBy: ctx.session.userId,
					})
					.where(eq(item.id, input.itemId));

				broadcast = await createSyncEvent(
					{
						eventType: "item_deleted",
						entityId: input.itemId,
						entityType: "item",
						vaultId: existingItem.vaultId,
						userId: ctx.session.userId,
						clientId: input.clientId,
						version: newVersion,
					},
					tx,
					ctx.clientId,
				);
			});

			await broadcastSyncPayload(broadcast!);

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
				clientId: z.string().optional(), // For sync event correlation
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

			const newVersion = (existingItem.version || 1) + 1;

			let broadcast: SyncBroadcastPayload;
			await db.transaction(async (tx) => {
				// Restore the item
				await tx
					.update(item)
					.set({
						deletedAt: null,
						version: newVersion,
						lastModifiedBy: ctx.session.userId,
						updatedAt: new Date(),
					})
					.where(eq(item.id, input.itemId));

				broadcast = await createSyncEvent(
					{
						eventType: "item_restored",
						entityId: input.itemId,
						entityType: "item",
						vaultId: existingItem.vaultId,
						userId: ctx.session.userId,
						clientId: input.clientId,
						version: newVersion,
					},
					tx,
					ctx.clientId,
				);
			});

			await broadcastSyncPayload(broadcast!);

			return { success: true };
		}),

	/**
	 * Move an item from one vault to another
	 * The client must re-encrypt the item data with the target vault's key
	 */
	moveItem: protectedProcedure
		.input(
			z.object({
				itemId: z.string(),
				sourceVaultId: z.string(),
				targetVaultId: z.string(),
				encryptedData: z.string(), // Re-encrypted with target vault key
				encryptionIv: z.string(),
				clientId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			// Verify the item exists and is in the source vault
			const existingItem = await db.query.item.findFirst({
				where: (item, { eq }) => eq(item.id, input.itemId),
			});

			if (!existingItem) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Item not found",
				});
			}

			if (existingItem.vaultId !== input.sourceVaultId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Item does not belong to the source vault",
				});
			}

			// Cannot move items that are in trash
			if (existingItem.deletedAt) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Cannot move items that are in trash. Restore first.",
				});
			}

			// Verify user has READ access to source vault
			const sourceVaultKey = await db.query.vaultKey.findFirst({
				where: (vk, { and, eq }) =>
					and(
						eq(vk.vaultId, input.sourceVaultId),
						eq(vk.userId, ctx.session.userId),
					),
			});

			if (!sourceVaultKey) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "No access to source vault",
				});
			}

			// Verify user has WRITE access to target vault
			const targetVaultKey = await db.query.vaultKey.findFirst({
				where: (vk, { and, eq }) =>
					and(
						eq(vk.vaultId, input.targetVaultId),
						eq(vk.userId, ctx.session.userId),
					),
			});

			if (!targetVaultKey) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "No access to target vault",
				});
			}

			if (targetVaultKey.role === "read-only") {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Cannot move items to a read-only vault",
				});
			}

			const newVersion = (existingItem.version || 1) + 1;

			let broadcast: SyncBroadcastPayload;
			await db.transaction(async (tx) => {
				// Move the item: update vaultId and encrypted data
				await tx
					.update(item)
					.set({
						vaultId: input.targetVaultId,
						encryptedData: input.encryptedData,
						encryptionIv: input.encryptionIv,
						version: newVersion,
						lastModifiedBy: ctx.session.userId,
						updatedAt: new Date(),
					})
					.where(eq(item.id, input.itemId));

				broadcast = await createSyncEvent(
					{
						eventType: "item_moved",
						entityId: input.itemId,
						entityType: "item",
						vaultId: input.targetVaultId,
						userId: ctx.session.userId,
						clientId: input.clientId,
						version: newVersion,
						metadata: {
							sourceVaultId: input.sourceVaultId,
						},
					},
					tx,
					ctx.clientId,
				);
			});

			await broadcastSyncPayload(broadcast!);

			return { success: true, version: newVersion };
		}),

	/**
	 * Permanently delete an item from trash
	 */
	permanentlyDeleteItem: protectedProcedure
		.input(
			z.object({
				itemId: z.string(),
				clientId: z.string().optional(),
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

			let broadcast: SyncBroadcastPayload;
			await db.transaction(async (tx) => {
				broadcast = await createSyncEvent(
					{
						eventType: "item_permanently_deleted",
						entityId: input.itemId,
						entityType: "item",
						vaultId: existingItem.vaultId,
						userId: ctx.session.userId,
						clientId: input.clientId,
						version: existingItem.version || 1,
					},
					tx,
					ctx.clientId,
				);

				// Permanently delete from database
				await tx.delete(item).where(eq(item.id, input.itemId));
			});

			await broadcastSyncPayload(broadcast!);

			return { success: true };
		}),

	/**
	 * Get dashboard stats for current user
	 */
	stats: protectedProcedure.query(async ({ ctx }) => {
		// Get user's team
		const userData = await db.query.user.findFirst({
			where: (user, { eq }) => eq(user.id, ctx.session.userId),
			with: { team: true },
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
			teamCount: userData?.team ? 1 : 0,
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
		 * When removing a member, the client must provide re-encrypted data:
		 * - New encrypted vault keys for all remaining members (using their RSA public keys)
		 * - Re-encrypted items (using the new vault key)
		 * This ensures the removed member can no longer decrypt vault contents.
		 */
		remove: protectedProcedure
			.input(
				z.object({
					vaultId: z.string(),
					userId: z.string(),
					// Key rotation data - required to securely revoke access
					keyRotation: z.object({
						// New encrypted vault keys for remaining members
						memberKeys: z.array(
							z.object({
								userId: z.string(),
								encryptedVaultKey: z.string(),
							}),
						),
						// Re-encrypted items with new vault key
						reEncryptedItems: z.array(
							z.object({
								itemId: z.string(),
								encryptedData: z.string(),
								encryptionIv: z.string(),
							}),
						),
					}),
					clientId: z.string().optional(), // For sync event correlation
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

				// Get current vault to get key version
				const currentVault = await db.query.vault.findFirst({
					where: (v, { eq }) => eq(v.id, input.vaultId),
				});

				if (!currentVault) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Vault not found",
					});
				}

				const newKeyVersion = currentVault.keyVersion + 1;
				const rotationId = nanoid();

				// Create key rotation record
				await db.insert(vaultKeyRotation).values({
					id: rotationId,
					vaultId: input.vaultId,
					keyVersion: newKeyVersion,
					reason: "member_removed",
					initiatedById: ctx.session.userId,
					removedUserId: input.userId,
					itemsReEncrypted: input.keyRotation.reEncryptedItems.length,
					membersUpdated: input.keyRotation.memberKeys.length,
					status: "in_progress",
				});

				try {
					const broadcasts: SyncBroadcastPayload[] = [];
					await db.transaction(async (tx) => {
						// Delete the removed user's vault key.
						const removedKey = await tx
							.delete(vaultKey)
							.where(
								and(
									eq(vaultKey.vaultId, input.vaultId),
									eq(vaultKey.userId, input.userId),
								),
							)
							.returning({ id: vaultKey.id });

						if (removedKey.length === 0) {
							throw new Error("Target member vault key not found");
						}

						// Update vault keys for all remaining members.
						for (const memberKey of input.keyRotation.memberKeys) {
							const updatedKey = await tx
								.update(vaultKey)
								.set({ encryptedVaultKey: memberKey.encryptedVaultKey })
								.where(
									and(
										eq(vaultKey.vaultId, input.vaultId),
										eq(vaultKey.userId, memberKey.userId),
									),
								)
								.returning({ id: vaultKey.id });

							if (updatedKey.length === 0) {
								throw new Error(
									`Member key not found for user ${memberKey.userId}`,
								);
							}
						}

						// Re-encrypt all items with new vault key.
						for (const reEncryptedItem of input.keyRotation.reEncryptedItems) {
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
										eq(item.vaultId, input.vaultId),
									),
								)
								.returning({ id: item.id });

							if (updatedItem.length === 0) {
								throw new Error(
									`Item not found in vault: ${reEncryptedItem.itemId}`,
								);
							}
						}

						// Update vault key version.
						const updatedVault = await tx
							.update(vault)
							.set({
								keyVersion: newKeyVersion,
								updatedAt: new Date(),
							})
							.where(eq(vault.id, input.vaultId))
							.returning({ id: vault.id });

						if (updatedVault.length === 0) {
							throw new Error("Vault not found during key rotation");
						}

						// Mark rotation as completed.
						await tx
							.update(vaultKeyRotation)
							.set({
								status: "completed",
								completedAt: new Date(),
							})
							.where(eq(vaultKeyRotation.id, rotationId));

						// Create sync events inside the transaction for atomicity
						broadcasts.push(
							await createSyncEvent(
								{
									eventType: "vault_member_removed",
									entityId: input.userId,
									entityType: "vault_member",
									vaultId: input.vaultId,
									userId: ctx.session.userId,
									clientId: input.clientId,
									version: newKeyVersion,
									metadata: {
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
									eventType: "vault_key_rotated",
									entityId: input.vaultId,
									entityType: "vault_key",
									vaultId: input.vaultId,
									userId: ctx.session.userId,
									clientId: input.clientId,
									version: newKeyVersion,
									metadata: {
										reason: "member_removed",
										keyRotationId: rotationId,
									},
								},
								tx,
								ctx.clientId,
							),
						);

						broadcasts.push(
							await createSyncEvent(
								{
									eventType: "vault_access_revoked",
									entityId: input.vaultId,
									entityType: "vault",
									vaultId: input.vaultId,
									userId: input.userId,
									clientId: input.clientId,
									version: newKeyVersion,
									metadata: {
										reason: "member_removed",
										removedUserId: input.userId,
									},
								},
								tx,
								ctx.clientId,
							),
						);
					});

					// Broadcast after transaction commits
					await broadcastSyncPayloads(broadcasts);

					await logAuditEvent({
						userId: ctx.session.userId,
						action: "vault_member_removed",
						device: ctx.device,
						entityType: "vault",
						entityId: input.vaultId,
						metadata: {
							removedUserId: input.userId,
							keyRotationId: rotationId,
							newKeyVersion,
							itemsReEncrypted: input.keyRotation.reEncryptedItems.length,
							membersUpdated: input.keyRotation.memberKeys.length,
						},
					});

					return {
						success: true,
						keyRotation: {
							id: rotationId,
							newKeyVersion,
							itemsReEncrypted: input.keyRotation.reEncryptedItems.length,
							membersUpdated: input.keyRotation.memberKeys.length,
						},
					};
				} catch (error) {
					// Mark rotation as failed
					await db
						.update(vaultKeyRotation)
						.set({
							status: "failed",
							errorMessage:
								error instanceof Error ? error.message : "Unknown error",
						})
						.where(eq(vaultKeyRotation.id, rotationId));

					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message: "Key rotation failed. Please try again.",
					});
				}
			}),

		/**
		 * Get data needed for key rotation
		 * Returns all remaining members' public keys and all items in the vault
		 * Called before removing a member to prepare for key rotation
		 */
		getRotationData: protectedProcedure
			.input(
				z.object({
					vaultId: z.string(),
					excludeUserId: z.string(), // The user being removed
				}),
			)
			.query(async ({ ctx, input }) => {
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
						message: "Only vault owner or admin can perform key rotation",
					});
				}

				// Get all members except the one being removed
				const members = await db.query.vaultKey.findMany({
					where: (vk, { and, eq, ne }) =>
						and(
							eq(vk.vaultId, input.vaultId),
							ne(vk.userId, input.excludeUserId),
						),
					with: {
						user: true,
					},
				});

				// Get all items in the vault
				const items = await db.query.item.findMany({
					where: (i, { eq }) => eq(i.vaultId, input.vaultId),
				});

				return {
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
					clientId: z.string().optional(), // For sync event correlation
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

				// Add the new member (atomic with sync event)
				let broadcast: SyncBroadcastPayload;
				await db.transaction(async (tx) => {
					await tx.insert(vaultKey).values({
						id: nanoid(),
						vaultId: input.vaultId,
						userId: input.userId,
						encryptedVaultKey: input.encryptedVaultKey,
						role: input.role,
					});

					broadcast = await createSyncEvent(
						{
							eventType: "vault_member_added",
							entityId: input.userId,
							entityType: "vault_member",
							vaultId: input.vaultId,
							userId: ctx.session.userId,
							clientId: input.clientId,
							version: 1,
							metadata: {
								addedUserId: input.userId,
								role: input.role,
							},
						},
						tx,
						ctx.clientId,
					);
				});

				// Broadcast after transaction commits
				await broadcastSyncPayload(broadcast!);

				await logAuditEvent({
					userId: ctx.session.userId,
					action: "vault_member_added",
					device: ctx.device,
					entityType: "vault",
					entityId: input.vaultId,
					metadata: {
						addedUserId: input.userId,
						role: input.role,
					},
				});

				return { success: true };
			}),
	}),
});
