package expo.modules.credentialprovider.crypto

/**
 * RSA-OAEP encryption/decryption using native Rust crypto via JNI.
 *
 * Uses:
 * - Algorithm: RSA-OAEP
 * - Hash: SHA-256
 * - MGF: MGF1 with SHA-256
 * - Key size: 4096 bits (generated externally, we only decrypt)
 *
 * This wraps the native Rust implementation for consistency with other platforms.
 */
object RsaCrypto {

    /**
     * Decrypt data with RSA private key.
     *
     * Uses native Rust crypto for the decryption.
     *
     * @param ciphertext Base64-encoded ciphertext
     * @param privateKeyPEM Private key in PEM format (PKCS#8)
     * @return Decrypted plaintext string
     * @throws RuntimeException if native crypto is not available or decryption fails
     */
    fun decrypt(ciphertext: String, privateKeyPEM: String): String {
        if (!NativeCrypto.isAvailable) {
            throw RuntimeException("Native crypto library not available")
        }

        val result = NativeCrypto.rsaDecrypt(ciphertext, privateKeyPEM)

        if (!result.isSuccess || result.value == null) {
            throw RuntimeException("RSA decryption failed: ${result.error ?: "Unknown error"}")
        }

        return result.value
    }

    /**
     * Decrypt data to raw bytes with RSA private key.
     *
     * @param ciphertext Base64-encoded ciphertext
     * @param privateKeyPEM Private key in PEM format (PKCS#8)
     * @return Decrypted plaintext bytes
     */
    fun decryptToBytes(ciphertext: String, privateKeyPEM: String): ByteArray {
        return decrypt(ciphertext, privateKeyPEM).toByteArray(Charsets.UTF_8)
    }

    /**
     * Encrypt data with RSA public key.
     *
     * Uses native Rust crypto for the encryption.
     *
     * @param plaintext The string to encrypt
     * @param publicKeyPEM Public key in PEM format (SPKI)
     * @return Base64-encoded ciphertext
     * @throws RuntimeException if native crypto is not available or encryption fails
     */
    fun encrypt(plaintext: String, publicKeyPEM: String): String {
        if (!NativeCrypto.isAvailable) {
            throw RuntimeException("Native crypto library not available")
        }

        val result = NativeCrypto.rsaEncrypt(plaintext, publicKeyPEM)

        if (!result.isSuccess || result.value == null) {
            throw RuntimeException("RSA encryption failed: ${result.error ?: "Unknown error"}")
        }

        return result.value
    }
}
