import type {
	DerivedKeys,
	EncryptedData,
	SRPClientEphemeral,
	SRPClientSession,
	SRPServerChallenge,
} from "@bittery/types";

export type {
	DerivedKeys,
	SRPClientEphemeral,
	SRPClientSession,
	SRPServerChallenge,
} from "@bittery/types";

/**
 * Crypto interface for platform-specific encryption operations.
 * All platforms (WASM, Tauri, FFI) export these exact functions
 * with identical signatures.
 */
export interface ICrypto {
	/**
	 * Decrypt data using AES-256-GCM.
	 */
	decrypt(encryptedData: EncryptedData, key: Uint8Array): Promise<string>;

	/**
	 * Encrypt data using AES-256-GCM.
	 */
	encrypt(plaintext: string, key: Uint8Array): Promise<EncryptedData>;

	/**
	 * Generate a random 256-bit encryption key.
	 */
	generateEncryptionKey(): Promise<Uint8Array>;

	/**
	 * Derive authentication key and Master Unlock Key from password + secret key.
	 */
	deriveKeys(
		password: string,
		secretKey: string,
		email: string,
	): Promise<DerivedKeys>;

	/**
	 * Generate client ephemeral key pair for SRP handshake.
	 */
	generateClientEphemeral(): SRPClientEphemeral | Promise<SRPClientEphemeral>;

	/**
	 * Derive client session from ephemeral secret and server challenge.
	 */
	deriveClientSession(
		secret: string,
		challenge: SRPServerChallenge,
		password: string,
	): Promise<SRPClientSession>;

	/**
	 * Verify server's proof to complete mutual authentication.
	 */
	verifyServerSession(
		publicKey: string,
		session: SRPClientSession,
		proof: string,
	): Promise<void>;

	/**
	 * Validate secret key format (A3-XXXXXX-... format).
	 */
	validateSecretKey(secretKey: string): boolean | Promise<boolean>;
}
