package com.bittery.mobile.credentialprovider.service

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EscrowPolicyTest {
    private val period = 30L * 24 * 60 * 60 * 1000

    @Test
    fun missingStampIsNotAReentryDemand() {
        assertFalse(EscrowPolicy.isMasterPasswordReentryDue(0L, 1_000L, period))
    }

    @Test
    fun periodNotYetElapsedAllowsBiometric() {
        val lastEntry = 1_000L
        assertFalse(
            EscrowPolicy.isMasterPasswordReentryDue(
                lastEntryMs = lastEntry,
                nowMs = lastEntry + period,
                periodMs = period,
            ),
        )
    }

    @Test
    fun periodElapsedDemandsThePassword() {
        val lastEntry = 1_000L
        assertTrue(
            EscrowPolicy.isMasterPasswordReentryDue(
                lastEntryMs = lastEntry,
                nowMs = lastEntry + period + 1,
                periodMs = period,
            ),
        )
    }
}
