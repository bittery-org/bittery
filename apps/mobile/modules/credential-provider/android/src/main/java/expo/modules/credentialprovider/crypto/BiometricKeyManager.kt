package expo.modules.credentialprovider.crypto

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.UserNotAuthenticatedException
import androidx.annotation.RequiresApi
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Manages AES-256 key in Android Keystore that requires biometric authentication.
 *
 * USAGE:
 * This class is now primarily used for legacy credential storage (CredentialStorageManager)
 * and is being phased out in favor of:
 * - MukEscrowManager for biometric MUK escrow (enables biometric unlock)
 * - VaultDecryptor for on-demand credential decryption using MUK
 *
 * The key here is used with time-bound authentication (10 minutes) for the legacy
 * sync flow where passwords are re-encrypted after decryption from server.
 *
 * For new code, use MukEscrowManager instead, which uses per-operation authentication
 * and properly integrates with the unified storage architecture.
 *
 * @see MukEscrowManager for the new biometric-protected key management
 */
class BiometricKeyManager(private val context: Context) {
    companion object {
        private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
        private const val KEY_ALIAS = "bittery_credential_provider_key"
        private const val ALGORITHM = KeyProperties.KEY_ALGORITHM_AES
        private const val BLOCK_MODE = KeyProperties.BLOCK_MODE_GCM
        private const val PADDING = KeyProperties.ENCRYPTION_PADDING_NONE
        private const val KEY_SIZE = 256
        private const val GCM_TAG_LENGTH = 128
        const val GCM_IV_LENGTH = 12

        // Key version - increment when key parameters change to force regeneration
        private const val KEY_VERSION = 3

        // Authentication validity in seconds (10 minutes, similar to 1Password)
        private const val AUTH_VALIDITY_SECONDS = 600
        private const val PREFS_NAME = "bittery_credential_provider"
        private const val PREF_KEY_VERSION = "key_version"
    }

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private val keyStore: KeyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply {
        load(null)
    }

    /**
     * Check if the device supports biometric authentication with strong biometrics.
     */
    fun isBiometricAvailable(): Boolean {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
    }

    /**
     * Check if the encryption key exists in the Keystore.
     */
    fun keyExists(): Boolean {
        return keyStore.containsAlias(KEY_ALIAS)
    }

    /**
     * Check if the stored key version matches the current version.
     */
    private fun isKeyVersionCurrent(): Boolean {
        return prefs.getInt(PREF_KEY_VERSION, 0) == KEY_VERSION
    }

    /**
     * Store the current key version.
     */
    private fun saveKeyVersion() {
        prefs.edit().putInt(PREF_KEY_VERSION, KEY_VERSION).apply()
    }

    /**
     * Generate a new AES-256 key in Android Keystore that requires biometric authentication.
     * The key is invalidated if biometric enrollment changes.
     * Will regenerate the key if the key version has changed (e.g., parameters updated).
     */
    @RequiresApi(Build.VERSION_CODES.M)
    fun generateKey() {
        // Check if key exists with outdated version - if so, delete and regenerate
        if (keyExists() && !isKeyVersionCurrent()) {
            deleteKey()
        }

        if (keyExists()) {
            return
        }

        val keyGenerator = KeyGenerator.getInstance(ALGORITHM, KEYSTORE_PROVIDER)

        val builder = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(BLOCK_MODE)
            .setEncryptionPaddings(PADDING)
            .setKeySize(KEY_SIZE)
            .setUserAuthenticationRequired(true)

        // For API 30+, use biometric or device credential authentication
        // Use 10-minute validity (similar to 1Password) - authenticate once, use for a while
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setUserAuthenticationParameters(
                AUTH_VALIDITY_SECONDS,
                KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL
            )
        } else {
            @Suppress("DEPRECATION")
            builder.setUserAuthenticationValidityDurationSeconds(AUTH_VALIDITY_SECONDS)
        }

        // Invalidate key if biometric enrollment changes
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            builder.setInvalidatedByBiometricEnrollment(true)
        }

        keyGenerator.init(builder.build())
        keyGenerator.generateKey()
        saveKeyVersion()
    }

    /**
     * Delete the encryption key from Keystore.
     */
    fun deleteKey() {
        if (keyExists()) {
            keyStore.deleteEntry(KEY_ALIAS)
        }
        prefs.edit().remove(PREF_KEY_VERSION).apply()
    }

    /**
     * Get the secret key from Keystore.
     */
    private fun getKey(): SecretKey {
        return keyStore.getKey(KEY_ALIAS, null) as SecretKey
    }

    /**
     * Get a Cipher initialized for encryption.
     * The cipher's IV should be stored alongside the encrypted data.
     *
     * This cipher requires biometric authentication to use.
     * Wrap in BiometricPrompt.CryptoObject for authentication.
     */
    @RequiresApi(Build.VERSION_CODES.M)
    fun getEncryptCipher(): Cipher {
        if (!keyExists()) {
            generateKey()
        }

        val cipher = Cipher.getInstance("$ALGORITHM/$BLOCK_MODE/$PADDING")
        cipher.init(Cipher.ENCRYPT_MODE, getKey())
        return cipher
    }

    /**
     * Get a Cipher initialized for decryption with the given IV.
     *
     * This cipher requires biometric authentication to use.
     * Wrap in BiometricPrompt.CryptoObject for authentication.
     */
    @RequiresApi(Build.VERSION_CODES.M)
    fun getDecryptCipher(iv: ByteArray): Cipher {
        if (!keyExists()) {
            throw IllegalStateException("Encryption key does not exist")
        }

        val cipher = Cipher.getInstance("$ALGORITHM/$BLOCK_MODE/$PADDING")
        val spec = GCMParameterSpec(GCM_TAG_LENGTH, iv)
        cipher.init(Cipher.DECRYPT_MODE, getKey(), spec)
        return cipher
    }

    /**
     * Encrypt data using the provided (already-authenticated) cipher.
     * Returns a Pair of (encryptedData, iv).
     */
    fun encryptWithCipher(cipher: Cipher, data: ByteArray): Pair<ByteArray, ByteArray> {
        val encryptedData = cipher.doFinal(data)
        val iv = cipher.iv
        return Pair(encryptedData, iv)
    }

    /**
     * Decrypt data using the provided (already-authenticated) cipher.
     */
    fun decryptWithCipher(cipher: Cipher, encryptedData: ByteArray): ByteArray {
        return cipher.doFinal(encryptedData)
    }

    /**
     * Check if the key requires re-authentication (user not authenticated).
     * Returns true if biometric auth is needed.
     */
    @RequiresApi(Build.VERSION_CODES.M)
    fun requiresAuthentication(): Boolean {
        if (!keyExists()) {
            return true
        }

        return try {
            // Try to get a cipher - will throw if auth required
            val cipher = Cipher.getInstance("$ALGORITHM/$BLOCK_MODE/$PADDING")
            cipher.init(Cipher.ENCRYPT_MODE, getKey())
            false
        } catch (e: UserNotAuthenticatedException) {
            true
        } catch (e: Exception) {
            true
        }
    }
}
