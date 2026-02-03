package expo.modules.credentialprovider.state

import android.util.Base64
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.write

/**
 * Singleton manager for vault state shared between the React Native app and
 * Android CredentialProviderService.
 *
 * CRITICAL: This class relies on being in the SAME PROCESS as the main app.
 * Do NOT add android:process attribute to BitteryCredentialProviderService in AndroidManifest.xml
 * as it would create a separate process where this singleton would be empty.
 *
 * The Master Unlock Key (MUK) is set by the React Native layer after successful
 * password or biometric unlock, and is used by the credential provider to decrypt
 * vault items on demand.
 */
object VaultStateManager {

    /**
     * Default user ID key for legacy single-account callers.
     */
    private const val DEFAULT_USER_ID = "default"

    /**
     * Master Unlock Keys keyed by user ID.
     */
    @Volatile
    private var masterUnlockKeys: MutableMap<String, ByteArray> = mutableMapOf()

    /**
     * Timestamp when each MUK was last set (per user).
     */
    @Volatile
    private var mukSetTimestamps: MutableMap<String, Long> = mutableMapOf()

    /**
     * Read-write lock for thread-safe access to the MUK.
     * Allows multiple concurrent reads but exclusive writes.
     */
    private val lock = ReentrantReadWriteLock()

    /**
     * Set the Master Unlock Key.
     * Called from React Native after successful password or biometric unlock.
     *
     * @param muk The 32-byte Master Unlock Key as ByteArray
     */
    fun setMasterUnlockKey(muk: ByteArray) {
        setMasterUnlockKey(DEFAULT_USER_ID, muk)
    }

    /**
     * Set the Master Unlock Key for a specific user.
     */
    fun setMasterUnlockKey(userId: String, muk: ByteArray) {
        lock.write {
            val normalizedUserId = userId.ifBlank { DEFAULT_USER_ID }
            masterUnlockKeys[normalizedUserId]?.fill(0)
            masterUnlockKeys[normalizedUserId] = muk.copyOf()
            mukSetTimestamps[normalizedUserId] = System.currentTimeMillis()
        }
    }

    /**
     * Set the Master Unlock Key from a Base64-encoded string.
     * Convenience method for React Native bridge.
     *
     * @param mukBase64 Base64-encoded MUK (typically 44 characters for 32 bytes)
     * @throws IllegalArgumentException if the decoded key is not 32 bytes
     */
    fun setMasterUnlockKeyFromBase64(mukBase64: String) {
        setMasterUnlockKeyFromBase64(mukBase64, DEFAULT_USER_ID)
    }

    fun setMasterUnlockKeyFromBase64(mukBase64: String, userId: String) {
        val muk = Base64.decode(mukBase64, Base64.NO_WRAP)
        if (muk.size != 32) {
            throw IllegalArgumentException("Master Unlock Key must be 32 bytes, got ${muk.size}")
        }
        setMasterUnlockKey(userId, muk)
    }

    /**
     * Get the Master Unlock Key.
     * Returns a COPY of the key to prevent external modification.
     *
     * @return Copy of the MUK or null if vault is locked
     */
    fun getMasterUnlockKey(): ByteArray? {
        return getMasterUnlockKey(DEFAULT_USER_ID)
    }

    fun getMasterUnlockKey(userId: String): ByteArray? {
        return lock.read {
            val normalizedUserId = userId.ifBlank { DEFAULT_USER_ID }
            masterUnlockKeys[normalizedUserId]?.copyOf()
        }
    }

    /**
     * Get the MUK as a Base64-encoded string.
     * Convenience method for operations that need string format.
     *
     * @return Base64-encoded MUK or null if vault is locked
     */
    fun getMasterUnlockKeyBase64(): String? {
        return getMasterUnlockKeyBase64(DEFAULT_USER_ID)
    }

    fun getMasterUnlockKeyBase64(userId: String): String? {
        return lock.read {
            val normalizedUserId = userId.ifBlank { DEFAULT_USER_ID }
            masterUnlockKeys[normalizedUserId]?.let { Base64.encodeToString(it, Base64.NO_WRAP) }
        }
    }

    /**
     * Clear the Master Unlock Key from memory.
     * Called on logout or auto-lock timeout.
     *
     * Security: Zeroes out the key memory before nullifying reference.
     */
    fun clearMasterUnlockKey() {
        clearAllMasterUnlockKeys()
    }

    fun clearMasterUnlockKey(userId: String) {
        lock.write {
            val normalizedUserId = userId.ifBlank { DEFAULT_USER_ID }
            masterUnlockKeys[normalizedUserId]?.fill(0)
            masterUnlockKeys.remove(normalizedUserId)
            mukSetTimestamps.remove(normalizedUserId)
        }
    }

    fun clearAllMasterUnlockKeys() {
        lock.write {
            for ((_, key) in masterUnlockKeys) {
                key.fill(0)
            }
            masterUnlockKeys.clear()
            mukSetTimestamps.clear()
        }
    }

    /**
     * Check if the vault is currently unlocked (MUK available).
     *
     * @return true if MUK is set and vault is unlocked
     */
    fun isUnlocked(): Boolean {
        return lock.read {
            masterUnlockKeys.isNotEmpty()
        }
    }

    fun isUnlocked(userId: String): Boolean {
        return lock.read {
            val normalizedUserId = userId.ifBlank { DEFAULT_USER_ID }
            masterUnlockKeys.containsKey(normalizedUserId)
        }
    }

    fun getUnlockedUserIds(): List<String> {
        return lock.read {
            masterUnlockKeys.keys.toList()
        }
    }

    /**
     * Get the timestamp when the MUK was last set.
     *
     * @return Timestamp in milliseconds, or 0 if never set
     */
    fun getMukSetTimestamp(): Long {
        return getMukSetTimestamp(DEFAULT_USER_ID)
    }

    fun getMukSetTimestamp(userId: String): Long {
        return lock.read {
            val normalizedUserId = userId.ifBlank { DEFAULT_USER_ID }
            mukSetTimestamps[normalizedUserId] ?: 0L
        }
    }

    /**
     * Check if the MUK has been set within the specified duration.
     * Useful for implementing auto-lock timeout.
     *
     * @param maxAgeMs Maximum age in milliseconds
     * @return true if MUK was set within maxAgeMs, false otherwise
     */
    fun isMukFresh(maxAgeMs: Long): Boolean {
        return isMukFresh(DEFAULT_USER_ID, maxAgeMs)
    }

    fun isMukFresh(userId: String, maxAgeMs: Long): Boolean {
        return lock.read {
            val normalizedUserId = userId.ifBlank { DEFAULT_USER_ID }
            val timestamp = mukSetTimestamps[normalizedUserId] ?: return@read false
            val age = System.currentTimeMillis() - timestamp
            age < maxAgeMs
        }
    }
}
