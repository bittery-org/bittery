package com.bittery.mobile.credentialprovider.vault

import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * One unlocked account, held in memory and nowhere else.
 *
 * [expiresAtElapsedRealtimeMs] is a monotonic deadline, not a wall-clock time, and
 * `null` means "no auto-lock". It is never written to disk, because a deadline
 * only means something inside the process that measured it.
 *
 * [serverUserId] is not secret. The local Room cache keys its rows by the server
 * user id while everything above keys by account id, so the pairing is kept
 * beside the key and a lock forgets both at once.
 */
data class LiveUnlockEntry(
    val muk: ByteArray,
    val expiresAtElapsedRealtimeMs: Long?,
    val serverUserId: String,
) {
    // Identity, not content. A generated equals would compare key bytes, which is
    // both meaningless here and a timing side channel.
    override fun equals(other: Any?): Boolean = this === other

    override fun hashCode(): Int = System.identityHashCode(this)
}

/**
 * The live master unlock keys, one per account.
 *
 * This is the whole of the unlocked state, and it belongs to
 * [AndroidNativeCredentialVault] alone. It never reads or writes storage, never
 * shows a prompt, and never reaches for the biometric escrow — a lock or a restart
 * really does lose the key, and getting it back costs a prompt somewhere the user
 * can see. [EscrowVault] is the separate, persistent, biometric-gated path for that.
 *
 * Everything is keyed by `accountId`. Blank ids are rejected rather than mapped to
 * a placeholder: a placeholder key is one account's vault handed to another.
 */
internal class LiveUnlockStore(private val clock: MonotonicClock) {

    companion object {
        /** Used when a caller has not configured one for the account. */
        const val DEFAULT_AUTO_LOCK_TIMEOUT_MS = 10 * 60 * 1000L

        const val MUK_SIZE_BYTES = 32

        /**
         * The removed fallback id. It is refused by name so a caller that still
         * passes it fails loudly instead of unlocking a shared pseudo-account.
         */
        private const val FORBIDDEN_ACCOUNT_ID = "default"
    }

    private val mutex = ReentrantLock()
    private val entries = LinkedHashMap<String, LiveUnlockEntry>()
    private val autoLockTimeouts = LinkedHashMap<String, Long>()

    /**
     * Take a key that has already been unlocked elsewhere — by the app after a
     * password unlock, or by an activity after a biometric escrow unwrap.
     *
     * The array is copied, so the caller keeps ownership of theirs and should
     * zeroize it. A negative [timeoutMs] means "no auto-lock"; `null` keeps
     * whatever timeout the account already had.
     */
    fun acceptUnlockedKey(
        accountId: String,
        serverUserId: String,
        muk: ByteArray,
        timeoutMs: Long? = null,
    ) {
        val id = requireAccountId(accountId)
        require(serverUserId.isNotBlank()) { "serverUserId is required" }
        require(muk.size == MUK_SIZE_BYTES) {
            "Master unlock key must be $MUK_SIZE_BYTES bytes, got ${muk.size}"
        }

        mutex.withLock {
            pruneExpiredLocked()
            if (timeoutMs != null) {
                autoLockTimeouts[id] = timeoutMs
            }
            val effectiveTimeoutMs = autoLockTimeouts[id] ?: DEFAULT_AUTO_LOCK_TIMEOUT_MS
            zeroizeAndRemoveLocked(id)
            entries[id] = LiveUnlockEntry(
                muk = muk.copyOf(),
                expiresAtElapsedRealtimeMs = deadlineFrom(effectiveTimeoutMs),
                serverUserId = serverUserId,
            )
        }
    }

    /**
     * A copy of the live key, or `null` when the account is locked or expired.
     *
     * A copy, so a caller that zeroizes its own array cannot blank the stored one.
     * Callers should zeroize what they get back.
     */
    fun borrowLiveMasterUnlockKey(accountId: String): ByteArray? {
        val id = requireAccountId(accountId)
        return mutex.withLock {
            pruneExpiredLocked()
            entries[id]?.muk?.copyOf()
        }
    }

    /** Whether this account has a live key. A read, with no side effect on storage. */
    fun isUnlocked(accountId: String): Boolean {
        val id = requireAccountId(accountId)
        return mutex.withLock {
            pruneExpiredLocked()
            entries.containsKey(id)
        }
    }

    fun getUnlockedAccountIds(): List<String> = mutex.withLock {
        pruneExpiredLocked()
        entries.keys.toList()
    }

    /** The server user id of an unlocked account, for the local Room cache. */
    fun serverUserIdFor(accountId: String): String? {
        val id = requireAccountId(accountId)
        return mutex.withLock {
            pruneExpiredLocked()
            entries[id]?.serverUserId
        }
    }

    /** The reverse: which unlocked account owns rows stamped with this user id. */
    fun accountIdForServerUserId(serverUserId: String): String? {
        if (serverUserId.isBlank()) return null
        return mutex.withLock {
            pruneExpiredLocked()
            entries.entries.firstOrNull { it.value.serverUserId == serverUserId }?.key
        }
    }

    /**
     * Set the auto-lock timeout for an account and re-arm any live key from now.
     *
     * The deadline restarts rather than being recomputed from the original unlock:
     * the entry keeps no unlock time, and a re-arm is what "applies immediately"
     * means to the caller that shortens the timeout.
     */
    fun setAutoLockTimeout(accountId: String, timeoutMs: Long) {
        val id = requireAccountId(accountId)
        mutex.withLock {
            autoLockTimeouts[id] = timeoutMs
            val current = entries[id] ?: return@withLock
            entries[id] = current.copy(expiresAtElapsedRealtimeMs = deadlineFrom(timeoutMs))
            pruneExpiredLocked()
        }
    }

    /** Lock one account, or every account when [accountId] is `null`. */
    fun lock(accountId: String?) {
        if (accountId == null) {
            mutex.withLock {
                for (id in entries.keys.toList()) {
                    zeroizeAndRemoveLocked(id)
                }
                autoLockTimeouts.clear()
            }
            return
        }

        val id = requireAccountId(accountId)
        mutex.withLock {
            zeroizeAndRemoveLocked(id)
            autoLockTimeouts.remove(id)
        }
    }

    /**
     * The array the store actually holds, for tests only.
     *
     * Zeroization is the point of [lock] and it cannot be seen through the public
     * surface, because every read hands back a copy.
     */
    internal fun storedKeyForTest(accountId: String): ByteArray? =
        mutex.withLock { entries[accountId]?.muk }

    private fun requireAccountId(accountId: String?): String {
        require(!accountId.isNullOrBlank()) { "accountId is required" }
        require(accountId != FORBIDDEN_ACCOUNT_ID) {
            "'$FORBIDDEN_ACCOUNT_ID' is not an account id"
        }
        return accountId
    }

    /** `null` means no deadline: a negative timeout, or one that would overflow. */
    private fun deadlineFrom(timeoutMs: Long): Long? {
        if (timeoutMs < 0) return null
        val now = clock.nowMs()
        return if (timeoutMs > Long.MAX_VALUE - now) null else now + timeoutMs
    }

    private fun pruneExpiredLocked() {
        val now = clock.nowMs()
        for (id in entries.keys.toList()) {
            val expiresAt = entries[id]?.expiresAtElapsedRealtimeMs ?: continue
            if (now >= expiresAt) {
                zeroizeAndRemoveLocked(id)
            }
        }
    }

    private fun zeroizeAndRemoveLocked(accountId: String) {
        entries.remove(accountId)?.muk?.fill(0)
    }
}
