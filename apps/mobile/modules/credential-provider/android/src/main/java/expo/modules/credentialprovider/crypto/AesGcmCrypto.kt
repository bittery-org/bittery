package expo.modules.credentialprovider.crypto

import android.util.Base64
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * AES-256-GCM encryption/decryption matching the TypeScript implementation
 * in packages/crypto/src/encryption.ts.
 *
 * Uses:
 * - Algorithm: AES-GCM
 * - Key length: 256 bits (32 bytes)
 * - IV length: 96 bits (12 bytes) - recommended for GCM
 * - Tag length: 128 bits (16 bytes)
 */
object AesGcmCrypto {

    private const val ALGORITHM = "AES/GCM/NoPadding"
    private const val KEY_LENGTH_BYTES = 32 // 256 bits
    private const val IV_LENGTH_BYTES = 12 // 96 bits - recommended for GCM
    private const val TAG_LENGTH_BITS = 128 // 128 bits

    /**
     * Encrypted data structure matching TypeScript's EncryptedData interface.
     */
    data class EncryptedData(
        /** Base64-encoded ciphertext */
        val ciphertext: String,
        /** Base64-encoded IV */
        val iv: String,
        /** Algorithm identifier */
        val algorithm: String = "AES-GCM"
    )

    /**
     * Encrypt plaintext using AES-256-GCM.
     *
     * Matches TypeScript: encrypt(plaintext: string, key: Uint8Array)
     *
     * @param plaintext The string to encrypt
     * @param key 32-byte encryption key
     * @return EncryptedData containing Base64-encoded ciphertext and IV
     * @throws IllegalArgumentException if key is not 32 bytes
     */
    fun encrypt(plaintext: String, key: ByteArray): EncryptedData {
        require(key.size == KEY_LENGTH_BYTES) {
            "Key must be $KEY_LENGTH_BYTES bytes, got ${key.size}"
        }

        // Generate random IV
        val iv = ByteArray(IV_LENGTH_BYTES)
        SecureRandom().nextBytes(iv)

        // Create cipher
        val cipher = Cipher.getInstance(ALGORITHM)
        val keySpec = SecretKeySpec(key, "AES")
        val gcmSpec = GCMParameterSpec(TAG_LENGTH_BITS, iv)
        cipher.init(Cipher.ENCRYPT_MODE, keySpec, gcmSpec)

        // Encrypt
        val plaintextBytes = plaintext.toByteArray(StandardCharsets.UTF_8)
        val ciphertextBytes = cipher.doFinal(plaintextBytes)

        return EncryptedData(
            ciphertext = Base64.encodeToString(ciphertextBytes, Base64.NO_WRAP),
            iv = Base64.encodeToString(iv, Base64.NO_WRAP),
            algorithm = "AES-GCM"
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

        // Generate random IV
        val iv = ByteArray(IV_LENGTH_BYTES)
        SecureRandom().nextBytes(iv)

        // Create cipher
        val cipher = Cipher.getInstance(ALGORITHM)
        val keySpec = SecretKeySpec(key, "AES")
        val gcmSpec = GCMParameterSpec(TAG_LENGTH_BITS, iv)
        cipher.init(Cipher.ENCRYPT_MODE, keySpec, gcmSpec)

        // Encrypt
        val ciphertextBytes = cipher.doFinal(plaintext)

        return EncryptedData(
            ciphertext = Base64.encodeToString(ciphertextBytes, Base64.NO_WRAP),
            iv = Base64.encodeToString(iv, Base64.NO_WRAP),
            algorithm = "AES-GCM"
        )
    }

    /**
     * Decrypt ciphertext using AES-256-GCM.
     *
     * Matches TypeScript: decrypt(encryptedData: EncryptedData, key: Uint8Array)
     *
     * @param encryptedData The encrypted data containing ciphertext and IV
     * @param key 32-byte decryption key
     * @return Decrypted plaintext string
     * @throws IllegalArgumentException if key is not 32 bytes
     * @throws javax.crypto.AEADBadTagException if authentication fails
     */
    fun decrypt(encryptedData: EncryptedData, key: ByteArray): String {
        require(key.size == KEY_LENGTH_BYTES) {
            "Key must be $KEY_LENGTH_BYTES bytes, got ${key.size}"
        }

        // Decode Base64
        val ciphertext = Base64.decode(encryptedData.ciphertext, Base64.NO_WRAP)
        val iv = Base64.decode(encryptedData.iv, Base64.NO_WRAP)

        // Create cipher
        val cipher = Cipher.getInstance(ALGORITHM)
        val keySpec = SecretKeySpec(key, "AES")
        val gcmSpec = GCMParameterSpec(TAG_LENGTH_BITS, iv)
        cipher.init(Cipher.DECRYPT_MODE, keySpec, gcmSpec)

        // Decrypt
        val plaintextBytes = cipher.doFinal(ciphertext)

        return String(plaintextBytes, StandardCharsets.UTF_8)
    }

    /**
     * Decrypt ciphertext to raw bytes using AES-256-GCM.
     *
     * @param encryptedData The encrypted data containing ciphertext and IV
     * @param key 32-byte decryption key
     * @return Decrypted plaintext bytes
     */
    fun decryptToBytes(encryptedData: EncryptedData, key: ByteArray): ByteArray {
        require(key.size == KEY_LENGTH_BYTES) {
            "Key must be $KEY_LENGTH_BYTES bytes, got ${key.size}"
        }

        // Decode Base64
        val ciphertext = Base64.decode(encryptedData.ciphertext, Base64.NO_WRAP)
        val iv = Base64.decode(encryptedData.iv, Base64.NO_WRAP)

        // Create cipher
        val cipher = Cipher.getInstance(ALGORITHM)
        val keySpec = SecretKeySpec(key, "AES")
        val gcmSpec = GCMParameterSpec(TAG_LENGTH_BITS, iv)
        cipher.init(Cipher.DECRYPT_MODE, keySpec, gcmSpec)

        // Decrypt
        return cipher.doFinal(ciphertext)
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
     * @return 32-byte random key
     */
    fun generateKey(): ByteArray {
        val key = ByteArray(KEY_LENGTH_BYTES)
        SecureRandom().nextBytes(key)
        return key
    }
}
