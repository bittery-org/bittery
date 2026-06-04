// Types
export type {
	DerivedKeys,
	EncryptedData,
	Ephemeral,
	HashAlgorithm,
	PrimeGroup,
	RsaKeyPair,
	Session,
	TotpResult,
} from "./BitteryCrypto.types";

export { CryptoError, ErrorCode } from "./BitteryCrypto.types";

// Module functions
export {
	// SRP-6a
	createSRPClient,
	createSRPServer,
	decrypt,
	decryptWithContext,
	// Key Derivation
	deriveKeys,
	// AES-256-GCM
	encrypt,
	encryptWithContext,
	generateEncryptionKey,
	// RSA-4096
	generateRsaKeyPair,
	// Secret Key
	generateSecretKey,
	// TOTP
	generateTotp,
	getSecretKeyHint,
	rsaDecrypt,
	rsaEncrypt,
	validateSecretKey,
} from "./BitteryCryptoModule";
