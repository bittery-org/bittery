package expo.modules.credentialprovider.crypto

import android.util.Base64
import java.nio.charset.StandardCharsets
import java.security.KeyFactory
import java.security.spec.MGF1ParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource

/**
 * RSA-OAEP encryption/decryption matching the TypeScript implementation
 * in packages/crypto/src/rsa.ts.
 *
 * Uses:
 * - Algorithm: RSA-OAEP
 * - Hash: SHA-256
 * - MGF: MGF1 with SHA-256
 * - Key size: 4096 bits (generated externally, we only decrypt)
 */
object RsaCrypto {

    private const val RSA_ALGORITHM = "RSA/ECB/OAEPWithSHA-256AndMGF1Padding"

    /**
     * Decrypt data with RSA private key.
     *
     * Matches TypeScript: rsaDecrypt(ciphertext: string, privateKeyPEM: string)
     *
     * @param ciphertext Base64-encoded ciphertext
     * @param privateKeyPEM Private key in PEM format (PKCS#8)
     * @return Decrypted plaintext string
     */
    fun decrypt(ciphertext: String, privateKeyPEM: String): String {
        // Extract Base64 from PEM format
        val privateKeyBase64 = privateKeyPEM
            .replace("-----BEGIN PRIVATE KEY-----", "")
            .replace("-----END PRIVATE KEY-----", "")
            .replace("\\s".toRegex(), "") // Remove all whitespace including newlines

        val privateKeyBytes = Base64.decode(privateKeyBase64, Base64.NO_WRAP)

        // Import private key
        val keyFactory = KeyFactory.getInstance("RSA")
        val keySpec = PKCS8EncodedKeySpec(privateKeyBytes)
        val privateKey = keyFactory.generatePrivate(keySpec)

        // Create cipher with OAEP parameters matching Web Crypto API
        val cipher = Cipher.getInstance(RSA_ALGORITHM)

        // Configure OAEP parameters to match TypeScript/Web Crypto
        // Web Crypto uses SHA-256 for both hash and MGF1
        val oaepParams = OAEPParameterSpec(
            "SHA-256",                          // Hash algorithm
            "MGF1",                             // Mask generation function
            MGF1ParameterSpec.SHA256,           // MGF1 hash algorithm (SHA-256)
            PSource.PSpecified.DEFAULT          // Empty label (default)
        )

        cipher.init(Cipher.DECRYPT_MODE, privateKey, oaepParams)

        // Decrypt
        val ciphertextBytes = Base64.decode(ciphertext, Base64.NO_WRAP)
        val plaintextBytes = cipher.doFinal(ciphertextBytes)

        return String(plaintextBytes, StandardCharsets.UTF_8)
    }

    /**
     * Decrypt data to raw bytes with RSA private key.
     *
     * @param ciphertext Base64-encoded ciphertext
     * @param privateKeyPEM Private key in PEM format (PKCS#8)
     * @return Decrypted plaintext bytes
     */
    fun decryptToBytes(ciphertext: String, privateKeyPEM: String): ByteArray {
        // Extract Base64 from PEM format
        val privateKeyBase64 = privateKeyPEM
            .replace("-----BEGIN PRIVATE KEY-----", "")
            .replace("-----END PRIVATE KEY-----", "")
            .replace("\\s".toRegex(), "")

        val privateKeyBytes = Base64.decode(privateKeyBase64, Base64.NO_WRAP)

        // Import private key
        val keyFactory = KeyFactory.getInstance("RSA")
        val keySpec = PKCS8EncodedKeySpec(privateKeyBytes)
        val privateKey = keyFactory.generatePrivate(keySpec)

        // Create cipher with OAEP parameters
        val cipher = Cipher.getInstance(RSA_ALGORITHM)
        val oaepParams = OAEPParameterSpec(
            "SHA-256",
            "MGF1",
            MGF1ParameterSpec.SHA256,
            PSource.PSpecified.DEFAULT
        )

        cipher.init(Cipher.DECRYPT_MODE, privateKey, oaepParams)

        // Decrypt
        val ciphertextBytes = Base64.decode(ciphertext, Base64.NO_WRAP)
        return cipher.doFinal(ciphertextBytes)
    }

    /**
     * Encrypt data with RSA public key.
     *
     * Matches TypeScript: rsaEncrypt(plaintext: string, publicKeyPEM: string)
     *
     * @param plaintext The string to encrypt
     * @param publicKeyPEM Public key in PEM format (SPKI)
     * @return Base64-encoded ciphertext
     */
    fun encrypt(plaintext: String, publicKeyPEM: String): String {
        // Extract Base64 from PEM format
        val publicKeyBase64 = publicKeyPEM
            .replace("-----BEGIN PUBLIC KEY-----", "")
            .replace("-----END PUBLIC KEY-----", "")
            .replace("\\s".toRegex(), "")

        val publicKeyBytes = Base64.decode(publicKeyBase64, Base64.NO_WRAP)

        // Import public key
        val keyFactory = KeyFactory.getInstance("RSA")
        val keySpec = X509EncodedKeySpec(publicKeyBytes)
        val publicKey = keyFactory.generatePublic(keySpec)

        // Create cipher with OAEP parameters
        val cipher = Cipher.getInstance(RSA_ALGORITHM)
        val oaepParams = OAEPParameterSpec(
            "SHA-256",
            "MGF1",
            MGF1ParameterSpec.SHA256,
            PSource.PSpecified.DEFAULT
        )

        cipher.init(Cipher.ENCRYPT_MODE, publicKey, oaepParams)

        // Encrypt
        val plaintextBytes = plaintext.toByteArray(StandardCharsets.UTF_8)
        val ciphertextBytes = cipher.doFinal(plaintextBytes)

        return Base64.encodeToString(ciphertextBytes, Base64.NO_WRAP)
    }
}
