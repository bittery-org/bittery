/**
 * Integration Tests for Sync tRPC Router
 *
 * Tests cover:
 * - Event retrieval with filtering (getEventsSince)
 * - Sync state tracking (getSyncState)
 * - Event acknowledgement (acknowledgeEvents)
 * - Last acknowledged event (getLastAcknowledged)
 * - Conflict detection (checkConflict)
 * - Access control (vault membership checks)
 */

import { afterEach, describe, expect, test } from "bun:test";
import { db } from "@bittery/db";
import { itemAttachment } from "@bittery/db/schema/vault";
import { nanoid } from "nanoid";
import { syncRouter } from "../routers/sync";
import {
	createTestItem,
	createTestSyncEvent,
	createTestTeam,
	createTestVault,
	setup,
	truncateAll,
} from "./test-utils";

describe("Sync Router", () => {
	afterEach(async () => {
		await truncateAll();
	});

	describe("getEventsSince", () => {
		test("should return events since a given timestamp", async () => {
			const { caller, userId } = await setup(syncRouter);
			const vaultId = await createTestVault(userId);

			// Create events at different times
			await createTestSyncEvent(vaultId, userId, {
				eventType: "item_created",
				entityId: "item-1",
			});
			await createTestSyncEvent(vaultId, userId, {
				eventType: "item_updated",
				entityId: "item-2",
			});

			const result = await caller.getEventsSince({
				sinceSeq: 0,
			});

			expect(result.events.length).toBe(2);
			expect(result.hasMore).toBe(false);
		});

		test("should filter by specific vaultIds", async () => {
			const { caller, userId } = await setup(syncRouter);
			const vault1 = await createTestVault(userId, { name: "Vault 1" });
			const vault2 = await createTestVault(userId, { name: "Vault 2" });

			await createTestSyncEvent(vault1, userId, {
				eventType: "item_created",
				entityId: "item-1",
			});
			await createTestSyncEvent(vault2, userId, {
				eventType: "item_created",
				entityId: "item-2",
			});

			const result = await caller.getEventsSince({
				sinceSeq: 0,
				vaultIds: [vault1],
			});

			expect(result.events.length).toBe(1);
			expect(result.events[0]?.entityId).toBe("item-1");
		});

		test("should return empty array for user with no vaults", async () => {
			const { caller } = await setup(syncRouter);

			const result = await caller.getEventsSince({
				sinceSeq: 0,
			});

			expect(result.events).toEqual([]);
			expect(result.hasMore).toBe(false);
		});

		test("should not return events from vaults user has no access to", async () => {
			const [{ userId: ownerId }, { caller }] = await Promise.all([
				setup(syncRouter),
				setup(syncRouter),
			]);
			const vaultId = await createTestVault(ownerId);
			await createTestSyncEvent(vaultId, ownerId, {
				eventType: "item_created",
			});

			const result = await caller.getEventsSince({
				sinceSeq: 0,
				vaultIds: [vaultId],
			});

			expect(result.events).toEqual([]);
		});

		test("should respect limit and set hasMore flag", async () => {
			const { caller, userId } = await setup(syncRouter);
			const vaultId = await createTestVault(userId);

			// Create 5 events
			for (let i = 0; i < 5; i++) {
				await createTestSyncEvent(vaultId, userId, {
					eventType: "item_created",
					entityId: `item-${i}`,
				});
			}

			const result = await caller.getEventsSince({
				sinceSeq: 0,
				limit: 3,
			});

			expect(result.events.length).toBe(3);
			expect(result.hasMore).toBe(true);
		});

		test("should include parsed metadata in events", async () => {
			const { caller, userId } = await setup(syncRouter);
			const vaultId = await createTestVault(userId);

			await createTestSyncEvent(vaultId, userId, {
				eventType: "item_moved",
				entityId: "item-1",
				metadata: JSON.stringify({ sourceVaultId: "old-vault" }),
			});

			const result = await caller.getEventsSince({
				sinceSeq: 0,
			});

			expect(result.events[0]?.metadata).toEqual({
				sourceVaultId: "old-vault",
			});
		});
	});

	describe("getSyncState", () => {
		test("should return latest event info per vault", async () => {
			const { caller, userId } = await setup(syncRouter);
			const vaultId = await createTestVault(userId);

			await createTestSyncEvent(vaultId, userId, {
				eventType: "item_created",
				version: 1,
			});
			await createTestSyncEvent(vaultId, userId, {
				eventType: "item_updated",
				version: 2,
			});

			const result = await caller.getSyncState({ vaultIds: [vaultId] });

			expect(result[vaultId]).toBeDefined();
			expect(result[vaultId]?.latestEventId).toBeDefined();
			expect(result[vaultId]?.latestTimestamp).toBeDefined();
		});

		test("should return null for vault with no events", async () => {
			const { caller, userId } = await setup(syncRouter);
			const vaultId = await createTestVault(userId);

			const result = await caller.getSyncState({ vaultIds: [vaultId] });

			expect(result[vaultId]?.latestEventId).toBeNull();
			expect(result[vaultId]?.latestTimestamp).toBeNull();
		});

		test("should exclude vaults user has no access to", async () => {
			const [{ userId: ownerId }, { caller }] = await Promise.all([
				setup(syncRouter),
				setup(syncRouter),
			]);
			const vaultId = await createTestVault(ownerId);
			await createTestSyncEvent(vaultId, ownerId);

			const result = await caller.getSyncState({ vaultIds: [vaultId] });

			// Should not include the inaccessible vault
			expect(result[vaultId]).toBeUndefined();
		});
	});

	describe("bootstrapItems", () => {
		test("should include soft-deleted items in bootstrap payload", async () => {
			const { caller, userId } = await setup(syncRouter);
			const vaultId = await createTestVault(userId);

			const activeItemId = await createTestItem(vaultId, userId);
			const deletedItemId = await createTestItem(vaultId, userId, {
				deletedAt: new Date(),
			});

			const result = await caller.bootstrapItems({});
			const returnedItemIds = result.items.map((item) => item.id);
			const activeItem = result.items.find((item) => item.id === activeItemId);
			const deletedItem = result.items.find(
				(item) => item.id === deletedItemId,
			);

			expect(returnedItemIds).toContain(activeItemId);
			expect(returnedItemIds).toContain(deletedItemId);
			expect(deletedItem).toBeDefined();
			expect(deletedItem?.deletedAt).not.toBeNull();
			expect(activeItem).toBeDefined();
			expect(activeItem?.deletedAt).toBeNull();
		});

		test("should hide attachment metadata when attachments entitlement is disabled", async () => {
			const { caller, userId } = await setup(syncRouter);
			await createTestTeam(userId, {
				billingPlan: "free",
				billingStatus: "none",
				type: "personal",
			});
			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId);
			await db.insert(itemAttachment).values({
				id: nanoid(),
				itemId,
				vaultId,
				storageKey: `attachments/${userId}/${itemId}/file.enc`,
				encryptedName: "enc-name",
				encryptedContentType: "enc-type",
				encryptionIv: "enc-iv",
				encryptedContentTypeIv: "enc-type-iv",
				encryptionAlgorithm: "AES-GCM",
				fileSize: 123,
				uploadedBy: userId,
			});

			const result = await caller.bootstrapItems({});
			expect(result.items.length).toBe(1);
			expect(result.items[0]?.attachments).toEqual([]);
		});

		test("should hide attachment metadata for cloud users without a team", async () => {
			const { caller, userId } = await setup(syncRouter);
			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId);
			await db.insert(itemAttachment).values({
				id: nanoid(),
				itemId,
				vaultId,
				storageKey: `attachments/${userId}/${itemId}/file.enc`,
				encryptedName: "enc-name",
				encryptedContentType: "enc-type",
				encryptionIv: "enc-iv",
				encryptedContentTypeIv: "enc-type-iv",
				encryptionAlgorithm: "AES-GCM",
				fileSize: 123,
				uploadedBy: userId,
			});

			const result = await caller.bootstrapItems({});
			expect(result.items.length).toBe(1);
			expect(result.items[0]?.attachments).toEqual([]);
		});
	});

	describe("acknowledgeEvents", () => {
		test("should acknowledge events user has access to", async () => {
			const { caller, userId } = await setup(syncRouter);
			const vaultId = await createTestVault(userId);

			const eventId1 = await createTestSyncEvent(vaultId, userId);
			const eventId2 = await createTestSyncEvent(vaultId, userId);

			const result = await caller.acknowledgeEvents({
				eventIds: [eventId1, eventId2],
				clientId: "client-1",
			});

			expect(result.acknowledged).toBe(2);
		});

		test("should return 0 for empty eventIds array", async () => {
			const { caller } = await setup(syncRouter);

			const result = await caller.acknowledgeEvents({
				eventIds: [],
				clientId: "client-1",
			});

			expect(result.acknowledged).toBe(0);
		});

		test("should only acknowledge events from accessible vaults", async () => {
			const [{ userId: ownerId }, { caller }] = await Promise.all([
				setup(syncRouter),
				setup(syncRouter),
			]);
			const vaultId = await createTestVault(ownerId);
			const eventId = await createTestSyncEvent(vaultId, ownerId);

			const result = await caller.acknowledgeEvents({
				eventIds: [eventId],
				clientId: "client-1",
			});

			// User has no access to the vault, so 0 acknowledged
			expect(result.acknowledged).toBe(0);
		});
	});

	describe("getLastAcknowledged", () => {
		test("should return last acknowledged event for a client", async () => {
			const { caller, userId } = await setup(syncRouter);
			const vaultId = await createTestVault(userId);

			const eventId1 = await createTestSyncEvent(vaultId, userId);
			const eventId2 = await createTestSyncEvent(vaultId, userId);

			// Acknowledge both events
			await caller.acknowledgeEvents({
				eventIds: [eventId1, eventId2],
				clientId: "client-1",
			});

			const result = await caller.getLastAcknowledged({
				clientId: "client-1",
			});

			expect(result).toBeDefined();
			expect(result?.eventId).toBeDefined();
			expect(result?.timestamp).toBeDefined();
		});

		test("should return null when no events acknowledged", async () => {
			const { caller } = await setup(syncRouter);

			const result = await caller.getLastAcknowledged({
				clientId: "nonexistent-client",
			});

			expect(result).toBeNull();
		});

		test("should separate acknowledgements by clientId", async () => {
			const { caller, userId } = await setup(syncRouter);
			const vaultId = await createTestVault(userId);

			const eventId1 = await createTestSyncEvent(vaultId, userId);
			const eventId2 = await createTestSyncEvent(vaultId, userId);

			await caller.acknowledgeEvents({
				eventIds: [eventId1],
				clientId: "client-A",
			});
			await caller.acknowledgeEvents({
				eventIds: [eventId2],
				clientId: "client-B",
			});

			const resultA = await caller.getLastAcknowledged({
				clientId: "client-A",
			});
			const resultB = await caller.getLastAcknowledged({
				clientId: "client-B",
			});

			expect(resultA?.eventId).toBe(eventId1);
			expect(resultB?.eventId).toBe(eventId2);
		});
	});

	describe("checkConflict", () => {
		test("should return no conflict when item has not been modified", async () => {
			const { caller, userId } = await setup(syncRouter);
			const vaultId = await createTestVault(userId);

			await createTestSyncEvent(vaultId, userId, {
				entityId: "item-1",
				entityType: "item",
				version: 3,
			});

			const result = await caller.checkConflict({
				itemId: "item-1",
				expectedVersion: 5, // Higher than current
			});

			expect(result.hasConflict).toBe(false);
		});

		test("should detect conflict when item version is ahead", async () => {
			const { caller, userId } = await setup(syncRouter);
			const vaultId = await createTestVault(userId);

			await createTestSyncEvent(vaultId, userId, {
				entityId: "item-1",
				entityType: "item",
				version: 5,
			});

			const result = await caller.checkConflict({
				itemId: "item-1",
				expectedVersion: 3, // Behind current
			});

			expect(result.hasConflict).toBe(true);
			expect(result.currentVersion).toBe(5);
			expect(result.lastModifiedBy).toBe(userId);
		});

		test("should return no conflict when no events exist for item", async () => {
			const { caller } = await setup(syncRouter);

			const result = await caller.checkConflict({
				itemId: "nonexistent-item",
				expectedVersion: 1,
			});

			expect(result.hasConflict).toBe(false);
		});

		test("should deny access when user cannot access the vault", async () => {
			const [{ userId: ownerId }, { caller }] = await Promise.all([
				setup(syncRouter),
				setup(syncRouter),
			]);
			const vaultId = await createTestVault(ownerId);

			await createTestSyncEvent(vaultId, ownerId, {
				entityId: "item-1",
				entityType: "item",
				version: 2,
			});

			await expect(
				caller.checkConflict({
					itemId: "item-1",
					expectedVersion: 1,
				}),
			).rejects.toThrow("Access denied");
		});
	});
});
