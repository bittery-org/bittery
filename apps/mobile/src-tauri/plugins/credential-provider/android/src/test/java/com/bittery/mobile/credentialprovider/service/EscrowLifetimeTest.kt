package com.bittery.mobile.credentialprovider.service

import com.bittery.mobile.credentialprovider.crypto.MukEscrowManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Characterization of the escrow clock, as it behaves today.
 *
 * These tests pin the two rules the credential-provider unlock paths depend on:
 * how a degenerate or skewed timestamp is read, and how long an escrow outlives
 * an auto-lock. They describe current behaviour so a later change to the MUK
 * state model shows up as a failure here, not as a locked-out user.
 *
 * The live MUK cache is covered separately, through `NativeCredentialVault`.
 * What is still not covered here is `MukEscrowManager` itself: it needs a
 * `Context` and the Android Keystore, neither of which runs on the JVM stub
 * `android.jar`, so it needs an instrumented test.
 */
class EscrowLifetimeTest {

    private val period = MukEscrowManager.MASTER_PASSWORD_REENTRY_PERIOD_MS

    // ---- Clock reading -------------------------------------------------

    /**
     * The stamp comes from `System.currentTimeMillis()`, so a user or the
     * network can move it backwards. Today that reads as "not due": the escrow
     * stays usable instead of demanding the password.
     */
    @Test
    fun clockMovedBackwardsDoesNotDemandThePassword() {
        val lastEntry = 10L * period
        assertFalse(
            EscrowPolicy.isMasterPasswordReentryDue(
                lastEntryMs = lastEntry,
                nowMs = lastEntry - period,
                periodMs = period,
            ),
        )
    }

    /** A negative stamp is treated the same as a missing one. */
    @Test
    fun negativeStampIsNotAReentryDemand() {
        assertFalse(
            EscrowPolicy.isMasterPasswordReentryDue(
                lastEntryMs = -1L,
                nowMs = period * 100,
                periodMs = period,
            ),
        )
    }

    /** A negative period fails open: biometric stays allowed. */
    @Test
    fun negativePeriodDoesNotDemandThePassword() {
        assertFalse(
            EscrowPolicy.isMasterPasswordReentryDue(
                lastEntryMs = 1_000L,
                nowMs = 1_000L + period,
                periodMs = -1L,
            ),
        )
    }

    /** A zero period demands the password on the next millisecond. */
    @Test
    fun zeroPeriodDemandsThePasswordImmediately() {
        assertTrue(
            EscrowPolicy.isMasterPasswordReentryDue(
                lastEntryMs = 1_000L,
                nowMs = 1_001L,
                periodMs = 0L,
            ),
        )
        assertFalse(
            EscrowPolicy.isMasterPasswordReentryDue(
                lastEntryMs = 1_000L,
                nowMs = 1_000L,
                periodMs = 0L,
            ),
        )
    }

    // ---- Escrow lifetime ------------------------------------------------

    /**
     * The escrow clock is the master-password clock. One period, one meaning.
     */
    @Test
    fun escrowTimeoutIsTheMasterPasswordPeriod() {
        assertEquals(
            MukEscrowManager.MASTER_PASSWORD_REENTRY_PERIOD_MS,
            MukEscrowManager.DEFAULT_ESCROW_TIMEOUT_MS,
        )
        assertEquals(30L * 24 * 60 * 60 * 1000, period)
    }

    /**
     * The escrow has to outlive an auto-lock. Auto-lock drops the in-memory
     * MUK; the keyboard bar still has to unwrap after it.
     */
    @Test
    fun escrowOutlivesTheDefaultAutoLockWindow() {
        val defaultAutoLockMs = 10L * 60 * 1000
        assertTrue(MukEscrowManager.DEFAULT_ESCROW_TIMEOUT_MS > defaultAutoLockMs)
        assertFalse(
            EscrowPolicy.isMasterPasswordReentryDue(
                lastEntryMs = 1_000L,
                nowMs = 1_000L + defaultAutoLockMs,
                periodMs = MukEscrowManager.DEFAULT_ESCROW_TIMEOUT_MS,
            ),
        )
    }
}
