package expo.modules.credentialprovider.crypto

import android.util.Base64
import java.nio.charset.StandardCharsets
import javax.crypto.Mac
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * Key derivation functions matching the TypeScript implementation in packages/crypto/src/key-derivation.ts.
 *
 * Derives authentication and encryption keys from Account Password + Secret Key using:
 * 1. PBKDF2-SHA256 (100,000 iterations) to derive a master key
 * 2. HKDF-SHA256 to split into two keys: authKey and masterUnlockKey
 *
 * This implementation MUST produce byte-for-byte identical output to the TypeScript version.
 */
object KeyDerivation {

    private const val PBKDF2_ITERATIONS = 100_000
    private const val KEY_LENGTH = 32 // 256 bits

    /**
     * Result of key derivation containing both keys.
     */
    data class DerivedKeys(
        /** For SRP authentication */
        val authKey: ByteArray,
        /** For encrypting vault keys */
        val masterUnlockKey: ByteArray
    ) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (javaClass != other?.javaClass) return false
            other as DerivedKeys
            return authKey.contentEquals(other.authKey) &&
                    masterUnlockKey.contentEquals(other.masterUnlockKey)
        }

        override fun hashCode(): Int {
            var result = authKey.contentHashCode()
            result = 31 * result + masterUnlockKey.contentHashCode()
            return result
        }
    }

    /**
     * Derive authentication and master unlock keys from password + secret key.
     *
     * This matches the TypeScript implementation:
     * 1. Combine: `${accountPassword}|${secretKey}`
     * 2. Salt: email.toLowerCase()
     * 3. PBKDF2: SHA-256, 100k iterations, 32 bytes
     * 4. HKDF: Split into authKey and masterUnlockKey
     *
     * @param accountPassword The user's master password
     * @param secretKey The Secret Key in A3-XXXXXX format
     * @param email The user's email (used as salt)
     * @return DerivedKeys containing authKey and masterUnlockKey
     */
    fun deriveKeys(
        accountPassword: String,
        secretKey: String,
        email: String
    ): DerivedKeys {
        // Combine password and secret key (matches TypeScript: `${accountPassword}|${secretKey}`)
        val combined = "$accountPassword|$secretKey"
        val combinedBytes = combined.toByteArray(StandardCharsets.UTF_8)

        // Use email as salt (lowercased to match TypeScript)
        val salt = email.lowercase().toByteArray(StandardCharsets.UTF_8)

        // Derive master key using PBKDF2-SHA256
        val masterKey = pbkdf2(combinedBytes, salt, PBKDF2_ITERATIONS, KEY_LENGTH)

        // Split master key using HKDF
        val authKeyInfo = "bittery-auth-key".toByteArray(StandardCharsets.UTF_8)
        val authKey = hkdf(masterKey, salt, authKeyInfo, KEY_LENGTH)

        val unlockKeyInfo = "bittery-unlock-key".toByteArray(StandardCharsets.UTF_8)
        val masterUnlockKey = hkdf(masterKey, salt, unlockKeyInfo, KEY_LENGTH)

        return DerivedKeys(authKey, masterUnlockKey)
    }

    /**
     * PBKDF2-SHA256 key derivation.
     *
     * Java's PBKDF2WithHmacSHA256 expects a char array, but the TypeScript
     * implementation uses raw UTF-8 bytes. To ensure compatibility, we use
     * ISO-8859-1 encoding which provides a 1:1 mapping between bytes (0-255)
     * and chars, so the resulting byte array in PBKDF2 is identical.
     *
     * @param password The password bytes (UTF-8 encoded)
     * @param salt The salt bytes
     * @param iterations Number of iterations (100,000 for Bittery)
     * @param keyLength Output key length in bytes
     * @return Derived key bytes
     */
    private fun pbkdf2(
        password: ByteArray,
        salt: ByteArray,
        iterations: Int,
        keyLength: Int
    ): ByteArray {
        // Convert bytes to chars using ISO-8859-1 (Latin-1) encoding
        // This ensures a 1:1 mapping: byte 0xNN becomes char '\u00NN'
        // When Java's PBKDF2 converts back to bytes, it uses the same encoding
        val passwordChars = CharArray(password.size) { i ->
            (password[i].toInt() and 0xFF).toChar()
        }

        val spec = PBEKeySpec(passwordChars, salt, iterations, keyLength * 8)
        val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        val key = factory.generateSecret(spec)

        // Clear sensitive data
        passwordChars.fill('\u0000')
        spec.clearPassword()

        return key.encoded
    }

    /**
     * HKDF-SHA256 implementation (RFC 5869).
     *
     * HKDF consists of two steps:
     * 1. Extract: HMAC-Hash(salt, ikm) → prk (pseudo-random key)
     * 2. Expand: iteratively compute output key material from prk
     *
     * Note: @noble/hashes uses a simplified HKDF where extract uses salt as HMAC key.
     *
     * @param ikm Input keying material
     * @param salt Salt value
     * @param info Context and application specific information
     * @param length Output length in bytes
     * @return Output keying material
     */
    private fun hkdf(
        ikm: ByteArray,
        salt: ByteArray,
        info: ByteArray,
        length: Int
    ): ByteArray {
        // Extract phase: PRK = HMAC-Hash(salt, IKM)
        val prk = hmacSha256(salt, ikm)

        // Expand phase
        return hkdfExpand(prk, info, length)
    }

    /**
     * HKDF-Expand step (RFC 5869 Section 2.3).
     *
     * @param prk Pseudo-random key from extract step
     * @param info Context info
     * @param length Output length in bytes
     * @return Output keying material
     */
    private fun hkdfExpand(
        prk: ByteArray,
        info: ByteArray,
        length: Int
    ): ByteArray {
        val hashLen = 32 // SHA-256 output length
        val n = (length + hashLen - 1) / hashLen

        require(n <= 255) { "HKDF output length too large" }

        var t = ByteArray(0)
        val okm = ByteArray(length)
        var okmOffset = 0

        for (i in 1..n) {
            // T(i) = HMAC-Hash(PRK, T(i-1) | info | i)
            val input = ByteArray(t.size + info.size + 1)
            System.arraycopy(t, 0, input, 0, t.size)
            System.arraycopy(info, 0, input, t.size, info.size)
            input[input.size - 1] = i.toByte()

            t = hmacSha256(prk, input)

            // Copy to output
            val copyLen = minOf(hashLen, length - okmOffset)
            System.arraycopy(t, 0, okm, okmOffset, copyLen)
            okmOffset += copyLen
        }

        return okm
    }

    /**
     * HMAC-SHA256.
     *
     * @param key The HMAC key
     * @param data The data to authenticate
     * @return The HMAC result (32 bytes)
     */
    private fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        val keySpec = SecretKeySpec(key, "HmacSHA256")
        mac.init(keySpec)
        return mac.doFinal(data)
    }

    /**
     * Convert ByteArray to Base64 string (no wrapping).
     */
    fun toBase64(bytes: ByteArray): String {
        return Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    /**
     * Convert Base64 string to ByteArray.
     */
    fun fromBase64(base64: String): ByteArray {
        return Base64.decode(base64, Base64.NO_WRAP)
    }
}
