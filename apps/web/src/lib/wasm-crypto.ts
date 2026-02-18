/**
 * WASM Crypto - Rust-based cryptographic operations via WebAssembly
 *
 * Provides the same interface as @bittery/crypto for drop-in replacement
 * in the web app, using native Rust crypto compiled to WASM.
 */

import init, {
	JsEncryptedData,
	type JsSession,
	JsSrpClient,
	decrypt as wasmDecrypt,
	decryptMasterKey as wasmDecryptMasterKey,
	deriveKeys as wasmDeriveKeys,
	deriveKeysFromMasterKey as wasmDeriveKeysFromMasterKey,
	deriveMasterKey as wasmDeriveMasterKey,
	encrypt as wasmEncrypt,
	encryptMasterKey as wasmEncryptMasterKey,
	generateEncryptionKey as wasmGenerateEncryptionKey,
	generateRecoveryKey as wasmGenerateRecoveryKey,
	generateRSAKeyPair as wasmGenerateRSAKeyPair,
	generateSecretKey as wasmGenerateSecretKey,
	getSecretKeyHint as wasmGetSecretKeyHint,
	performKeyRotation as wasmPerformKeyRotation,
	rsaDecrypt as wasmRsaDecrypt,
	rsaEncrypt as wasmRsaEncrypt,
	validateRecoveryKey as wasmValidateRecoveryKey,
	validateRotationData as wasmValidateRotationData,
	validateSecretKey as wasmValidateSecretKey,
} from "@bittery/crypto-wasm";
import type {
	DerivedKeys,
	EncryptedData,
	RsaKeyPair,
	SRPClientEphemeral,
	SRPClientSession,
	SRPRegistration,
	SRPServerChallenge,
} from "@bittery/types";

// Re-export types for consumers
export type {
	DerivedKeys,
	EncryptedData,
	RsaKeyPair,
	SRPClientEphemeral,
	SRPClientSession,
	SRPRegistration,
	SRPServerChallenge,
};

// ============================================================================
// WASM Initialization
// ============================================================================

let initialized = false;
let initPromise: Promise<void> | null = null;

/**
 * Initialize the WASM crypto module.
 * Must be called before using any crypto functions.
 * Safe to call multiple times - will only initialize once.
 * Skips initialization in non-browser environments (SSR/prerender).
 */
export async function initWasmCrypto(): Promise<void> {
	// Skip WASM initialization in non-browser environments (SSR/prerender)
	if (typeof window === "undefined") return;

	if (initialized) return;
	if (initPromise) return initPromise;

	initPromise = (async () => {
		await init();
		initialized = true;
	})();

	return initPromise;
}

/**
 * Check if WASM crypto is initialized
 */
export function isWasmInitialized(): boolean {
	return initialized;
}

/**
 * Ensure WASM is initialized, throw if not
 */
function ensureInitialized(): void {
	// In SSR, WASM won't be initialized - skip silently
	if (typeof window === "undefined") return;

	if (!initialized) {
		throw new Error(
			"WASM crypto not initialized. Call initWasmCrypto() first.",
		);
	}
}

/**
 * Auto-initialize WASM if needed
 */
async function autoInit(): Promise<void> {
	// Skip WASM initialization in non-browser environments
	if (typeof window === "undefined") return;

	if (!initialized) {
		await initWasmCrypto();
	}
}

// ============================================================================
// Utility Functions
// ============================================================================

function base64ToUint8Array(base64: string): Uint8Array {
	const binaryString = atob(base64);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
	const binaryString = String.fromCharCode(...bytes);
	return btoa(binaryString);
}

/**
 * Convert an ArrayBuffer or Uint8Array to base64 string
 * Exported for use in share dialogs and other places
 */
export function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	return uint8ArrayToBase64(bytes);
}

/**
 * Convert base64 to Uint8Array
 */
export function base64ToArrayBuffer(base64: string): Uint8Array {
	return base64ToUint8Array(base64);
}

// ============================================================================
// Key Derivation (matching @bittery/crypto/key-derivation)
// ============================================================================

/**
 * Derive authentication and master unlock keys from password + secret key
 */
export async function deriveKeys(
	accountPassword: string,
	secretKey: string,
	email: string,
): Promise<DerivedKeys> {
	await autoInit();

	const result = wasmDeriveKeys(accountPassword, secretKey, email);

	return {
		authKey: base64ToUint8Array(result.auth_key),
		masterUnlockKey: base64ToUint8Array(result.master_unlock_key),
	};
}

/**
 * Derive intermediate master key (PBKDF2 output) from password + secret key
 */
export async function deriveMasterKey(
	accountPassword: string,
	secretKey: string,
	email: string,
): Promise<Uint8Array> {
	await autoInit();

	const masterKeyBase64 = wasmDeriveMasterKey(
		accountPassword,
		secretKey,
		email,
	);
	return base64ToUint8Array(masterKeyBase64);
}

/**
 * Derive auth key + master unlock key from a raw master key
 */
export async function deriveKeysFromMasterKey(
	masterKey: Uint8Array,
	email: string,
): Promise<DerivedKeys> {
	await autoInit();

	const result = wasmDeriveKeysFromMasterKey(
		uint8ArrayToBase64(masterKey),
		email,
	);
	return {
		authKey: base64ToUint8Array(result.auth_key),
		masterUnlockKey: base64ToUint8Array(result.master_unlock_key),
	};
}

// ============================================================================
// AES-256-GCM Encryption (matching @bittery/crypto/encryption)
// ============================================================================

/**
 * Encrypt plaintext using AES-256-GCM
 */
export async function encrypt(
	plaintext: string,
	key: Uint8Array,
): Promise<EncryptedData> {
	await autoInit();

	const keyBase64 = uint8ArrayToBase64(key);
	const result = wasmEncrypt(plaintext, keyBase64);

	return {
		ciphertext: result.ciphertext,
		iv: result.iv,
		algorithm: result.algorithm,
	};
}

/**
 * Decrypt ciphertext using AES-256-GCM
 */
export async function decrypt(
	data: EncryptedData,
	key: Uint8Array,
): Promise<string> {
	await autoInit();

	const keyBase64 = uint8ArrayToBase64(key);

	// Create a proper JsEncryptedData WASM instance for decryption
	const wasmData = new JsEncryptedData(
		data.ciphertext,
		data.iv,
		data.algorithm,
	);

	return wasmDecrypt(wasmData, keyBase64);
}

/**
 * Generate a random 256-bit encryption key
 */
export async function generateEncryptionKey(): Promise<Uint8Array> {
	await autoInit();

	const keyBase64 = wasmGenerateEncryptionKey();
	return base64ToUint8Array(keyBase64);
}

// ============================================================================
// RSA-4096 (matching @bittery/crypto/rsa)
// ============================================================================

/**
 * Generate an RSA-4096 key pair
 */
export async function generateRSAKeyPair(): Promise<RsaKeyPair> {
	await autoInit();

	const result = wasmGenerateRSAKeyPair();
	return {
		publicKey: result.public_key,
		privateKey: result.private_key,
	};
}

/**
 * Encrypt data with RSA-OAEP using a public key
 */
export async function rsaEncrypt(
	plaintext: string,
	publicKeyPem: string,
): Promise<string> {
	await autoInit();
	return wasmRsaEncrypt(plaintext, publicKeyPem);
}

/**
 * Decrypt data with RSA-OAEP using a private key
 */
export async function rsaDecrypt(
	ciphertext: string,
	privateKeyPem: string,
): Promise<string> {
	await autoInit();
	return wasmRsaDecrypt(ciphertext, privateKeyPem);
}

// ============================================================================
// Secret Key (matching @bittery/crypto/secret-key)
// ============================================================================

/**
 * Generate a new secret key in A3-XXXXXX format
 */
export function generateSecretKey(): string {
	ensureInitialized();
	return wasmGenerateSecretKey();
}

/**
 * Generate a new secret key in A3-XXXXXX format (async version for compatibility)
 */
export async function generateSecretKeyAsync(): Promise<string> {
	await autoInit();
	return wasmGenerateSecretKey();
}

/**
 * Validate secret key format
 */
export function validateSecretKey(secretKey: string): boolean {
	ensureInitialized();
	return wasmValidateSecretKey(secretKey);
}

/**
 * Validate secret key format (async version for compatibility)
 */
export async function validateSecretKeyAsync(
	secretKey: string,
): Promise<boolean> {
	await autoInit();
	return wasmValidateSecretKey(secretKey);
}

/**
 * Get the hint (first segment) from a secret key
 */
export function getSecretKeyHint(secretKey: string): string {
	ensureInitialized();
	return wasmGetSecretKeyHint(secretKey);
}

/**
 * Get the hint (first segment) from a secret key (async version for compatibility)
 */
export async function getSecretKeyHintAsync(
	secretKey: string,
): Promise<string> {
	await autoInit();
	return wasmGetSecretKeyHint(secretKey);
}

/**
 * Generate a new recovery key in R1-XXXXXX format
 */
export function generateRecoveryKey(): string {
	ensureInitialized();
	return wasmGenerateRecoveryKey();
}

/**
 * Generate a new recovery key (async version for compatibility)
 */
export async function generateRecoveryKeyAsync(): Promise<string> {
	await autoInit();
	return wasmGenerateRecoveryKey();
}

/**
 * Validate recovery key format
 */
export function validateRecoveryKey(recoveryKey: string): boolean {
	ensureInitialized();
	return wasmValidateRecoveryKey(recoveryKey);
}

/**
 * Validate recovery key format (async version for compatibility)
 */
export async function validateRecoveryKeyAsync(
	recoveryKey: string,
): Promise<boolean> {
	await autoInit();
	return wasmValidateRecoveryKey(recoveryKey);
}

/**
 * Get the hint (first segment) from a recovery key
 */
export function getRecoveryKeyHint(recoveryKey: string): string {
	const parts = recoveryKey.split("-");
	if (parts.length >= 2) {
		return `${parts[0]}-${parts[1]}`;
	}
	return "";
}

/**
 * Encrypt a raw master key using recovery key material
 */
export async function encryptMasterKey(
	masterKey: Uint8Array,
	recoveryKey: string,
	email: string,
): Promise<EncryptedData> {
	await autoInit();

	const result = wasmEncryptMasterKey(
		uint8ArrayToBase64(masterKey),
		recoveryKey,
		email,
	);

	return {
		ciphertext: result.ciphertext,
		iv: result.iv,
		algorithm: result.algorithm,
	};
}

/**
 * Decrypt encrypted recovery material back into a raw master key
 */
export async function decryptMasterKey(
	data: EncryptedData,
	recoveryKey: string,
	email: string,
): Promise<Uint8Array> {
	await autoInit();

	const wasmData = new JsEncryptedData(
		data.ciphertext,
		data.iv,
		data.algorithm,
	);

	const masterKeyBase64 = wasmDecryptMasterKey(wasmData, recoveryKey, email);
	return base64ToUint8Array(masterKeyBase64);
}

// ============================================================================
// SRP-6a Client (matching @bittery/crypto/srp-client)
// ============================================================================

// Cached SRP client instance (reuse for better performance)
let srpClient: JsSrpClient | null = null;

// Cache for JsSession objects (needed because verifySession requires the actual WASM object)
// Keyed by session proof string
const sessionCache = new Map<string, JsSession>();

function getSrpClient(): JsSrpClient {
	ensureInitialized();
	if (!srpClient) {
		srpClient = new JsSrpClient("SHA-256", 4096);
	}
	return srpClient;
}

/**
 * Generate salt and verifier for registration
 */
export async function generateSRPRegistration(
	password: string,
): Promise<SRPRegistration> {
	await autoInit();

	const client = getSrpClient();
	const salt = client.generateSalt();
	const privateKey = client.deriveSafePrivateKey(salt, password);
	const verifier = client.deriveVerifier(privateKey);

	return { salt, verifier };
}

/**
 * Generate client ephemeral key pair
 */
export function generateClientEphemeral(): SRPClientEphemeral {
	const client = getSrpClient();
	const ephemeral = client.generateEphemeral();

	return {
		publicKey: ephemeral.public,
		secret: ephemeral.secret,
	};
}

/**
 * Generate client ephemeral key pair (async version for compatibility)
 */
export async function generateClientEphemeralAsync(): Promise<SRPClientEphemeral> {
	await autoInit();
	return generateClientEphemeral();
}

/**
 * Derive client session and proof
 */
export async function deriveClientSession(
	clientEphemeralSecret: string,
	serverChallenge: SRPServerChallenge,
	password: string,
): Promise<SRPClientSession> {
	await autoInit();

	const client = getSrpClient();

	// First derive the safe private key from the salt and password
	const privateKey = client.deriveSafePrivateKey(
		serverChallenge.salt,
		password,
	);

	// Then derive the session
	const session = client.deriveSession(
		clientEphemeralSecret,
		serverChallenge.serverPublicKey,
		serverChallenge.salt,
		"", // Empty string when using deriveSafePrivateKey
		privateKey,
	);

	// Cache the actual JsSession object for later verification
	// (verifySession requires the WASM object, not a plain JS object)
	sessionCache.set(session.proof, session);

	return {
		key: session.key,
		proof: session.proof,
	};
}

/**
 * Verify server session proof
 */
export async function verifyServerSession(
	clientPublicEphemeral: string,
	clientSession: SRPClientSession,
	serverSessionProof: string,
): Promise<void> {
	await autoInit();

	const client = getSrpClient();

	// Retrieve the cached JsSession object (required by WASM verifySession)
	const cachedSession = sessionCache.get(clientSession.proof);
	if (!cachedSession) {
		throw new Error(
			"Session not found in cache. deriveClientSession must be called first.",
		);
	}

	client.verifySession(
		clientPublicEphemeral,
		cachedSession,
		serverSessionProof,
	);

	// Clean up the cached session after successful verification
	sessionCache.delete(clientSession.proof);
}

// ============================================================================
// Key Rotation (for vault member removal)
// ============================================================================

export interface MemberKeyData {
	userId: string;
	publicKey: string;
}

export interface ItemData {
	id: string;
	encryptedData: string;
	encryptionIv: string;
	encryptionAlgorithm: string;
}

export interface ReEncryptedItem {
	itemId: string;
	encryptedData: string;
	encryptionIv: string;
}

export interface MemberEncryptedKey {
	userId: string;
	encryptedVaultKey: string;
}

export interface KeyRotationResult {
	newVaultKey: Uint8Array;
	newVaultKeyBase64: string;
	memberEncryptedKeys: MemberEncryptedKey[];
	reEncryptedItems: ReEncryptedItem[];
}

export interface ValidationResult {
	valid: boolean;
	errors: string[];
}

/**
 * Perform a complete key rotation
 * 1. Generate a new vault key
 * 2. Encrypt the new key for each remaining member
 * 3. Re-encrypt all items with the new key
 */
export async function performKeyRotation(
	oldVaultKey: Uint8Array,
	members: MemberKeyData[],
	items: ItemData[],
	currentUserId: string,
	masterUnlockKey: Uint8Array,
): Promise<KeyRotationResult> {
	await autoInit();

	const oldKeyBase64 = uint8ArrayToBase64(oldVaultKey);
	const mukBase64 = uint8ArrayToBase64(masterUnlockKey);

	// Convert to JSON for WASM
	const membersJson = JSON.stringify(
		members.map((m) => ({
			user_id: m.userId,
			public_key: m.publicKey,
		})),
	);
	const itemsJson = JSON.stringify(
		items.map((i) => ({
			id: i.id,
			encrypted_data: i.encryptedData,
			encryption_iv: i.encryptionIv,
			encryption_algorithm: i.encryptionAlgorithm,
		})),
	);

	const result = wasmPerformKeyRotation(
		oldKeyBase64,
		membersJson,
		itemsJson,
		currentUserId,
		mukBase64,
	);

	// Parse the results from WASM
	const memberEncryptedKeys = result.getMemberEncryptedKeys() as Array<{
		user_id: string;
		encrypted_vault_key: string;
	}>;
	const reEncryptedItems = result.getReEncryptedItems() as Array<{
		item_id: string;
		encrypted_data: string;
		encryption_iv: string;
	}>;

	return {
		newVaultKey: base64ToUint8Array(result.new_vault_key_base64),
		newVaultKeyBase64: result.new_vault_key_base64,
		memberEncryptedKeys: memberEncryptedKeys.map((m) => ({
			userId: m.user_id,
			encryptedVaultKey: m.encrypted_vault_key,
		})),
		reEncryptedItems: reEncryptedItems.map((i) => ({
			itemId: i.item_id,
			encryptedData: i.encrypted_data,
			encryptionIv: i.encryption_iv,
		})),
	};
}

/**
 * Validate that rotation can be performed
 */
export async function validateRotationData(
	members: MemberKeyData[],
): Promise<ValidationResult> {
	await autoInit();

	const membersJson = JSON.stringify(
		members.map((m) => ({
			user_id: m.userId,
			public_key: m.publicKey,
		})),
	);

	const result = wasmValidateRotationData(membersJson);
	const errors = result.getErrors() as string[];

	return {
		valid: result.valid,
		errors,
	};
}
