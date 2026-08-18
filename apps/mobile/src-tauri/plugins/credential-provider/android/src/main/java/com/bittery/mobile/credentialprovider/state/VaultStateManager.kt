package com.bittery.mobile.credentialprovider.state

import android.content.Context
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
 * The Master Unlock Key (MUK) is kept in memory for active use and also persisted
 * in a Keystore-backed secure store with timeout metadata so it can be auto-cleared
 * even if lifecycle callbacks are missed.
 */
object VaultStateManager {

    private const val TAG = "VaultStateManager"
    private const val DEFAULT_USER_ID = "default"
    private const val DEFAULT_AUTO_LOCK_TIMEOUT_MS = 10 * 60 * 1000L

    @Volatile
    private var secureMukStore: SecureMukStore? = null

    /**
     * In-memory MUK cache keyed by user ID.
     */
    @Volatile
    private var masterUnlockKeys: MutableMap<String, ByteArray> = mutableMapOf()

    /**
     * Timestamp when each MUK was last set (per user).
     */
    @Volatile
    private var mukSetTimestamps: MutableMap<String, Long> = mutableMapOf()

    /**
     * Expiry timestamp for each MUK (per user). Long.MAX_VALUE means "never".
     */
    @Volatile
    private var mukExpiresAtTimestamps: MutableMap<String, Long> = mutableMapOf()

    /**
     * Runtime timeout preference per user. This is configured from the RN bridge.
     */
    @Volatile
    private var mukAutoLockTimeouts: MutableMap<String, Long> = mutableMapOf()

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

    private val instanceCreatedAt: Long = System.currentTimeMillis()
    private val instancePid: Int = Process.myPid()
    private val lock = ReentrantReadWriteLock()

    init {
        Log.d(TAG, "=== VaultStateManager SINGLETON CREATED === pid=$instancePid, time=$instanceCreatedAt")
    }

    fun initialize(context: Context) {
        lock.write {
            if (secureMukStore == null) {
                secureMukStore = SecureMukStore(context.applicationContext)
                Log.d(TAG, "SecureMukStore initialized")
            }
        }
    }

    private fun normalizeUserId(userId: String): String {
        return userId.ifBlank { DEFAULT_USER_ID }
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

    private fun isExpired(expiresAt: Long, now: Long = System.currentTimeMillis()): Boolean {
        return expiresAt != Long.MAX_VALUE && now >= expiresAt
    }

    private fun getResolvedTimeoutLocked(normalizedUserId: String): Long {
        val runtimeTimeout = mukAutoLockTimeouts[normalizedUserId]
        if (runtimeTimeout != null) {
            return runtimeTimeout
        }

        val persistedTimeout = secureMukStore?.getConfiguredTimeout(normalizedUserId)
        if (persistedTimeout != null) {
            mukAutoLockTimeouts[normalizedUserId] = persistedTimeout
            return persistedTimeout
        }

        return DEFAULT_AUTO_LOCK_TIMEOUT_MS
    }

    private fun getCallerInfo(): String {
        val stack = Thread.currentThread().stackTrace
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

    private fun logState(operation: String) {
        val userIds = masterUnlockKeys.keys.toList()
        val ages = mukSetTimestamps.entries.associate { (userId, ts) ->
            userId to "${(System.currentTimeMillis() - ts) / 1000}s ago"
        }
        val expires = mukExpiresAtTimestamps.entries.associate { (userId, ts) ->
            userId to if (ts == Long.MAX_VALUE) "never" else "${((ts - System.currentTimeMillis()).coerceAtLeast(0)) / 1000}s"
        }
        Log.d(
            TAG,
            "[$operation] pid=$instancePid, instanceAge=${(System.currentTimeMillis() - instanceCreatedAt) / 1000}s, " +
                "unlockedUsers=$userIds, mukAges=$ages, timeUntilExpiry=$expires, thread=${Thread.currentThread().name}"
        )
    }

    private fun cacheMukLocked(
        normalizedUserId: String,
        muk: ByteArray,
        setAt: Long,
        expiresAt: Long,
        setBy: String
    ) {
        masterUnlockKeys[normalizedUserId]?.fill(0)
        masterUnlockKeys[normalizedUserId] = muk.copyOf()
        mukSetTimestamps[normalizedUserId] = setAt
        mukExpiresAtTimestamps[normalizedUserId] = expiresAt
        lastSetCallers[normalizedUserId] = setBy
    }

    private fun clearMukLocked(
        normalizedUserId: String,
        caller: String,
        reason: String,
        clearPersistent: Boolean = true
    ) {
        val wasSet = masterUnlockKeys.containsKey(normalizedUserId)
        val setAge = mukSetTimestamps[normalizedUserId]?.let { "${(System.currentTimeMillis() - it) / 1000}s" } ?: "n/a"

        masterUnlockKeys[normalizedUserId]?.fill(0)
        masterUnlockKeys.remove(normalizedUserId)
        mukSetTimestamps.remove(normalizedUserId)
        mukExpiresAtTimestamps.remove(normalizedUserId)
        mukClearTimestamps[normalizedUserId] = System.currentTimeMillis()
        lastClearCaller = caller

        if (clearPersistent) {
            secureMukStore?.clearMuk(normalizedUserId)
        }

        Log.w(
            TAG,
            "!!! CLEAR MUK for userId='$normalizedUserId' (wasSet=$wasSet, mukAge=$setAge, reason=$reason, caller=$caller)"
        )
    }

    private fun pruneExpiredLocked(caller: String) {
        val now = System.currentTimeMillis()
        val candidateUserIds = (masterUnlockKeys.keys + mukExpiresAtTimestamps.keys).toSet()
        for (userId in candidateUserIds) {
            val expiresAt = mukExpiresAtTimestamps[userId] ?: continue
            if (isExpired(expiresAt, now)) {
                clearMukLocked(userId, caller, reason = "expired", clearPersistent = true)
            }
        }
    }

    private fun restoreMukFromSecureStoreLocked(normalizedUserId: String, caller: String): ByteArray? {
        val store = secureMukStore ?: return null
        if (!store.hasValidMuk(normalizedUserId)) {
            return null
        }

        val metadata = store.getMetadata(normalizedUserId) ?: return null
        if (isExpired(metadata.expiresAt)) {
            store.clearMuk(normalizedUserId)
            clearMukLocked(normalizedUserId, caller, reason = "expired_in_store", clearPersistent = false)
            return null
        }

        val restoredMuk = store.getMuk(normalizedUserId) ?: return null
        cacheMukLocked(
            normalizedUserId = normalizedUserId,
            muk = restoredMuk,
            setAt = metadata.setAt,
            expiresAt = metadata.expiresAt,
            setBy = "SecureMukStore#restore"
        )
        restoredMuk.fill(0)
        Log.d(TAG, "Restored MUK from secure store for userId='$normalizedUserId'")
        return masterUnlockKeys[normalizedUserId]?.copyOf()
    }

    fun setMukAutoLockTimeout(timeoutMs: Long) {
        setMukAutoLockTimeout(DEFAULT_USER_ID, timeoutMs)
    }

    fun setMukAutoLockTimeout(userId: String, timeoutMs: Long) {
        val caller = getCallerInfo()
        lock.write {
            val normalizedUserId = normalizeUserId(userId)
            mukAutoLockTimeouts[normalizedUserId] = timeoutMs
            secureMukStore?.setConfiguredTimeout(normalizedUserId, timeoutMs)

            val setAt = mukSetTimestamps[normalizedUserId]
            if (setAt != null) {
                val expiresAt = calculateExpiresAt(setAt, timeoutMs)
                mukExpiresAtTimestamps[normalizedUserId] = expiresAt
                if (isExpired(expiresAt)) {
                    clearMukLocked(normalizedUserId, caller, reason = "timeout_updated_expired")
                } else {
                    masterUnlockKeys[normalizedUserId]?.let { muk ->
                        secureMukStore?.storeMuk(normalizedUserId, muk, timeoutMs, setAt)
                    }
                }
            } else {
                val persistedExpiry = secureMukStore?.updateTimeout(normalizedUserId, timeoutMs)
                if (persistedExpiry != null && isExpired(persistedExpiry)) {
                    secureMukStore?.clearMuk(normalizedUserId)
                }
            }

            Log.d(TAG, "setMukAutoLockTimeout(userId='$normalizedUserId', timeoutMs=$timeoutMs, caller=$caller)")
            logState("SET_TIMEOUT")
        }
    }

    fun setMasterUnlockKey(muk: ByteArray) {
        setMasterUnlockKey(DEFAULT_USER_ID, muk)
    }

    fun setMasterUnlockKey(userId: String, muk: ByteArray) {
        val caller = getCallerInfo()
        lock.write {
            val normalizedUserId = normalizeUserId(userId)
            val timeoutMs = getResolvedTimeoutLocked(normalizedUserId)
            val now = System.currentTimeMillis()
            val expiresAt = calculateExpiresAt(now, timeoutMs)
            val wasAlreadySet = masterUnlockKeys.containsKey(normalizedUserId)

            cacheMukLocked(normalizedUserId, muk, now, expiresAt, caller)
            secureMukStore?.storeMuk(normalizedUserId, muk, timeoutMs, now)

            Log.d(
                TAG,
                ">>> SET MUK for userId='$normalizedUserId' (wasAlreadySet=$wasAlreadySet, mukSize=${muk.size}, timeoutMs=$timeoutMs, caller=$caller)"
            )
            logState("SET")
        }
    }

    fun setMasterUnlockKeyFromBase64(mukBase64: String) {
        setMasterUnlockKeyFromBase64(mukBase64, DEFAULT_USER_ID, null)
    }

    fun setMasterUnlockKeyFromBase64(mukBase64: String, userId: String) {
        setMasterUnlockKeyFromBase64(mukBase64, userId, null)
    }

    fun setMasterUnlockKeyFromBase64(
        mukBase64: String,
        userId: String,
        autoLockTimeoutMs: Long?
    ) {
        val normalizedUserId = normalizeUserId(userId)
        if (autoLockTimeoutMs != null) {
            setMukAutoLockTimeout(normalizedUserId, autoLockTimeoutMs)
        }

        Log.d(
            TAG,
            "setMasterUnlockKeyFromBase64: userId='$normalizedUserId', base64Length=${mukBase64.length}, timeoutMs=$autoLockTimeoutMs, caller=${getCallerInfo()}"
        )
        val muk = Base64.decode(mukBase64, Base64.NO_WRAP)
        if (muk.size != 32) {
            Log.e(TAG, "setMasterUnlockKeyFromBase64: INVALID MUK SIZE ${muk.size} bytes (expected 32)")
            throw IllegalArgumentException("Master Unlock Key must be 32 bytes, got ${muk.size}")
        }
        try {
            setMasterUnlockKey(normalizedUserId, muk)
        } finally {
            muk.fill(0)
        }
    }

    fun getMasterUnlockKey(): ByteArray? {
        return getMasterUnlockKey(DEFAULT_USER_ID)
    }

    fun getMasterUnlockKey(userId: String): ByteArray? {
        val caller = getCallerInfo()
        return lock.write {
            val normalizedUserId = normalizeUserId(userId)
            pruneExpiredLocked(caller)

            val cachedMuk = masterUnlockKeys[normalizedUserId]
            val muk = cachedMuk?.copyOf() ?: restoreMukFromSecureStoreLocked(normalizedUserId, caller)

            val setTimestamp = mukSetTimestamps[normalizedUserId]
            val expiresAt = mukExpiresAtTimestamps[normalizedUserId]
            val clearTimestamp = mukClearTimestamps[normalizedUserId]
            val lastSetBy = lastSetCallers[normalizedUserId]

            if (muk != null) {
                val expiryAge = if (expiresAt == null) {
                    "?"
                } else if (expiresAt == Long.MAX_VALUE) {
                    "never"
                } else {
                    "${((expiresAt - System.currentTimeMillis()).coerceAtLeast(0)) / 1000}s"
                }
                Log.d(
                    TAG,
                    "<<< GET MUK for userId='$normalizedUserId': FOUND (setAge=${setTimestamp?.let { "${(System.currentTimeMillis() - it) / 1000}s" } ?: "?"}, expiresIn=$expiryAge, setBy=$lastSetBy, caller=$caller)"
                )
            } else {
                Log.w(
                    TAG,
                    "<<< GET MUK for userId='$normalizedUserId': NOT FOUND! " +
                        "(lastClearedAge=${clearTimestamp?.let { "${(System.currentTimeMillis() - it) / 1000}s ago" } ?: "never"}, " +
                        "lastClearedBy='$lastClearCaller', allUnlockedUsers=${masterUnlockKeys.keys.toList()}, " +
                        "pid=$instancePid, instanceAge=${(System.currentTimeMillis() - instanceCreatedAt) / 1000}s, caller=$caller)"
                )
            }
            muk
        }
    }

    fun getMasterUnlockKeyBase64(): String? {
        return getMasterUnlockKeyBase64(DEFAULT_USER_ID)
    }

    fun getMasterUnlockKeyBase64(userId: String): String? {
        val muk = getMasterUnlockKey(userId) ?: return null
        return try {
            Base64.encodeToString(muk, Base64.NO_WRAP)
        } finally {
            muk.fill(0)
        }
    }

    fun clearMasterUnlockKey() {
        clearAllMasterUnlockKeys()
    }

    fun clearMasterUnlockKey(userId: String) {
        val caller = getCallerInfo()
        lock.write {
            val normalizedUserId = normalizeUserId(userId)
            clearMukLocked(normalizedUserId, caller, reason = "explicit_clear")
            logState("CLEAR")
        }
    }

    fun clearAllMasterUnlockKeys() {
        val caller = getCallerInfo()
        lock.write {
            val clearedUsers = (masterUnlockKeys.keys + mukExpiresAtTimestamps.keys + mukSetTimestamps.keys).toSet().toList()
            val ages = mukSetTimestamps.entries.associate { (userId, ts) ->
                userId to "${(System.currentTimeMillis() - ts) / 1000}s"
            }

            for (userId in clearedUsers) {
                clearMukLocked(userId, caller, reason = "explicit_clear_all", clearPersistent = false)
            }
            secureMukStore?.clearAll()

            Log.w(TAG, "!!! CLEAR ALL MUKs (clearedUsers=$clearedUsers, mukAges=$ages, caller=$caller)")
            logState("CLEAR_ALL")
        }
    }

    fun isUnlocked(): Boolean {
        val caller = getCallerInfo()
        return lock.write {
            pruneExpiredLocked(caller)
            val unlocked =
                masterUnlockKeys.isNotEmpty() ||
                    (secureMukStore?.getValidUserIds()?.isNotEmpty() == true)
            Log.d(TAG, "isUnlocked(): $unlocked (users=${masterUnlockKeys.keys.toList()}, pid=$instancePid, caller=$caller)")
            unlocked
        }
    }

    fun isUnlocked(userId: String): Boolean {
        val caller = getCallerInfo()
        return lock.write {
            val normalizedUserId = normalizeUserId(userId)
            pruneExpiredLocked(caller)

            val inMemory = masterUnlockKeys.containsKey(normalizedUserId)
            val inStore = secureMukStore?.hasValidMuk(normalizedUserId) ?: false
            val result = inMemory || inStore
            if (!result) {
                val clearAge = mukClearTimestamps[normalizedUserId]?.let { "${(System.currentTimeMillis() - it) / 1000}s ago" } ?: "never"
                Log.d(
                    TAG,
                    "isUnlocked(userId='$normalizedUserId'): FALSE (lastCleared=$clearAge, lastClearedBy='$lastClearCaller', allUsers=${masterUnlockKeys.keys.toList()}, caller=$caller)"
                )
            } else {
                Log.d(TAG, "isUnlocked(userId='$normalizedUserId'): TRUE (inMemory=$inMemory, inStore=$inStore, caller=$caller)")
            }
            result
        }
    }

    fun getUnlockedUserIds(): List<String> {
        val caller = getCallerInfo()
        return lock.write {
            pruneExpiredLocked(caller)
            val result = (masterUnlockKeys.keys + (secureMukStore?.getValidUserIds() ?: emptyList())).toSet().toList()
            Log.d(TAG, "getUnlockedUserIds(): $result (pid=$instancePid, instanceAge=${(System.currentTimeMillis() - instanceCreatedAt) / 1000}s)")
            result
        }
    }

    fun getMukSetTimestamp(): Long {
        return getMukSetTimestamp(DEFAULT_USER_ID)
    }

    fun getMukSetTimestamp(userId: String): Long {
        return lock.read {
            val normalizedUserId = normalizeUserId(userId)
            mukSetTimestamps[normalizedUserId]
                ?: secureMukStore?.getMetadata(normalizedUserId)?.setAt
                ?: 0L
        }
    }

    fun isMukFresh(maxAgeMs: Long): Boolean {
        return isMukFresh(DEFAULT_USER_ID, maxAgeMs)
    }

    fun isMukFresh(userId: String, maxAgeMs: Long): Boolean {
        return lock.read {
            val normalizedUserId = normalizeUserId(userId)
            val timestamp = mukSetTimestamps[normalizedUserId]
                ?: secureMukStore?.getMetadata(normalizedUserId)?.setAt
                ?: return@read false
            val age = System.currentTimeMillis() - timestamp
            val fresh = age < maxAgeMs
            Log.d(TAG, "isMukFresh(userId='$normalizedUserId', maxAge=${maxAgeMs}ms): $fresh (age=${age}ms)")
            fresh
        }
    }

    fun dumpDebugState(label: String = "DUMP") {
        lock.read {
            Log.d(TAG, "========== VaultStateManager DEBUG DUMP ($label) ==========")
            Log.d(TAG, "  PID: $instancePid")
            Log.d(TAG, "  Instance created: $instanceCreatedAt (${(System.currentTimeMillis() - instanceCreatedAt) / 1000}s ago)")
            Log.d(TAG, "  Unlocked users (memory): ${masterUnlockKeys.keys.toList()}")
            Log.d(TAG, "  Unlocked users (store): ${secureMukStore?.getValidUserIds() ?: emptyList<String>()}")
            for ((userId, ts) in mukSetTimestamps) {
                val age = (System.currentTimeMillis() - ts) / 1000
                val setBy = lastSetCallers[userId] ?: "unknown"
                val expiresAt = mukExpiresAtTimestamps[userId]
                val expiresIn = when {
                    expiresAt == null -> "?"
                    expiresAt == Long.MAX_VALUE -> "never"
                    else -> "${((expiresAt - System.currentTimeMillis()).coerceAtLeast(0)) / 1000}s"
                }
                Log.d(TAG, "  MUK[$userId]: set ${age}s ago by $setBy, expiresIn=$expiresIn")
            }
            for ((userId, ts) in mukClearTimestamps) {
                val age = (System.currentTimeMillis() - ts) / 1000
                if (!masterUnlockKeys.containsKey(userId)) {
                    Log.d(TAG, "  MUK[$userId]: CLEARED ${age}s ago by '$lastClearCaller'")
                }
            }
            if (masterUnlockKeys.isEmpty()) {
                Log.d(TAG, "  >>> IN-MEMORY MUK CACHE EMPTY <<<")
            }
            Log.d(TAG, "========== END DEBUG DUMP ==========")
        }
    }
}
