import { db, item, syncEvent, syncEventAck, vaultKey } from "@bittery/db";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt, inArray, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { canUserUseAttachments } from "../helpers/entitlements";
import { protectedProcedure, router } from "../index";
import { getStoragePublicUrl } from "../storage/s3";
import {
	clientIdSchema,
	resourceIdSchema,
	syncEventIdsSchema,
	syncVaultIdsSchema,
} from "../validation";

function toSyncEventDto(event: {
	id: string;
	eventType: string;
	entityId: string;
	entityType: string;
	vaultId: string | null;
	version: number;
	clientId: string | null;
	userId: string;
	metadata: string | null;
	createdAt: Date;
}) {
	return {
		id: event.id,
		type: event.eventType,
		entityId: event.entityId,
		entityType: event.entityType,
		vaultId: event.vaultId,
		version: event.version,
		clientId: event.clientId,
		userId: event.userId,
		metadata: event.metadata ? JSON.parse(event.metadata) : null,
		timestamp: event.createdAt.getTime(),
	};
}

export const syncRouter = router({
	/**
	 * Get sync events since a given opaque event id
	 * Used for catching up after reconnection
	 */
	getEventsSince: protectedProcedure
		.input(
			z
				.object({
					sinceId: resourceIdSchema.nullable().optional(),
					vaultIds: syncVaultIdsSchema.optional(),
					limit: z.number().min(1).max(1000).default(100),
				})
				.strict(),
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

			const visibleEventsWhere =
				targetVaultIds.length > 0
					? or(
							inArray(syncEvent.vaultId, targetVaultIds),
							and(
								eq(syncEvent.userId, ctx.session.userId),
								eq(syncEvent.eventType, "vault_access_revoked"),
							),
						)
					: and(
							eq(syncEvent.userId, ctx.session.userId),
							eq(syncEvent.eventType, "vault_access_revoked"),
						);

			let sinceSeq = 0;
			if (input.sinceId) {
				const cursorEvent = await db.query.syncEvent.findFirst({
					where: and(eq(syncEvent.id, input.sinceId), visibleEventsWhere),
					columns: {
						id: true,
						seq: true,
					},
				});

				if (!cursorEvent) {
					const latestVisibleEvent = await db.query.syncEvent.findFirst({
						where: visibleEventsWhere,
						orderBy: [desc(syncEvent.seq)],
						columns: { id: true },
					});

					return {
						events: [],
						cursor: latestVisibleEvent ? { id: latestVisibleEvent.id } : null,
						hasMore: false,
						requiresFullRefresh: true,
					};
				}

				sinceSeq = cursorEvent.seq;
			}

			const cursorCondition = gt(syncEvent.seq, sinceSeq);
			const eventsWhere = and(visibleEventsWhere, cursorCondition);

			// Get events for these vaults since the given cursor
			const events = await db.query.syncEvent.findMany({
				where: eventsWhere,
				orderBy: [asc(syncEvent.seq)],
				limit: input.limit + 1, // Get one extra to check if there are more
			});

			const hasMore = events.length > input.limit;
			const resultEvents = hasMore ? events.slice(0, input.limit) : events;
			const latestCursorEvent = resultEvents[resultEvents.length - 1];

			return {
				events: resultEvents.map(toSyncEventDto),
				cursor: latestCursorEvent ? { id: latestCursorEvent.id } : null,
				hasMore,
				requiresFullRefresh: false,
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
			const attachmentsEnabled = await canUserUseAttachments(
				ctx.session.userId,
			);

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
				? and(inArray(item.vaultId, vaultIds), gt(item.id, input.cursor))
				: and(inArray(item.vaultId, vaultIds));

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
					attachments: attachmentsEnabled ? vaultItem.attachments : [],
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
			z
				.object({
					vaultIds: syncVaultIdsSchema,
				})
				.strict(),
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
			z
				.object({
					eventIds: syncEventIdsSchema,
					clientId: clientIdSchema,
				})
				.strict(),
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
			z
				.object({
					clientId: clientIdSchema,
				})
				.strict(),
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
			z
				.object({
					itemId: resourceIdSchema,
					expectedVersion: z.number(),
				})
				.strict(),
		)
		.query(async ({ ctx, input }) => {
			const [accessibleItem] = await db
				.select({
					id: item.id,
					vaultId: item.vaultId,
				})
				.from(item)
				.innerJoin(
					vaultKey,
					and(
						eq(vaultKey.vaultId, item.vaultId),
						eq(vaultKey.userId, ctx.session.userId),
					),
				)
				.where(eq(item.id, input.itemId))
				.limit(1);

			if (!accessibleItem) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Item not found",
				});
			}

			const latestItemEvent = await db.query.syncEvent.findFirst({
				where: and(
					eq(syncEvent.entityId, input.itemId),
					eq(syncEvent.entityType, "item"),
					eq(syncEvent.vaultId, accessibleItem.vaultId),
				),
				orderBy: [desc(syncEvent.createdAt)],
			});

			if (!latestItemEvent) {
				return { hasConflict: false };
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
