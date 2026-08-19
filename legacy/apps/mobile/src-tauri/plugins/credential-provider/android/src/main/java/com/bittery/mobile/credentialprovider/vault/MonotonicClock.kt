package com.bittery.mobile.credentialprovider.vault

/**
 * A clock that only counts forward.
 *
 * Auto-lock deadlines use this instead of `System.currentTimeMillis()`. The wall
 * clock can jump: the user or the network can set the date back, and a deadline
 * measured against it would then hand a locked vault more time. It is injected so
 * a test can drive expiry without sleeping.
 */
fun interface MonotonicClock {
    fun nowMs(): Long
}
