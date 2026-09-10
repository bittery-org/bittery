package com.bittery.mobile.credentialprovider.crypto

import android.util.Base64
import android.util.Log

/**
 * Key derivation functions using native Rust crypto via JNI.
 *
 * Derives authentication and encryption keys from Account Password + Secret Key using:
 * 1. PBKDF2-SHA256 (100,000 iterations) to derive a master key
 * 2. HKDF-SHA256 to split into two keys: authKey and masterUnlockKey
 *
 * This wraps the native Rust implementation for consistency with other platforms.
 */
object KeyDerivation {

    private const val TAG = "KeyDerivation"

    /**
     * Result of key derivation containing both keys.
     */
    data class DerivedKeys(
        /** For SRP authentication (32 bytes) */
        val authKey: ByteArray,
        /** For encrypting vault keys (32 bytes) */
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
     * Uses native Rust crypto for the derivation.
     *
     * @param accountPassword The user's master password
     * @param secretKey The Secret Key in A3-XXXXXX format
     * @param email The user's email (used as salt)
     * @return DerivedKeys containing authKey and masterUnlockKey
     * @throws RuntimeException if native crypto is not available or derivation fails
     */
    fun deriveKeys(
        accountPassword: String,
        secretKey: String,
        email: String,
        schemaVersion: Int?,
        algorithm: String?,
        iterations: Int?
    ): DerivedKeys {
        if (!NativeCrypto.isAvailable) {
            throw RuntimeException("Native crypto library not available")
        }

        if (schemaVersion == null || algorithm == null || iterations == null) {
            throw RuntimeException("Reauthentication required: missing KDF profile")
        }
        val result = NativeCrypto.deriveKeys(
            accountPassword, secretKey, email, schemaVersion, algorithm, iterations
        )

        if (!result.isSuccess || result.authKey == null || result.masterUnlockKey == null) {
            throw RuntimeException("Key derivation failed: ${result.error ?: "Unknown error"}")
        }

        return DerivedKeys(
            authKey = fromBase64(result.authKey),
            masterUnlockKey = fromBase64(result.masterUnlockKey)
        )
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
