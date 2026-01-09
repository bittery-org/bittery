/**
 * Client-Side Cryptography Utilities
 * Browser-compatible wrappers for @bittery/crypto functions
 */

import {
	arrayBufferToBase64,
	base64ToArrayBuffer,
	buildTrpcUrl,
	canQuickUnlock as canQuickUnlockServer,
	clearAllStoredData as clearAllStoredDataServer,
	clearServerUrl as clearServerUrlServer,
	clearSession as clearSessionServer,
	type DerivedKeys,
	decrypt as decryptServer,
	decryptStoredMasterUnlockKey as decryptStoredMasterUnlockKeyServer,
	decryptVaultKey as decryptVaultKeyServer,
	deriveClientSession,
	deriveKeys as deriveKeysServer,
	type EncryptedData,
	encrypt as encryptServer,
	generateClientEphemeral,
	generateEncryptionKey,
	generateRSAKeyPair,
	generateSecretKey as generateSecretKeyServer,
	generateSRPRegistration,
	getAuthToken as getAuthTokenServer,
	getDecryptedVaultKey as getDecryptedVaultKeyServer,
	getMasterUnlockKey as getMasterUnlockKeyServer,
	getSecretKeyHint as getSecretKeyHintServer,
	getServerUrl as getServerUrlServer,
	getStoredSecretKey as getStoredSecretKeyServer,
	getStoredSessionData as getStoredSessionDataServer,
	getTimeUntilExpiry as getTimeUntilExpiryServer,
	getVaultKeys as getVaultKeysServer,
	hasStoredSecretKey as hasStoredSecretKeyServer,
	isAuthenticated as isAuthenticatedServer,
	isSessionValid as isSessionValidServer,
	normalizeServerUrl,
	rsaDecrypt,
	rsaEncrypt,
	type SRPClientEphemeral,
	type SRPClientSession,
	type SRPServerChallenge,
	storeAuthToken as storeAuthTokenServer,
	storeMasterUnlockKey as storeMasterUnlockKeyServer,
	storeSecretKey as storeSecretKeyServer,
	storeServerUrl as storeServerUrlServer,
	storeSessionData as storeSessionDataServer,
	storeVaultKeys as storeVaultKeysServer,
	tryRestoreSession as tryRestoreSessionServer,
	type VaultKeyData,
	validateSecretKey as validateSecretKeyServer,
	verifyServerSession,
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
	generateClientEphemeral,
	deriveClientSession,
	verifyServerSession,
	storeSecretKeyServer as storeSecretKey,
	getStoredSecretKeyServer as getStoredSecretKey,
	hasStoredSecretKeyServer as hasStoredSecretKey,
	storeServerUrlServer as storeServerUrl,
	getServerUrlServer as getServerUrl,
	clearServerUrlServer as clearServerUrl,
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
	normalizeServerUrl,
	buildTrpcUrl,
};

export type {
	EncryptedData,
	DerivedKeys,
	SRPClientSession,
	SRPClientEphemeral,
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

export interface PasswordOptions {
	length?: number;
	lowercase?: boolean;
	uppercase?: boolean;
	numbers?: boolean;
	symbols?: boolean;
}

/**
 * Generate a secure random password
 */
export function generatePassword(options: PasswordOptions = {}): string {
	const {
		length = 20,
		lowercase = true,
		uppercase = true,
		numbers = true,
		symbols = true,
	} = options;

	const lowercaseChars = "abcdefghijklmnopqrstuvwxyz";
	const uppercaseChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
	const numberChars = "0123456789";
	const symbolChars = "!@#$%^&*()_+-=[]{}|;:,.<>?";

	let allChars = "";
	const requiredChars: string[] = [];
	const charSets: string[] = [];

	if (lowercase) {
		allChars += lowercaseChars;
		charSets.push(lowercaseChars);
	}
	if (uppercase) {
		allChars += uppercaseChars;
		charSets.push(uppercaseChars);
	}
	if (numbers) {
		allChars += numberChars;
		charSets.push(numberChars);
	}
	if (symbols) {
		allChars += symbolChars;
		charSets.push(symbolChars);
	}

	// Need at least one character set
	if (allChars.length === 0) {
		allChars = lowercaseChars + uppercaseChars + numberChars + symbolChars;
		charSets.push(lowercaseChars, uppercaseChars, numberChars, symbolChars);
	}

	const randomValues = new Uint8Array(length + charSets.length);
	crypto.getRandomValues(randomValues);

	// Ensure at least one character from each enabled character set
	for (let i = 0; i < charSets.length; i++) {
		const charSet = charSets[i];
		const val = randomValues[i];
		if (charSet && val !== undefined) {
			requiredChars.push(charSet[val % charSet.length] ?? "");
		}
	}

	// Fill the rest randomly from all allowed characters
	for (let i = requiredChars.length; i < length; i++) {
		const val = randomValues[i];
		if (val !== undefined) {
			requiredChars.push(allChars[val % allChars.length] ?? "");
		}
	}

	// Shuffle the password
	for (let i = requiredChars.length - 1; i > 0; i--) {
		const val = randomValues[charSets.length + i];
		if (val !== undefined) {
			const j = val % (i + 1);
			const temp = requiredChars[i];
			const tempJ = requiredChars[j];
			if (temp !== undefined && tempJ !== undefined) {
				requiredChars[i] = tempJ;
				requiredChars[j] = temp;
			}
		}
	}

	return requiredChars.join("");
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
