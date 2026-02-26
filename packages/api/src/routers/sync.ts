import { db, item, syncEvent, syncEventAck, vaultKey } from "@bittery/db";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { protectedProcedure, router } from "../index";
import { getStoragePublicUrl } from "../storage/s3";

export const syncRouter = router({
	/**
	 * Get sync events since a given sequence number
	 * Used for catching up after reconnection
	 */
	getEventsSince: protectedProcedure
		.input(
			z.object({
				sinceSeq: z.number(), // Sequence number cursor
				vaultIds: z.array(z.string()).optional(), // Filter by specific vaults
				limit: z.number().min(1).max(1000).default(100),
			}),
		)
		.query(async ({ ctx, input }) => {
			// Get user's vault memberships
			const userVaults = await db.query.vaultKey.findMany({
				where: eq(vaultKey.userId, ctx.session.userId),
			});

			const userVaultIds = userVaults.map((vk) => vk.vaultId);

			// Filter to requested vaults or all user vaults
			const targetVaultIds = input.vaultIds
				? input.vaultIds.filter((id) => userVaultIds.includes(id))
				: userVaultIds;

			const cursorCondition = gt(syncEvent.seq, input.sinceSeq);

			const vaultEventsWhere =
				targetVaultIds.length > 0
					? and(inArray(syncEvent.vaultId, targetVaultIds), cursorCondition)
					: undefined;
			const targetedControlEventsWhere = and(
				eq(syncEvent.userId, ctx.session.userId),
				eq(syncEvent.eventType, "vault_access_revoked"),
				cursorCondition,
			);
			const eventsWhere = vaultEventsWhere
				? or(vaultEventsWhere, targetedControlEventsWhere)
				: targetedControlEventsWhere;

			// Get events for these vaults since the given cursor
			const events = await db.query.syncEvent.findMany({
				where: eventsWhere,
				orderBy: [asc(syncEvent.seq)],
				limit: input.limit + 1, // Get one extra to check if there are more
			});

			const hasMore = events.length > input.limit;
			const resultEvents = hasMore ? events.slice(0, input.limit) : events;

			const oldestVaultEventsWhere =
				targetVaultIds.length > 0
					? inArray(syncEvent.vaultId, targetVaultIds)
					: undefined;
			const oldestControlEventsWhere = and(
				eq(syncEvent.userId, ctx.session.userId),
				eq(syncEvent.eventType, "vault_access_revoked"),
			);
			const oldestEventWhere = oldestVaultEventsWhere
				? or(oldestVaultEventsWhere, oldestControlEventsWhere)
				: oldestControlEventsWhere;

			// If the oldest retained event is newer than the requested cursor,
			// a full refresh is required because part of history was pruned.
			const oldestEvent = await db.query.syncEvent.findFirst({
				where: oldestEventWhere,
				orderBy: [asc(syncEvent.seq)],
			});

			const requiresFullRefresh = Boolean(
				oldestEvent && oldestEvent.seq > input.sinceSeq,
			);
			const latestCursorEvent = resultEvents[resultEvents.length - 1];

			return {
				events: resultEvents.map((e) => ({
					id: e.id,
					seq: e.seq,
					type: e.eventType,
					entityId: e.entityId,
					entityType: e.entityType,
					vaultId: e.vaultId,
					version: e.version,
					clientId: e.clientId,
					userId: e.userId,
					metadata: e.metadata ? JSON.parse(e.metadata) : null,
					timestamp: e.createdAt.getTime(),
				})),
				cursor: latestCursorEvent
					? { seq: latestCursorEvent.seq }
					: null,
				hasMore,
				requiresFullRefresh,
			};
		}),

	/**
	 * Paginated bootstrap endpoint for large vaults.
	 * Returns encrypted items with vault metadata in deterministic pages.
	 */
	bootstrapItems: protectedProcedure
		.input(
			z.object({
				cursor: z.string().optional(),
				limit: z.number().min(1).max(1000).default(500),
			}),
		)
		.query(async ({ ctx, input }) => {
			const userVaults = await db.query.vaultKey.findMany({
				where: eq(vaultKey.userId, ctx.session.userId),
				with: {
					vault: true,
				},
			});

			if (userVaults.length === 0) {
				return {
					items: [],
					nextCursor: null,
					hasMore: false,
				};
			}

			const vaultIds = userVaults.map((vk) => vk.vaultId);
			const where = input.cursor
				? and(
						inArray(item.vaultId, vaultIds),
						isNull(item.deletedAt),
						gt(item.id, input.cursor),
					)
				: and(inArray(item.vaultId, vaultIds), isNull(item.deletedAt));

			const pageItems = await db.query.item.findMany({
				where,
				orderBy: [asc(item.id)],
				limit: input.limit + 1,
				with: { attachments: true },
			});

			const hasMore = pageItems.length > input.limit;
			const resultItems = hasMore ? pageItems.slice(0, input.limit) : pageItems;
			const lastItem = resultItems[resultItems.length - 1];

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

			return {
				items: resultItems.map((vaultItem) => ({
					...vaultItem,
					vault: vaultMap.get(vaultItem.vaultId),
				})),
				nextCursor: lastItem?.id ?? null,
				hasMore,
			};
		}),

	/**
	 * Get current sync state for vaults
	 * Returns the latest version for each vault to detect conflicts
	 */
	getSyncState: protectedProcedure
		.input(
			z.object({
				vaultIds: z.array(z.string()),
			}),
		)
		.query(async ({ ctx, input }) => {
			// Verify user has access to these vaults
			const userVaults = await db.query.vaultKey.findMany({
				where: and(
					eq(vaultKey.userId, ctx.session.userId),
					inArray(vaultKey.vaultId, input.vaultIds),
				),
			});

			const accessibleVaultIds = userVaults.map((vk) => vk.vaultId);

			// Get latest event for each vault
			const states: Record<
				string,
				{ latestEventId: string | null; latestTimestamp: number | null }
			> = {};

			for (const vaultId of accessibleVaultIds) {
				const latestEvent = await db.query.syncEvent.findFirst({
					where: eq(syncEvent.vaultId, vaultId),
					orderBy: [desc(syncEvent.createdAt)],
				});

				states[vaultId] = {
					latestEventId: latestEvent?.id || null,
					latestTimestamp: latestEvent?.createdAt.getTime() || null,
				};
			}

			return states;
		}),

	/**
	 * Acknowledge that events have been processed by a client
	 * This helps track sync progress per client
	 */
	acknowledgeEvents: protectedProcedure
		.input(
			z.object({
				eventIds: z.array(z.string()),
				clientId: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			if (input.eventIds.length === 0) {
				return { acknowledged: 0 };
			}

			// Verify events exist and user has access
			const events = await db.query.syncEvent.findMany({
				where: inArray(syncEvent.id, input.eventIds),
			});

			// Get user's vault access
			const userVaults = await db.query.vaultKey.findMany({
				where: eq(vaultKey.userId, ctx.session.userId),
			});
			const userVaultIds = new Set(userVaults.map((vk) => vk.vaultId));

			// Filter to events user has access to
			const accessibleEvents = events.filter(
				(e) => e.vaultId && userVaultIds.has(e.vaultId),
			);

			// Insert acknowledgements
			const acks = accessibleEvents.map((e) => ({
				id: nanoid(),
				eventId: e.id,
				userId: ctx.session.userId,
				clientId: input.clientId,
			}));

			if (acks.length > 0) {
				await db.insert(syncEventAck).values(acks);
			}

			return { acknowledged: acks.length };
		}),

	/**
	 * Get last acknowledged event for a client
	 * Used to determine where to resume sync from
	 */
	getLastAcknowledged: protectedProcedure
		.input(
			z.object({
				clientId: z.string(),
			}),
		)
		.query(async ({ ctx, input }) => {
			const lastAck = await db.query.syncEventAck.findFirst({
				where: and(
					eq(syncEventAck.userId, ctx.session.userId),
					eq(syncEventAck.clientId, input.clientId),
				),
				orderBy: [desc(syncEventAck.acknowledgedAt)],
				with: {
					event: true,
				},
			});

			if (!lastAck || !lastAck.event) {
				return null;
			}

			return {
				eventId: lastAck.eventId,
				timestamp: lastAck.event.createdAt.getTime(),
			};
		}),

	/**
	 * Check for conflicts before updating an item
	 * Returns conflict info if the item has been modified since the expected version
	 */
	checkConflict: protectedProcedure
		.input(
			z.object({
				itemId: z.string(),
				expectedVersion: z.number(),
			}),
		)
		.query(async ({ ctx, input }) => {
			// Get the item's current version from recent sync events
			const latestItemEvent = await db.query.syncEvent.findFirst({
				where: and(
					eq(syncEvent.entityId, input.itemId),
					eq(syncEvent.entityType, "item"),
				),
				orderBy: [desc(syncEvent.createdAt)],
			});

			if (!latestItemEvent) {
				return { hasConflict: false };
			}

			// Verify user has access to the vault
			if (latestItemEvent.vaultId) {
				const userVaultKey = await db.query.vaultKey.findFirst({
					where: and(
						eq(vaultKey.userId, ctx.session.userId),
						eq(vaultKey.vaultId, latestItemEvent.vaultId),
					),
				});

				if (!userVaultKey) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "Access denied",
					});
				}
			}

			const hasConflict = latestItemEvent.version > input.expectedVersion;

			return {
				hasConflict,
				currentVersion: latestItemEvent.version,
				lastModifiedBy: latestItemEvent.userId,
				lastModifiedAt: latestItemEvent.createdAt.getTime(),
			};
		}),
});
