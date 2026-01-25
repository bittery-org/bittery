/**
 * WASM Crypto - Rust-based cryptographic operations via WebAssembly
 *
 * Provides the same interface as @bittery/crypto for drop-in replacement
 * in the web app, using native Rust crypto compiled to WASM.
 */

import init, {
	decrypt as wasmDecrypt,
	deriveKeys as wasmDeriveKeys,
	encrypt as wasmEncrypt,
	generateEncryptionKey as wasmGenerateEncryptionKey,
	generateRSAKeyPair as wasmGenerateRSAKeyPair,
	generateSecretKey as wasmGenerateSecretKey,
	getSecretKeyHint as wasmGetSecretKeyHint,
	JsEncryptedData,
	JsSrpClient,
	rsaDecrypt as wasmRsaDecrypt,
	rsaEncrypt as wasmRsaEncrypt,
	validateSecretKey as wasmValidateSecretKey,
	type JsSession,
} from "@bittery/crypto-wasm";

// ============================================================================
// Types (matching @bittery/crypto interfaces)
// ============================================================================

export interface DerivedKeys {
	authKey: Uint8Array;
	masterUnlockKey: Uint8Array;
}

export interface EncryptedData {
	ciphertext: string;
	iv: string;
	algorithm: string;
}

export interface RsaKeyPair {
	publicKey: string;
	privateKey: string;
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

export interface SRPRegistration {
	salt: string;
	verifier: string;
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

/**
 * Convert an ArrayBuffer or Uint8Array to base64 string
 * Exported for use in share dialogs and other places
 */
export function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
	const bytes =
		buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
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
export async function getSecretKeyHintAsync(secretKey: string): Promise<string> {
	await autoInit();
	return wasmGetSecretKeyHint(secretKey);
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

	client.verifySession(clientPublicEphemeral, cachedSession, serverSessionProof);

	// Clean up the cached session after successful verification
	sessionCache.delete(clientSession.proof);
}
