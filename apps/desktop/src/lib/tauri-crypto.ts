/**
 * Tauri Crypto - Native Rust cryptographic operations via Tauri
 *
 * Provides the same interface as @bittery/crypto for drop-in replacement
 * in the desktop app, but uses native Rust crypto via Tauri commands.
 */

import { unwrapPlaintextWithContext } from "@bittery/shared/crypto-context-envelope";
import { attachVaultKeyWrapContext } from "@bittery/shared/vault-key-crypto";
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
import { invoke } from "@tauri-apps/api/core";

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
// Internal response types (from Rust)
// ============================================================================

interface DerivedKeysResponse {
	auth_key: string;
	master_unlock_key: string;
}

interface EncryptResponse {
	ciphertext: string;
	iv: string;
	algorithm: string;
}

interface RsaKeyPairResponse {
	public_key: string;
	private_key: string;
}

interface EphemeralResponse {
	public: string;
	secret: string;
}

interface SessionResponse {
	key: string;
	proof: string;
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
 * Exported for use in share-item-dialog and other places
 */
export function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	return uint8ArrayToBase64(bytes);
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
	params?: KdfParams,
): Promise<DerivedKeys> {
	const response = await invoke<DerivedKeysResponse>("crypto_derive_keys", {
		password: accountPassword,
		secretKey,
		email,
		algorithm: params?.algorithm ?? null,
		iterations: params?.iterations ?? null,
	});

	return {
		authKey: base64ToUint8Array(response.auth_key),
		masterUnlockKey: base64ToUint8Array(response.master_unlock_key),
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
	const keyBase64 = uint8ArrayToBase64(key);
	const response = context
		? await invoke<EncryptResponse>("crypto_encrypt_with_context", {
				plaintext,
				keyBase64,
				vaultId: context.vaultId,
				entityId: context.entityId,
				entityType: context.entityType,
				version: context.version,
				userId: context.userId,
			})
		: await invoke<EncryptResponse>("crypto_encrypt", {
				plaintext,
				keyBase64,
			});

	const encryptedData: EncryptedData = {
		ciphertext: response.ciphertext,
		iv: response.iv,
		algorithm: response.algorithm,
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
	const keyBase64 = uint8ArrayToBase64(key);
	if (!context) {
		return invoke<string>("crypto_decrypt", {
			ciphertext: data.ciphertext,
			iv: data.iv,
			algorithm: data.algorithm,
			keyBase64,
		});
	}

	try {
		return await invoke<string>("crypto_decrypt_with_context", {
			ciphertext: data.ciphertext,
			iv: data.iv,
			algorithm: data.algorithm,
			keyBase64,
			vaultId: context.vaultId,
			entityId: context.entityId,
			entityType: context.entityType,
			version: context.version,
			userId: context.userId,
		});
	} catch {
		const decrypted = await invoke<string>("crypto_decrypt", {
			ciphertext: data.ciphertext,
			iv: data.iv,
			algorithm: data.algorithm,
			keyBase64,
		});
		return unwrapPlaintextWithContext(decrypted, context);
	}
}

export async function validateServerKdfParams(
	serverParams: KdfParams,
	pinnedParams?: KdfParams | null,
): Promise<void> {
	await invoke<void>("crypto_validate_server_kdf_params", {
		serverParamsJson: JSON.stringify(serverParams),
		pinnedParamsJson: pinnedParams ? JSON.stringify(pinnedParams) : null,
	});
}

/**
 * Generate a random 256-bit encryption key
 */
export async function generateEncryptionKey(): Promise<Uint8Array> {
	const keyBase64 = await invoke<string>("crypto_generate_encryption_key");
	return base64ToUint8Array(keyBase64);
}

/**
 * Generate a UUID for client-side entity IDs.
 */
export async function generateUuid(): Promise<string> {
	return invoke<string>("crypto_generate_uuid");
}

// ============================================================================
// RSA-4096 (matching @bittery/crypto/rsa)
// ============================================================================

/**
 * Generate an RSA-4096 key pair
 */
export async function generateRsaKeyPair(): Promise<RsaKeyPair> {
	const response = await invoke<RsaKeyPairResponse>(
		"crypto_generate_rsa_key_pair",
	);
	return {
		publicKey: response.public_key,
		privateKey: response.private_key,
	};
}

/**
 * Encrypt data with RSA-OAEP using a public key
 */
export async function rsaEncrypt(
	plaintext: string,
	publicKeyPem: string,
): Promise<string> {
	return await invoke<string>("crypto_rsa_encrypt", {
		plaintext,
		publicKeyPem,
	});
}

/**
 * Decrypt data with RSA-OAEP using a private key
 */
export async function rsaDecrypt(
	ciphertext: string,
	privateKeyPem: string,
): Promise<string> {
	return await invoke<string>("crypto_rsa_decrypt", {
		ciphertext,
		privateKeyPem,
	});
}

// ============================================================================
// Secret Key (matching @bittery/crypto/secret-key)
// ============================================================================

/**
 * Generate a new secret key in A3-XXXXXX format
 */
export async function generateSecretKey(): Promise<string> {
	return await invoke<string>("crypto_generate_secret_key");
}

/**
 * Validate secret key format
 */
export async function validateSecretKey(secretKey: string): Promise<boolean> {
	return await invoke<boolean>("crypto_validate_secret_key", { secretKey });
}

/**
 * Get the hint (first 5 characters) from a secret key
 */
export async function getSecretKeyHint(secretKey: string): Promise<string> {
	return await invoke<string>("crypto_get_secret_key_hint", { secretKey });
}

// ============================================================================
// SRP-6a Client (matching @bittery/crypto/srp-client)
// ============================================================================

/**
 * Generate salt and verifier for registration
 */
export async function generateSRPRegistration(
	password: string,
): Promise<SRPRegistration> {
	const salt = await invoke<string>("crypto_srp_generate_salt");
	const privateKey = await invoke<string>(
		"crypto_srp_derive_safe_private_key",
		{
			salt,
			password,
			iterations: null as unknown as number | undefined,
		},
	);
	const verifier = await invoke<string>("crypto_srp_derive_verifier", {
		privateKey,
	});

	return { salt, verifier };
}

/**
 * Generate client ephemeral key pair
 */
export async function generateClientEphemeral(): Promise<SRPClientEphemeral> {
	const response = await invoke<EphemeralResponse>(
		"crypto_srp_generate_ephemeral",
	);
	return {
		publicKey: response.public,
		secret: response.secret,
	};
}

/**
 * Derive client session and proof
 */
export async function deriveClientSession(
	clientEphemeralSecret: string,
	serverChallenge: SRPServerChallenge,
	password: string,
): Promise<SRPClientSession> {
	// First derive the safe private key from the salt and password
	const privateKey = await invoke<string>(
		"crypto_srp_derive_safe_private_key",
		{
			salt: serverChallenge.salt,
			password,
			iterations: null as unknown as number | undefined,
		},
	);

	// Then derive the session
	const response = await invoke<SessionResponse>("crypto_srp_derive_session", {
		clientSecretEphemeral: clientEphemeralSecret,
		serverPublicEphemeral: serverChallenge.serverPublicKey,
		salt: serverChallenge.salt,
		username: "", // Empty string when using deriveSafePrivateKey
		privateKey,
	});

	return {
		key: response.key,
		proof: response.proof,
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
	await invoke<void>("crypto_srp_verify_session", {
		clientPublicEphemeral,
		sessionKey: clientSession.key,
		sessionProof: clientSession.proof,
		serverSessionProof,
	});
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

interface KeyRotationResponse {
	member_encrypted_keys: Array<{
		user_id: string;
		encrypted_vault_key: string;
	}>;
	re_encrypted_items: Array<{
		item_id: string;
		encrypted_data: string;
		encryption_iv: string;
	}>;
}

interface ValidationResponse {
	valid: boolean;
	errors: string[];
}

/**
 * Perform a complete key rotation
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
	const oldKeyBase64 = uint8ArrayToBase64(oldVaultKey);
	const mukBase64 = uint8ArrayToBase64(masterUnlockKey);

	const response = await invoke<KeyRotationResponse>(
		"crypto_perform_key_rotation",
		{
			oldVaultKeyBase64: oldKeyBase64,
			members: members.map((m) => ({
				user_id: m.userId,
				public_key: m.publicKey,
			})),
			items: items.map((i) => ({
				id: i.id,
				encrypted_data: i.encryptedData,
				encryption_iv: i.encryptionIv,
				encryption_algorithm: i.encryptionAlgorithm,
			})),
			vaultId,
			keyVersion,
			currentUserId,
			masterUnlockKeyBase64: mukBase64,
		},
	);

	return {
		memberEncryptedKeys: response.member_encrypted_keys.map((m) => ({
			userId: m.user_id,
			encryptedVaultKey: m.encrypted_vault_key,
		})),
		reEncryptedItems: response.re_encrypted_items.map((i) => ({
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
	const response = await invoke<ValidationResponse>(
		"crypto_validate_rotation_data",
		{
			members: members.map((m) => ({
				user_id: m.userId,
				public_key: m.publicKey,
			})),
		},
	);

	return {
		valid: response.valid,
		errors: response.errors,
	};
}
