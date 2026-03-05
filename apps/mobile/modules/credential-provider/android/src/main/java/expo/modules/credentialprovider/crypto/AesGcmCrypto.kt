package expo.modules.credentialprovider.crypto

import android.util.Base64

/**
 * AES-256-GCM encryption/decryption using native Rust crypto via JNI.
 *
 * Uses:
 * - Algorithm: AES-GCM-AAD-V1
 * - Key length: 256 bits (32 bytes)
 * - IV length: 96 bits (12 bytes) - recommended for GCM
 * - Tag length: 128 bits (16 bytes)
 *
 * This wraps the native Rust implementation for consistency with other platforms.
 */
object AesGcmCrypto {

    private const val KEY_LENGTH_BYTES = 32 // 256 bits

    /**
     * Encrypted data structure matching TypeScript's EncryptedData interface.
     */
    data class EncryptedData(
        /** Base64-encoded ciphertext */
        val ciphertext: String,
        /** Base64-encoded IV */
        val iv: String,
        /** Algorithm identifier */
        val algorithm: String = "AES-GCM-AAD-V1"
    )

    /**
     * Encrypt plaintext using AES-256-GCM.
     *
     * Uses native Rust crypto for the encryption.
     *
     * @param plaintext The string to encrypt
     * @param key 32-byte encryption key
     * @return EncryptedData containing Base64-encoded ciphertext and IV
     * @throws IllegalArgumentException if key is not 32 bytes
     * @throws RuntimeException if native crypto is not available or encryption fails
     */
    fun encrypt(plaintext: String, key: ByteArray): EncryptedData {
        require(key.size == KEY_LENGTH_BYTES) {
            "Key must be $KEY_LENGTH_BYTES bytes, got ${key.size}"
        }

        if (!NativeCrypto.isAvailable) {
            throw RuntimeException("Native crypto library not available")
        }

        val keyBase64 = Base64.encodeToString(key, Base64.NO_WRAP)
        val result = NativeCrypto.encrypt(plaintext, keyBase64)

        if (!result.isSuccess || result.ciphertext == null || result.iv == null) {
            throw RuntimeException("Encryption failed: ${result.error ?: "Unknown error"}")
        }

        return EncryptedData(
            ciphertext = result.ciphertext,
            iv = result.iv,
            algorithm = result.algorithm ?: "AES-GCM-AAD-V1"
        )
    }

    /**
     * Encrypt raw bytes using AES-256-GCM.
     *
     * @param plaintext The bytes to encrypt
     * @param key 32-byte encryption key
     * @return EncryptedData containing Base64-encoded ciphertext and IV
     */
    fun encryptBytes(plaintext: ByteArray, key: ByteArray): EncryptedData {
        require(key.size == KEY_LENGTH_BYTES) {
            "Key must be $KEY_LENGTH_BYTES bytes, got ${key.size}"
        }

        if (!NativeCrypto.isAvailable) {
            throw RuntimeException("Native crypto library not available")
        }

        // Convert bytes to Base64 string for encryption
        val plaintextBase64 = Base64.encodeToString(plaintext, Base64.NO_WRAP)
        val keyBase64 = Base64.encodeToString(key, Base64.NO_WRAP)
        val result = NativeCrypto.encrypt(plaintextBase64, keyBase64)

        if (!result.isSuccess || result.ciphertext == null || result.iv == null) {
            throw RuntimeException("Encryption failed: ${result.error ?: "Unknown error"}")
        }

        return EncryptedData(
            ciphertext = result.ciphertext,
            iv = result.iv,
            algorithm = result.algorithm ?: "AES-GCM-AAD-V1"
        )
    }

    /**
     * Decrypt ciphertext using AES-256-GCM.
     *
     * Uses native Rust crypto for the decryption.
     *
     * @param encryptedData The encrypted data containing ciphertext and IV
     * @param key 32-byte decryption key
     * @return Decrypted plaintext string
     * @throws IllegalArgumentException if key is not 32 bytes
     * @throws RuntimeException if native crypto is not available or decryption fails
     */
    fun decrypt(encryptedData: EncryptedData, key: ByteArray): String {
        require(key.size == KEY_LENGTH_BYTES) {
            "Key must be $KEY_LENGTH_BYTES bytes, got ${key.size}"
        }

        if (!NativeCrypto.isAvailable) {
            throw RuntimeException("Native crypto library not available")
        }

        val keyBase64 = Base64.encodeToString(key, Base64.NO_WRAP)
        val result = NativeCrypto.decrypt(
            encryptedData.ciphertext,
            encryptedData.iv,
            encryptedData.algorithm,
            keyBase64
        )

        if (!result.isSuccess || result.value == null) {
            throw RuntimeException("Decryption failed: ${result.error ?: "Unknown error"}")
        }

        return result.value
    }

    /**
     * Decrypt ciphertext to raw bytes using AES-256-GCM.
     *
     * @param encryptedData The encrypted data containing ciphertext and IV
     * @param key 32-byte decryption key
     * @return Decrypted plaintext bytes
     */
    fun decryptToBytes(encryptedData: EncryptedData, key: ByteArray): ByteArray {
        // Decrypt to string, then decode if it was Base64-encoded bytes
        val decrypted = decrypt(encryptedData, key)
        return try {
            Base64.decode(decrypted, Base64.NO_WRAP)
        } catch (e: IllegalArgumentException) {
            // Not Base64, return as raw bytes
            decrypted.toByteArray(Charsets.UTF_8)
        }
    }

    /**
     * Decrypt using separate ciphertext and IV strings.
     * Convenience method for when data comes from separate fields.
     *
     * @param ciphertextBase64 Base64-encoded ciphertext
     * @param ivBase64 Base64-encoded IV
     * @param key 32-byte decryption key
     * @return Decrypted plaintext string
     */
    fun decrypt(ciphertextBase64: String, ivBase64: String, key: ByteArray): String {
        return decrypt(
            EncryptedData(ciphertext = ciphertextBase64, iv = ivBase64),
            key
        )
    }

    /**
     * Generate a random 256-bit encryption key.
     *
     * Note: Uses Java SecureRandom since the native library doesn't expose
     * key generation for AES (only RSA key pair generation is exposed).
     *
     * @return 32-byte random key
     */
    fun generateKey(): ByteArray {
        val key = ByteArray(KEY_LENGTH_BYTES)
        java.security.SecureRandom().nextBytes(key)
        return key
    }
}
