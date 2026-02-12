package expo.modules.credentialprovider.state

import android.os.Process
import android.util.Base64
import android.util.Log
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

    private const val TAG = "VaultStateManager"

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
     * Timestamp when each MUK was last cleared (per user), for debugging.
     */
    @Volatile
    private var mukClearTimestamps: MutableMap<String, Long> = mutableMapOf()

    /**
     * Tracks the source/caller of the last set/clear for debugging.
     */
    @Volatile
    private var lastSetCallers: MutableMap<String, String> = mutableMapOf()

    @Volatile
    private var lastClearCaller: String = ""

    /**
     * Singleton instance creation time, to detect process restarts.
     */
    private val instanceCreatedAt: Long = System.currentTimeMillis()
    private val instancePid: Int = Process.myPid()

    init {
        Log.d(TAG, "=== VaultStateManager SINGLETON CREATED === pid=$instancePid, time=$instanceCreatedAt")
    }

    /**
     * Read-write lock for thread-safe access to the MUK.
     * Allows multiple concurrent reads but exclusive writes.
     */
    private val lock = ReentrantReadWriteLock()

    /**
     * Get a short caller description from the stack trace for debugging.
     */
    private fun getCallerInfo(): String {
        val stack = Thread.currentThread().stackTrace
        // Skip getCallerInfo, the VaultStateManager method, and dalvik frames
        val caller = stack.drop(3).firstOrNull { frame ->
            !frame.className.contains("VaultStateManager") &&
                !frame.className.startsWith("dalvik.") &&
                !frame.className.startsWith("java.lang.Thread")
        }
        return if (caller != null) {
            "${caller.className.substringAfterLast('.')}#${caller.methodName}:${caller.lineNumber}"
        } else {
            "unknown"
        }
    }

    /**
     * Log a debug summary of current state.
     */
    private fun logState(operation: String) {
        val userIds = masterUnlockKeys.keys.toList()
        val ages = mukSetTimestamps.entries.associate { (userId, ts) ->
            userId to "${(System.currentTimeMillis() - ts) / 1000}s ago"
        }
        Log.d(TAG, "[$operation] pid=$instancePid, instanceAge=${(System.currentTimeMillis() - instanceCreatedAt) / 1000}s, " +
            "unlockedUsers=$userIds, mukAges=$ages, thread=${Thread.currentThread().name}"
        )
    }

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
        val caller = getCallerInfo()
        lock.write {
            val normalizedUserId = userId.ifBlank { DEFAULT_USER_ID }
            val wasAlreadySet = masterUnlockKeys.containsKey(normalizedUserId)
            masterUnlockKeys[normalizedUserId]?.fill(0)
            masterUnlockKeys[normalizedUserId] = muk.copyOf()
            mukSetTimestamps[normalizedUserId] = System.currentTimeMillis()
            lastSetCallers[normalizedUserId] = caller
            Log.d(TAG, ">>> SET MUK for userId='$normalizedUserId' (wasAlreadySet=$wasAlreadySet, mukSize=${muk.size}, caller=$caller)")
            logState("SET")
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
        Log.d(TAG, "setMasterUnlockKeyFromBase64: userId='$userId', base64Length=${mukBase64.length}, caller=${getCallerInfo()}")
        val muk = Base64.decode(mukBase64, Base64.NO_WRAP)
        if (muk.size != 32) {
            Log.e(TAG, "setMasterUnlockKeyFromBase64: INVALID MUK SIZE ${muk.size} bytes (expected 32)")
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
        val caller = getCallerInfo()
        return lock.read {
            val normalizedUserId = userId.ifBlank { DEFAULT_USER_ID }
            val muk = masterUnlockKeys[normalizedUserId]?.copyOf()
            val setTimestamp = mukSetTimestamps[normalizedUserId]
            val clearTimestamp = mukClearTimestamps[normalizedUserId]
            val lastSetBy = lastSetCallers[normalizedUserId]
            if (muk != null) {
                Log.d(TAG, "<<< GET MUK for userId='$normalizedUserId': FOUND (setAge=${setTimestamp?.let { "${(System.currentTimeMillis() - it) / 1000}s" } ?: "?"}, setBy=$lastSetBy, caller=$caller)")
            } else {
                Log.w(TAG, "<<< GET MUK for userId='$normalizedUserId': NOT FOUND! " +
                    "(lastClearedAge=${clearTimestamp?.let { "${(System.currentTimeMillis() - it) / 1000}s ago" } ?: "never"}, " +
                    "lastClearedBy='$lastClearCaller', allUnlockedUsers=${masterUnlockKeys.keys.toList()}, " +
                    "pid=$instancePid, instanceAge=${(System.currentTimeMillis() - instanceCreatedAt) / 1000}s, caller=$caller)")
            }
            muk
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
        val caller = getCallerInfo()
        lock.write {
            val normalizedUserId = userId.ifBlank { DEFAULT_USER_ID }
            val wasSet = masterUnlockKeys.containsKey(normalizedUserId)
            val setAge = mukSetTimestamps[normalizedUserId]?.let { "${(System.currentTimeMillis() - it) / 1000}s" } ?: "n/a"
            masterUnlockKeys[normalizedUserId]?.fill(0)
            masterUnlockKeys.remove(normalizedUserId)
            mukSetTimestamps.remove(normalizedUserId)
            mukClearTimestamps[normalizedUserId] = System.currentTimeMillis()
            lastClearCaller = caller
            Log.w(TAG, "!!! CLEAR MUK for userId='$normalizedUserId' (wasSet=$wasSet, mukAge=$setAge, caller=$caller)")
            logState("CLEAR")
        }
    }

    fun clearAllMasterUnlockKeys() {
        val caller = getCallerInfo()
        lock.write {
            val clearedUsers = masterUnlockKeys.keys.toList()
            val ages = mukSetTimestamps.entries.associate { (userId, ts) ->
                userId to "${(System.currentTimeMillis() - ts) / 1000}s"
            }
            for ((_, key) in masterUnlockKeys) {
                key.fill(0)
            }
            val now = System.currentTimeMillis()
            for (userId in clearedUsers) {
                mukClearTimestamps[userId] = now
            }
            masterUnlockKeys.clear()
            mukSetTimestamps.clear()
            lastClearCaller = caller
            Log.w(TAG, "!!! CLEAR ALL MUKs (clearedUsers=$clearedUsers, mukAges=$ages, caller=$caller)")
            logState("CLEAR_ALL")
        }
    }

    /**
     * Check if the vault is currently unlocked (MUK available).
     *
     * @return true if MUK is set and vault is unlocked
     */
    fun isUnlocked(): Boolean {
        return lock.read {
            val result = masterUnlockKeys.isNotEmpty()
            val caller = getCallerInfo()
            Log.d(TAG, "isUnlocked(): $result (users=${masterUnlockKeys.keys.toList()}, pid=$instancePid, caller=$caller)")
            result
        }
    }

    fun isUnlocked(userId: String): Boolean {
        return lock.read {
            val normalizedUserId = userId.ifBlank { DEFAULT_USER_ID }
            val result = masterUnlockKeys.containsKey(normalizedUserId)
            val caller = getCallerInfo()
            if (!result) {
                val clearAge = mukClearTimestamps[normalizedUserId]?.let { "${(System.currentTimeMillis() - it) / 1000}s ago" } ?: "never"
                Log.d(TAG, "isUnlocked(userId='$normalizedUserId'): FALSE (lastCleared=$clearAge, lastClearedBy='$lastClearCaller', allUsers=${masterUnlockKeys.keys.toList()}, caller=$caller)")
            } else {
                Log.d(TAG, "isUnlocked(userId='$normalizedUserId'): TRUE (caller=$caller)")
            }
            result
        }
    }

    fun getUnlockedUserIds(): List<String> {
        return lock.read {
            val result = masterUnlockKeys.keys.toList()
            Log.d(TAG, "getUnlockedUserIds(): $result (pid=$instancePid, instanceAge=${(System.currentTimeMillis() - instanceCreatedAt) / 1000}s)")
            result
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
            val fresh = age < maxAgeMs
            Log.d(TAG, "isMukFresh(userId='$normalizedUserId', maxAge=${maxAgeMs}ms): $fresh (age=${age}ms)")
            fresh
        }
    }

    /**
     * Dump full debug state for diagnostics. Call from anywhere to get a snapshot.
     */
    fun dumpDebugState(label: String = "DUMP") {
        lock.read {
            Log.d(TAG, "========== VaultStateManager DEBUG DUMP ($label) ==========")
            Log.d(TAG, "  PID: $instancePid")
            Log.d(TAG, "  Instance created: $instanceCreatedAt (${(System.currentTimeMillis() - instanceCreatedAt) / 1000}s ago)")
            Log.d(TAG, "  Unlocked users: ${masterUnlockKeys.keys.toList()}")
            for ((userId, ts) in mukSetTimestamps) {
                val age = (System.currentTimeMillis() - ts) / 1000
                val setBy = lastSetCallers[userId] ?: "unknown"
                Log.d(TAG, "  MUK[$userId]: set ${age}s ago by $setBy")
            }
            for ((userId, ts) in mukClearTimestamps) {
                val age = (System.currentTimeMillis() - ts) / 1000
                if (!masterUnlockKeys.containsKey(userId)) {
                    Log.d(TAG, "  MUK[$userId]: CLEARED ${age}s ago by '$lastClearCaller'")
                }
            }
            if (masterUnlockKeys.isEmpty()) {
                Log.d(TAG, "  >>> ALL MUKs EMPTY - vault is LOCKED <<<")
            }
            Log.d(TAG, "========== END DEBUG DUMP ==========")
        }
    }
}
