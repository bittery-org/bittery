import { requireNativeModule } from "expo-modules-core";
import type {
	DerivedKeys,
	EncryptedData,
	Ephemeral,
	HashAlgorithm,
	PrimeGroup,
	RsaKeyPair,
	Session,
	TotpResult,
} from "./BitteryCrypto.types";
import { CryptoError, ErrorCode } from "./BitteryCrypto.types";

// Load the native module
const NativeModule = requireNativeModule("BitteryCrypto");

// ============================================================================
// Key Derivation
// ============================================================================

/**
 * Convert base64 string to Uint8Array
 */
function base64ToUint8Array(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

/**
 * Derive authentication and master unlock keys from password, secret key, and email.
 * Uses PBKDF2 (100k iterations) + HKDF for key splitting.
 */
export async function deriveKeys(
	password: string,
	secretKey: string,
	email: string,
): Promise<DerivedKeys> {
	try {
		// Native module returns base64-encoded strings
		const result = await NativeModule.deriveKeys(password, secretKey, email);
		// Convert to Uint8Array to match DerivedKeys interface
		return {
			authKey: base64ToUint8Array(result.authKey),
			masterUnlockKey: base64ToUint8Array(result.masterUnlockKey),
		};
	} catch (error) {
		throw new CryptoError(
			ErrorCode.KeyDerivationFailed,
			`Key derivation failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

// ============================================================================
// AES-256-GCM Encryption
// ============================================================================

/**
 * Encrypt plaintext using AES-256-GCM.
 * @param plaintext - String to encrypt
 * @param keyBase64 - Base64-encoded 32-byte encryption key
 */
export async function encrypt(
	plaintext: string,
	keyBase64: string,
): Promise<EncryptedData> {
	try {
		const result = await NativeModule.encrypt(plaintext, keyBase64);
		return {
			ciphertext: result.ciphertext,
			iv: result.iv,
			algorithm: result.algorithm,
		};
	} catch (error) {
		throw new CryptoError(
			ErrorCode.EncryptionFailed,
			`Encryption failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Decrypt data using AES-256-GCM.
 * @param ciphertext - Base64-encoded ciphertext
 * @param iv - Base64-encoded initialization vector
 * @param keyBase64 - Base64-encoded 32-byte encryption key
 */
export async function decrypt(
	ciphertext: string,
	iv: string,
	algorithm: string,
	keyBase64: string,
): Promise<string> {
	try {
		return await NativeModule.decrypt(ciphertext, iv, algorithm, keyBase64);
	} catch (error) {
		throw new CryptoError(
			ErrorCode.DecryptionFailed,
			`Decryption failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Encrypt plaintext using AES-256-GCM with authenticated context (AAD).
 * @param plaintext - String to encrypt
 * @param keyBase64 - Base64-encoded 32-byte encryption key
 * @param vaultId - Vault ID for AAD context
 * @param entityId - Entity ID for AAD context
 * @param entityType - Entity type for AAD context
 * @param version - Version number for AAD context
 * @param userId - User ID for AAD context
 */
export async function encryptWithContext(
	plaintext: string,
	keyBase64: string,
	vaultId: string,
	entityId: string,
	entityType: string,
	version: number,
	userId: string,
): Promise<EncryptedData> {
	try {
		const result = await NativeModule.encryptWithContext(
			plaintext,
			keyBase64,
			vaultId,
			entityId,
			entityType,
			version,
			userId,
		);
		return {
			ciphertext: result.ciphertext,
			iv: result.iv,
			algorithm: result.algorithm,
		};
	} catch (error) {
		throw new CryptoError(
			ErrorCode.EncryptionFailed,
			`Encryption failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Decrypt data using AES-256-GCM with authenticated context (AAD).
 * @param ciphertext - Base64-encoded ciphertext
 * @param iv - Base64-encoded initialization vector
 * @param algorithm - Algorithm identifier
 * @param keyBase64 - Base64-encoded 32-byte encryption key
 * @param vaultId - Vault ID for AAD context
 * @param entityId - Entity ID for AAD context
 * @param entityType - Entity type for AAD context
 * @param version - Version number for AAD context
 * @param userId - User ID for AAD context
 */
export async function decryptWithContext(
	ciphertext: string,
	iv: string,
	algorithm: string,
	keyBase64: string,
	vaultId: string,
	entityId: string,
	entityType: string,
	version: number,
	userId: string,
): Promise<string> {
	try {
		return await NativeModule.decryptWithContext(
			{ ciphertext, iv, algorithm },
			keyBase64,
			vaultId,
			entityId,
			entityType,
			version,
			userId,
		);
	} catch (error) {
		throw new CryptoError(
			ErrorCode.DecryptionFailed,
			`Decryption failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Generate a random 256-bit encryption key.
 * @returns Base64-encoded 32-byte key
 */
export function generateEncryptionKey(): string {
	return NativeModule.generateEncryptionKey();
}

// ============================================================================
// RSA-4096
// ============================================================================

/**
 * Generate a new RSA-4096 key pair.
 */
export async function generateRsaKeyPair(): Promise<RsaKeyPair> {
	try {
		const result = await NativeModule.generateRsaKeyPair();
		return {
			publicKey: result.publicKey,
			privateKey: result.privateKey,
		};
	} catch (error) {
		throw new CryptoError(
			ErrorCode.RsaOperationFailed,
			`RSA key generation failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Encrypt data with RSA-OAEP.
 * @param plaintext - String to encrypt
 * @param publicKeyPem - PEM-encoded public key
 * @returns Base64-encoded ciphertext
 */
export async function rsaEncrypt(
	plaintext: string,
	publicKeyPem: string,
): Promise<string> {
	try {
		return await NativeModule.rsaEncrypt(plaintext, publicKeyPem);
	} catch (error) {
		throw new CryptoError(
			ErrorCode.RsaOperationFailed,
			`RSA encryption failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Decrypt data with RSA-OAEP.
 * @param ciphertext - Base64-encoded ciphertext
 * @param privateKeyPem - PEM-encoded private key
 * @returns Decrypted plaintext
 */
export async function rsaDecrypt(
	ciphertext: string,
	privateKeyPem: string,
): Promise<string> {
	try {
		return await NativeModule.rsaDecrypt(ciphertext, privateKeyPem);
	} catch (error) {
		throw new CryptoError(
			ErrorCode.RsaOperationFailed,
			`RSA decryption failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

// ============================================================================
// Secret Key
// ============================================================================

/**
 * Generate a new secret key in A3-XXXXXX format.
 */
export function generateSecretKey(): string {
	return NativeModule.generateSecretKey();
}

/**
 * Validate secret key format.
 */
export function validateSecretKey(secretKey: string): boolean {
	return NativeModule.validateSecretKey(secretKey);
}

/**
 * Get the hint portion of a secret key (first segment).
 */
export function getSecretKeyHint(secretKey: string): string {
	return NativeModule.getSecretKeyHint(secretKey);
}

// ============================================================================
// TOTP (Time-Based One-Time Password)
// ============================================================================

/**
 * Generate a TOTP code for the current time.
 * @param secret - Base32-encoded shared secret
 * @param algorithm - Hash algorithm: "SHA1", "SHA256", or "SHA512" (default: "SHA1")
 * @param digits - Number of OTP digits: 6, 7, or 8 (default: 6)
 * @param period - Time step in seconds (default: 30)
 */
export function generateTotp(options: {
	secret: string;
	algorithm?: string;
	digits?: number;
	period?: number;
}): TotpResult {
	try {
		return NativeModule.generateTotp(
			options.secret,
			options.algorithm ?? "SHA1",
			options.digits ?? 6,
			options.period ?? 30,
		) as TotpResult;
	} catch (error) {
		throw new CryptoError(
			ErrorCode.NativeError,
			`TOTP generation failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

// ============================================================================
// SRP-6a Client
// ============================================================================

/**
 * Create a new SRP client instance.
 */
export function createSRPClient(
	hashAlgorithm: HashAlgorithm,
	primeGroup: PrimeGroup,
) {
	const clientId = NativeModule.srpClientNew(hashAlgorithm, primeGroup);

	return {
		/**
		 * Generate a random salt for password registration.
		 */
		generateSalt(): string {
			return NativeModule.srpClientGenerateSalt(clientId);
		},

		/**
		 * Derive a safe private key from salt and password using PBKDF2.
		 * @param iterations - PBKDF2 iterations (default based on hash algorithm)
		 */
		async deriveSafePrivateKey(
			salt: string,
			password: string,
			iterations?: number,
		): Promise<string> {
			try {
				const privateKey = await NativeModule.srpClientDeriveSafePrivateKey(
					clientId,
					salt,
					password,
					iterations ?? 0,
				);
				if (!privateKey) {
					throw new Error(
						"Native SRP private key derivation returned empty result",
					);
				}
				return privateKey;
			} catch (error) {
				throw new CryptoError(
					ErrorCode.SrpOperationFailed,
					`SRP key derivation failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},

		/**
		 * Derive verifier from private key.
		 */
		deriveVerifier(privateKey: string): string {
			const verifier = NativeModule.srpClientDeriveVerifier(
				clientId,
				privateKey,
			);
			if (!verifier) {
				throw new CryptoError(
					ErrorCode.SrpOperationFailed,
					"SRP verifier derivation failed: native returned empty result",
				);
			}
			return verifier;
		},

		/**
		 * Generate client ephemeral key pair.
		 */
		generateEphemeral(): Ephemeral {
			const result = NativeModule.srpClientGenerateEphemeral(clientId);
			if (!result.public || !result.secret) {
				throw new CryptoError(
					ErrorCode.SrpOperationFailed,
					"SRP ephemeral generation failed: native returned empty values",
				);
			}
			return {
				public: result.public,
				secret: result.secret,
			};
		},

		/**
		 * Derive session key and proof.
		 */
		async deriveSession(
			clientSecretEphemeral: string,
			serverPublicEphemeral: string,
			salt: string,
			username: string,
			privateKey: string,
		): Promise<Session> {
			try {
				const result = await NativeModule.srpClientDeriveSession(
					clientId,
					clientSecretEphemeral,
					serverPublicEphemeral,
					salt,
					username,
					privateKey,
				);
				return {
					key: result.key,
					proof: result.proof,
				};
			} catch (error) {
				throw new CryptoError(
					ErrorCode.SrpOperationFailed,
					`SRP session derivation failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},

		/**
		 * Verify server's session proof.
		 * @param clientPublicEphemeral - Client's public ephemeral (A)
		 * @param clientSession - Client's session containing key and proof
		 * @param serverSessionProof - Server's proof (M2)
		 */
		async verifySession(
			clientPublicEphemeral: string,
			clientSession: Session,
			serverSessionProof: string,
		): Promise<void> {
			try {
				await NativeModule.srpClientVerifySession(
					clientId,
					clientPublicEphemeral,
					clientSession.key,
					clientSession.proof,
					serverSessionProof,
				);
			} catch (error) {
				throw new CryptoError(
					ErrorCode.SrpOperationFailed,
					`SRP session verification failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},

		/**
		 * Free native resources. Call when done with the client.
		 */
		destroy(): void {
			NativeModule.srpClientFree(clientId);
		},
	};
}

// ============================================================================
// SRP-6a Server
// ============================================================================

/**
 * Create a new SRP server instance.
 */
export function createSRPServer(
	hashAlgorithm: HashAlgorithm,
	primeGroup: PrimeGroup,
) {
	const serverId = NativeModule.srpServerNew(hashAlgorithm, primeGroup);

	return {
		/**
		 * Generate server ephemeral from verifier.
		 */
		async generateEphemeral(verifier: string): Promise<Ephemeral> {
			try {
				const result = await NativeModule.srpServerGenerateEphemeral(
					serverId,
					verifier,
				);
				if (!result.public || !result.secret) {
					throw new Error(
						"Native SRP ephemeral generation returned empty result",
					);
				}
				return {
					public: result.public,
					secret: result.secret,
				};
			} catch (error) {
				throw new CryptoError(
					ErrorCode.SrpOperationFailed,
					`SRP ephemeral generation failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},

		/**
		 * Derive session key and proof, verifying client proof.
		 */
		async deriveSession(
			serverSecretEphemeral: string,
			clientPublicEphemeral: string,
			salt: string,
			username: string,
			verifier: string,
			clientSessionProof: string,
		): Promise<Session> {
			try {
				const result = await NativeModule.srpServerDeriveSession(
					serverId,
					serverSecretEphemeral,
					clientPublicEphemeral,
					salt,
					username,
					verifier,
					clientSessionProof,
				);
				return {
					key: result.key,
					proof: result.proof,
				};
			} catch (error) {
				throw new CryptoError(
					ErrorCode.SrpOperationFailed,
					`SRP session derivation failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},

		/**
		 * Free native resources. Call when done with the server.
		 */
		destroy(): void {
			NativeModule.srpServerFree(serverId);
		},
	};
}

// ============================================================================
// Key Rotation
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

/**
 * Perform a complete key rotation.
 * @param oldVaultKeyBase64 - Current vault key (base64)
 * @param members - Members to encrypt the new key for
 * @param items - Items to re-encrypt
 * @param currentUserId - Current user's ID (for MUK encryption)
 * @param masterUnlockKeyBase64 - Current user's MUK (base64)
 */
export async function performKeyRotation(
	oldVaultKeyBase64: string,
	members: MemberKeyData[],
	items: ItemData[],
	vaultId: string,
	keyVersion: number,
	currentUserId: string,
	masterUnlockKeyBase64: string,
): Promise<KeyRotationResult> {
	try {
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

		const result = await NativeModule.performKeyRotation(
			oldVaultKeyBase64,
			membersJson,
			itemsJson,
			vaultId,
			keyVersion,
			currentUserId,
			masterUnlockKeyBase64,
		);

		const memberEncryptedKeys = JSON.parse(
			result.memberEncryptedKeysJson,
		) as Array<{
			user_id: string;
			encrypted_vault_key: string;
		}>;
		const reEncryptedItems = JSON.parse(result.reEncryptedItemsJson) as Array<{
			item_id: string;
			encrypted_data: string;
			encryption_iv: string;
		}>;

		return {
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
	} catch (error) {
		throw new CryptoError(
			ErrorCode.EncryptionFailed,
			`Key rotation failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Validate that rotation can be performed.
 */
export async function validateRotationData(
	members: MemberKeyData[],
): Promise<ValidationResult> {
	try {
		const membersJson = JSON.stringify(
			members.map((m) => ({
				user_id: m.userId,
				public_key: m.publicKey,
			})),
		);

		const result = await NativeModule.validateRotationData(membersJson);
		const errors = JSON.parse(result.errorsJson) as string[];

		return {
			valid: result.valid === 1,
			errors,
		};
	} catch (error) {
		throw new CryptoError(
			ErrorCode.EncryptionFailed,
			`Validation failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
