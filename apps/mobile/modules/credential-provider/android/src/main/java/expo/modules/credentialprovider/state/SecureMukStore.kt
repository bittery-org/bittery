package expo.modules.credentialprovider.state

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Keystore-backed secure persistence for MUK material.
 *
 * This store protects MUK at rest without requiring biometric prompts for read/write.
 * Biometric-gated unlock flows are handled separately via MukEscrowManager.
 */
class SecureMukStore(context: Context) {
    companion object {
        private const val TAG = "SecureMukStore"
        private const val PREFS_NAME = "bittery_secure_muk_store"
        private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
        private const val KEY_ALIAS = "bittery_vault_state_muk_store_key"
        private const val ALGORITHM = KeyProperties.KEY_ALGORITHM_AES
        private const val BLOCK_MODE = KeyProperties.BLOCK_MODE_GCM
        private const val PADDING = KeyProperties.ENCRYPTION_PADDING_NONE
        private const val KEY_SIZE = 256
        private const val GCM_TAG_LENGTH = 128

        private const val PREFIX_ENC = "enc_"
        private const val PREFIX_IV = "iv_"
        private const val PREFIX_SET_AT = "set_at_"
        private const val PREFIX_EXPIRES_AT = "expires_at_"
        private const val PREFIX_TIMEOUT_MS = "timeout_ms_"
    }

    data class StoredMukMetadata(
        val setAt: Long,
        val expiresAt: Long
    )

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val keyStore: KeyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply {
        load(null)
    }

    private fun prefKey(prefix: String, userId: String): String {
        return prefix + userId
    }

    private fun getOrCreateKey(): SecretKey {
        if (!keyStore.containsAlias(KEY_ALIAS)) {
            val keyGenerator = KeyGenerator.getInstance(ALGORITHM, KEYSTORE_PROVIDER)
            val spec = KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(BLOCK_MODE)
                .setEncryptionPaddings(PADDING)
                .setKeySize(KEY_SIZE)
                .build()
            keyGenerator.init(spec)
            keyGenerator.generateKey()
        }

        return keyStore.getKey(KEY_ALIAS, null) as SecretKey
    }

    private fun calculateExpiresAt(setAt: Long, timeoutMs: Long): Long {
        if (timeoutMs < 0) {
            return Long.MAX_VALUE
        }

        return if (timeoutMs > Long.MAX_VALUE - setAt) {
            Long.MAX_VALUE
        } else {
            setAt + timeoutMs
        }
    }

    private fun isExpired(expiresAt: Long): Boolean {
        return expiresAt != Long.MAX_VALUE && System.currentTimeMillis() >= expiresAt
    }

    fun storeMuk(userId: String, muk: ByteArray, timeoutMs: Long, setAt: Long = System.currentTimeMillis()): Long {
        require(muk.size == 32) { "MUK must be 32 bytes" }

        val key = getOrCreateKey()
        val cipher = Cipher.getInstance("$ALGORITHM/$BLOCK_MODE/$PADDING")
        cipher.init(Cipher.ENCRYPT_MODE, key)

        val encryptedMuk = cipher.doFinal(muk)
        val iv = cipher.iv
        val expiresAt = calculateExpiresAt(setAt, timeoutMs)

        prefs.edit()
            .putString(prefKey(PREFIX_ENC, userId), Base64.encodeToString(encryptedMuk, Base64.NO_WRAP))
            .putString(prefKey(PREFIX_IV, userId), Base64.encodeToString(iv, Base64.NO_WRAP))
            .putLong(prefKey(PREFIX_SET_AT, userId), setAt)
            .putLong(prefKey(PREFIX_EXPIRES_AT, userId), expiresAt)
            .apply()

        encryptedMuk.fill(0)
        return expiresAt
    }

    fun getMuk(userId: String): ByteArray? {
        val encryptedMukBase64 = prefs.getString(prefKey(PREFIX_ENC, userId), null) ?: return null
        val ivBase64 = prefs.getString(prefKey(PREFIX_IV, userId), null) ?: return null
        val metadata = getMetadata(userId) ?: return null

        if (isExpired(metadata.expiresAt)) {
            clearMuk(userId)
            return null
        }

        return try {
            val encryptedMuk = Base64.decode(encryptedMukBase64, Base64.NO_WRAP)
            val iv = Base64.decode(ivBase64, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("$ALGORITHM/$BLOCK_MODE/$PADDING")
            val spec = GCMParameterSpec(GCM_TAG_LENGTH, iv)
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), spec)
            val muk = cipher.doFinal(encryptedMuk)
            encryptedMuk.fill(0)

            if (muk.size != 32) {
                muk.fill(0)
                clearMuk(userId)
                null
            } else {
                muk
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to decrypt persisted MUK for userId='$userId', clearing entry", e)
            clearMuk(userId)
            null
        }
    }

    fun getMetadata(userId: String): StoredMukMetadata? {
        val setAt = prefs.getLong(prefKey(PREFIX_SET_AT, userId), 0L)
        val expiresAt = prefs.getLong(prefKey(PREFIX_EXPIRES_AT, userId), 0L)
        if (setAt == 0L || expiresAt == 0L) {
            return null
        }

        return StoredMukMetadata(setAt = setAt, expiresAt = expiresAt)
    }

    fun hasValidMuk(userId: String): Boolean {
        val metadata = getMetadata(userId) ?: return false
        if (isExpired(metadata.expiresAt)) {
            clearMuk(userId)
            return false
        }

        val hasCiphertext = prefs.contains(prefKey(PREFIX_ENC, userId))
        val hasIv = prefs.contains(prefKey(PREFIX_IV, userId))
        return hasCiphertext && hasIv
    }

    fun getValidUserIds(): List<String> {
        val userIds = prefs.all.keys
            .filter { key -> key.startsWith(PREFIX_ENC) }
            .map { key -> key.removePrefix(PREFIX_ENC) }

        return userIds.filter { userId -> hasValidMuk(userId) }
    }

    fun updateTimeout(userId: String, timeoutMs: Long): Long? {
        val metadata = getMetadata(userId) ?: return null
        val expiresAt = calculateExpiresAt(metadata.setAt, timeoutMs)
        prefs.edit()
            .putLong(prefKey(PREFIX_EXPIRES_AT, userId), expiresAt)
            .apply()
        return expiresAt
    }

    fun setConfiguredTimeout(userId: String, timeoutMs: Long) {
        prefs.edit()
            .putLong(prefKey(PREFIX_TIMEOUT_MS, userId), timeoutMs)
            .apply()
    }

    fun getConfiguredTimeout(userId: String): Long? {
        val key = prefKey(PREFIX_TIMEOUT_MS, userId)
        return if (prefs.contains(key)) prefs.getLong(key, 0L) else null
    }

    fun clearMuk(userId: String) {
        prefs.edit()
            .remove(prefKey(PREFIX_ENC, userId))
            .remove(prefKey(PREFIX_IV, userId))
            .remove(prefKey(PREFIX_SET_AT, userId))
            .remove(prefKey(PREFIX_EXPIRES_AT, userId))
            .apply()
    }

    fun clearAll() {
        val editor = prefs.edit()
        for (key in prefs.all.keys) {
            if (key.startsWith(PREFIX_ENC) ||
                key.startsWith(PREFIX_IV) ||
                key.startsWith(PREFIX_SET_AT) ||
                key.startsWith(PREFIX_EXPIRES_AT)
            ) {
                editor.remove(key)
            }
        }
        editor.apply()
    }
}
