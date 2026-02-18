/**
 * WASM Crypto - Rust-based cryptographic operations via WebAssembly
 *
 * Provides the same interface as @bittery/crypto for drop-in replacement
 * in the browser extension, using native Rust crypto compiled to WASM.
 *
 * Note: In Manifest V3 service workers, WASM needs to be initialized
 * on each wake from idle, so we use auto-init pattern.
 */

import * as wasmCrypto from "@bittery/crypto-wasm";
import init, {
	JsEncryptedData,
	type JsSession,
	JsSrpClient,
	decrypt as wasmDecrypt,
	decryptMasterKey as wasmDecryptMasterKey,
	deriveKeysFromMasterKey as wasmDeriveKeysFromMasterKey,
	deriveMasterKey as wasmDeriveMasterKey,
	deriveKeys as wasmDeriveKeys,
	encrypt as wasmEncrypt,
	encryptMasterKey as wasmEncryptMasterKey,
	generateEncryptionKey as wasmGenerateEncryptionKey,
	generateRecoveryKey as wasmGenerateRecoveryKey,
	rsaDecrypt as wasmRsaDecrypt,
	validateRecoveryKey as wasmValidateRecoveryKey,
	validateSecretKey as wasmValidateSecretKey,
} from "@bittery/crypto-wasm";
import type {
	DerivedKeys,
	EncryptedData,
	SRPClientEphemeral,
	SRPClientSession,
	SRPServerChallenge,
} from "@bittery/types";

// Re-export types for consumers
export type {
	DerivedKeys,
	EncryptedData,
	SRPClientEphemeral,
	SRPClientSession,
	SRPServerChallenge,
};

export interface PasskeyKeypair {
	privateKey: string;
	publicKeyCose: string;
}

export interface PasskeyAttestation {
	authenticatorData: Uint8Array;
	attestationObject: Uint8Array;
}

export interface PasskeyAssertion {
	authenticatorData: Uint8Array;
	signatureDer: Uint8Array;
}

type PasskeyWasmExports = {
	generatePasskeyKeypair?: () => {
		private_key: string;
		public_key_cose: string;
	};
	generatePasskeyCredentialId?: () => string;
	buildPasskeyAttestationObject?: (
		rpId: string,
		credentialIdBase64: string,
		cosePublicKeyBase64: string,
		signCount?: number,
	) => {
		authenticator_data: string;
		attestation_object: string;
	};
	signPasskeyAssertion?: (
		privateKeyBase64: string,
		rpId: string,
		clientDataHashBase64: string,
		signCount: number,
	) => {
		authenticator_data: string;
		signature_der: string;
	};
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
 */
export async function initWasmCrypto(): Promise<void> {
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

	const masterKeyBase64 = wasmDeriveMasterKey(accountPassword, secretKey, email);
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

	const result = wasmDeriveKeysFromMasterKey(uint8ArrayToBase64(masterKey), email);
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
// Passkey / WebAuthn
// ============================================================================

function getPasskeyExports(): PasskeyWasmExports {
	return wasmCrypto as unknown as PasskeyWasmExports;
}

export async function generatePasskeyKeypair(): Promise<PasskeyKeypair> {
	await autoInit();

	const fn = getPasskeyExports().generatePasskeyKeypair;
	if (typeof fn !== "function") {
		throw new Error(
			"Missing WASM export generatePasskeyKeypair. Rebuild @bittery/crypto-wasm.",
		);
	}

	const result = fn();
	return {
		privateKey: result.private_key,
		publicKeyCose: result.public_key_cose,
	};
}

export async function generatePasskeyCredentialId(): Promise<string> {
	await autoInit();

	const fn = getPasskeyExports().generatePasskeyCredentialId;
	if (typeof fn !== "function") {
		throw new Error(
			"Missing WASM export generatePasskeyCredentialId. Rebuild @bittery/crypto-wasm.",
		);
	}

	return fn();
}

export async function buildPasskeyAttestationObject(input: {
	rpId: string;
	credentialIdBase64: string;
	cosePublicKeyBase64: string;
	signCount?: number;
}): Promise<PasskeyAttestation> {
	await autoInit();

	const fn = getPasskeyExports().buildPasskeyAttestationObject;
	if (typeof fn !== "function") {
		throw new Error(
			"Missing WASM export buildPasskeyAttestationObject. Rebuild @bittery/crypto-wasm.",
		);
	}

	const result = fn(
		input.rpId,
		input.credentialIdBase64,
		input.cosePublicKeyBase64,
		input.signCount,
	);

	return {
		authenticatorData: base64ToUint8Array(result.authenticator_data),
		attestationObject: base64ToUint8Array(result.attestation_object),
	};
}

export async function signPasskeyAssertion(input: {
	privateKeyBase64: string;
	rpId: string;
	clientDataHashBase64: string;
	signCount: number;
}): Promise<PasskeyAssertion> {
	await autoInit();

	const fn = getPasskeyExports().signPasskeyAssertion;
	if (typeof fn !== "function") {
		throw new Error(
			"Missing WASM export signPasskeyAssertion. Rebuild @bittery/crypto-wasm.",
		);
	}

	const result = fn(
		input.privateKeyBase64,
		input.rpId,
		input.clientDataHashBase64,
		input.signCount,
	);

	return {
		authenticatorData: base64ToUint8Array(result.authenticator_data),
		signatureDer: base64ToUint8Array(result.signature_der),
	};
}

// ============================================================================
// RSA-4096 (matching @bittery/crypto/rsa)
// ============================================================================

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
// Secret Key Validation
// ============================================================================

/**
 * Validate secret key format (A3-XXXXXX-... format)
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
