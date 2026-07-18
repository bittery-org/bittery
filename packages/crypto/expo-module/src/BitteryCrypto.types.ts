// Re-export shared types from @bittery/types
export type {
	DerivedKeys,
	EncryptedData,
	KdfParams,
	RsaKeyPair,
	SRPClientEphemeral,
	SRPClientSession,
	SRPRegistration,
	SRPServerChallenge,
} from "@bittery/types";

/**
 * Result from key derivation (native module returns base64 strings)
 * Note: This differs from @bittery/types DerivedKeys which uses Uint8Array
 */
export interface NativeDerivedKeys {
	/** Base64-encoded authentication key for SRP */
	authKey: string;
	/** Base64-encoded master unlock key for vault encryption */
	masterUnlockKey: string;
}

/**
 * SRP ephemeral key pair (internal native format)
 */
export interface Ephemeral {
	/** Hex-encoded public ephemeral value */
	public: string;
	/** Hex-encoded secret ephemeral value */
	secret: string;
}

/**
 * SRP session data (internal native format)
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
export type HashAlgorithm = "SHA-256";

/**
 * Prime group size for SRP
 */
export type PrimeGroup = 4096;

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

/**
 * Result of TOTP code generation
 */
export interface TotpResult {
	/** The generated TOTP code (zero-padded) */
	code: string;
	/** Seconds remaining until the code expires */
	remainingSeconds: number;
	/** Total period in seconds */
	period: number;
	/** Progress percentage (0-100) of time elapsed in current period */
	progress: number;
}
