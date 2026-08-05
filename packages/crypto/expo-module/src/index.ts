// Types
export type {
	DerivedKeys,
	EncryptedData,
	Ephemeral,
	HashAlgorithm,
	NativePasskeyAssertion,
	NativePasskeyAttestation,
	PasskeyKeypair,
	PrimeGroup,
	RsaKeyPair,
	Session,
	TotpResult,
} from "./BitteryCrypto.types";

export { CryptoError, ErrorCode } from "./BitteryCrypto.types";

// Key Rotation types
export type {
	ItemData,
	KeyRotationResult,
	MemberEncryptedKey,
	MemberKeyData,
	ReEncryptedItem,
	ValidationResult,
} from "./BitteryCryptoModule";

// Module functions
export {
	buildPasskeyAttestationObject,
	// SRP-6a
	createSRPClient,
	createSRPServer,
	decrypt,
	decryptMasterKey,
	decryptWithContext,
	// Key Derivation
	deriveKeys,
	deriveKeysFromMasterKey,
	deriveMasterKey,
	// AES-256-GCM
	encrypt,
	encryptMasterKey,
	// Key Rotation (vault keys)
	encryptVaultKeyForMember,
	encryptVaultKeyWithMuk,
	encryptWithContext,
	generateEncryptionKey,
	// Passkey / WebAuthn
	generatePasskeyCredentialId,
	generatePasskeyKeypair,
	// Recovery Key
	generateRecoveryKey,
	// RSA-4096
	generateRsaKeyPair,
	// Secret Key
	generateSecretKey,
	// TOTP
	generateTotp,
	generateUuid,
	getSecretKeyHint,
	// Key Rotation (whole-vault rotation and pre-flight validation)
	performKeyRotation,
	reEncryptItem,
	rsaDecrypt,
	rsaEncrypt,
	signPasskeyAssertion,
	validateRecoveryKey,
	validateRotationData,
	validateSecretKey,
} from "./BitteryCryptoModule";
