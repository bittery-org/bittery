/**
 * CryptoProvider Interface
 *
 * Defines the minimal crypto operations required by storage adapters.
 * Apps inject their platform-specific crypto implementation when creating adapters.
 */

import type { EncryptedData } from "@bittery/types";

/**
 * Crypto operations required by storage adapters for encryption/decryption.
 */
export interface CryptoProvider {
	/**
	 * Encrypt plaintext using AES-256-GCM
	 * @param plaintext - The plaintext string to encrypt
	 * @param key - 256-bit encryption key
	 * @returns Encrypted data with ciphertext, IV, and algorithm
	 */
	encrypt(plaintext: string, key: Uint8Array): Promise<EncryptedData>;

	/**
	 * Decrypt ciphertext using AES-256-GCM
	 * @param encryptedData - The encrypted data object
	 * @param key - 256-bit decryption key
	 * @returns Decrypted plaintext string
	 */
	decrypt(encryptedData: EncryptedData, key: Uint8Array): Promise<string>;

	/**
	 * Decrypt data using RSA-OAEP with a private key
	 * Used for decrypting vault keys that were shared via RSA encryption
	 * @param ciphertext - Base64-encoded RSA ciphertext
	 * @param privateKeyPem - PEM-encoded RSA private key (PKCS8 format)
	 * @returns Decrypted plaintext string
	 */
	rsaDecrypt(ciphertext: string, privateKeyPem: string): Promise<string>;
}
