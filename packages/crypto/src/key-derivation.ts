/**
 * Key Derivation Functions
 * Derives authentication and encryption keys from Account Password + Secret Key
 */

import { hkdf } from "@noble/hashes/hkdf";
import { pbkdf2 } from "@noble/hashes/pbkdf2";
import { sha256 } from "@noble/hashes/sha2";

const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 32; // 256 bits

export interface DerivedKeys {
	authKey: Uint8Array; // For SRP authentication
	masterUnlockKey: Uint8Array; // For encrypting vault keys
}

/**
 * Derive authentication and master unlock keys from password + secret key
 * Uses PBKDF2 for initial derivation, then HKDF to split into two keys
 */
export async function deriveKeys(
	accountPassword: string,
	secretKey: string,
	email: string,
): Promise<DerivedKeys> {
	// Combine password and secret key
	const combined = `${accountPassword}|${secretKey}`;
	const combinedBytes = new TextEncoder().encode(combined);

	// Use email as salt for PBKDF2
	const salt = new TextEncoder().encode(email.toLowerCase());

	// Derive master key using PBKDF2
	const masterKey = pbkdf2(sha256, combinedBytes, salt, {
		c: PBKDF2_ITERATIONS,
		dkLen: KEY_LENGTH,
	});

	// Split master key into auth key and master unlock key using HKDF
	const authKeyInfo = new TextEncoder().encode("bittery-auth-key");
	const authKey = hkdf(sha256, masterKey, salt, authKeyInfo, KEY_LENGTH);

	const unlockKeyInfo = new TextEncoder().encode("bittery-unlock-key");
	const masterUnlockKey = hkdf(
		sha256,
		masterKey,
		salt,
		unlockKeyInfo,
		KEY_LENGTH,
	);

	return {
		authKey,
		masterUnlockKey,
	};
}

/**
 * Convert Uint8Array to base64 for storage/transmission
 */
export function arrayBufferToBase64(buffer: Uint8Array): string {
	const binary = String.fromCharCode(...buffer);
	return btoa(binary);
}

/**
 * Convert base64 to Uint8Array
 */
export function base64ToArrayBuffer(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}
