package com.bittery.mobile.credentialprovider.crypto

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.UserNotAuthenticatedException
import android.util.Base64
import androidx.annotation.RequiresApi
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Manages biometric escrow of the Master Unlock Key (MUK).
 *
 * When the user unlocks with their password, the MUK is escrowed (encrypted) with a
 * biometric-protected key. Later, the user can authenticate with biometrics to
 * retrieve the escrowed MUK without entering their password again.
 *
 * The escrow has a configurable timeout (default 10 minutes). After timeout,
 * the escrow is considered invalid and the user must enter their password again.
 *
 * Security properties:
 * - MUK is encrypted with AES-256-GCM using a Keystore key
 * - Keystore key requires biometric authentication to use
 * - Keystore key is invalidated if biometric enrollment changes
 * - Escrow expires after configurable timeout
 * - Escrow is cleared on logout
 */
@RequiresApi(Build.VERSION_CODES.M)
class MukEscrowManager(private val context: Context) {

    companion object {
        private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
        private const val KEY_ALIAS = "bittery_muk_escrow_key"
        private const val ALGORITHM = KeyProperties.KEY_ALGORITHM_AES
        private const val BLOCK_MODE = KeyProperties.BLOCK_MODE_GCM
        private const val PADDING = KeyProperties.ENCRYPTION_PADDING_NONE
        private const val KEY_SIZE = 256
        private const val GCM_TAG_LENGTH = 128
        private const val GCM_IV_LENGTH = 12

        // Authentication validity: 0 means require auth for every operation
        // We use 0 for maximum security - biometric required for each decryption
        private const val AUTH_VALIDITY_SECONDS = 0

        // Default escrow timeout: 10 minutes
        const val DEFAULT_ESCROW_TIMEOUT_MS = 10 * 60 * 1000L

        // 30-day master password re-entry period (matches RN: MASTER_PASSWORD_REENTRY_PERIOD_MS)
        const val MASTER_PASSWORD_REENTRY_PERIOD_MS = 30L * 24 * 60 * 60 * 1000

        // SharedPreferences for storing escrowed data
        private const val PREFS_NAME = "bittery_muk_escrow"
        private const val PREF_ESCROWED_MUK = "escrowed_muk"
        private const val PREF_ESCROW_IV = "escrow_iv"
        private const val PREF_ESCROW_TIMESTAMP = "escrow_timestamp"
        private const val PREF_ESCROW_TIMEOUT = "escrow_timeout_ms"
        private const val PREF_ESCROW_EMAIL = "escrow_email"
        private const val PREF_ESCROW_USER_ID = "escrow_user_id"
        private const val PREF_LAST_MASTER_PASSWORD_ENTRY = "last_master_password_entry"
    }

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private val keyStore: KeyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply {
        load(null)
    }

    /**
     * Generate the escrow encryption key in Android Keystore.
     * The key requires biometric authentication for each use.
     */
    fun generateKey() {
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

        // Require biometric auth for each operation (no time-based validity)
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
    }

    /**
     * Check if the escrow key exists in Keystore.
     */
    fun keyExists(): Boolean {
        return keyStore.containsAlias(KEY_ALIAS)
    }

    /**
     * Delete the escrow key and clear any escrowed data.
     */
    fun deleteKeyAndClearEscrow() {
        if (keyExists()) {
            keyStore.deleteEntry(KEY_ALIAS)
        }
        clearEscrow()
    }

    /**
     * Get a cipher for encryption. Must be wrapped in BiometricPrompt.CryptoObject.
     */
    fun getEncryptCipher(): Cipher {
        if (!keyExists()) {
            generateKey()
        }

        val key = keyStore.getKey(KEY_ALIAS, null) as SecretKey
        val cipher = Cipher.getInstance("$ALGORITHM/$BLOCK_MODE/$PADDING")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        return cipher
    }

    /**
     * Get a cipher for decryption. Must be wrapped in BiometricPrompt.CryptoObject.
     *
     * @throws IllegalStateException if no escrowed data exists
     * @throws KeyPermanentlyInvalidatedException if biometric enrollment changed
     */
    fun getDecryptCipher(): Cipher {
        if (!keyExists()) {
            throw IllegalStateException("Escrow key does not exist")
        }

        val ivBase64 = prefs.getString(PREF_ESCROW_IV, null)
            ?: throw IllegalStateException("No escrowed data found")

        val iv = Base64.decode(ivBase64, Base64.NO_WRAP)
        val key = keyStore.getKey(KEY_ALIAS, null) as SecretKey
        val cipher = Cipher.getInstance("$ALGORITHM/$BLOCK_MODE/$PADDING")
        val spec = GCMParameterSpec(GCM_TAG_LENGTH, iv)
        cipher.init(Cipher.DECRYPT_MODE, key, spec)
        return cipher
    }

    /**
     * Escrow the Master Unlock Key using an already-authenticated cipher.
     * Call this after successful password unlock to enable future biometric unlock.
     *
     * @param muk The 32-byte Master Unlock Key
     * @param cipher Already-authenticated cipher from BiometricPrompt
     * @param email The account email this escrow is for
     * @param timeoutMs Escrow validity timeout in milliseconds (default 10 min)
     */
    fun escrowMuk(
        muk: ByteArray,
        cipher: Cipher,
        email: String,
        timeoutMs: Long = DEFAULT_ESCROW_TIMEOUT_MS,
        userId: String? = null
    ) {
        require(muk.size == 32) { "MUK must be 32 bytes" }

        val encryptedMuk = cipher.doFinal(muk)
        val iv = cipher.iv

        prefs.edit()
            .putString(PREF_ESCROWED_MUK, Base64.encodeToString(encryptedMuk, Base64.NO_WRAP))
            .putString(PREF_ESCROW_IV, Base64.encodeToString(iv, Base64.NO_WRAP))
            .putLong(PREF_ESCROW_TIMESTAMP, System.currentTimeMillis())
            .putLong(PREF_ESCROW_TIMEOUT, timeoutMs)
            .putString(PREF_ESCROW_EMAIL, email)
            .putString(PREF_ESCROW_USER_ID, userId)
            .apply()
    }

    /**
     * Retrieve the escrowed MUK using an already-authenticated cipher.
     * Call this after successful biometric authentication.
     *
     * @param cipher Already-authenticated cipher from BiometricPrompt
     * @return The 32-byte Master Unlock Key
     * @throws IllegalStateException if no valid escrow exists
     */
    fun retrieveEscrowedMuk(cipher: Cipher): ByteArray {
        if (!hasValidEscrow()) {
            throw IllegalStateException("No valid escrow available")
        }

        val encryptedMukBase64 = prefs.getString(PREF_ESCROWED_MUK, null)
            ?: throw IllegalStateException("No escrowed MUK found")

        val encryptedMuk = Base64.decode(encryptedMukBase64, Base64.NO_WRAP)
        return cipher.doFinal(encryptedMuk)
    }

    /**
     * Clear the escrowed MUK data (but keep the key for future escrows).
     * Called on logout or when escrow expires.
     */
    fun clearEscrow() {
        prefs.edit()
            .remove(PREF_ESCROWED_MUK)
            .remove(PREF_ESCROW_IV)
            .remove(PREF_ESCROW_TIMESTAMP)
            .remove(PREF_ESCROW_TIMEOUT)
            .remove(PREF_ESCROW_EMAIL)
            .remove(PREF_ESCROW_USER_ID)
            .apply()
    }

    /**
     * Check if there is a valid (non-expired) escrow.
     */
    fun hasValidEscrow(): Boolean {
        val mukBase64 = prefs.getString(PREF_ESCROWED_MUK, null) ?: return false
        val timestamp = prefs.getLong(PREF_ESCROW_TIMESTAMP, 0)
        val timeout = prefs.getLong(PREF_ESCROW_TIMEOUT, DEFAULT_ESCROW_TIMEOUT_MS)

        if (timestamp == 0L) return false

        val age = System.currentTimeMillis() - timestamp
        return age < timeout
    }

    /**
     * Check if there is an escrow for the specified email.
     */
    fun hasValidEscrowForEmail(email: String): Boolean {
        if (!hasValidEscrow()) return false
        val escrowEmail = prefs.getString(PREF_ESCROW_EMAIL, null)
        return escrowEmail == email
    }

    /**
     * Get the email associated with the current escrow.
     */
    fun getEscrowEmail(): String? {
        return prefs.getString(PREF_ESCROW_EMAIL, null)
    }

    fun getEscrowUserId(): String? {
        return prefs.getString(PREF_ESCROW_USER_ID, null)
    }

    /**
     * Get remaining time until escrow expires.
     *
     * @return Remaining time in milliseconds, or 0 if expired/no escrow
     */
    fun getEscrowRemainingTime(): Long {
        val timestamp = prefs.getLong(PREF_ESCROW_TIMESTAMP, 0)
        val timeout = prefs.getLong(PREF_ESCROW_TIMEOUT, DEFAULT_ESCROW_TIMEOUT_MS)

        if (timestamp == 0L) return 0

        val age = System.currentTimeMillis() - timestamp
        val remaining = timeout - age

        return if (remaining > 0) remaining else 0
    }

    /**
     * Check if biometric authentication is required to decrypt the escrow.
     * This will be true if we're using a per-operation auth key (which we are).
     */
    fun requiresAuthentication(): Boolean {
        if (!keyExists() || !hasValidEscrow()) {
            return false
        }

        return try {
            getDecryptCipher()
            false
        } catch (e: UserNotAuthenticatedException) {
            true
        } catch (e: KeyPermanentlyInvalidatedException) {
            // Key was invalidated, clear escrow
            clearEscrow()
            false
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Check if the escrow key is still valid (not invalidated by biometric change).
     */
    fun isKeyValid(): Boolean {
        if (!keyExists()) return false

        return try {
            val key = keyStore.getKey(KEY_ALIAS, null) as SecretKey
            val cipher = Cipher.getInstance("$ALGORITHM/$BLOCK_MODE/$PADDING")
            cipher.init(Cipher.ENCRYPT_MODE, key)
            true
        } catch (e: KeyPermanentlyInvalidatedException) {
            false
        } catch (e: Exception) {
            // Other errors might be temporary
            true
        }
    }

    /**
     * Set the escrow timeout for future escrows.
     *
     * @param timeoutMs Timeout in milliseconds
     */
    fun setDefaultTimeout(timeoutMs: Long) {
        prefs.edit()
            .putLong(PREF_ESCROW_TIMEOUT, timeoutMs)
            .apply()
    }

    /**
     * Get the current default timeout.
     */
    fun getDefaultTimeout(): Long {
        return prefs.getLong(PREF_ESCROW_TIMEOUT, DEFAULT_ESCROW_TIMEOUT_MS)
    }

    // ========================================
    // 30-Day Master Password Re-entry
    // ========================================

    /**
     * Update the last master password entry timestamp.
     * Call this after successful password-based unlock.
     */
    fun updateLastMasterPasswordEntry() {
        prefs.edit()
            .putLong(PREF_LAST_MASTER_PASSWORD_ENTRY, System.currentTimeMillis())
            .apply()
    }

    /**
     * Get the timestamp of the last master password entry.
     */
    fun getLastMasterPasswordEntry(): Long {
        return prefs.getLong(PREF_LAST_MASTER_PASSWORD_ENTRY, 0)
    }

    /**
     * Check if master password re-entry is required (> 30 days since last entry).
     *
     * @return true if password entry is required, false if biometric can be used
     */
    fun isMasterPasswordReentryRequired(): Boolean {
        val lastEntry = getLastMasterPasswordEntry()
        if (lastEntry == 0L) {
            // Never entered password - require it
            return true
        }

        val timeSinceLastEntry = System.currentTimeMillis() - lastEntry
        return timeSinceLastEntry > MASTER_PASSWORD_REENTRY_PERIOD_MS
    }

    /**
     * Check if biometric unlock can be used.
     * Combines escrow validity and 30-day check.
     *
     * @return true if biometric can be used, false if password required
     */
    fun canUseBiometricUnlock(): Boolean {
        // Must have valid escrow AND not require master password re-entry
        return hasValidEscrow() && !isMasterPasswordReentryRequired()
    }
}
