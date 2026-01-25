/**
 * Result from key derivation
 */
export interface DerivedKeys {
  /** Base64-encoded authentication key for SRP */
  authKey: string;
  /** Base64-encoded master unlock key for vault encryption */
  masterUnlockKey: string;
}

/**
 * Encrypted data with IV and algorithm
 */
export interface EncryptedData {
  /** Base64-encoded ciphertext */
  ciphertext: string;
  /** Base64-encoded initialization vector */
  iv: string;
  /** Encryption algorithm (always "AES-GCM") */
  algorithm: string;
}

/**
 * RSA key pair
 */
export interface RsaKeyPair {
  /** PEM-encoded public key (SPKI format) */
  publicKey: string;
  /** PEM-encoded private key (PKCS8 format) */
  privateKey: string;
}

/**
 * SRP ephemeral key pair
 */
export interface Ephemeral {
  /** Hex-encoded public ephemeral value */
  public: string;
  /** Hex-encoded secret ephemeral value */
  secret: string;
}

/**
 * SRP session data
 */
export interface Session {
  /** Hex-encoded session key */
  key: string;
  /** Hex-encoded session proof */
  proof: string;
}

/**
 * Hash algorithm for SRP
 */
export type HashAlgorithm = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";

/**
 * Prime group size for SRP
 */
export type PrimeGroup = 1024 | 1536 | 2048 | 3072 | 4096 | 6144 | 8192;

/**
 * Error codes for crypto operations
 */
export enum ErrorCode {
  InvalidInput = "INVALID_INPUT",
  EncryptionFailed = "ENCRYPTION_FAILED",
  DecryptionFailed = "DECRYPTION_FAILED",
  KeyDerivationFailed = "KEY_DERIVATION_FAILED",
  RsaOperationFailed = "RSA_OPERATION_FAILED",
  SrpOperationFailed = "SRP_OPERATION_FAILED",
  InvalidSecretKey = "INVALID_SECRET_KEY",
  NativeError = "NATIVE_ERROR",
}

/**
 * Crypto operation error
 */
export class CryptoError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "CryptoError";
    this.code = code;
  }
}
