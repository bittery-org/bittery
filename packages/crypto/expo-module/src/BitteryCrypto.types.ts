// Re-export shared types from @bittery/types
export type {
	DerivedKeys,
	EncryptedData,
	KdfProfile,
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
 * Passkey key pair (base64-encoded private key + COSE public key).
 * Matches @bittery/crypto-port's `PasskeyKeypair` shape exactly — the FFI's C ABI
 * already drops the core's third `public_key_spki` field, which has no consumer
 * on any adapter today.
 */
export interface PasskeyKeypair {
	privateKey: string;
	publicKeyCose: string;
}

/**
 * Result from building a passkey attestation object (native module returns base64
 * strings). Note: differs from @bittery/crypto-port's `PasskeyAttestation`, which
 * uses `Uint8Array` for direct use in a `PublicKeyCredential` response.
 */
export interface NativePasskeyAttestation {
	authenticatorData: string;
	attestationObject: string;
}

/**
 * Result from signing a passkey assertion (native module returns base64 strings).
 * Note: differs from @bittery/crypto-port's `PasskeyAssertion`, which uses
 * `Uint8Array` for direct use in a `PublicKeyCredential` response.
 */
export interface NativePasskeyAssertion {
	authenticatorData: string;
	signatureDer: string;
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
	PasskeyOperationFailed = "PASSKEY_OPERATION_FAILED",
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
