/**
 * Key Rotation Feature Verification Test
 *
 * This test verifies the shared vault key encryption feature:
 * - Vault keys are encrypted with recipient RSA public keys when sharing
 * - Key rotation and re-encryption works correctly when access is revoked
 */

import { describe, expect, test } from "bun:test";
import {
	decrypt,
	type EncryptedData,
	encrypt,
	generateEncryptionKey,
} from "./encryption";
import { arrayBufferToBase64 } from "./key-derivation";
import {
	encryptVaultKeyForMember,
	performKeyRotation,
	reEncryptItem,
	validateRotationData,
} from "./key-rotation";
import { generateRSAKeyPair, rsaDecrypt } from "./rsa";

describe("Shared Vault Key Encryption Feature", () => {
	test("should generate valid RSA key pairs", async () => {
		const keys = await generateRSAKeyPair();

		expect(keys.publicKey).toContain("-----BEGIN PUBLIC KEY-----");
		expect(keys.publicKey).toContain("-----END PUBLIC KEY-----");
		expect(keys.privateKey).toContain("-----BEGIN PRIVATE KEY-----");
		expect(keys.privateKey).toContain("-----END PRIVATE KEY-----");
	});

	test("should encrypt vault keys with RSA public keys for sharing", async () => {
		// Generate RSA key pair for a team member
		const memberKeys = await generateRSAKeyPair();

		// Generate a vault key (AES-256)
		const originalVaultKey = generateEncryptionKey();
		const originalVaultKeyBase64 = arrayBufferToBase64(originalVaultKey);

		// Encrypt vault key for member using their RSA public key
		const encryptedVaultKey = await encryptVaultKeyForMember(
			originalVaultKey,
			memberKeys.publicKey,
		);

		// Member should be able to decrypt with their private key
		const decryptedVaultKey = await rsaDecrypt(
			encryptedVaultKey,
			memberKeys.privateKey,
		);

		// Verify the decrypted key matches the original
		expect(decryptedVaultKey).toBe(originalVaultKeyBase64);
	});

	test("should re-encrypt items with new vault key", async () => {
		// Create original vault key and item
		const originalVaultKey = generateEncryptionKey();
		const testItemData = JSON.stringify({
			title: "Test Login",
			username: "test@example.com",
			password: "supersecret123",
		});

		// Encrypt item with original vault key
		const encryptedItem = await encrypt(testItemData, originalVaultKey);
		const itemForRotation = {
			id: "test-item-1",
			encryptedData: encryptedItem.ciphertext,
			encryptionIv: encryptedItem.iv,
			encryptionAlgorithm: encryptedItem.algorithm,
		};

		// Generate a new vault key for rotation
		const newVaultKey = generateEncryptionKey();

		// Re-encrypt the item with the new key
		const reEncryptedItem = await reEncryptItem(
			itemForRotation,
			originalVaultKey,
			newVaultKey,
		);

		// Verify the re-encrypted item can be decrypted with the new key
		const decryptedItemData = await decrypt(
			{
				ciphertext: reEncryptedItem.encryptedData,
				iv: reEncryptedItem.encryptionIv,
				algorithm: "AES-GCM",
			},
			newVaultKey,
		);

		const parsedItem = JSON.parse(decryptedItemData);
		expect(parsedItem.password).toBe("supersecret123");
		expect(parsedItem.title).toBe("Test Login");
	});

	test("should perform full key rotation when member is removed", async () => {
		// Generate RSA key pairs for team members
		const ownerKeys = await generateRSAKeyPair();
		const member1Keys = await generateRSAKeyPair();
		// const member2Keys = await generateRSAKeyPair();

		// Generate original vault key
		const originalVaultKey = generateEncryptionKey();

		// Create items encrypted with original vault key
		const item1 = await encrypt("Item 1 secret data", originalVaultKey);
		const item2 = await encrypt("Item 2 secret data", originalVaultKey);

		const itemsToRotate = [
			{
				id: "item-1",
				encryptedData: item1.ciphertext,
				encryptionIv: item1.iv,
				encryptionAlgorithm: item1.algorithm,
			},
			{
				id: "item-2",
				encryptedData: item2.ciphertext,
				encryptionIv: item2.iv,
				encryptionAlgorithm: item2.algorithm,
			},
		];

		// Simulate removing member2, only owner and member1 remain
		const remainingMembers = [
			{ userId: "owner-id", publicKey: ownerKeys.publicKey },
			{ userId: "member1-id", publicKey: member1Keys.publicKey },
		];

		// Perform key rotation
		const mockMasterUnlockKey = generateEncryptionKey();
		const rotationResult = await performKeyRotation(
			originalVaultKey,
			remainingMembers,
			itemsToRotate,
			"owner-id",
			mockMasterUnlockKey,
		);

		// Verify all remaining members got new encrypted keys
		expect(rotationResult.memberEncryptedKeys.length).toBe(2);

		// Verify all items were re-encrypted
		expect(rotationResult.reEncryptedItems.length).toBe(2);

		// Verify owner can decrypt the new vault key (encrypted with AES-GCM using Master Unlock Key)
		const ownerKeyEntry = rotationResult.memberEncryptedKeys.find(
			(k) => k.userId === "owner-id",
		);
		expect(ownerKeyEntry).toBeDefined();

		// Owner's key is AES-GCM encrypted with Master Unlock Key, not RSA encrypted
		const ownerEncryptedData = JSON.parse(
			// biome-ignore lint/style/noNonNullAssertion: We know this is defined here
			ownerKeyEntry!.encryptedVaultKey,
		) as EncryptedData;
		const ownerDecryptedKey = await decrypt(
			ownerEncryptedData,
			mockMasterUnlockKey,
		);
		expect(ownerDecryptedKey).toBe(rotationResult.newVaultKeyBase64);

		// Verify member1 can decrypt the new vault key
		const member1KeyEntry = rotationResult.memberEncryptedKeys.find(
			(k) => k.userId === "member1-id",
		);
		expect(member1KeyEntry).toBeDefined();

		const member1DecryptedKey = await rsaDecrypt(
			// biome-ignore lint/style/noNonNullAssertion: We know this is defined here
			member1KeyEntry!.encryptedVaultKey,
			member1Keys.privateKey,
		);
		expect(member1DecryptedKey).toBe(rotationResult.newVaultKeyBase64);

		// Verify re-encrypted items can be decrypted with new key
		const reEncryptedItem1 = rotationResult.reEncryptedItems[0];
		expect(reEncryptedItem1).toBeDefined();
		const decryptedItem1 = await decrypt(
			{
				// biome-ignore lint/style/noNonNullAssertion: We verified above it's defined
				ciphertext: reEncryptedItem1!.encryptedData,
				// biome-ignore lint/style/noNonNullAssertion: We verified above it's defined
				iv: reEncryptedItem1!.encryptionIv,
				algorithm: "AES-GCM",
			},
			rotationResult.newVaultKey,
		);
		expect(decryptedItem1).toBe("Item 1 secret data");
	});

	test("should prevent old key from decrypting new data after rotation", async () => {
		// Generate keys
		const memberKeys = await generateRSAKeyPair();
		const originalVaultKey = generateEncryptionKey();

		// Create and encrypt item
		const item = await encrypt("Secret data", originalVaultKey);
		const itemForRotation = {
			id: "item-1",
			encryptedData: item.ciphertext,
			encryptionIv: item.iv,
			encryptionAlgorithm: item.algorithm,
		};

		// Perform rotation
		const mockMasterUnlockKey = generateEncryptionKey();
		const rotationResult = await performKeyRotation(
			originalVaultKey,
			[{ userId: "member-id", publicKey: memberKeys.publicKey }],
			[itemForRotation],
			"member-id",
			mockMasterUnlockKey,
		);

		// Try to decrypt new data with old key - should fail
		const reEncryptedItem = rotationResult.reEncryptedItems[0];
		expect(reEncryptedItem).toBeDefined();
		let decryptionFailed = false;
		try {
			await decrypt(
				{
					// biome-ignore lint/style/noNonNullAssertion: We verified above it's defined
					ciphertext: reEncryptedItem!.encryptedData,
					// biome-ignore lint/style/noNonNullAssertion: We verified above it's defined
					iv: reEncryptedItem!.encryptionIv,
					algorithm: "AES-GCM",
				},
				originalVaultKey,
			);
		} catch {
			decryptionFailed = true;
		}

		expect(decryptionFailed).toBe(true);
	});

	test("should validate rotation data correctly", () => {
		// Test with valid data
		const validMembers = [
			{
				userId: "user1",
				publicKey:
					"-----BEGIN PUBLIC KEY-----\nMIIB...\n-----END PUBLIC KEY-----",
			},
		];
		const validResult = validateRotationData(validMembers);
		expect(validResult.valid).toBe(true);
		expect(validResult.errors.length).toBe(0);

		// Test with missing public key
		const invalidMembers = [{ userId: "user2", publicKey: "" }];
		const invalidResult = validateRotationData(invalidMembers);
		expect(invalidResult.valid).toBe(false);
		expect(invalidResult.errors.length).toBeGreaterThan(0);

		// Test with invalid public key format
		const badFormatMembers = [
			{ userId: "user3", publicKey: "not-a-valid-key" },
		];
		const badFormatResult = validateRotationData(badFormatMembers);
		expect(badFormatResult.valid).toBe(false);
	});
});
