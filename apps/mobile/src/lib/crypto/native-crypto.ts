/**
 * Native crypto module for React Native
 *
 * This module provides a unified interface to the Rust crypto implementation
 * via the @bittery/crypto-nitro Expo module.
 */

import {
	createSRPClient,
	createSRPServer,
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
} from "@bittery/crypto-nitro";
import {
	unwrapPlaintextWithContext,
	wrapPlaintextWithContext,
} from "@bittery/shared/crypto-context-envelope";
import { attachVaultKeyWrapContext } from "@bittery/shared/vault-key-crypto";
import { validateServerKdfParamsOrThrow } from "@bittery/shared/kdf-policy";
import type {
	DerivedKeys,
	EncryptedData,
	EncryptionContext,
	KdfParams,
	RsaKeyPair,
	SRPClientEphemeral,
	SRPClientSession,
	SRPRegistration,
	SRPServerChallenge,
} from "@bittery/types";

// Re-export types from @bittery/types
export type {
	DerivedKeys,
	EncryptedData,
	RsaKeyPair,
	SRPClientEphemeral,
	SRPClientSession,
	SRPRegistration,
	SRPServerChallenge,
};

// Re-export crypto-nitro specific types
export type { HashAlgorithm, PrimeGroup };

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
	// Native module already returns Uint8Array values
	return nativeDeriveKeys(password, secretKey, email);
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
	context?: EncryptionContext,
): Promise<EncryptedData> {
	const keyBase64 = arrayBufferToBase64(key);
	const plaintextToEncrypt = context
		? wrapPlaintextWithContext(plaintext, context)
		: plaintext;
	const encryptedData = await nativeEncrypt(plaintextToEncrypt, keyBase64);

	if (context?.entityType === "vault_key") {
		return attachVaultKeyWrapContext(encryptedData, {
			vaultId: context.vaultId,
			userId: context.userId,
			keyVersion: context.version,
		}) as EncryptedData;
	}

	return encryptedData;
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
	context?: EncryptionContext,
): Promise<string> {
	const keyBase64 = arrayBufferToBase64(key);
	const decrypted = await nativeDecrypt(
		encryptedData.ciphertext,
		encryptedData.iv,
		encryptedData.algorithm,
		keyBase64,
	);
	return context ? unwrapPlaintextWithContext(decrypted, context) : decrypted;
}

export function validateServerKdfParams(
	serverParams: KdfParams,
	pinnedParams?: KdfParams | null,
): void {
	validateServerKdfParamsOrThrow(serverParams, pinnedParams);
}

/**
 * Decrypt ciphertext using AES-256-GCM with individual fields.
 */
export async function decryptRaw(
	ciphertext: string,
	iv: string,
	algorithm: string,
	keyBase64: string,
): Promise<string> {
	return nativeDecrypt(ciphertext, iv, algorithm, keyBase64);
}

/**
 * Decrypt EncryptedData object using AES-256-GCM with base64 key.
 */
export async function decryptData(
	data: EncryptedData,
	keyBase64: string,
): Promise<string> {
	return nativeDecrypt(data.ciphertext, data.iv, data.algorithm, keyBase64);
}

/**
 * Generate a random 256-bit encryption key (base64 encoded).
 */
export function generateEncryptionKey(): string {
	return nativeGenerateEncryptionKey();
}

/**
 * Generate a UUID for client-side entity IDs.
 */
export function generateUuid(): string {
	const random = globalThis?.crypto?.randomUUID?.();
	if (random) {
		return random;
	}
	return `item_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
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
// These match the interface from @bittery/types
// ============================================================================

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
