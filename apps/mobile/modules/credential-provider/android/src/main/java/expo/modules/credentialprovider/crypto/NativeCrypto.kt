package expo.modules.credentialprovider.crypto

import android.util.Log

/**
 * JNI wrapper for the Rust crypto library (bittery-crypto-ffi).
 *
 * This provides native cryptographic operations for the credential provider,
 * using the same Rust implementation as the main app for consistency.
 *
 * The native library is loaded from jniLibs/[abi]/libbittery_crypto_ffi.so
 */
object NativeCrypto {

    private const val TAG = "NativeCrypto"

    /**
     * Whether the native library is available.
     * Will be false if the library failed to load.
     */
    var isAvailable: Boolean = false
        private set

    init {
        try {
            System.loadLibrary("bittery_crypto_ffi")
            isAvailable = true
            Log.d(TAG, "Native crypto library loaded successfully")
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "Failed to load native crypto library: ${e.message}")
            isAvailable = false
        }
    }

    // ============================================================================
    // Result Classes
    // ============================================================================

    /**
     * Generic result with value or error.
     */
    data class Result(
        val value: String?,
        val error: String?
    ) {
        val isSuccess: Boolean get() = error == null
    }

    /**
     * Result of key derivation.
     */
    data class DerivedKeysResult(
        val authKey: String?,
        val masterUnlockKey: String?,
        val error: String?
    ) {
        val isSuccess: Boolean get() = error == null
    }

    /**
     * Result of encryption.
     */
    data class EncryptResult(
        val ciphertext: String?,
        val iv: String?,
        val algorithm: String?,
        val error: String?
    ) {
        val isSuccess: Boolean get() = error == null
    }

    // ============================================================================
    // Key Derivation
    // ============================================================================

    /**
     * Derive authentication and master unlock keys from password + secret key.
     *
     * @param password The user's master password
     * @param secretKey The Secret Key in A3-XXXXXX format
     * @param email The user's email (used as salt)
     * @return DerivedKeysResult containing base64-encoded keys or error
     */
    fun deriveKeys(
        password: String,
        secretKey: String,
        email: String
    ): DerivedKeysResult {
        if (!isAvailable) {
            return DerivedKeysResult(null, null, "Native crypto library not available")
        }
        return nativeDeriveKeys(password, secretKey, email)
    }

    // ============================================================================
    // AES-256-GCM Encryption
    // ============================================================================

    /**
     * Encrypt plaintext using AES-256-GCM.
     *
     * @param plaintext The string to encrypt
     * @param keyBase64 Base64-encoded 32-byte encryption key
     * @return EncryptResult containing base64-encoded ciphertext and IV, or error
     */
    fun encrypt(plaintext: String, keyBase64: String): EncryptResult {
        if (!isAvailable) {
            return EncryptResult(null, null, null, "Native crypto library not available")
        }
        return nativeEncrypt(plaintext, keyBase64)
    }

    /**
     * Decrypt ciphertext using AES-256-GCM.
     *
     * @param ciphertext Base64-encoded ciphertext
     * @param iv Base64-encoded IV
     * @param algorithm Encryption algorithm identifier
     * @param keyBase64 Base64-encoded 32-byte decryption key
     * @return Result containing plaintext or error
     */
    fun decrypt(ciphertext: String, iv: String, algorithm: String, keyBase64: String): Result {
        if (!isAvailable) {
            return Result(null, "Native crypto library not available")
        }
        return nativeDecrypt(ciphertext, iv, algorithm, keyBase64)
    }

    // ============================================================================
    // RSA-OAEP
    // ============================================================================

    /**
     * Encrypt data with RSA public key.
     *
     * @param plaintext The string to encrypt
     * @param publicKeyPem Public key in PEM format (SPKI)
     * @return Result containing base64-encoded ciphertext or error
     */
    fun rsaEncrypt(plaintext: String, publicKeyPem: String): Result {
        if (!isAvailable) {
            return Result(null, "Native crypto library not available")
        }
        return nativeRsaEncrypt(plaintext, publicKeyPem)
    }

    /**
     * Decrypt data with RSA private key.
     *
     * @param ciphertext Base64-encoded ciphertext
     * @param privateKeyPem Private key in PEM format (PKCS#8)
     * @return Result containing plaintext or error
     */
    fun rsaDecrypt(ciphertext: String, privateKeyPem: String): Result {
        if (!isAvailable) {
            return Result(null, "Native crypto library not available")
        }
        return nativeRsaDecrypt(ciphertext, privateKeyPem)
    }

    // ============================================================================
    // Passkey / WebAuthn (future credential flows)
    // ============================================================================

    /**
     * Generate passkey private key + COSE/SPKI public keys.
     *
     * Returns JSON in Result.value:
     * {"privateKey":"...","publicKeyCose":"...","publicKeySpki":"..."}
     */
    fun passkeyGenerateKeypair(): Result {
        if (!isAvailable) {
            return Result(null, "Native crypto library not available")
        }
        return nativePasskeyGenerateKeypair()
    }

    /**
     * Generate passkey credential ID (base64) in Result.value.
     */
    fun passkeyGenerateCredentialId(): Result {
        if (!isAvailable) {
            return Result(null, "Native crypto library not available")
        }
        return nativePasskeyGenerateCredentialId()
    }

    /**
     * Build passkey attestation object.
     *
     * Returns JSON in Result.value:
     * {"authenticatorData":"...","attestationObject":"..."}
     */
    fun passkeyBuildAttestationObject(
        rpId: String,
        credentialIdBase64: String,
        cosePublicKeyBase64: String,
        signCount: Int
    ): Result {
        if (!isAvailable) {
            return Result(null, "Native crypto library not available")
        }
        return nativePasskeyBuildAttestationObject(
            rpId,
            credentialIdBase64,
            cosePublicKeyBase64,
            signCount
        )
    }

    /**
     * Sign passkey assertion.
     *
     * Returns JSON in Result.value:
     * {"authenticatorData":"...","signatureDer":"..."}
     */
    fun passkeySignAssertion(
        privateKeyBase64: String,
        rpId: String,
        clientDataHashBase64: String,
        signCount: Int
    ): Result {
        if (!isAvailable) {
            return Result(null, "Native crypto library not available")
        }
        return nativePasskeySignAssertion(
            privateKeyBase64,
            rpId,
            clientDataHashBase64,
            signCount
        )
    }

    // ============================================================================
    // Native JNI Methods
    // ============================================================================

    private external fun nativeDeriveKeys(
        password: String,
        secretKey: String,
        email: String
    ): DerivedKeysResult

    private external fun nativeEncrypt(
        plaintext: String,
        keyBase64: String
    ): EncryptResult

    private external fun nativeDecrypt(
        ciphertext: String,
        iv: String,
        algorithm: String,
        keyBase64: String
    ): Result

    private external fun nativeRsaEncrypt(
        plaintext: String,
        publicKeyPem: String
    ): Result

    private external fun nativeRsaDecrypt(
        ciphertext: String,
        privateKeyPem: String
    ): Result

    private external fun nativePasskeyGenerateKeypair(): Result

    private external fun nativePasskeyGenerateCredentialId(): Result

    private external fun nativePasskeyBuildAttestationObject(
        rpId: String,
        credentialIdBase64: String,
        cosePublicKeyBase64: String,
        signCount: Int
    ): Result

    private external fun nativePasskeySignAssertion(
        privateKeyBase64: String,
        rpId: String,
        clientDataHashBase64: String,
        signCount: Int
    ): Result
}
