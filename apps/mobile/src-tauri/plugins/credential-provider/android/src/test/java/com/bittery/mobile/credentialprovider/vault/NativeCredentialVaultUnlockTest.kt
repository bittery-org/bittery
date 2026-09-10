package com.bittery.mobile.credentialprovider.vault

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The unlock state, through the vault.
 *
 * [NativeCredentialVault] is the whole surface the services, the activities and
 * the bridge use, so these tests pin what a mistake behind it would cost: one
 * account never reads another's key, a read never resurrects a key, a lock really
 * blanks the bytes, and only an explicit biometric unlock may touch the escrow.
 *
 * No Android framework class is involved, so this runs on the JVM stub
 * `android.jar`. Both clocks are injected, so expiry is driven, not waited on.
 */
class NativeCredentialVaultUnlockTest {

    private val fixture = VaultUnderTest()
    private val vault = fixture.vault

    // ---- Accepting a key -------------------------------------------------

    @Test
    fun acceptingAKeyUnlocksTheAccount() {
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1))

        assertTrue(vault.isUnlocked("acct_a"))
        assertEquals(listOf("acct_a"), vault.unlockedAccountIds())
        assertArrayEquals(muk(1), vault.borrowLiveMasterUnlockKey("acct_a"))
    }

    @Test
    fun theCallersOwnArrayIsNotAdopted() {
        val caller = muk(9)
        vault.acceptUnlockedKey("acct_a", "user-a", caller)

        caller.fill(0)

        assertArrayEquals(muk(9), vault.borrowLiveMasterUnlockKey("acct_a"))
    }

    @Test
    fun acceptingASecondKeyReplacesTheFirstAndBlanksIt() {
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1))
        val first = fixture.liveUnlocks.storedKeyForTest("acct_a")
        assertNotNull(first)

        vault.acceptUnlockedKey("acct_a", "user-a", muk(2))

        assertArrayEquals(ByteArray(LiveUnlockStore.MUK_SIZE_BYTES), first)
        assertArrayEquals(muk(2), vault.borrowLiveMasterUnlockKey("acct_a"))
    }

    @Test
    fun aKeyOfTheWrongLengthIsRefused() {
        assertRejected { vault.acceptUnlockedKey("acct_a", "user-a", ByteArray(16)) }
        assertFalse(vault.isUnlocked("acct_a"))
    }

    // ---- Borrowing -------------------------------------------------------

    /**
     * The bridge blanks what it is handed. That is only safe because the vault
     * hands out a copy — otherwise the first borrow would blank the live key and
     * lock the credential-provider service out.
     */
    @Test
    fun theBorrowedArrayIsTheCallersToBlank() {
        vault.acceptUnlockedKey("acct_a", "user-a", muk(5))

        vault.borrowLiveMasterUnlockKey("acct_a")?.fill(0)

        assertArrayEquals(muk(5), vault.borrowLiveMasterUnlockKey("acct_a"))
        assertTrue(vault.isUnlocked("acct_a"))
    }

    /**
     * The defect this design guards against: a "borrow" that quietly reached the
     * escrow would unlock the vault with no prompt the user ever saw.
     */
    @Test
    fun aBorrowNeverResurrectsALockedKey() {
        fixture.escrow.record = FakeEscrowVault.Record("acct_a", "user-a")
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1))
        vault.lock("acct_a")

        repeat(3) {
            assertNull(vault.borrowLiveMasterUnlockKey("acct_a"))
            assertFalse(vault.isUnlocked("acct_a"))
        }
    }

    @Test
    fun oneAccountCanNeverBorrowAnothersKey() {
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1))

        assertNull(vault.borrowLiveMasterUnlockKey("acct_b"))
        assertFalse(vault.isUnlocked("acct_b"))
        assertArrayEquals(muk(1), vault.borrowLiveMasterUnlockKey("acct_a"))
    }

    // ---- Locking ---------------------------------------------------------

    @Test
    fun lockingOneAccountBlanksOnlyThatAccountsKey() {
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1))
        vault.acceptUnlockedKey("acct_b", "user-b", muk(2))
        val storedA = fixture.liveUnlocks.storedKeyForTest("acct_a")
        assertNotNull(storedA)

        vault.lock("acct_a")

        assertArrayEquals(ByteArray(LiveUnlockStore.MUK_SIZE_BYTES), storedA)
        assertFalse(vault.isUnlocked("acct_a"))
        assertEquals(listOf("acct_b"), vault.unlockedAccountIds())
    }

    @Test
    fun lockingEverythingBlanksEveryKey() {
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1))
        vault.acceptUnlockedKey("acct_b", "user-b", muk(2))
        val storedA = fixture.liveUnlocks.storedKeyForTest("acct_a")
        val storedB = fixture.liveUnlocks.storedKeyForTest("acct_b")

        vault.lock(null)

        assertArrayEquals(ByteArray(LiveUnlockStore.MUK_SIZE_BYTES), storedA)
        assertArrayEquals(ByteArray(LiveUnlockStore.MUK_SIZE_BYTES), storedB)
        assertTrue(vault.unlockedAccountIds().isEmpty())
    }

    // ---- Expiry ----------------------------------------------------------

    @Test
    fun expiryRemovesAndBlanksTheLiveKey() {
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1), autoLockTimeoutMs = 60_000L)
        val stored = fixture.liveUnlocks.storedKeyForTest("acct_a")

        fixture.monotonicClock.advance(59_999L)
        assertTrue(vault.isUnlocked("acct_a"))

        fixture.monotonicClock.advance(1L)

        assertFalse(vault.isUnlocked("acct_a"))
        assertNull(vault.borrowLiveMasterUnlockKey("acct_a"))
        assertArrayEquals(ByteArray(LiveUnlockStore.MUK_SIZE_BYTES), stored)
    }

    /** A borrow is a read. It must not push the auto-lock deadline out. */
    @Test
    fun aBorrowDoesNotRenewTheDeadline() {
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1), autoLockTimeoutMs = 60_000L)

        fixture.monotonicClock.advance(59_999L)
        assertNotNull(vault.borrowLiveMasterUnlockKey("acct_a"))

        fixture.monotonicClock.advance(1L)
        assertNull(vault.borrowLiveMasterUnlockKey("acct_a"))
    }

    @Test
    fun changingTheTimeoutReArmsTheLiveKey() {
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1), autoLockTimeoutMs = 100_000L)

        vault.setAutoLockTimeout("acct_a", 1_000L)
        fixture.monotonicClock.advance(1_000L)

        assertFalse(vault.isUnlocked("acct_a"))
    }

    @Test
    fun aRecordedTimeoutAppliesToTheNextUnlock() {
        vault.setAutoLockTimeout("acct_a", 5_000L)
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1))

        fixture.monotonicClock.advance(5_000L)

        assertFalse(vault.isUnlocked("acct_a"))
    }

    @Test
    fun lockingForgetsTheRecordedTimeout() {
        vault.setAutoLockTimeout("acct_a", 5_000L)
        vault.lock("acct_a")
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1))

        fixture.monotonicClock.advance(5_000L)

        assertTrue(vault.isUnlocked("acct_a"))
    }

    // ---- No persistence, no escrow ---------------------------------------

    /** Every read, twice, with an escrow sitting there. Nothing may bring the key back. */
    @Test
    fun aStatusCheckNeverRestoresAKey() {
        fixture.escrow.record = FakeEscrowVault.Record("acct_a", "user-a")
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1))
        vault.lock("acct_a")

        repeat(2) {
            assertFalse(vault.isUnlocked("acct_a"))
            assertNull(vault.borrowLiveMasterUnlockKey("acct_a"))
            assertTrue(vault.unlockedAccountIds().isEmpty())
        }
    }

    /**
     * A structural guard. A read that could reach storage or the escrow is the
     * defect this design removes, so the live keys must hold nothing that could.
     */
    @Test
    fun theLiveKeysHoldNothingThatCouldReachDiskOrEscrow() {
        val forbidden = listOf("Escrow", "SecureMuk", "SharedPreferences", "Context", "KeyStore")
        for (field in LiveUnlockStore::class.java.declaredFields) {
            val typeName = field.type.name
            for (word in forbidden) {
                assertFalse(
                    "LiveUnlockStore.${field.name} is a $typeName",
                    typeName.contains(word),
                )
            }
        }
    }

    // ---- Identity --------------------------------------------------------

    @Test
    fun anUnnamedAccountIsRefusedRatherThanPooled() {
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1))

        assertRejected { vault.borrowLiveMasterUnlockKey("") }
        assertRejected { vault.borrowLiveMasterUnlockKey("   ") }
        assertRejected { vault.isUnlocked("") }
        assertRejected { vault.lock("") }
    }

    @Test
    fun theRemovedFallbackIdCanNeverBeCreated() {
        assertRejected { vault.acceptUnlockedKey("default", "user-a", muk(1)) }
        assertRejected { vault.isUnlocked("default") }
        assertRejected { vault.borrowLiveMasterUnlockKey("default") }

        assertFalse(vault.unlockedAccountIds().contains("default"))
    }

    @Test
    fun aBlankServerUserIdIsRejected() {
        assertRejected { vault.acceptUnlockedKey("acct_a", "", muk(1)) }

        assertFalse(vault.isUnlocked("acct_a"))
    }

    // ---- Biometric unlock ------------------------------------------------

    @Test
    fun aSuccessfulPromptPutsTheEscrowedKeyIntoTheLiveState() = runBlocking {
        fixture.escrow.record = FakeEscrowVault.Record("acct_a", "user-a")
        fixture.escrow.unwrapped = muk(7)

        val result = fixture.unlockWithBiometric()

        assertEquals(UnlockResult.Unlocked("acct_a", "user-a"), result)
        assertTrue(vault.isUnlocked("acct_a"))
        assertArrayEquals(muk(7), vault.borrowLiveMasterUnlockKey("acct_a"))
    }

    @Test
    fun withNoEscrowNoPromptIsEvenShown() = runBlocking {
        var prompted = false
        fixture.authentication = {
            prompted = true
            CipherAuthentication.Authenticated(it)
        }

        assertEquals(UnlockResult.NoEscrow, fixture.unlockWithBiometric())
        assertFalse(prompted)
        assertTrue(vault.unlockedAccountIds().isEmpty())
    }

    /**
     * A record written before the account-id rekey names no account. Guessing
     * which vault it opens is how one account's key ends up in another's hands,
     * so it asks for re-enrolment instead.
     */
    @Test
    fun aRecordNamingNoAccountAsksForReEnrolment() = runBlocking {
        fixture.escrow.holdsRecordNamingNoAccount()

        assertEquals(UnlockResult.NoEscrow, fixture.unlockWithBiometric())
        assertTrue(vault.unlockedAccountIds().isEmpty())
    }

    @Test
    fun aRefusedPromptLeavesTheVaultLocked() = runBlocking {
        fixture.escrow.record = FakeEscrowVault.Record("acct_a", "user-a")
        fixture.authentication = { CipherAuthentication.Rejected("Cancelled") }

        assertEquals(UnlockResult.Rejected("Cancelled"), fixture.unlockWithBiometric())
        assertTrue(vault.unlockedAccountIds().isEmpty())
    }

    /** Authentication passing and the unwrap failing are different answers. */
    @Test
    fun anUnwrapThatFailsAfterAGoodPromptIsNotARefusal() = runBlocking {
        fixture.escrow.record = FakeEscrowVault.Record("acct_a", "user-a")
        fixture.escrow.unwrapFailure = IllegalStateException("Key invalidated")

        val result = fixture.unlockWithBiometric()

        assertTrue(result is UnlockResult.Failed)
        assertEquals("Key invalidated", (result as UnlockResult.Failed).message)
        assertTrue(vault.unlockedAccountIds().isEmpty())
    }

    @Test
    fun aPromptThatCannotStartIsReportedSeparately() = runBlocking {
        fixture.escrow.record = FakeEscrowVault.Record("acct_a", "user-a")
        fixture.escrow.cipherFailure = IllegalStateException("Escrow key does not exist")

        val result = fixture.unlockWithBiometric()

        assertTrue(result is UnlockResult.PromptFailed)
        assertTrue(vault.unlockedAccountIds().isEmpty())
    }

    @Test
    fun anActivityThatCannotHostThePromptIsReportedSeparately() = runBlocking {
        fixture.escrow.record = FakeEscrowVault.Record("acct_a", "user-a")
        fixture.authentication = { CipherAuthentication.NoHost("No activity") }

        assertEquals(
            UnlockResult.PromptUnavailable("No activity"),
            fixture.unlockWithBiometric(),
        )
    }

    // ---- Enrolling -------------------------------------------------------

    @Test
    fun enrollingWrapsTheLiveKeyForThatAccount() {
        vault.acceptUnlockedKey("acct_a", "user-a", muk(3))

        val result = vault.enrolBiometricUnlock("acct_a", "user-a", "user@example.com", 5_000L)

        assertEquals(EnrolResult.Enrolled, result)
        assertEquals(1, fixture.escrow.wraps.size)
        val wrap = fixture.escrow.wraps.first()
        assertArrayEquals(muk(3), wrap.muk)
        assertEquals("acct_a", wrap.accountId)
        assertEquals("user-a", wrap.serverUserId)
        assertEquals(5_000L, wrap.timeoutMs)
    }

    /** Escrow follows an unlock. It can never start one. */
    @Test
    fun enrollingALockedAccountWrapsNothing() {
        val result = vault.enrolBiometricUnlock("acct_a", "user-a", "user@example.com", 5_000L)

        assertEquals(EnrolResult.VaultLocked, result)
        assertTrue(fixture.escrow.wraps.isEmpty())
    }

    @Test
    fun theEscrowStateIsReportedAsSeparateFacts() {
        fixture.escrow.record = FakeEscrowVault.Record("acct_a", "user-a")
        fixture.escrow.masterPasswordRequired = true
        fixture.escrow.remainingMs = 1_234L

        val state = vault.biometricUnlockState()

        assertTrue(state.hasEscrow)
        assertFalse(state.canUnlock)
        assertTrue(state.masterPasswordRequired)
        assertEquals(1_234L, state.remainingMs)
        assertTrue(vault.hasBiometricUnlockFor("user@example.com"))
        assertFalse(vault.hasBiometricUnlockFor("someone@else.example"))
    }

    @Test
    fun forgettingTheEscrowLeavesTheLiveKeysAlone() {
        fixture.escrow.record = FakeEscrowVault.Record("acct_a", "user-a")
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1))

        vault.forgetBiometricUnlock()

        assertFalse(vault.biometricUnlockState().hasEscrow)
        assertTrue(vault.isUnlocked("acct_a"))
    }

    /**
     * The escrow is one slot. Signing one account out must not cost another
     * account the biometric unlock it enrolled.
     */
    @Test
    fun anotherAccountSigningOutLeavesTheEscrowAlone() {
        fixture.escrow.record = FakeEscrowVault.Record("acct_a", "user-a")

        assertFalse(vault.forgetBiometricUnlockFor("acct_b"))

        assertTrue(vault.biometricUnlockState().hasEscrow)
    }

    @Test
    fun theEscrowsOwnAccountSigningOutClearsIt() {
        fixture.escrow.record = FakeEscrowVault.Record("acct_a", "user-a")

        assertTrue(vault.forgetBiometricUnlockFor("acct_a"))

        assertFalse(vault.biometricUnlockState().hasEscrow)
    }

    /**
     * A pre-rekey record names no account, so no account can claim it and none can
     * disown it. It cannot unlock anything either, so the safe reading is "mine".
     */
    @Test
    fun aRecordNamingNoAccountIsClearedByAnySignOut() {
        fixture.escrow.holdsRecordNamingNoAccount()

        assertTrue(vault.forgetBiometricUnlockFor("acct_b"))

        assertFalse(vault.biometricUnlockState().hasEscrow)
    }

    private fun assertRejected(block: () -> Unit) {
        try {
            block()
            fail("expected IllegalArgumentException")
        } catch (_: IllegalArgumentException) {
            // expected
        }
    }
}
