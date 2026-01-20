import { db } from "@bittery/db";
import { syncEvent, syncEventAck, vaultKey } from "@bittery/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { protectedProcedure, router } from "../index";

export const syncRouter = router({
	/**
	 * Get sync events since a given timestamp
	 * Used for catching up after reconnection
	 */
	getEventsSince: protectedProcedure
		.input(
			z.object({
				since: z.number(), // Unix timestamp in milliseconds
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

			if (targetVaultIds.length === 0) {
				return { events: [], hasMore: false };
			}

			const sinceDate = new Date(input.since);

			// Get events for these vaults since the given timestamp
			const events = await db.query.syncEvent.findMany({
				where: and(
					inArray(syncEvent.vaultId, targetVaultIds),
					gt(syncEvent.createdAt, sinceDate),
				),
				orderBy: [desc(syncEvent.createdAt)],
				limit: input.limit + 1, // Get one extra to check if there are more
			});

			const hasMore = events.length > input.limit;
			const resultEvents = hasMore ? events.slice(0, input.limit) : events;

			return {
				events: resultEvents.map((e) => ({
					id: e.id,
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
