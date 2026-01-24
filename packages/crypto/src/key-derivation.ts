/**
 * Key Derivation Functions
 * Derives authentication and encryption keys from Account Password + Secret Key
 */

import { hkdf } from "@noble/hashes/hkdf";
import { pbkdf2 as noblePbkdf2 } from "@noble/hashes/pbkdf2";
import { sha256 } from "@noble/hashes/sha2";

const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 32; // 256 bits

export interface DerivedKeys {
	authKey: Uint8Array; // For SRP authentication
	masterUnlockKey: Uint8Array; // For encrypting vault keys
}

/**
 * Custom crypto provider for native PBKDF2 (e.g., react-native-quick-crypto)
 * Set this to use native crypto instead of JS fallback
 */
let customCryptoProvider: CryptoProvider | null = null;

export interface CryptoProvider {
	pbkdf2: (
		password: Uint8Array,
		salt: Uint8Array,
		iterations: number,
		keyLength: number,
	) => Promise<Uint8Array>;
}

/**
 * Set a custom crypto provider for PBKDF2 operations
 * Call this early in app initialization (e.g., with react-native-quick-crypto)
 */
export function setKeyDerivationCryptoProvider(
	provider: CryptoProvider | null,
): void {
	customCryptoProvider = provider;
}

/**
 * Check if Web Crypto API is available for PBKDF2
 */
function hasWebCrypto(): boolean {
	return (
		typeof globalThis !== "undefined" &&
		globalThis.crypto?.subtle?.importKey !== undefined &&
		globalThis.crypto?.subtle?.deriveBits !== undefined
	);
}

/**
 * Convert Uint8Array to ArrayBuffer (needed for Web Crypto API)
 */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	// Create a new ArrayBuffer and copy the data
	const buffer = new ArrayBuffer(data.length);
	new Uint8Array(buffer).set(data);
	return buffer;
}

/**
 * Derive key using Web Crypto API (native, fast)
 */
async function pbkdf2WebCrypto(
	password: Uint8Array,
	salt: Uint8Array,
	iterations: number,
	keyLength: number,
): Promise<Uint8Array> {
	const baseKey = await crypto.subtle.importKey(
		"raw",
		toArrayBuffer(password),
		{ name: "PBKDF2" },
		false,
		["deriveBits"],
	);

	const derivedBits = await crypto.subtle.deriveBits(
		{
			name: "PBKDF2",
			salt: toArrayBuffer(salt),
			iterations,
			hash: "SHA-256",
		},
		baseKey,
		keyLength * 8,
	);

	return new Uint8Array(derivedBits);
}

/**
 * Derive key using noble-hashes (JS fallback, slow)
 */
function pbkdf2Fallback(
	password: Uint8Array,
	salt: Uint8Array,
	iterations: number,
	keyLength: number,
): Uint8Array {
	return noblePbkdf2(sha256, password, salt, {
		c: iterations,
		dkLen: keyLength,
	});
}

/**
 * PBKDF2 with automatic selection of best available implementation
 * Priority: custom provider > Web Crypto API > noble-hashes fallback
 */
async function pbkdf2(
	password: Uint8Array,
	salt: Uint8Array,
	iterations: number,
	keyLength: number,
): Promise<Uint8Array> {
	// 1. Try custom crypto provider (e.g., react-native-quick-crypto)
	if (customCryptoProvider) {
		return customCryptoProvider.pbkdf2(password, salt, iterations, keyLength);
	}

	// 2. Try Web Crypto API (browser, Node.js, Bun)
	if (hasWebCrypto()) {
		return pbkdf2WebCrypto(password, salt, iterations, keyLength);
	}

	// 3. Fall back to noble-hashes (pure JS, slowest)
	return pbkdf2Fallback(password, salt, iterations, keyLength);
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

	// Derive master key using PBKDF2 (uses native crypto when available)
	const masterKey = await pbkdf2(
		combinedBytes,
		salt,
		PBKDF2_ITERATIONS,
		KEY_LENGTH,
	);

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
