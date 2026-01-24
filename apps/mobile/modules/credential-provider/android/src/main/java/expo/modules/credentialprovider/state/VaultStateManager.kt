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
     * The Master Unlock Key (32 bytes).
     * This is the key derived from password + secret key that can decrypt vault keys,
     * which in turn decrypt individual vault items.
     *
     * @Volatile ensures visibility across threads but we use read-write lock for
     * compound operations.
     */
    @Volatile
    private var masterUnlockKey: ByteArray? = null

    /**
     * Timestamp when the MUK was last set.
     * Used for potential timeout-based auto-clearing.
     */
    @Volatile
    private var mukSetTimestamp: Long = 0

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
        lock.write {
            // Clear previous key if any (security: zero out memory)
            masterUnlockKey?.fill(0)

            // Copy the key to prevent external modification
            masterUnlockKey = muk.copyOf()
            mukSetTimestamp = System.currentTimeMillis()
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
        val muk = Base64.decode(mukBase64, Base64.NO_WRAP)
        if (muk.size != 32) {
            throw IllegalArgumentException("Master Unlock Key must be 32 bytes, got ${muk.size}")
        }
        setMasterUnlockKey(muk)
    }

    /**
     * Get the Master Unlock Key.
     * Returns a COPY of the key to prevent external modification.
     *
     * @return Copy of the MUK or null if vault is locked
     */
    fun getMasterUnlockKey(): ByteArray? {
        return lock.read {
            masterUnlockKey?.copyOf()
        }
    }

    /**
     * Get the MUK as a Base64-encoded string.
     * Convenience method for operations that need string format.
     *
     * @return Base64-encoded MUK or null if vault is locked
     */
    fun getMasterUnlockKeyBase64(): String? {
        return lock.read {
            masterUnlockKey?.let { Base64.encodeToString(it, Base64.NO_WRAP) }
        }
    }

    /**
     * Clear the Master Unlock Key from memory.
     * Called on logout or auto-lock timeout.
     *
     * Security: Zeroes out the key memory before nullifying reference.
     */
    fun clearMasterUnlockKey() {
        lock.write {
            masterUnlockKey?.fill(0)
            masterUnlockKey = null
            mukSetTimestamp = 0
        }
    }

    /**
     * Check if the vault is currently unlocked (MUK available).
     *
     * @return true if MUK is set and vault is unlocked
     */
    fun isUnlocked(): Boolean {
        return lock.read {
            masterUnlockKey != null
        }
    }

    /**
     * Get the timestamp when the MUK was last set.
     *
     * @return Timestamp in milliseconds, or 0 if never set
     */
    fun getMukSetTimestamp(): Long {
        return lock.read {
            mukSetTimestamp
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
        return lock.read {
            if (masterUnlockKey == null) return@read false
            val age = System.currentTimeMillis() - mukSetTimestamp
            age < maxAgeMs
        }
    }
}
