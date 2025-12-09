/**
 * AES-256-GCM Encryption/Decryption
 * Uses Web Crypto API for secure encryption
 */

const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96 bits recommended for GCM

export interface EncryptedData {
	ciphertext: string; // base64
	iv: string; // base64
	algorithm: string;
}

/**
 * Encrypt data using AES-256-GCM
 */
export async function encrypt(
	plaintext: string,
	key: Uint8Array,
): Promise<EncryptedData> {
	// Import key
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		key,
		{ name: ALGORITHM, length: KEY_LENGTH },
		false,
		["encrypt"],
	);

	// Generate random IV
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

	// Encrypt
	const plaintextBytes = new TextEncoder().encode(plaintext);
	const ciphertextBuffer = await crypto.subtle.encrypt(
		{ name: ALGORITHM, iv },
		cryptoKey,
		plaintextBytes,
	);

	const ciphertext = arrayBufferToBase64(new Uint8Array(ciphertextBuffer));
	const ivBase64 = arrayBufferToBase64(iv);

	return {
		ciphertext,
		iv: ivBase64,
		algorithm: ALGORITHM,
	};
}

/**
 * Decrypt data using AES-256-GCM
 */
export async function decrypt(
	encryptedData: EncryptedData,
	key: Uint8Array,
): Promise<string> {
	// Import key
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		key,
		{ name: ALGORITHM, length: KEY_LENGTH },
		false,
		["decrypt"],
	);

	// Decode base64
	const ciphertext = base64ToArrayBuffer(encryptedData.ciphertext);
	const iv = base64ToArrayBuffer(encryptedData.iv);

	// Decrypt
	const plaintextBuffer = await crypto.subtle.decrypt(
		{ name: ALGORITHM, iv },
		cryptoKey,
		ciphertext,
	);

	return new TextDecoder().decode(plaintextBuffer);
}

/**
 * Generate a random encryption key
 */
export function generateEncryptionKey(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(KEY_LENGTH / 8));
}

/**
 * Convert ArrayBuffer to base64
 */
function arrayBufferToBase64(buffer: Uint8Array): string {
	const binary = String.fromCharCode(...buffer);
	return btoa(binary);
}

/**
 * Convert base64 to ArrayBuffer
 */
function base64ToArrayBuffer(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}
