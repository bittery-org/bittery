/**
 * Key Rotation Utilities
 * Handles vault key rotation for secure access revocation
 */

import {
	decrypt,
	type EncryptedData,
	encrypt,
	generateEncryptionKey,
} from "./encryption";
import { arrayBufferToBase64 } from "./key-derivation";
import { rsaEncrypt } from "./rsa";

export interface MemberKeyData {
	userId: string;
	publicKey: string;
}

export interface ReEncryptedItem {
	itemId: string;
	encryptedData: string;
	encryptionIv: string;
}

export interface KeyRotationResult {
	newVaultKey: Uint8Array;
	newVaultKeyBase64: string;
	memberEncryptedKeys: {
		userId: string;
		encryptedVaultKey: string;
	}[];
	reEncryptedItems: ReEncryptedItem[];
}

export interface ItemData {
	id: string;
	encryptedData: string;
	encryptionIv: string;
	encryptionAlgorithm: string;
}

/**
 * Generate a new vault key for rotation
 */
export function generateNewVaultKey(): Uint8Array {
	return generateEncryptionKey();
}

/**
 * Encrypt a vault key with a member's RSA public key
 */
export async function encryptVaultKeyForMember(
	vaultKey: Uint8Array,
	memberPublicKey: string,
): Promise<string> {
	const vaultKeyBase64 = arrayBufferToBase64(vaultKey);
	return rsaEncrypt(vaultKeyBase64, memberPublicKey);
}

/**
 * Re-encrypt an item with a new vault key
 * This decrypts the item with the old key and re-encrypts with the new key
 */
export async function reEncryptItem(
	item: ItemData,
	oldVaultKey: Uint8Array,
	newVaultKey: Uint8Array,
): Promise<ReEncryptedItem> {
	// Decrypt with old key
	const oldEncryptedData: EncryptedData = {
		ciphertext: item.encryptedData,
		iv: item.encryptionIv,
		algorithm: item.encryptionAlgorithm,
	};

	const decryptedData = await decrypt(oldEncryptedData, oldVaultKey);

	// Re-encrypt with new key
	const newEncryptedData = await encrypt(decryptedData, newVaultKey);

	return {
		itemId: item.id,
		encryptedData: newEncryptedData.ciphertext,
		encryptionIv: newEncryptedData.iv,
	};
}

/**
 * Perform a complete key rotation
 * 1. Generate a new vault key
 * 2. Encrypt the new key for each remaining member:
 *    - For the current user: encrypt with Master Unlock Key (AES-GCM)
 *    - For other members: encrypt with their RSA public keys
 * 3. Re-encrypt all items with the new key
 */
export async function performKeyRotation(
	oldVaultKey: Uint8Array,
	members: MemberKeyData[],
	items: ItemData[],
	currentUserId: string,
	masterUnlockKey: Uint8Array,
): Promise<KeyRotationResult> {
	// 1. Generate new vault key
	const newVaultKey = generateNewVaultKey();
	const newVaultKeyBase64 = arrayBufferToBase64(newVaultKey);

	// 2. Encrypt new vault key for each member
	// - Current user: use AES-GCM with Master Unlock Key
	// - Other members: use RSA with their public key
	const memberEncryptedKeys = await Promise.all(
		members.map(async (member) => ({
			userId: member.userId,
			encryptedVaultKey:
				member.userId === currentUserId
					? await encryptVaultKeyWithMUK(newVaultKey, masterUnlockKey)
					: await encryptVaultKeyForMember(newVaultKey, member.publicKey),
		})),
	);

	// 3. Re-encrypt all items with the new key
	const reEncryptedItems = await Promise.all(
		items.map((item) => reEncryptItem(item, oldVaultKey, newVaultKey)),
	);

	return {
		newVaultKey,
		newVaultKeyBase64,
		memberEncryptedKeys,
		reEncryptedItems,
	};
}

/**
 * Encrypt a vault key with AES-GCM for the owner (using Master Unlock Key)
 * Used when rotating keys for the vault owner's copy
 */
export async function encryptVaultKeyWithMUK(
	vaultKey: Uint8Array,
	masterUnlockKey: Uint8Array,
): Promise<string> {
	const vaultKeyBase64 = arrayBufferToBase64(vaultKey);
	const encrypted = await encrypt(vaultKeyBase64, masterUnlockKey);
	return JSON.stringify(encrypted);
}

/**
 * Validate that a rotation can be performed
 * Checks that we have valid keys for all members
 */
export function validateRotationData(members: MemberKeyData[]): {
	valid: boolean;
	errors: string[];
} {
	const errors: string[] = [];

	for (const member of members) {
		if (!member.publicKey) {
			errors.push(`Member ${member.userId} has no public key`);
		}
		if (!member.publicKey.includes("-----BEGIN PUBLIC KEY-----")) {
			errors.push(`Member ${member.userId} has invalid public key format`);
		}
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}
