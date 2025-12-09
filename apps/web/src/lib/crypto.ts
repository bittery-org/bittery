/**
 * Client-Side Cryptography Utilities
 * Browser-compatible wrappers for @bittery/crypto functions
 */

import {
	arrayBufferToBase64,
	base64ToArrayBuffer,
	canQuickUnlock as canQuickUnlockServer,
	clearAllStoredData as clearAllStoredDataServer,
	clearSession as clearSessionServer,
	type DerivedKeys,
	decrypt as decryptServer,
	decryptStoredMasterUnlockKey as decryptStoredMasterUnlockKeyServer,
	decryptVaultKey as decryptVaultKeyServer,
	deriveKeys as deriveKeysServer,
	type EncryptedData,
	encrypt as encryptServer,
	finishSRPLogin,
	generateEncryptionKey,
	generateRSAKeyPair,
	generateSecretKey as generateSecretKeyServer,
	generateSRPRegistration,
	getAuthToken as getAuthTokenServer,
	getDecryptedVaultKey as getDecryptedVaultKeyServer,
	getMasterUnlockKey as getMasterUnlockKeyServer,
	getSecretKeyHint as getSecretKeyHintServer,
	getStoredSecretKey as getStoredSecretKeyServer,
	getStoredSessionData as getStoredSessionDataServer,
	getTimeUntilExpiry as getTimeUntilExpiryServer,
	getVaultKeys as getVaultKeysServer,
	hasStoredSecretKey as hasStoredSecretKeyServer,
	isAuthenticated as isAuthenticatedServer,
	isSessionValid as isSessionValidServer,
	rsaDecrypt,
	rsaEncrypt,
	type SRPClientSessionData,
	type SRPServerChallenge,
	startSRPLogin,
	storeAuthToken as storeAuthTokenServer,
	storeMasterUnlockKey as storeMasterUnlockKeyServer,
	storeSecretKey as storeSecretKeyServer,
	storeSessionData as storeSessionDataServer,
	storeVaultKeys as storeVaultKeysServer,
	tryRestoreSession as tryRestoreSessionServer,
	type VaultKeyData,
	validateSecretKey as validateSecretKeyServer,
} from "@bittery/crypto";

// Re-export all functions from @bittery/crypto
export {
	generateSecretKeyServer as generateSecretKey,
	validateSecretKeyServer as validateSecretKey,
	getSecretKeyHintServer as getSecretKeyHint,
	generateEncryptionKey,
	arrayBufferToBase64,
	base64ToArrayBuffer,
	generateRSAKeyPair,
	rsaEncrypt,
	rsaDecrypt,
	generateSRPRegistration,
	startSRPLogin,
	finishSRPLogin,
	storeSecretKeyServer as storeSecretKey,
	getStoredSecretKeyServer as getStoredSecretKey,
	hasStoredSecretKeyServer as hasStoredSecretKey,
	storeSessionDataServer as storeSessionData,
	getStoredSessionDataServer as getStoredSessionData,
	isSessionValidServer as isSessionValid,
	getTimeUntilExpiryServer as getTimeUntilExpiry,
	decryptStoredMasterUnlockKeyServer as decryptStoredMasterUnlockKey,
	clearAllStoredDataServer as clearAllStoredData,
	canQuickUnlockServer as canQuickUnlock,
	storeAuthTokenServer as storeAuthToken,
	getAuthTokenServer as getAuthToken,
	storeVaultKeysServer as storeVaultKeys,
	getVaultKeysServer as getVaultKeys,
	storeMasterUnlockKeyServer as storeMasterUnlockKey,
	getMasterUnlockKeyServer as getMasterUnlockKey,
	decryptVaultKeyServer as decryptVaultKey,
	getDecryptedVaultKeyServer as getDecryptedVaultKey,
	clearSessionServer as clearSession,
	isAuthenticatedServer as isAuthenticated,
	tryRestoreSessionServer as tryRestoreSession,
};

export type {
	EncryptedData,
	DerivedKeys,
	SRPClientSessionData,
	SRPServerChallenge,
	VaultKeyData,
};

/**
 * Derive authentication and encryption keys from password + secret key
 */
export async function deriveKeys(
	accountPassword: string,
	secretKey: string,
	email: string,
): Promise<DerivedKeys> {
	return deriveKeysServer(accountPassword, secretKey, email);
}

/**
 * Encrypt data for storage
 */
export async function encrypt(
	plaintext: string,
	key: Uint8Array,
): Promise<EncryptedData> {
	return encryptServer(plaintext, key);
}

/**
 * Decrypt data from storage
 */
export async function decrypt(
	encryptedData: EncryptedData,
	key: Uint8Array,
): Promise<string> {
	return decryptServer(encryptedData, key);
}

/**
 * Generate a secure random password
 */
export function generatePassword(length = 20): string {
	const lowercase = "abcdefghijklmnopqrstuvwxyz";
	const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
	const numbers = "0123456789";
	const symbols = "!@#$%^&*()_+-=[]{}|;:,.<>?";
	const allChars = lowercase + uppercase + numbers + symbols;

	const randomValues = new Uint8Array(length);
	crypto.getRandomValues(randomValues);

	// Ensure at least one of each character type
	let password = "";
	password += lowercase[randomValues[0] % lowercase.length];
	password += uppercase[randomValues[1] % uppercase.length];
	password += numbers[randomValues[2] % numbers.length];
	password += symbols[randomValues[3] % symbols.length];

	// Fill the rest randomly
	for (let i = 4; i < length; i++) {
		password += allChars[randomValues[i] % allChars.length];
	}

	// Shuffle the password
	const passwordArray = password.split("");
	for (let i = passwordArray.length - 1; i > 0; i--) {
		const j = randomValues[i] % (i + 1);
		[passwordArray[i], passwordArray[j]] = [passwordArray[j], passwordArray[i]];
	}

	return passwordArray.join("");
}

/**
 * Copy text to clipboard with auto-clear
 */
export async function copyToClipboard(
	text: string,
	autoClearMs = 30000,
): Promise<void> {
	await navigator.clipboard.writeText(text);

	if (autoClearMs > 0) {
		setTimeout(() => {
			navigator.clipboard.writeText("").catch(() => {
				// Ignore errors when clearing
			});
		}, autoClearMs);
	}
}
