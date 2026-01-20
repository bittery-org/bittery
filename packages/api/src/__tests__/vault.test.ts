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

import { describe, expect, test, afterEach } from "bun:test";
import { vaultRouter } from "../routers/vault";
import {
	createAuthenticatedContext,
	createPublicContext,
	createTestUser,
	createTestSession,
	createTestVault,
	createTestItem,
	addVaultMember,
	cleanupTestData,
	mockSrpData,
	mockItemData,
	generateTestEmail,
	getVault,
	getItem,
	getVaultKey,
	countVaultItems,
} from "./test-utils";

describe("Vault Router", () => {
	const testUserIds: string[] = [];

	afterEach(async () => {
		await cleanupTestData(testUserIds);
		testUserIds.length = 0;
	});

	describe("list", () => {
		test("should return all vaults for the current user", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			await createTestVault(userId, { name: "Vault 1" });
			await createTestVault(userId, { name: "Vault 2" });

			const sessionId = await createTestSession(userId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId)
			);

			const result = await caller.list();

			expect(result.length).toBe(2);
			expect(result.map((v) => v.name)).toContain("Vault 1");
			expect(result.map((v) => v.name)).toContain("Vault 2");
		});

		test("should return empty array for user with no vaults", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const sessionId = await createTestSession(userId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId)
			);

			const result = await caller.list();

			expect(result).toEqual([]);
		});

		test("should include vault items in response", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const vaultId = await createTestVault(userId, { name: "Test Vault" });
			await createTestItem(vaultId, userId);
			await createTestItem(vaultId, userId);

			const sessionId = await createTestSession(userId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId)
			);

			const result = await caller.list();

			expect(result[0].items.length).toBe(2);
		});
	});

	describe("get", () => {
		test("should return vault details with item count", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const vaultId = await createTestVault(userId, { name: "My Vault" });
			await createTestItem(vaultId, userId);
			await createTestItem(vaultId, userId);
			await createTestItem(vaultId, userId);

			const sessionId = await createTestSession(userId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId)
			);

			const result = await caller.get({ vaultId });

			expect(result.id).toBe(vaultId);
			expect(result.name).toBe("My Vault");
			expect(result.itemCount).toBe(3);
			expect(result.userRole).toBe("owner");
		});

		test("should throw NOT_FOUND for non-existent vault", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const sessionId = await createTestSession(userId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId)
			);

			await expect(caller.get({ vaultId: "nonexistent" })).rejects.toThrow(
				"Vault not found or access denied"
			);
		});

		test("should deny access to vault user is not member of", async () => {
			const email1 = generateTestEmail();
			const email2 = generateTestEmail();
			const { userId: userId1 } = await createTestUser({ email: email1 });
			const { userId: userId2 } = await createTestUser({ email: email2 });
			testUserIds.push(userId1, userId2);

			const vaultId = await createTestVault(userId1);

			const sessionId = await createTestSession(userId2);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(userId2, email2, sessionId)
			);

			await expect(caller.get({ vaultId })).rejects.toThrow(
				"Vault not found or access denied"
			);
		});
	});

	describe("create", () => {
		test("should create a new vault", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const sessionId = await createTestSession(userId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId)
			);

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
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const sessionId = await createTestSession(userId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId)
			);

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
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const vaultId = await createTestVault(userId, { name: "Old Name" });

			const sessionId = await createTestSession(userId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId)
			);

			const result = await caller.update({
				vaultId,
				name: "New Name",
				icon: "star",
			});

			expect(result.name).toBe("New Name");
			expect(result.icon).toBe("star");
		});

		test("should deny update for non-admin members", async () => {
			const email1 = generateTestEmail();
			const email2 = generateTestEmail();
			const { userId: ownerId } = await createTestUser({ email: email1 });
			const { userId: memberId } = await createTestUser({ email: email2 });
			testUserIds.push(ownerId, memberId);

			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, memberId, "member");

			const sessionId = await createTestSession(memberId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(memberId, email2, sessionId)
			);

			await expect(
				caller.update({ vaultId, name: "Hacked Name" })
			).rejects.toThrow("Access denied");
		});

		test("should allow admin to update vault", async () => {
			const email1 = generateTestEmail();
			const email2 = generateTestEmail();
			const { userId: ownerId } = await createTestUser({ email: email1 });
			const { userId: adminId } = await createTestUser({ email: email2 });
			testUserIds.push(ownerId, adminId);

			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, adminId, "admin");

			const sessionId = await createTestSession(adminId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(adminId, email2, sessionId)
			);

			const result = await caller.update({ vaultId, name: "Admin Updated" });

			expect(result.name).toBe("Admin Updated");
		});
	});

	describe("delete", () => {
		test("should delete vault and all its items", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const vaultId = await createTestVault(userId);
			await createTestItem(vaultId, userId);
			await createTestItem(vaultId, userId);

			const sessionId = await createTestSession(userId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId)
			);

			const result = await caller.delete({ vaultId });

			expect(result.success).toBe(true);

			const vault = await getVault(vaultId);
			expect(vault).toBeUndefined();
		});

		test("should deny deletion by non-owner", async () => {
			const email1 = generateTestEmail();
			const email2 = generateTestEmail();
			const { userId: ownerId } = await createTestUser({ email: email1 });
			const { userId: adminId } = await createTestUser({ email: email2 });
			testUserIds.push(ownerId, adminId);

			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, adminId, "admin");

			const sessionId = await createTestSession(adminId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(adminId, email2, sessionId)
			);

			await expect(caller.delete({ vaultId })).rejects.toThrow(
				"Only the vault owner can delete the vault"
			);
		});
	});

	describe("listItems", () => {
		test("should return all non-deleted items in a vault", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const vaultId = await createTestVault(userId);
			await createTestItem(vaultId, userId, { category: "login" });
			await createTestItem(vaultId, userId, { category: "secure-note" });
			await createTestItem(vaultId, userId, { deletedAt: new Date() }); // Soft deleted

			const sessionId = await createTestSession(userId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId)
			);

			const result = await caller.listItems({ vaultId });

			expect(result.length).toBe(2);
		});

		test("should deny access to non-member", async () => {
			const email1 = generateTestEmail();
			const email2 = generateTestEmail();
			const { userId: ownerId } = await createTestUser({ email: email1 });
			const { userId: otherId } = await createTestUser({ email: email2 });
			testUserIds.push(ownerId, otherId);

			const vaultId = await createTestVault(ownerId);

			const sessionId = await createTestSession(otherId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(otherId, email2, sessionId)
			);

			await expect(caller.listItems({ vaultId })).rejects.toThrow(
				"Access denied to this vault"
			);
		});
	});

	describe("createItem", () => {
		test("should create a new item in the vault", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const vaultId = await createTestVault(userId);

			const sessionId = await createTestSession(userId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId)
			);

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
			const email1 = generateTestEmail();
			const email2 = generateTestEmail();
			const { userId: ownerId } = await createTestUser({ email: email1 });
			const { userId: readOnlyId } = await createTestUser({ email: email2 });
			testUserIds.push(ownerId, readOnlyId);

			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, readOnlyId, "read-only");

			const sessionId = await createTestSession(readOnlyId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(readOnlyId, email2, sessionId)
			);

			await expect(
				caller.createItem({
					vaultId,
					category: "login",
					encryptedData: mockItemData.encryptedData,
					encryptionIv: mockItemData.encryptionIv,
				})
			).rejects.toThrow("Read-only access cannot create items");
		});
	});

	describe("updateItem", () => {
		test("should update item data and increment version", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId);

			const sessionId = await createTestSession(userId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId)
			);

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
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId, { version: 5 });

			const sessionId = await createTestSession(userId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId)
			);

			await expect(
				caller.updateItem({
					itemId,
					encryptedData: "newData",
					encryptionIv: "newIv",
					expectedVersion: 3, // Wrong version
				})
			).rejects.toThrow("Item has been modified by another client");
		});
	});

	describe("deleteItem", () => {
		test("should soft delete an item", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId);

			const sessionId = await createTestSession(userId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId)
			);

			const result = await caller.deleteItem({ itemId });

			expect(result.success).toBe(true);

			const item = await getItem(itemId);
			expect(item?.deletedAt).toBeDefined();
		});
	});

	describe("toggleFavorite", () => {
		test("should toggle item favorite status", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId, { favorite: false });

			const sessionId = await createTestSession(userId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId)
			);

			const result = await caller.toggleFavorite({ itemId, favorite: true });

			expect(result.success).toBe(true);

			const item = await getItem(itemId);
			expect(item?.favorite).toBe(true);
		});
	});

	describe("listDeletedItems", () => {
		test("should return only deleted items", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const vaultId = await createTestVault(userId);
			await createTestItem(vaultId, userId); // Not deleted
			await createTestItem(vaultId, userId, { deletedAt: new Date() });
			await createTestItem(vaultId, userId, { deletedAt: new Date() });

			const sessionId = await createTestSession(userId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId)
			);

			const result = await caller.listDeletedItems({ vaultId });

			expect(result.length).toBe(2);
		});
	});

	describe("restoreItem", () => {
		test("should restore a deleted item", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId, {
				deletedAt: new Date(),
			});

			const sessionId = await createTestSession(userId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId)
			);

			const result = await caller.restoreItem({ itemId });

			expect(result.success).toBe(true);

			const item = await getItem(itemId);
			expect(item?.deletedAt).toBeNull();
		});

		test("should reject restoring non-deleted item", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId); // Not deleted

			const sessionId = await createTestSession(userId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId)
			);

			await expect(caller.restoreItem({ itemId })).rejects.toThrow(
				"Item is not deleted"
			);
		});
	});

	describe("permanentlyDeleteItem", () => {
		test("should permanently delete a trashed item", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId, {
				deletedAt: new Date(),
			});

			const sessionId = await createTestSession(userId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId)
			);

			const result = await caller.permanentlyDeleteItem({ itemId });

			expect(result.success).toBe(true);

			const item = await getItem(itemId);
			expect(item).toBeUndefined();
		});

		test("should reject deleting non-trashed item", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const vaultId = await createTestVault(userId);
			const itemId = await createTestItem(vaultId, userId); // Not deleted

			const sessionId = await createTestSession(userId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId)
			);

			await expect(
				caller.permanentlyDeleteItem({ itemId })
			).rejects.toThrow("Can only permanently delete items in trash");
		});
	});

	describe("bulkImportItems", () => {
		test("should import multiple items at once", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const vaultId = await createTestVault(userId);

			const sessionId = await createTestSession(userId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId)
			);

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
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const vaultId = await createTestVault(userId);
			await createTestItem(vaultId, userId);
			await createTestItem(vaultId, userId);

			const sessionId = await createTestSession(userId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId)
			);

			const result = await caller.stats();

			expect(result.vaultCount).toBe(1);
			expect(result.itemCount).toBe(2);
		});
	});

	describe("members.list", () => {
		test("should return all vault members", async () => {
			const email1 = generateTestEmail();
			const email2 = generateTestEmail();
			const { userId: ownerId } = await createTestUser({
				email: email1,
				name: "Owner",
			});
			const { userId: memberId } = await createTestUser({
				email: email2,
				name: "Member",
			});
			testUserIds.push(ownerId, memberId);

			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, memberId, "member");

			const sessionId = await createTestSession(ownerId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(ownerId, email1, sessionId)
			);

			const result = await caller.members.list({ vaultId });

			expect(result.length).toBe(2);
			expect(result.map((m) => m.role)).toContain("owner");
			expect(result.map((m) => m.role)).toContain("member");
		});
	});

	describe("members.updateRole", () => {
		test("should update member role", async () => {
			const email1 = generateTestEmail();
			const email2 = generateTestEmail();
			const { userId: ownerId } = await createTestUser({ email: email1 });
			const { userId: memberId } = await createTestUser({ email: email2 });
			testUserIds.push(ownerId, memberId);

			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, memberId, "member");

			const sessionId = await createTestSession(ownerId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(ownerId, email1, sessionId)
			);

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
			const email = generateTestEmail();
			const { userId: ownerId } = await createTestUser({ email });
			testUserIds.push(ownerId);

			const vaultId = await createTestVault(ownerId);

			const sessionId = await createTestSession(ownerId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(ownerId, email, sessionId)
			);

			await expect(
				caller.members.updateRole({
					vaultId,
					userId: ownerId,
					role: "admin",
				})
			).rejects.toThrow("Cannot change your own role");
		});

		test("should not allow changing owner role", async () => {
			const email1 = generateTestEmail();
			const email2 = generateTestEmail();
			const { userId: ownerId } = await createTestUser({ email: email1 });
			const { userId: adminId } = await createTestUser({ email: email2 });
			testUserIds.push(ownerId, adminId);

			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, adminId, "admin");

			const sessionId = await createTestSession(adminId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(adminId, email2, sessionId)
			);

			await expect(
				caller.members.updateRole({
					vaultId,
					userId: ownerId,
					role: "member",
				})
			).rejects.toThrow("Cannot change vault owner's role");
		});
	});

	describe("members.add", () => {
		test("should add a new member to the vault", async () => {
			const email1 = generateTestEmail();
			const email2 = generateTestEmail();
			const { userId: ownerId } = await createTestUser({ email: email1 });
			const { userId: newMemberId } = await createTestUser({ email: email2 });
			testUserIds.push(ownerId, newMemberId);

			const vaultId = await createTestVault(ownerId);

			const sessionId = await createTestSession(ownerId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(ownerId, email1, sessionId)
			);

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
		});

		test("should reject adding existing member", async () => {
			const email1 = generateTestEmail();
			const email2 = generateTestEmail();
			const { userId: ownerId } = await createTestUser({ email: email1 });
			const { userId: memberId } = await createTestUser({ email: email2 });
			testUserIds.push(ownerId, memberId);

			const vaultId = await createTestVault(ownerId);
			await addVaultMember(vaultId, memberId, "member");

			const sessionId = await createTestSession(ownerId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(ownerId, email1, sessionId)
			);

			await expect(
				caller.members.add({
					vaultId,
					userId: memberId,
					role: "admin",
					encryptedVaultKey: mockSrpData.encryptedVaultKey,
				})
			).rejects.toThrow("User is already a member of this vault");
		});
	});

	describe("members.lookupUser", () => {
		test("should find user by email and return public key", async () => {
			const email1 = generateTestEmail();
			const email2 = generateTestEmail();
			const { userId: lookupUserId } = await createTestUser({
				email: email1,
				name: "Lookup User",
			});
			const { userId: searcherId } = await createTestUser({ email: email2 });
			testUserIds.push(lookupUserId, searcherId);

			const sessionId = await createTestSession(searcherId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(searcherId, email2, sessionId)
			);

			const result = await caller.members.lookupUser({ email: email1 });

			expect(result.id).toBe(lookupUserId);
			expect(result.name).toBe("Lookup User");
			expect(result.publicKey).toBe(mockSrpData.publicKey);
		});

		test("should not allow looking up yourself", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const sessionId = await createTestSession(userId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId)
			);

			await expect(caller.members.lookupUser({ email })).rejects.toThrow(
				"Cannot add yourself as a member"
			);
		});

		test("should throw NOT_FOUND for non-existent user", async () => {
			const email = generateTestEmail();
			const { userId } = await createTestUser({ email });
			testUserIds.push(userId);

			const sessionId = await createTestSession(userId);
			const caller = vaultRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId)
			);

			await expect(
				caller.members.lookupUser({ email: "nonexistent@example.com" })
			).rejects.toThrow("User not found");
		});
	});
});
