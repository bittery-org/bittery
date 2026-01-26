// Types
export type {
	DerivedKeys,
	EncryptedData,
	Ephemeral,
	HashAlgorithm,
	PrimeGroup,
	RsaKeyPair,
	Session,
} from "./BitteryCrypto.types";

export { CryptoError, ErrorCode } from "./BitteryCrypto.types";

// Module functions
export {
	// SRP-6a
	createSRPClient,
	createSRPServer,
	decrypt,
	// Key Derivation
	deriveKeys,
	// AES-256-GCM
	encrypt,
	generateEncryptionKey,
	// RSA-4096
	generateRsaKeyPair,
	// Secret Key
	generateSecretKey,
	getSecretKeyHint,
	rsaDecrypt,
	rsaEncrypt,
	validateSecretKey,
} from "./BitteryCryptoModule";
