/**
 * Native crypto module for React Native
 *
 * This module provides a unified interface to the Rust crypto implementation
 * via the @bittery/crypto-nitro Expo module.
 */

import {
	createSRPClient,
	createSRPServer,
	type EncryptedData,
	type HashAlgorithm,
	decrypt as nativeDecrypt,
	deriveKeys as nativeDeriveKeys,
	encrypt as nativeEncrypt,
	generateEncryptionKey as nativeGenerateEncryptionKey,
	generateRsaKeyPair as nativeGenerateRsaKeyPair,
	generateSecretKey as nativeGenerateSecretKey,
	getSecretKeyHint as nativeGetSecretKeyHint,
	rsaDecrypt as nativeRsaDecrypt,
	rsaEncrypt as nativeRsaEncrypt,
	validateSecretKey as nativeValidateSecretKey,
	type PrimeGroup,
	type RsaKeyPair,
} from "@bittery/crypto-nitro";

// DerivedKeys interface matching @bittery/crypto/key-derivation
// Uses Uint8Array for compatibility with existing code
export interface DerivedKeys {
	authKey: Uint8Array;
	masterUnlockKey: Uint8Array;
}

// Re-export types
export type { EncryptedData, RsaKeyPair, HashAlgorithm, PrimeGroup };

// ============================================================================
// Key Derivation
// ============================================================================

/**
 * Derive authentication and master unlock keys using native Rust crypto.
 * Uses PBKDF2 (100k iterations) + HKDF for key splitting.
 *
 * Returns Uint8Array for compatibility with existing @bittery/crypto interface.
 */
export async function deriveKeys(
	password: string,
	secretKey: string,
	email: string,
): Promise<DerivedKeys> {
	const result = await nativeDeriveKeys(password, secretKey, email);

	// Convert base64 strings to Uint8Array for compatibility
	return {
		authKey: base64ToArrayBuffer(result.authKey),
		masterUnlockKey: base64ToArrayBuffer(result.masterUnlockKey),
	};
}

// ============================================================================
// AES-256-GCM Encryption
// ============================================================================

/**
 * Encrypt plaintext using AES-256-GCM.
 * Accepts Uint8Array key for compatibility with @bittery/crypto/encryption.
 */
export async function encrypt(
	plaintext: string,
	key: Uint8Array,
): Promise<EncryptedData> {
	const keyBase64 = arrayBufferToBase64(key);
	return nativeEncrypt(plaintext, keyBase64);
}

/**
 * Encrypt plaintext using AES-256-GCM with base64 key.
 */
export async function encryptWithBase64Key(
	plaintext: string,
	keyBase64: string,
): Promise<EncryptedData> {
	return nativeEncrypt(plaintext, keyBase64);
}

/**
 * Decrypt EncryptedData using AES-256-GCM.
 * Accepts Uint8Array key for compatibility with @bittery/crypto/encryption.
 */
export async function decrypt(
	encryptedData: EncryptedData,
	key: Uint8Array,
): Promise<string> {
	const keyBase64 = arrayBufferToBase64(key);
	return nativeDecrypt(encryptedData.ciphertext, encryptedData.iv, keyBase64);
}

/**
 * Decrypt ciphertext using AES-256-GCM with individual fields.
 */
export async function decryptRaw(
	ciphertext: string,
	iv: string,
	keyBase64: string,
): Promise<string> {
	return nativeDecrypt(ciphertext, iv, keyBase64);
}

/**
 * Decrypt EncryptedData object using AES-256-GCM with base64 key.
 */
export async function decryptData(
	data: EncryptedData,
	keyBase64: string,
): Promise<string> {
	return nativeDecrypt(data.ciphertext, data.iv, keyBase64);
}

/**
 * Generate a random 256-bit encryption key (base64 encoded).
 */
export function generateEncryptionKey(): string {
	return nativeGenerateEncryptionKey();
}

// ============================================================================
// RSA-4096
// ============================================================================

/**
 * Generate an RSA-4096 key pair.
 */
export async function generateRsaKeyPair(): Promise<RsaKeyPair> {
	return nativeGenerateRsaKeyPair();
}

/**
 * Encrypt data with RSA-OAEP.
 */
export async function rsaEncrypt(
	plaintext: string,
	publicKeyPem: string,
): Promise<string> {
	return nativeRsaEncrypt(plaintext, publicKeyPem);
}

/**
 * Decrypt data with RSA-OAEP.
 */
export async function rsaDecrypt(
	ciphertext: string,
	privateKeyPem: string,
): Promise<string> {
	return nativeRsaDecrypt(ciphertext, privateKeyPem);
}

// ============================================================================
// Secret Key
// ============================================================================

/**
 * Generate a new secret key in A3-XXXXXX format.
 */
export function generateSecretKey(): string {
	return nativeGenerateSecretKey();
}

/**
 * Validate secret key format.
 */
export function validateSecretKey(secretKey: string): boolean {
	return nativeValidateSecretKey(secretKey);
}

/**
 * Get the hint portion of a secret key.
 */
export function getSecretKeyHint(secretKey: string): string {
	return nativeGetSecretKeyHint(secretKey);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Convert Uint8Array to base64 for storage/transmission
 */
export function arrayBufferToBase64(buffer: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < buffer.byteLength; i++) {
		binary += String.fromCharCode(buffer[i]);
	}
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

// ============================================================================
// SRP-6a
// ============================================================================

export { createSRPClient, createSRPServer };

/**
 * Create an SRP client with sensible defaults for Bittery.
 */
export function createBitterySRPClient() {
	return createSRPClient("SHA-256", 4096);
}

/**
 * Create an SRP server with sensible defaults for Bittery.
 */
export function createBitterySRPServer() {
	return createSRPServer("SHA-256", 4096);
}

// ============================================================================
// SRP-6a Helper Functions
// These match the interface from @bittery/crypto/srp-client.ts
// ============================================================================

export interface SRPRegistration {
	salt: string;
	verifier: string;
}

export interface SRPClientEphemeral {
	publicKey: string;
	secret: string;
}

export interface SRPServerChallenge {
	salt: string;
	serverPublicKey: string;
}

export interface SRPClientSession {
	key: string;
	proof: string;
}

// Singleton client instance (reused for all SRP operations)
let _srpClient: ReturnType<typeof createSRPClient> | null = null;

function getSRPClient() {
	if (!_srpClient) {
		_srpClient = createBitterySRPClient();
	}
	return _srpClient;
}

/**
 * Client: Generate salt and verifier for registration
 * Used during signup to create credentials for the server to store
 */
export async function generateSRPRegistration(
	password: string,
): Promise<SRPRegistration> {
	const client = getSRPClient();
	const salt = client.generateSalt();
	const privateKey = await client.deriveSafePrivateKey(salt, password);
	const verifier = client.deriveVerifier(privateKey);

	return { salt, verifier };
}

/**
 * Client: Start login by generating ephemeral key pair
 * Step 1 of login - generates a random ephemeral key pair
 */
export function generateClientEphemeral(): SRPClientEphemeral {
	const client = getSRPClient();
	const ephemeral = client.generateEphemeral();

	return {
		publicKey: ephemeral.public,
		secret: ephemeral.secret,
	};
}

/**
 * Client: Finish login by computing proof
 * Step 3 of login - derives session key and generates proof for server
 */
export async function deriveClientSession(
	clientEphemeralSecret: string,
	serverChallenge: SRPServerChallenge,
	password: string,
): Promise<SRPClientSession> {
	const client = getSRPClient();

	const privateKey = await client.deriveSafePrivateKey(
		serverChallenge.salt,
		password,
	);

	const session = await client.deriveSession(
		clientEphemeralSecret,
		serverChallenge.serverPublicKey,
		serverChallenge.salt,
		"", // Empty string when using deriveSafePrivateKey
		privateKey,
	);

	return {
		key: session.key,
		proof: session.proof,
	};
}

/**
 * Client: Verify server's proof
 * Step 5 of login - verifies that server has the correct session key
 */
export async function verifyServerSession(
	clientPublicEphemeral: string,
	clientSession: SRPClientSession,
	serverSessionProof: string,
): Promise<void> {
	const client = getSRPClient();

	await client.verifySession(
		clientPublicEphemeral,
		clientSession,
		serverSessionProof,
	);
}
