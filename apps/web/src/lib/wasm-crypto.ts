/**
 * WASM Crypto - Rust-based cryptographic operations via WebAssembly
 *
 * Provides the same interface as @bittery/crypto for drop-in replacement
 * in the web app, using native Rust crypto compiled to WASM.
 */

import init, {
	cloneKeyHandle as wasmCloneKeyHandle,
	JsAadContext,
	JsEncryptedData,
	type JsSession,
	JsSrpClient,
	decrypt as wasmDecrypt,
	decryptKeyHandleWithKey as wasmDecryptKeyHandleWithKey,
	decryptWithContextHandle as wasmDecryptWithContextHandle,
	decryptWithContext as wasmDecryptWithContext,
	decryptWithHandle as wasmDecryptWithHandle,
	decryptMasterKey as wasmDecryptMasterKey,
	deriveKeysHandle as wasmDeriveKeysHandle,
	deriveKeys as wasmDeriveKeys,
	deriveKeysFromMasterKey as wasmDeriveKeysFromMasterKey,
	deriveMasterKey as wasmDeriveMasterKey,
	deriveSrpPasswordFromHandle as wasmDeriveSrpPasswordFromHandle,
	destroyKeyHandle as wasmDestroyKeyHandle,
	encrypt as wasmEncrypt,
	encryptKeyHandleWithKey as wasmEncryptKeyHandleWithKey,
	encryptWithContextHandle as wasmEncryptWithContextHandle,
	encryptWithContext as wasmEncryptWithContext,
	encryptWithHandle as wasmEncryptWithHandle,
	encryptMasterKey as wasmEncryptMasterKey,
	exportKeyHandle as wasmExportKeyHandle,
	generateEncryptionKey as wasmGenerateEncryptionKey,
	generateRecoveryKey as wasmGenerateRecoveryKey,
	generateRSAKeyPair as wasmGenerateRSAKeyPair,
	generateSecretKey as wasmGenerateSecretKey,
	generateUuid as wasmGenerateUuid,
	getSecretKeyHint as wasmGetSecretKeyHint,
	importKeyHandle as wasmImportKeyHandle,
	performKeyRotation as wasmPerformKeyRotation,
	rsaDecrypt as wasmRsaDecrypt,
	rsaEncrypt as wasmRsaEncrypt,
	validateRecoveryKey as wasmValidateRecoveryKey,
	validateRotationData as wasmValidateRotationData,
	validateSecretKey as wasmValidateSecretKey,
} from "@bittery/crypto-wasm";
import {
	unwrapPlaintextWithContext,
} from "@bittery/shared/crypto-context-envelope";
import {
	attachVaultKeyWrapContext,
} from "@bittery/shared/vault-key-crypto";
import type {
	DerivedKeys,
	EncryptedData,
	EncryptionContext,
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

export interface DerivedKeyHandles {
	authKeyHandle: number;
	masterUnlockKeyHandle: number;
}

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

function toWasmHandle(handle: number): bigint {
	if (!Number.isSafeInteger(handle) || handle < 1) {
		throw new Error("Invalid key handle");
	}
	return BigInt(handle);
}

function fromWasmHandle(value: bigint): number {
	const handle = Number(value);
	if (!Number.isSafeInteger(handle) || handle < 1) {
		throw new Error("Invalid key handle from WASM");
	}
	return handle;
}

function toWasmAadContext(context: EncryptionContext): JsAadContext {
	return new JsAadContext(
		context.vaultId,
		context.entityId,
		context.entityType,
		BigInt(context.version),
		context.userId,
	);
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
 * Derive opaque key handles for auth key + master unlock key.
 */
export async function deriveKeyHandles(
	accountPassword: string,
	secretKey: string,
	email: string,
): Promise<DerivedKeyHandles> {
	await autoInit();

	const result = wasmDeriveKeysHandle(accountPassword, secretKey, email);

	return {
		authKeyHandle: fromWasmHandle(result.auth_key_handle),
		masterUnlockKeyHandle: fromWasmHandle(result.master_unlock_key_handle),
	};
}

/**
 * Convert an auth-key handle into the SRP password string used by SRP helpers.
 */
export async function deriveSrpPasswordFromKeyHandle(
	authKeyHandle: number,
): Promise<string> {
	await autoInit();
	return wasmDeriveSrpPasswordFromHandle(toWasmHandle(authKeyHandle));
}

export const deriveSrpPasswordFromHandle = deriveSrpPasswordFromKeyHandle;

/**
 * Import raw key bytes into WASM as an opaque handle.
 */
export async function importKeyHandle(key: Uint8Array): Promise<number> {
	await autoInit();
	const handle = wasmImportKeyHandle(uint8ArrayToBase64(key));
	return fromWasmHandle(handle);
}

/**
 * Export key bytes from an opaque handle.
 * This is for compatibility only; prefer handle-based operations.
 */
export async function exportKeyHandle(keyHandle: number): Promise<Uint8Array> {
	await autoInit();
	const keyBase64 = wasmExportKeyHandle(toWasmHandle(keyHandle));
	return base64ToUint8Array(keyBase64);
}

/**
 * Clone an existing key handle.
 */
export async function cloneKeyHandle(keyHandle: number): Promise<number> {
	await autoInit();
	const cloned = wasmCloneKeyHandle(toWasmHandle(keyHandle));
	return fromWasmHandle(cloned);
}

/**
 * Destroy a key handle and zeroize the backing key material.
 */
export async function destroyKeyHandle(keyHandle: number): Promise<void> {
	await autoInit();
	wasmDestroyKeyHandle(toWasmHandle(keyHandle));
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
	context?: EncryptionContext,
): Promise<EncryptedData> {
	await autoInit();

	const keyBase64 = uint8ArrayToBase64(key);
	const result =
		context
			? wasmEncryptWithContext(plaintext, keyBase64, toWasmAadContext(context))
			: wasmEncrypt(plaintext, keyBase64);
	const encryptedData: EncryptedData = {
		ciphertext: result.ciphertext,
		iv: result.iv,
		algorithm: result.algorithm,
	};

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
 * Encrypt plaintext using an opaque key handle.
 */
export async function encryptWithKeyHandle(
	plaintext: string,
	keyHandle: number,
	context?: EncryptionContext,
): Promise<EncryptedData> {
	await autoInit();

	const result =
		context
			? wasmEncryptWithContextHandle(
					plaintext,
					toWasmHandle(keyHandle),
					toWasmAadContext(context),
				)
			: wasmEncryptWithHandle(plaintext, toWasmHandle(keyHandle));
	const encryptedData: EncryptedData = {
		ciphertext: result.ciphertext,
		iv: result.iv,
		algorithm: result.algorithm,
	};

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
 * Decrypt ciphertext using AES-256-GCM
 */
export async function decrypt(
	data: EncryptedData,
	key: Uint8Array,
	context?: EncryptionContext,
): Promise<string> {
	await autoInit();

	const keyBase64 = uint8ArrayToBase64(key);
	const createWasmData = () =>
		new JsEncryptedData(data.ciphertext, data.iv, data.algorithm);

	if (!context) {
		return wasmDecrypt(createWasmData(), keyBase64);
	}

	try {
		return wasmDecryptWithContext(
			createWasmData(),
			keyBase64,
			toWasmAadContext(context),
		);
	} catch {
		const decrypted = wasmDecrypt(createWasmData(), keyBase64);
		return unwrapPlaintextWithContext(decrypted, context);
	}
}

/**
 * Decrypt ciphertext using an opaque key handle.
 */
export async function decryptWithKeyHandle(
	data: EncryptedData,
	keyHandle: number,
	context?: EncryptionContext,
): Promise<string> {
	await autoInit();

	const createWasmData = () =>
		new JsEncryptedData(data.ciphertext, data.iv, data.algorithm);

	if (!context) {
		return wasmDecryptWithHandle(createWasmData(), toWasmHandle(keyHandle));
	}

	try {
		return wasmDecryptWithContextHandle(
			createWasmData(),
			toWasmHandle(keyHandle),
			toWasmAadContext(context),
		);
	} catch {
		const decrypted = wasmDecryptWithHandle(
			createWasmData(),
			toWasmHandle(keyHandle),
		);
		return unwrapPlaintextWithContext(decrypted, context);
	}
}

/**
 * Encrypt the key material behind a key handle with a wrapping key.
 */
export async function encryptKeyHandleWithWrappingKey(
	keyHandle: number,
	wrappingKey: Uint8Array,
): Promise<EncryptedData> {
	await autoInit();

	const result = wasmEncryptKeyHandleWithKey(
		toWasmHandle(keyHandle),
		uint8ArrayToBase64(wrappingKey),
	);
	return {
		ciphertext: result.ciphertext,
		iv: result.iv,
		algorithm: result.algorithm,
	};
}

/**
 * Decrypt wrapped key material into a new opaque key handle.
 */
export async function decryptKeyHandleWithWrappingKey(
	data: EncryptedData,
	wrappingKey: Uint8Array,
): Promise<number> {
	await autoInit();

	const wasmData = new JsEncryptedData(
		data.ciphertext,
		data.iv,
		data.algorithm,
	);
	const handle = wasmDecryptKeyHandleWithKey(
		wasmData,
		uint8ArrayToBase64(wrappingKey),
	);
	return fromWasmHandle(handle);
}

/**
 * Generate a random 256-bit encryption key
 */
export async function generateEncryptionKey(): Promise<Uint8Array> {
	await autoInit();

	const keyBase64 = wasmGenerateEncryptionKey();
	return base64ToUint8Array(keyBase64);
}

/**
 * Generate a UUID for client-side entity IDs.
 */
export async function generateUuid(): Promise<string> {
	await autoInit();

	if (typeof window !== "undefined") {
		return wasmGenerateUuid();
	}

	const random = globalThis?.crypto?.randomUUID?.();
	if (random) {
		return random;
	}

	// Last-resort fallback for non-browser environments without WebCrypto.
	const hex = () =>
		Math.floor(Math.random() * 0xffffffff)
			.toString(16)
			.padStart(8, "0");
	return `${hex()}-${hex().slice(0, 4)}-4${hex().slice(0, 3)}-a${hex().slice(0, 3)}-${hex()}${hex().slice(0, 4)}`;
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
	memberEncryptedKeys: MemberEncryptedKey[];
	reEncryptedItems: ReEncryptedItem[];
}

export interface ValidationResult {
	valid: boolean;
	errors: string[];
}

interface WasmMemberEncryptedKey {
	user_id: string;
	encrypted_vault_key: string;
}

interface WasmReEncryptedItem {
	item_id: string;
	encrypted_data: string;
	encryption_iv: string;
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
	vaultId: string,
	keyVersion: number,
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
		vaultId,
		BigInt(keyVersion),
		currentUserId,
		mukBase64,
	);

	// Parse the results from WASM
	const memberEncryptedKeys =
		result.getMemberEncryptedKeys() as WasmMemberEncryptedKey[];
	const reEncryptedItems = result.getReEncryptedItems() as WasmReEncryptedItem[];
	const normalizedMemberEncryptedKeys = memberEncryptedKeys.map((m) => ({
		userId: m.user_id,
		encryptedVaultKey: m.encrypted_vault_key,
	}));

	return {
		memberEncryptedKeys: normalizedMemberEncryptedKeys,
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
