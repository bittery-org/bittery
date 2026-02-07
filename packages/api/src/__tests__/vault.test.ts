/**
 * Integration Tests for Vault tRPC Router
 *
 * Tests cover:
 * - Vault CRUD operations (get, list, create, update, delete)
 * - Item operations (listItems, listAllItems, getItem, createItem, updateItem, deleteItem)
 * - Item management (toggleFavorite, bulkImportItems)
 * - Trash operations (listDeletedItems, restoreItem, permanentlyDeleteItem)
 * - Member management (list, updateRole, remove, add, lookupUser, getRotationData)
 * - Access control and role-based permissions
 */

import { afterEach, describe, expect, test } from "bun:test";
import { db } from "@bittery/db";
import { vaultRouter } from "../routers/vault";
import {
	addVaultMember,
	countVaultItems,
	createTestItem,
	createTestVault,
	getItem,
	getVault,
	getVaultKey,
	mockItemData,
	mockSrpData,
	setup,
	truncateAll,
} from "./test-utils";

describe("Vault Router", () => {
	afterEach(async () => {
		await truncateAll();
	});

	describe("list", () => {
		test("should return all vaults for the current user", async () => {
			const { caller, userId } = await setup(vaultRouter);
			await createTestVault(userId, { name: "Vault 1" });
			await createTestVault(userId, { name: "Vault 2" });

			const result = await caller.list();

			expect(result.length).toBe(2);
			expect(result.map((v) => v.name)).toContain("Vault 1");
			expect(result.map((v) => v.name)).toContain("Vault 2");
		});

		test("should return empty array for user with no vaults", async () => {
			const { caller } = await setup(vaultRouter);

			const result = await caller.list();

			expect(result).toEqual([]);
		});

		test("should include vault items in response", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const vaultId = await createTestVault(userId, { name: "Test Vault" });
			await createTestItem(vaultId, userId);
			await createTestItem(vaultId, userId);

			const result = await caller.list();

			expect(result[0]?.items.length).toBe(2);
		});
	});

	describe("get", () => {
		test("should return vault details with item count", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const vaultId = await createTestVault(userId, { name: "My Vault" });
			await createTestItem(vaultId, userId);
			await createTestItem(vaultId, userId);
			await createTestItem(vaultId, userId);

			const result = await caller.get({ vaultId });

			expect(result.id).toBe(vaultId);
			expect(result.name).toBe("My Vault");
			expect(result.itemCount).toBe(3);
			expect(result.userRole).toBe("owner");
		});

		test("should throw NOT_FOUND for non-existent vault", async () => {
			const { caller } = await setup(vaultRouter);

			await expect(caller.get({ vaultId: "nonexistent" })).rejects.toThrow(
				"Vault not found or access denied",
			);
		});

		test("should deny access to vault user is not member of", async () => {
			const [{ userId: ownerId }, { caller }] = await Promise.all([
				setup(vaultRouter),
				setup(vaultRouter),
			]);
			const vaultId = await createTestVault(ownerId);

			await expect(caller.get({ vaultId })).rejects.toThrow(
				"Vault not found or access denied",
			);
		});
	});

	describe("create", () => {
		test("should create a new vault", async () => {
			const { caller } = await setup(vaultRouter);

			const result = await caller.create({
				name: "New Vault",
				type: "personal",
				encryptedVaultKey: mockSrpData.encryptedVaultKey,
				icon: "folder",
			});

			expect(result.vaultId).toBeDefined();

			const vault = await getVault(result.vaultId);
			expect(vault?.name).toBe("New Vault");
			expect(vault?.type).toBe("personal");
			expect(vault?.icon).toBe("folder");
		});

		test("should create vault key for creator with owner role", async () => {
			const { caller, userId } = await setup(vaultRouter);

			const result = await caller.create({
				name: "My Vault",
				type: "team",
				encryptedVaultKey: mockSrpData.encryptedVaultKey,
			});

			const vaultKey = await getVaultKey(result.vaultId, userId);
			expect(vaultKey?.role).toBe("owner");
			expect(vaultKey?.encryptedVaultKey).toBe(mockSrpData.encryptedVaultKey);
		});
	});

	describe("update", () => {
		test("should update vault name and icon", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const vaultId = await createTestVault(userId, { name: "Old Name" });

			const result = await caller.update({
				vaultId,
				name: "New Name",
				icon: "star",
			});

			expect(result.name).toBe("New Name");
			expect(result.icon).toBe("star");
		});

		test("should deny update for non-admin members", async () => {
			const [{ userId: ownerId }, { userId: memberId, caller }] =
				await Promise.all([setup(vaultRouter), setup(vaultRouter)]);
			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, memberId, "member");

			await expect(
				caller.update({ vaultId, name: "Hacked Name" }),
			).rejects.toThrow("Access denied");
		});

		test("should allow admin to update vault", async () => {
			const [{ userId: ownerId }, { userId: adminId, caller }] =
				await Promise.all([setup(vaultRouter), setup(vaultRouter)]);
			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, adminId, "admin");

			const result = await caller.update({ vaultId, name: "Admin Updated" });

			expect(result.name).toBe("Admin Updated");
		});
	});

	describe("delete", () => {
		test("should delete vault and all its items", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const vaultId = await createTestVault(userId);
			await createTestItem(vaultId, userId);
			await createTestItem(vaultId, userId);

			const result = await caller.delete({ vaultId });

			expect(result.success).toBe(true);

			const vault = await getVault(vaultId);
			expect(vault).toBeUndefined();

			const auditLogs = await db.query.auditLog.findMany({
				where: (log, { and, eq }) =>
					and(eq(log.userId, userId), eq(log.action, "vault_deleted")),
			});
			expect(auditLogs.length).toBe(1);
			expect(auditLogs[0]?.entityId).toBe(vaultId);
		});

		test("should deny deletion by non-owner", async () => {
			const [{ userId: ownerId }, { userId: adminId, caller }] =
				await Promise.all([setup(vaultRouter), setup(vaultRouter)]);
			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, adminId, "admin");

			await expect(caller.delete({ vaultId })).rejects.toThrow(
				"Only the vault owner can delete the vault",
			);
		});
	});

	describe("listItems", () => {
		test("should return all non-deleted items in a vault", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const vaultId = await createTestVault(userId);
			await createTestItem(vaultId, userId, { category: "login" });
			await createTestItem(vaultId, userId, { category: "secure-note" });
			await createTestItem(vaultId, userId, { deletedAt: new Date() }); // Soft deleted

			const result = await caller.listItems({ vaultId });

			expect(result.length).toBe(2);
		});

		test("should deny access to non-member", async () => {
			const [{ userId: ownerId }, { caller }] = await Promise.all([
				setup(vaultRouter),
				setup(vaultRouter),
			]);
			const vaultId = await createTestVault(ownerId);

			await expect(caller.listItems({ vaultId })).rejects.toThrow(
				"Access denied to this vault",
			);
		});
	});

	describe("createItem", () => {
		test("should create a new item in the vault", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const vaultId = await createTestVault(userId);

			const result = await caller.createItem({
				vaultId,
				category: "login",
				encryptedData: mockItemData.encryptedData,
				encryptionIv: mockItemData.encryptionIv,
			});

			expect(result.itemId).toBeDefined();

			const item = await getItem(result.itemId);
			expect(item?.category).toBe("login");
			expect(item?.version).toBe(1);
		});

		test("should deny item creation for read-only members", async () => {
			const [{ userId: ownerId }, { userId: readOnlyId, caller }] =
				await Promise.all([setup(vaultRouter), setup(vaultRouter)]);
			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, readOnlyId, "read-only");

			await expect(
				caller.createItem({
					vaultId,
					category: "login",
					encryptedData: mockItemData.encryptedData,
					encryptionIv: mockItemData.encryptionIv,
				}),
			).rejects.toThrow("Read-only access cannot create items");
		});
	});

	describe("updateItem", () => {
		test("should update item data and increment version", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId);

			const result = await caller.updateItem({
				itemId,
				encryptedData: "newEncryptedData123",
				encryptionIv: "newIv456",
			});

			expect(result.success).toBe(true);
			expect(result.version).toBe(2);

			const item = await getItem(itemId);
			expect(item?.encryptedData).toBe("newEncryptedData123");
		});

		test("should detect version conflict", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId, { version: 5 });

			await expect(
				caller.updateItem({
					itemId,
					encryptedData: "newData",
					encryptionIv: "newIv",
					expectedVersion: 3, // Wrong version
				}),
			).rejects.toThrow("Item has been modified by another client");
		});
	});

	describe("deleteItem", () => {
		test("should soft delete an item", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId);

			const result = await caller.deleteItem({ itemId });

			expect(result.success).toBe(true);

			const item = await getItem(itemId);
			expect(item?.deletedAt).toBeDefined();
		});
	});

	describe("toggleFavorite", () => {
		test("should toggle item favorite status", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId, { favorite: false });

			const result = await caller.toggleFavorite({ itemId, favorite: true });

			expect(result.success).toBe(true);

			const item = await getItem(itemId);
			expect(item?.favorite).toBe(true);
		});
	});

	describe("listDeletedItems", () => {
		test("should return only deleted items", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const vaultId = await createTestVault(userId);
			await createTestItem(vaultId, userId); // Not deleted
			await createTestItem(vaultId, userId, { deletedAt: new Date() });
			await createTestItem(vaultId, userId, { deletedAt: new Date() });

			const result = await caller.listDeletedItems({ vaultId });

			expect(result.length).toBe(2);
		});
	});

	describe("restoreItem", () => {
		test("should restore a deleted item", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId, {
				deletedAt: new Date(),
			});

			const result = await caller.restoreItem({ itemId });

			expect(result.success).toBe(true);

			const item = await getItem(itemId);
			expect(item?.deletedAt).toBeNull();
		});

		test("should reject restoring non-deleted item", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId); // Not deleted

			await expect(caller.restoreItem({ itemId })).rejects.toThrow(
				"Item is not deleted",
			);
		});
	});

	describe("permanentlyDeleteItem", () => {
		test("should permanently delete a trashed item", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId, {
				deletedAt: new Date(),
			});

			const result = await caller.permanentlyDeleteItem({ itemId });

			expect(result.success).toBe(true);

			const item = await getItem(itemId);
			expect(item).toBeUndefined();
		});

		test("should reject deleting non-trashed item", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId); // Not deleted

			await expect(caller.permanentlyDeleteItem({ itemId })).rejects.toThrow(
				"Can only permanently delete items in trash",
			);
		});
	});

	describe("bulkImportItems", () => {
		test("should import multiple items at once", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const vaultId = await createTestVault(userId);

			const result = await caller.bulkImportItems({
				vaultId,
				items: [
					{
						category: "login",
						encryptedData: "data1",
						encryptionIv: "iv1",
						encryptionAlgorithm: "AES-GCM",
					},
					{
						category: "secure-note",
						encryptedData: "data2",
						encryptionIv: "iv2",
						encryptionAlgorithm: "AES-GCM",
					},
					{
						category: "credit-card",
						favorite: true,
						encryptedData: "data3",
						encryptionIv: "iv3",
						encryptionAlgorithm: "AES-GCM",
					},
				],
			});

			expect(result.success).toBe(true);
			expect(result.importedCount).toBe(3);
			expect(result.itemIds.length).toBe(3);

			const itemCount = await countVaultItems(vaultId);
			expect(itemCount).toBe(3);
		});
	});

	describe("stats", () => {
		test("should return correct dashboard stats", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const vaultId = await createTestVault(userId);
			await createTestItem(vaultId, userId);
			await createTestItem(vaultId, userId);

			const result = await caller.stats();

			expect(result.vaultCount).toBe(1);
			expect(result.itemCount).toBe(2);
		});
	});

	describe("members.list", () => {
		test("should return all vault members", async () => {
			const [{ userId: ownerId, caller }, { userId: memberId }] =
				await Promise.all([
					setup(vaultRouter, { name: "Owner" }),
					setup(vaultRouter, { name: "Member" }),
				]);
			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, memberId, "member");

			const result = await caller.members.list({ vaultId });

			expect(result.length).toBe(2);
			expect(result.map((m) => m.role)).toContain("owner");
			expect(result.map((m) => m.role)).toContain("member");
		});
	});

	describe("members.updateRole", () => {
		test("should update member role", async () => {
			const [{ userId: ownerId, caller }, { userId: memberId }] =
				await Promise.all([setup(vaultRouter), setup(vaultRouter)]);
			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, memberId, "member");

			const result = await caller.members.updateRole({
				vaultId,
				userId: memberId,
				role: "admin",
			});

			expect(result.success).toBe(true);

			const vaultKey = await getVaultKey(vaultId, memberId);
			expect(vaultKey?.role).toBe("admin");
		});

		test("should not allow changing own role", async () => {
			const { userId: ownerId, caller } = await setup(vaultRouter);
			const vaultId = await createTestVault(ownerId);

			await expect(
				caller.members.updateRole({
					vaultId,
					userId: ownerId,
					role: "admin",
				}),
			).rejects.toThrow("Cannot change your own role");
		});

		test("should not allow changing owner role", async () => {
			const [{ userId: ownerId }, { userId: adminId, caller }] =
				await Promise.all([setup(vaultRouter), setup(vaultRouter)]);
			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, adminId, "admin");

			await expect(
				caller.members.updateRole({
					vaultId,
					userId: ownerId,
					role: "member",
				}),
			).rejects.toThrow("Cannot change vault owner's role");
		});
	});

	describe("members.add", () => {
		test("should add a new member to the vault", async () => {
			const [{ userId: ownerId, caller }, { userId: newMemberId }] =
				await Promise.all([setup(vaultRouter), setup(vaultRouter)]);
			const vaultId = await createTestVault(ownerId);

			const result = await caller.members.add({
				vaultId,
				userId: newMemberId,
				role: "member",
				encryptedVaultKey: mockSrpData.encryptedVaultKey,
			});

			expect(result.success).toBe(true);

			const vaultKey = await getVaultKey(vaultId, newMemberId);
			expect(vaultKey).toBeDefined();
			expect(vaultKey?.role).toBe("member");

			const auditLogs = await db.query.auditLog.findMany({
				where: (log, { and, eq }) =>
					and(eq(log.userId, ownerId), eq(log.action, "vault_member_added")),
			});
			expect(auditLogs.length).toBe(1);
			expect(auditLogs[0]?.entityId).toBe(vaultId);
		});

		test("should reject adding existing member", async () => {
			const [{ userId: ownerId, caller }, { userId: memberId }] =
				await Promise.all([setup(vaultRouter), setup(vaultRouter)]);
			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, memberId, "member");

			await expect(
				caller.members.add({
					vaultId,
					userId: memberId,
					role: "admin",
					encryptedVaultKey: mockSrpData.encryptedVaultKey,
				}),
			).rejects.toThrow("User is already a member of this vault");
		});
	});

	describe("getItem", () => {
		test("should return item by id", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId, {
				category: "login",
			});

			const result = await caller.getItem({ itemId });

			expect(result.id).toBe(itemId);
			expect(result.category).toBe("login");
			expect(result.vaultId).toBe(vaultId);
		});

		test("should deny access to non-member", async () => {
			const [{ userId: ownerId }, { caller }] = await Promise.all([
				setup(vaultRouter),
				setup(vaultRouter),
			]);
			const vaultId = await createTestVault(ownerId);
			const itemId = await createTestItem(vaultId, ownerId);

			await expect(caller.getItem({ itemId })).rejects.toThrow("Access denied");
		});

		test("should throw for non-existent item", async () => {
			const { caller } = await setup(vaultRouter);

			await expect(caller.getItem({ itemId: "nonexistent" })).rejects.toThrow(
				"Item not found",
			);
		});
	});

	describe("listAllItems", () => {
		test("should return items from all accessible vaults", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const vault1 = await createTestVault(userId, { name: "Vault 1" });
			const vault2 = await createTestVault(userId, { name: "Vault 2" });
			await createTestItem(vault1, userId);
			await createTestItem(vault2, userId);

			const result = await caller.listAllItems();

			expect(result.length).toBe(2);
			expect(result[0]?.vault).toBeDefined();
			expect(result[0]?.vault.name).toBeDefined();
		});

		test("should exclude soft-deleted items", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const vaultId = await createTestVault(userId);
			await createTestItem(vaultId, userId);
			await createTestItem(vaultId, userId, { deletedAt: new Date() });

			const result = await caller.listAllItems();

			expect(result.length).toBe(1);
		});

		test("should return empty array for user with no vaults", async () => {
			const { caller } = await setup(vaultRouter);

			const result = await caller.listAllItems();

			expect(result).toEqual([]);
		});
	});

	describe("listAllDeletedItems", () => {
		test("should return deleted items from all vaults", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const vault1 = await createTestVault(userId, { name: "Vault 1" });
			const vault2 = await createTestVault(userId, { name: "Vault 2" });
			await createTestItem(vault1, userId, { deletedAt: new Date() });
			await createTestItem(vault2, userId, { deletedAt: new Date() });
			await createTestItem(vault1, userId); // Not deleted

			const result = await caller.listAllDeletedItems();

			expect(result.length).toBe(2);
			expect(result[0]?.vault).toBeDefined();
		});

		test("should return empty array when no deleted items", async () => {
			const { caller, userId } = await setup(vaultRouter);
			await createTestVault(userId);

			const result = await caller.listAllDeletedItems();

			expect(result).toEqual([]);
		});
	});

	describe("moveItem", () => {
		test("should move item between vaults", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const sourceVault = await createTestVault(userId, { name: "Source" });
			const targetVault = await createTestVault(userId, { name: "Target" });
			const itemId = await createTestItem(sourceVault, userId);

			const result = await caller.moveItem({
				itemId,
				sourceVaultId: sourceVault,
				targetVaultId: targetVault,
				encryptedData: "re-encrypted-data",
				encryptionIv: "new-iv",
			});

			expect(result.success).toBe(true);

			const item = await getItem(itemId);
			expect(item?.vaultId).toBe(targetVault);
			expect(item?.encryptedData).toBe("re-encrypted-data");
		});

		test("should reject moving non-existent item", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const vaultId = await createTestVault(userId);

			await expect(
				caller.moveItem({
					itemId: "nonexistent",
					sourceVaultId: vaultId,
					targetVaultId: vaultId,
					encryptedData: "data",
					encryptionIv: "iv",
				}),
			).rejects.toThrow("Item not found");
		});

		test("should reject if item is not in source vault", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const vault1 = await createTestVault(userId, { name: "Vault 1" });
			const vault2 = await createTestVault(userId, { name: "Vault 2" });
			const itemId = await createTestItem(vault1, userId);

			await expect(
				caller.moveItem({
					itemId,
					sourceVaultId: vault2, // Wrong source
					targetVaultId: vault1,
					encryptedData: "data",
					encryptionIv: "iv",
				}),
			).rejects.toThrow("Item does not belong to the source vault");
		});

		test("should reject moving deleted items", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const sourceVault = await createTestVault(userId);
			const targetVault = await createTestVault(userId);
			const itemId = await createTestItem(sourceVault, userId, {
				deletedAt: new Date(),
			});

			await expect(
				caller.moveItem({
					itemId,
					sourceVaultId: sourceVault,
					targetVaultId: targetVault,
					encryptedData: "data",
					encryptionIv: "iv",
				}),
			).rejects.toThrow("Cannot move items that are in trash");
		});

		test("should reject moving to read-only target vault", async () => {
			const [{ userId: ownerId }, { userId: memberId, caller }] =
				await Promise.all([setup(vaultRouter), setup(vaultRouter)]);
			const sourceVault = await createTestVault(ownerId);
			const targetVault = await createTestVault(ownerId);
			await addVaultMember(sourceVault, memberId, "member");
			await addVaultMember(targetVault, memberId, "read-only");
			const itemId = await createTestItem(sourceVault, ownerId);

			await expect(
				caller.moveItem({
					itemId,
					sourceVaultId: sourceVault,
					targetVaultId: targetVault,
					encryptedData: "data",
					encryptionIv: "iv",
				}),
			).rejects.toThrow("Cannot move items to a read-only vault");
		});

		test("should reject if user has no access to source vault", async () => {
			const [{ userId: ownerId }, { userId: otherId, caller }] =
				await Promise.all([setup(vaultRouter), setup(vaultRouter)]);
			const sourceVault = await createTestVault(ownerId);
			const targetVault = await createTestVault(otherId);
			const itemId = await createTestItem(sourceVault, ownerId);

			await expect(
				caller.moveItem({
					itemId,
					sourceVaultId: sourceVault,
					targetVaultId: targetVault,
					encryptedData: "data",
					encryptionIv: "iv",
				}),
			).rejects.toThrow("No access to source vault");
		});
	});

	describe("updateItem - edge cases", () => {
		test("should deny update for read-only members", async () => {
			const [{ userId: ownerId }, { userId: readOnlyId, caller }] =
				await Promise.all([setup(vaultRouter), setup(vaultRouter)]);
			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, readOnlyId, "read-only");
			const itemId = await createTestItem(vaultId, ownerId);

			await expect(
				caller.updateItem({
					itemId,
					encryptedData: "hacked",
					encryptionIv: "iv",
				}),
			).rejects.toThrow("Access denied");
		});

		test("should throw for non-existent item", async () => {
			const { caller } = await setup(vaultRouter);

			await expect(
				caller.updateItem({
					itemId: "nonexistent",
					encryptedData: "data",
					encryptionIv: "iv",
				}),
			).rejects.toThrow("Item not found");
		});
	});

	describe("deleteItem - edge cases", () => {
		test("should deny deletion for read-only members", async () => {
			const [{ userId: ownerId }, { userId: readOnlyId, caller }] =
				await Promise.all([setup(vaultRouter), setup(vaultRouter)]);
			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, readOnlyId, "read-only");
			const itemId = await createTestItem(vaultId, ownerId);

			await expect(caller.deleteItem({ itemId })).rejects.toThrow(
				"Access denied",
			);
		});

		test("should throw for non-existent item", async () => {
			const { caller } = await setup(vaultRouter);

			await expect(
				caller.deleteItem({ itemId: "nonexistent" }),
			).rejects.toThrow("Item not found");
		});
	});

	describe("toggleFavorite - edge cases", () => {
		test("should deny favorite toggle for read-only members", async () => {
			const [{ userId: ownerId }, { userId: readOnlyId, caller }] =
				await Promise.all([setup(vaultRouter), setup(vaultRouter)]);
			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, readOnlyId, "read-only");
			const itemId = await createTestItem(vaultId, ownerId);

			await expect(
				caller.toggleFavorite({ itemId, favorite: true }),
			).rejects.toThrow("Access denied");
		});
	});

	describe("bulkImportItems - edge cases", () => {
		test("should deny import for read-only members", async () => {
			const [{ userId: ownerId }, { userId: readOnlyId, caller }] =
				await Promise.all([setup(vaultRouter), setup(vaultRouter)]);
			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, readOnlyId, "read-only");

			await expect(
				caller.bulkImportItems({
					vaultId,
					items: [
						{
							category: "login",
							encryptedData: "data",
							encryptionIv: "iv",
						},
					],
				}),
			).rejects.toThrow("Read-only access cannot create items");
		});

		test("should deny import for non-member", async () => {
			const [{ userId: ownerId }, { caller }] = await Promise.all([
				setup(vaultRouter),
				setup(vaultRouter),
			]);
			const vaultId = await createTestVault(ownerId);

			await expect(
				caller.bulkImportItems({
					vaultId,
					items: [
						{
							category: "login",
							encryptedData: "data",
							encryptionIv: "iv",
						},
					],
				}),
			).rejects.toThrow("Access denied to this vault");
		});
	});

	describe("restoreItem - edge cases", () => {
		test("should deny restore for read-only members", async () => {
			const [{ userId: ownerId }, { userId: readOnlyId, caller }] =
				await Promise.all([setup(vaultRouter), setup(vaultRouter)]);
			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, readOnlyId, "read-only");
			const itemId = await createTestItem(vaultId, ownerId, {
				deletedAt: new Date(),
			});

			await expect(caller.restoreItem({ itemId })).rejects.toThrow(
				"Access denied",
			);
		});
	});

	describe("permanentlyDeleteItem - edge cases", () => {
		test("should deny permanent deletion for read-only members", async () => {
			const [{ userId: ownerId }, { userId: readOnlyId, caller }] =
				await Promise.all([setup(vaultRouter), setup(vaultRouter)]);
			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, readOnlyId, "read-only");
			const itemId = await createTestItem(vaultId, ownerId, {
				deletedAt: new Date(),
			});

			await expect(caller.permanentlyDeleteItem({ itemId })).rejects.toThrow(
				"Access denied",
			);
		});
	});

	describe("members.updateRole - edge cases", () => {
		test("should deny admin from changing other admin's role", async () => {
			const [
				{ userId: ownerId },
				{ userId: admin1Id, caller },
				{ userId: admin2Id },
			] = await Promise.all([
				setup(vaultRouter),
				setup(vaultRouter),
				setup(vaultRouter),
			]);
			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, admin1Id, "admin");
			await addVaultMember(vaultId, admin2Id, "admin");

			await expect(
				caller.members.updateRole({
					vaultId,
					userId: admin2Id,
					role: "member",
				}),
			).rejects.toThrow("Admins cannot change other admins");
		});

		test("should deny non-owner/admin from changing roles", async () => {
			const [
				{ userId: ownerId },
				{ userId: memberId, caller },
				{ userId: targetId },
			] = await Promise.all([
				setup(vaultRouter),
				setup(vaultRouter),
				setup(vaultRouter),
			]);
			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, memberId, "member");
			await addVaultMember(vaultId, targetId, "read-only");

			await expect(
				caller.members.updateRole({
					vaultId,
					userId: targetId,
					role: "member",
				}),
			).rejects.toThrow("Only vault owner or admin can change roles");
		});
	});

	describe("members.add - edge cases", () => {
		test("should deny non-owner/admin from adding members", async () => {
			const [
				{ userId: ownerId },
				{ userId: memberId, caller },
				{ userId: newUserId },
			] = await Promise.all([
				setup(vaultRouter),
				setup(vaultRouter),
				setup(vaultRouter),
			]);
			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, memberId, "member");

			await expect(
				caller.members.add({
					vaultId,
					userId: newUserId,
					role: "member",
					encryptedVaultKey: mockSrpData.encryptedVaultKey,
				}),
			).rejects.toThrow("Only vault owner or admin can add members");
		});

		test("should throw NOT_FOUND for non-existent user", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const vaultId = await createTestVault(userId);

			await expect(
				caller.members.add({
					vaultId,
					userId: "nonexistent-user",
					role: "member",
					encryptedVaultKey: mockSrpData.encryptedVaultKey,
				}),
			).rejects.toThrow("User not found");
		});
	});

	describe("members.remove", () => {
		test("should remove member with key rotation", async () => {
			const [{ userId: ownerId, caller }, { userId: memberId }] =
				await Promise.all([setup(vaultRouter), setup(vaultRouter)]);
			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, memberId, "member");
			const itemId = await createTestItem(vaultId, ownerId);

			const result = await caller.members.remove({
				vaultId,
				userId: memberId,
				keyRotation: {
					memberKeys: [
						{
							userId: ownerId,
							encryptedVaultKey: "new-encrypted-key-for-owner",
						},
					],
					reEncryptedItems: [
						{
							itemId,
							encryptedData: "re-encrypted-data",
							encryptionIv: "new-iv",
						},
					],
				},
			});

			expect(result.success).toBe(true);
			expect(result.keyRotation.newKeyVersion).toBe(2);
			expect(result.keyRotation.itemsReEncrypted).toBe(1);
			expect(result.keyRotation.membersUpdated).toBe(1);

			// Verify member was removed
			const vaultKey = await getVaultKey(vaultId, memberId);
			expect(vaultKey).toBeUndefined();

			// Verify items were re-encrypted
			const item = await getItem(itemId);
			expect(item?.encryptedData).toBe("re-encrypted-data");

			const auditLogs = await db.query.auditLog.findMany({
				where: (log, { and, eq }) =>
					and(eq(log.userId, ownerId), eq(log.action, "vault_member_removed")),
			});
			expect(auditLogs.length).toBe(1);
			expect(auditLogs[0]?.entityId).toBe(vaultId);
		});

		test("should rollback key rotation if an item update fails", async () => {
			const [{ userId: ownerId, caller }, { userId: memberId }] =
				await Promise.all([setup(vaultRouter), setup(vaultRouter)]);
			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, memberId, "member");
			const itemId = await createTestItem(vaultId, ownerId);

			await expect(
				caller.members.remove({
					vaultId,
					userId: memberId,
					keyRotation: {
						memberKeys: [
							{
								userId: ownerId,
								encryptedVaultKey: "new-encrypted-key-for-owner",
							},
						],
						reEncryptedItems: [
							{
								itemId: "non-existent-item",
								encryptedData: "re-encrypted-data",
								encryptionIv: "new-iv",
							},
						],
					},
				}),
			).rejects.toThrow("Key rotation failed. Please try again.");

			const memberVaultKey = await getVaultKey(vaultId, memberId);
			expect(memberVaultKey).toBeDefined();

			const unchangedItem = await getItem(itemId);
			expect(unchangedItem?.encryptedData).toBe(mockItemData.encryptedData);
		});

		test("should deny non-owner/admin from removing members", async () => {
			const [
				{ userId: ownerId },
				{ userId: memberId, caller },
				{ userId: targetId },
			] = await Promise.all([
				setup(vaultRouter),
				setup(vaultRouter),
				setup(vaultRouter),
			]);
			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, memberId, "member");
			await addVaultMember(vaultId, targetId, "member");

			await expect(
				caller.members.remove({
					vaultId,
					userId: targetId,
					keyRotation: {
						memberKeys: [],
						reEncryptedItems: [],
					},
				}),
			).rejects.toThrow("Only vault owner or admin can remove members");
		});

		test("should not allow removing yourself", async () => {
			const { caller, userId } = await setup(vaultRouter);
			const vaultId = await createTestVault(userId);

			await expect(
				caller.members.remove({
					vaultId,
					userId,
					keyRotation: {
						memberKeys: [],
						reEncryptedItems: [],
					},
				}),
			).rejects.toThrow("Cannot remove yourself");
		});

		test("should not allow removing vault owner", async () => {
			const [{ userId: ownerId }, { userId: adminId, caller }] =
				await Promise.all([setup(vaultRouter), setup(vaultRouter)]);
			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, adminId, "admin");

			await expect(
				caller.members.remove({
					vaultId,
					userId: ownerId,
					keyRotation: {
						memberKeys: [],
						reEncryptedItems: [],
					},
				}),
			).rejects.toThrow("Cannot remove vault owner");
		});

		test("should not allow admin to remove other admin", async () => {
			const [
				{ userId: ownerId },
				{ userId: admin1Id, caller },
				{ userId: admin2Id },
			] = await Promise.all([
				setup(vaultRouter),
				setup(vaultRouter),
				setup(vaultRouter),
			]);
			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, admin1Id, "admin");
			await addVaultMember(vaultId, admin2Id, "admin");

			await expect(
				caller.members.remove({
					vaultId,
					userId: admin2Id,
					keyRotation: {
						memberKeys: [],
						reEncryptedItems: [],
					},
				}),
			).rejects.toThrow("Admins cannot remove other admins");
		});
	});

	describe("members.getRotationData", () => {
		test("should return remaining members and items", async () => {
			const [{ userId: ownerId, caller }, { userId: memberId }] =
				await Promise.all([setup(vaultRouter), setup(vaultRouter)]);
			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, memberId, "member");
			await createTestItem(vaultId, ownerId);
			await createTestItem(vaultId, ownerId);

			const result = await caller.members.getRotationData({
				vaultId,
				excludeUserId: memberId,
			});

			expect(result.members.length).toBe(1); // Only owner remains
			expect(result.members[0]?.userId).toBe(ownerId);
			expect(result.members[0]?.publicKey).toBeDefined();
			expect(result.items.length).toBe(2);
		});

		test("should deny non-owner/admin from getting rotation data", async () => {
			const [
				{ userId: ownerId },
				{ userId: memberId, caller },
				{ userId: targetId },
			] = await Promise.all([
				setup(vaultRouter),
				setup(vaultRouter),
				setup(vaultRouter),
			]);
			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, memberId, "member");
			await addVaultMember(vaultId, targetId, "member");

			await expect(
				caller.members.getRotationData({
					vaultId,
					excludeUserId: targetId,
				}),
			).rejects.toThrow("Only vault owner or admin can perform key rotation");
		});
	});

	describe("members.lookupUser", () => {
		test("should find user by email and return public key", async () => {
			const [{ userId: lookupUserId, email: lookupEmail }, { caller }] =
				await Promise.all([
					setup(vaultRouter, { name: "Lookup User" }),
					setup(vaultRouter),
				]);

			const result = await caller.members.lookupUser({ email: lookupEmail });

			expect(result.id).toBe(lookupUserId);
			expect(result.name).toBe("Lookup User");
			expect(result.publicKey).toBe(mockSrpData.publicKey);
		});

		test("should not allow looking up yourself", async () => {
			const { email, caller } = await setup(vaultRouter);

			await expect(caller.members.lookupUser({ email })).rejects.toThrow(
				"Cannot add yourself as a member",
			);
		});

		test("should throw NOT_FOUND for non-existent user", async () => {
			const { caller } = await setup(vaultRouter);

			await expect(
				caller.members.lookupUser({ email: "nonexistent@example.com" }),
			).rejects.toThrow("User not found");
		});
	});
});
