import { requireNativeModule } from "expo-modules-core";
import type {
  DerivedKeys,
  EncryptedData,
  RsaKeyPair,
  Ephemeral,
  Session,
  HashAlgorithm,
  PrimeGroup,
} from "./BitteryCrypto.types";
import { CryptoError, ErrorCode } from "./BitteryCrypto.types";

// Load the native module
const NativeModule = requireNativeModule("BitteryCrypto");

// ============================================================================
// Key Derivation
// ============================================================================

/**
 * Derive authentication and master unlock keys from password, secret key, and email.
 * Uses PBKDF2 (100k iterations) + HKDF for key splitting.
 */
export async function deriveKeys(
  password: string,
  secretKey: string,
  email: string
): Promise<DerivedKeys> {
  try {
    const result = await NativeModule.deriveKeys(password, secretKey, email);
    return {
      authKey: result.authKey,
      masterUnlockKey: result.masterUnlockKey,
    };
  } catch (error) {
    throw new CryptoError(
      ErrorCode.KeyDerivationFailed,
      `Key derivation failed: ${error instanceof Error ? error.message : String(error)}`
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
  keyBase64: string
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
      `Encryption failed: ${error instanceof Error ? error.message : String(error)}`
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
  keyBase64: string
): Promise<string> {
  try {
    return await NativeModule.decrypt(ciphertext, iv, keyBase64);
  } catch (error) {
    throw new CryptoError(
      ErrorCode.DecryptionFailed,
      `Decryption failed: ${error instanceof Error ? error.message : String(error)}`
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
      `RSA key generation failed: ${error instanceof Error ? error.message : String(error)}`
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
  publicKeyPem: string
): Promise<string> {
  try {
    return await NativeModule.rsaEncrypt(plaintext, publicKeyPem);
  } catch (error) {
    throw new CryptoError(
      ErrorCode.RsaOperationFailed,
      `RSA encryption failed: ${error instanceof Error ? error.message : String(error)}`
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
  privateKeyPem: string
): Promise<string> {
  try {
    return await NativeModule.rsaDecrypt(ciphertext, privateKeyPem);
  } catch (error) {
    throw new CryptoError(
      ErrorCode.RsaOperationFailed,
      `RSA decryption failed: ${error instanceof Error ? error.message : String(error)}`
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
// SRP-6a Client
// ============================================================================

/**
 * Create a new SRP client instance.
 */
export function createSRPClient(
  hashAlgorithm: HashAlgorithm,
  primeGroup: PrimeGroup
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
      iterations?: number
    ): Promise<string> {
      try {
        return await NativeModule.srpClientDeriveSafePrivateKey(
          clientId,
          salt,
          password,
          iterations ?? 0
        );
      } catch (error) {
        throw new CryptoError(
          ErrorCode.SrpOperationFailed,
          `SRP key derivation failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },

    /**
     * Derive verifier from private key.
     */
    deriveVerifier(privateKey: string): string {
      return NativeModule.srpClientDeriveVerifier(clientId, privateKey);
    },

    /**
     * Generate client ephemeral key pair.
     */
    generateEphemeral(): Ephemeral {
      const result = NativeModule.srpClientGenerateEphemeral(clientId);
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
      privateKey: string
    ): Promise<Session> {
      try {
        const result = await NativeModule.srpClientDeriveSession(
          clientId,
          clientSecretEphemeral,
          serverPublicEphemeral,
          salt,
          username,
          privateKey
        );
        return {
          key: result.key,
          proof: result.proof,
        };
      } catch (error) {
        throw new CryptoError(
          ErrorCode.SrpOperationFailed,
          `SRP session derivation failed: ${error instanceof Error ? error.message : String(error)}`
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
      serverSessionProof: string
    ): Promise<void> {
      try {
        await NativeModule.srpClientVerifySession(
          clientId,
          clientPublicEphemeral,
          clientSession.key,
          clientSession.proof,
          serverSessionProof
        );
      } catch (error) {
        throw new CryptoError(
          ErrorCode.SrpOperationFailed,
          `SRP session verification failed: ${error instanceof Error ? error.message : String(error)}`
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
  primeGroup: PrimeGroup
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
          verifier
        );
        return {
          public: result.public,
          secret: result.secret,
        };
      } catch (error) {
        throw new CryptoError(
          ErrorCode.SrpOperationFailed,
          `SRP ephemeral generation failed: ${error instanceof Error ? error.message : String(error)}`
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
      clientSessionProof: string
    ): Promise<Session> {
      try {
        const result = await NativeModule.srpServerDeriveSession(
          serverId,
          serverSecretEphemeral,
          clientPublicEphemeral,
          salt,
          username,
          verifier,
          clientSessionProof
        );
        return {
          key: result.key,
          proof: result.proof,
        };
      } catch (error) {
        throw new CryptoError(
          ErrorCode.SrpOperationFailed,
          `SRP session derivation failed: ${error instanceof Error ? error.message : String(error)}`
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
