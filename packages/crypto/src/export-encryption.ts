/**
 * Export Encryption Utilities
 * Encrypt/decrypt vault exports with password-based encryption
 */

import { hkdf } from "@noble/hashes/hkdf";
import { pbkdf2 } from "@noble/hashes/pbkdf2";
import { sha256 } from "@noble/hashes/sha2";

const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96 bits recommended for GCM
const SALT_LENGTH = 32; // 256 bits for salt
const PBKDF2_ITERATIONS = 100_000;

/**
 * Encrypted export data structure
 */
export interface EncryptedExport {
	version: string;
	algorithm: string;
	iterations: number;
	salt: string; // base64 encoded
	iv: string; // base64 encoded
	ciphertext: string; // base64 encoded
}

/**
 * Derive an encryption key from a password using PBKDF2 + HKDF
 */
async function deriveKeyFromPassword(
	password: string,
	salt: Uint8Array,
): Promise<Uint8Array> {
	const passwordBytes = new TextEncoder().encode(password);

	// Derive master key using PBKDF2
	const masterKey = pbkdf2(sha256, passwordBytes, salt, {
		c: PBKDF2_ITERATIONS,
		dkLen: KEY_LENGTH / 8,
	});

	// Derive final key using HKDF for added security
	const info = new TextEncoder().encode("bittery-export-encryption-key");
	const derivedKey = hkdf(sha256, masterKey, salt, info, KEY_LENGTH / 8);

	return derivedKey;
}

/**
 * Encrypt export data with a user-provided password
 */
export async function encryptExport(
	data: string,
	password: string,
): Promise<EncryptedExport> {
	// Generate random salt
	const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));

	// Derive key from password
	const key = await deriveKeyFromPassword(password, salt);

	// Import key for Web Crypto API
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		key as Uint8Array<ArrayBuffer>,
		{ name: ALGORITHM, length: KEY_LENGTH },
		false,
		["encrypt"],
	);

	// Generate random IV
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

	// Encrypt
	const dataBytes = new TextEncoder().encode(data);
	const ciphertextBuffer = await crypto.subtle.encrypt(
		{ name: ALGORITHM, iv },
		cryptoKey,
		dataBytes,
	);

	return {
		version: "1.0",
		algorithm: ALGORITHM,
		iterations: PBKDF2_ITERATIONS,
		salt: arrayBufferToBase64(salt),
		iv: arrayBufferToBase64(iv),
		ciphertext: arrayBufferToBase64(new Uint8Array(ciphertextBuffer)),
	};
}

/**
 * Decrypt export data with the password used to encrypt it
 */
export async function decryptExport(
	encryptedExport: EncryptedExport,
	password: string,
): Promise<string> {
	// Decode salt and IV
	const salt = base64ToArrayBuffer(encryptedExport.salt);
	const iv = base64ToArrayBuffer(encryptedExport.iv);
	const ciphertext = base64ToArrayBuffer(encryptedExport.ciphertext);

	// Derive key from password
	const key = await deriveKeyFromPassword(password, salt);

	// Import key for Web Crypto API
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		key as Uint8Array<ArrayBuffer>,
		{ name: ALGORITHM, length: KEY_LENGTH },
		false,
		["decrypt"],
	);

	// Decrypt
	const plaintextBuffer = await crypto.subtle.decrypt(
		{ name: ALGORITHM, iv: iv as Uint8Array<ArrayBuffer> },
		cryptoKey,
		ciphertext as Uint8Array<ArrayBuffer>,
	);

	return new TextDecoder().decode(plaintextBuffer);
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
