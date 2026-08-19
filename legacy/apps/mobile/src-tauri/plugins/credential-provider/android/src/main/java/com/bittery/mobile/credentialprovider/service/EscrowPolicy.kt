package com.bittery.mobile.credentialprovider.service

/**
 * Native autofill re-entry rules, kept pure so AutofillAuthActivity and the
 * JS bridge cannot disagree on a missing timestamp.
 *
 * A missing last-password stamp used to mean "require the password", which
 * sent every locked Chrome tap into the full app — even when a valid escrow
 * was sitting there. The stamp is only a 30-day clock. No stamp means the
 * clock has not started, not that biometric is forbidden.
 */
object EscrowPolicy {
    fun isMasterPasswordReentryDue(
        lastEntryMs: Long,
        nowMs: Long,
        periodMs: Long,
    ): Boolean {
        if (lastEntryMs <= 0L) return false
        if (periodMs < 0L) return false
        return nowMs - lastEntryMs > periodMs
    }
}
