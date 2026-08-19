package com.bittery.mobile.credentialprovider.vault

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the vault will offer, and to whom.
 *
 * These are the reads the autofill service, the credential-provider service and
 * the pick-a-credential activity make. Two rules run through all of them: a
 * locked account offers nothing, and an origin only reaches the items indexed
 * under the same keys — the SQL side of `DomainMatch.matches`.
 */
class NativeCredentialVaultLookupTest {

    private val fixture = VaultUnderTest()
    private val vault = fixture.vault

    private fun unlockAccountA() {
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1))
        fixture.replica.put(vaultKey("user-a", mukFill = 1))
    }

    private fun unlockAccountB() {
        vault.acceptUnlockedKey("acct_b", "user-b", muk(2))
        fixture.replica.put(vaultKey("user-b", mukFill = 2))
    }

    // ---- Filling a field -------------------------------------------------

    @Test
    fun anUnlockedAccountFillsItsMatchingCredential() = runBlocking {
        unlockAccountA()
        fixture.replica.put(
            loginItem("item-1", "user-a", username = "ada@example.com", password = "hunter2"),
        )
        fixture.replica.index("item-1", "login.example.com", "example.com")

        val credentials = vault.credentialsForOrigin("https://login.example.com/signin", limit = 20)

        assertEquals(1, credentials.size)
        assertEquals("item-1", credentials[0].itemId)
        assertEquals("acct_a", credentials[0].accountId)
        assertEquals("ada@example.com", credentials[0].username)
        assertEquals("hunter2", credentials[0].password)
        assertEquals("Example", credentials[0].label)
    }

    /** A sibling subdomain is the same site. That is what the parent key is for. */
    @Test
    fun aSiblingSubdomainStillMatches() = runBlocking {
        unlockAccountA()
        fixture.replica.put(loginItem("item-1", "user-a"))
        fixture.replica.index("item-1", "login.example.com", "example.com")

        val credentials = vault.credentialsForOrigin("shop.example.com", limit = 20)

        assertEquals(listOf("item-1"), credentials.map { it.itemId })
    }

    @Test
    fun anUnrelatedOriginMatchesNothing() = runBlocking {
        unlockAccountA()
        fixture.replica.put(loginItem("item-1", "user-a"))
        fixture.replica.index("item-1", "example.com")

        assertTrue(vault.credentialsForOrigin("example.org", limit = 20).isEmpty())
        assertTrue(vault.credentialsForOrigin("", limit = 20).isEmpty())
    }

    /** The whole point of the live-only rule: a locked vault fills nothing. */
    @Test
    fun aLockedAccountFillsNothing() = runBlocking {
        unlockAccountA()
        fixture.replica.put(loginItem("item-1", "user-a"))
        fixture.replica.index("item-1", "example.com")

        vault.lock("acct_a")

        assertTrue(vault.credentialsForOrigin("example.com", limit = 20).isEmpty())
    }

    @Test
    fun oneAccountNeverFillsAnothersCredential() = runBlocking {
        unlockAccountB()
        fixture.replica.put(loginItem("item-a", "user-a"))
        fixture.replica.index("item-a", "example.com")
        fixture.replica.put(loginItem("item-b", "user-b", username = "bob@example.com"))
        fixture.replica.index("item-b", "example.com")

        val credentials = vault.credentialsForOrigin("example.com", limit = 20)

        assertEquals(listOf("item-b"), credentials.map { it.itemId })
    }

    @Test
    fun theCallersLimitIsRespected() = runBlocking {
        unlockAccountA()
        fixture.replica.put(loginItem("item-1", "user-a"))
        fixture.replica.index("item-1", "example.com")
        fixture.replica.put(loginItem("item-2", "user-a"))
        fixture.replica.index("item-2", "example.com")

        assertEquals(1, vault.credentialsForOrigin("example.com", limit = 1).size)
        assertEquals(0, vault.credentialsForOrigin("example.com", limit = 0).size)
    }

    /** One unreadable row must not cost the user every other suggestion. */
    @Test
    fun anItemThatWillNotDecryptIsSkipped() = runBlocking {
        unlockAccountA()
        fixture.replica.put(loginItem("item-1", "user-a"))
        fixture.replica.index("item-1", "example.com")
        fixture.replica.put(loginItem("item-2", "user-a"))
        fixture.replica.index("item-2", "example.com")
        fixture.crypto.undecryptableItemIds.add("item-1")

        val credentials = vault.credentialsForOrigin("example.com", limit = 20)

        assertEquals(listOf("item-2"), credentials.map { it.itemId })
    }

    @Test
    fun anItemWithNoPasswordIsSkipped() = runBlocking {
        unlockAccountA()
        fixture.replica.put(loginItem("item-1", "user-a", password = ""))
        fixture.replica.index("item-1", "example.com")

        assertTrue(vault.credentialsForOrigin("example.com", limit = 20).isEmpty())
    }

    // ---- Offering an entry, with no secret in it -------------------------

    @Test
    fun suggestionsCarryLabelsAndNeverDecrypt() = runBlocking {
        unlockAccountA()
        fixture.replica.put(
            loginItem(
                "item-1",
                "user-a",
                username = "ada@example.com",
                displayTitle = "Example",
                updatedAtMs = 99L,
            ),
        )
        fixture.replica.index("item-1", "example.com")
        // Nothing may open: an entry is a label, not a credential.
        fixture.crypto.undecryptableItemIds.add("item-1")

        val suggestions = vault.passwordSuggestionsForOrigin("https://example.com/login")

        assertEquals(1, suggestions.size)
        assertEquals("item-1", suggestions[0].itemId)
        assertEquals("ada@example.com", suggestions[0].username)
        assertEquals("Example", suggestions[0].displayName)
        assertEquals(99L, suggestions[0].lastUsedAtMs)
    }

    /**
     * An item with no title of its own is offered under its domain.
     *
     * The domain is the only name left: the picker shows the entry beside entries
     * from other apps, and "Login" tells the user nothing about which site it is
     * for. The username line falls back the same way when the item has no username.
     */
    @Test
    fun anItemWithNoTitleIsOfferedUnderItsDomain() = runBlocking {
        unlockAccountA()
        fixture.replica.put(
            loginItem(
                "item-1",
                "user-a",
                username = "",
                displayTitle = "",
                primaryDomain = "login.example.com",
            ),
        )
        fixture.replica.index("item-1", "example.com")

        val suggestions = vault.passwordSuggestionsForOrigin("https://example.com/login")

        assertEquals("login.example.com", suggestions[0].username)
        assertEquals("login.example.com", suggestions[0].displayName)
    }

    /**
     * An Android package name is not a site. Offering a credential to one because
     * its reversed labels happen to match an indexed domain is a leak.
     */
    @Test
    fun anOriginThatNamesNoWebHostIsOfferedNothing() = runBlocking {
        unlockAccountA()
        fixture.replica.put(loginItem("item-1", "user-a"))
        fixture.replica.index("item-1", "com.android.chrome", "android.chrome")

        assertTrue(vault.passwordSuggestionsForOrigin("com.android.chrome").isEmpty())
        assertTrue(vault.passwordSuggestionsForOrigin("android:apk-key-hash:abc").isEmpty())
        assertTrue(vault.passwordSuggestionsForOrigin("").isEmpty())
    }

    @Test
    fun aLockedAccountOffersNothing() = runBlocking {
        fixture.replica.put(loginItem("item-1", "user-a"))
        fixture.replica.index("item-1", "example.com")

        assertTrue(vault.passwordSuggestionsForOrigin("example.com").isEmpty())
    }

    // ---- Revealing the password the user picked --------------------------

    @Test
    fun revealingAPasswordRecordsTheUse() = runBlocking {
        unlockAccountA()
        fixture.replica.put(
            loginItem("item-1", "user-a", username = "ada@example.com", password = "hunter2"),
        )
        fixture.wallClock.nowMs = 5_000L

        val reveal = vault.revealPassword("item-1")

        assertEquals(PasswordReveal.Revealed("ada@example.com", "hunter2"), reveal)
        assertEquals(listOf("item-1" to 5_000L), fixture.replica.lastUsedWrites)
    }

    @Test
    fun revealingAnUnknownItemSaysSo() = runBlocking {
        unlockAccountA()

        assertEquals(PasswordReveal.ItemNotFound, vault.revealPassword("missing"))
    }

    /**
     * A locked item says whether a prompt would help. The escrow opens exactly one
     * account, so an escrow for someone else is no help at all.
     */
    @Test
    fun aLockedItemSaysWhetherAPromptWouldHelp() = runBlocking {
        fixture.replica.put(loginItem("item-1", "user-a"))
        fixture.escrow.record = FakeEscrowVault.Record("acct_a", "user-a")

        assertEquals(PasswordReveal.Locked(canUnlockWithBiometric = true), vault.revealPassword("item-1"))

        fixture.escrow.record = FakeEscrowVault.Record("acct_b", "user-b")
        assertEquals(PasswordReveal.Locked(canUnlockWithBiometric = false), vault.revealPassword("item-1"))

        fixture.escrow.record = null
        assertEquals(PasswordReveal.Locked(canUnlockWithBiometric = false), vault.revealPassword("item-1"))
    }

    @Test
    fun revealingWithoutAVaultKeyFails() = runBlocking {
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1))
        fixture.replica.put(loginItem("item-1", "user-a"))

        assertEquals(PasswordReveal.Failed("Vault key not found"), vault.revealPassword("item-1"))
    }

    @Test
    fun revealingAnItemWithNoPasswordFails() = runBlocking {
        unlockAccountA()
        fixture.replica.put(loginItem("item-1", "user-a", password = ""))

        assertEquals(
            PasswordReveal.Failed("No password found in item"),
            vault.revealPassword("item-1"),
        )
    }

    // ---- Where a new passkey goes ----------------------------------------

    @Test
    fun aLockedVaultHasNowhereToSaveAPasskey() = runBlocking {
        assertEquals(
            PasskeySaveTargetChoice.VaultLocked,
            vault.passkeySaveTarget("example.com", "ada@example.com"),
        )
    }

    @Test
    fun withNoMatchingItemANewOneIsMade() = runBlocking {
        unlockAccountA()

        assertEquals(
            PasskeySaveTargetChoice.Resolved(PasskeySaveTarget.NewItem),
            vault.passkeySaveTarget("example.com", "ada@example.com"),
        )
    }

    @Test
    fun oneMatchingItemIsChosenWithoutAsking() = runBlocking {
        unlockAccountA()
        fixture.replica.put(loginItem("item-1", "user-a", username = "ada@example.com"))
        fixture.replica.index("item-1", "example.com")

        assertEquals(
            PasskeySaveTargetChoice.Resolved(PasskeySaveTarget.ExistingItem("item-1")),
            vault.passkeySaveTarget("example.com", "ada@example.com"),
        )
    }

    /** The requested user decides. Two of their items means the most recent one. */
    @Test
    fun theMostRecentItemOfTheRequestedUserWins() = runBlocking {
        unlockAccountA()
        fixture.replica.put(
            loginItem("item-old", "user-a", username = "ada@example.com", lastUsedAtMs = 10L),
        )
        fixture.replica.index("item-old", "example.com")
        fixture.replica.put(
            loginItem("item-new", "user-a", username = "ada@example.com", lastUsedAtMs = 20L),
        )
        fixture.replica.index("item-new", "example.com")

        assertEquals(
            PasskeySaveTargetChoice.Resolved(PasskeySaveTarget.ExistingItem("item-new")),
            vault.passkeySaveTarget("example.com", "ada@example.com"),
        )
    }

    /** Different users, no way to tell. Only the person at the screen can. */
    @Test
    fun severalUnrelatedItemsAreLeftForTheUserToChoose() = runBlocking {
        unlockAccountA()
        fixture.replica.put(loginItem("item-1", "user-a", username = "one@example.com"))
        fixture.replica.index("item-1", "example.com")
        fixture.replica.put(loginItem("item-2", "user-a", username = "two@example.com"))
        fixture.replica.index("item-2", "example.com")

        val choice = vault.passkeySaveTarget("example.com", "ada@example.com")

        assertTrue(choice is PasskeySaveTargetChoice.Ambiguous)
        assertEquals(
            listOf("item-1", "item-2"),
            (choice as PasskeySaveTargetChoice.Ambiguous).candidates.map { it.itemId },
        )
        assertEquals("Example", choice.candidates[0].label)
        assertEquals("one@example.com", choice.candidates[0].username)
    }

    /**
     * "No match" and "a match you cannot reach" are different answers: the second
     * is fixed by unlocking, and telling them apart is why the cross-account
     * lookup exists.
     */
    @Test
    fun aMatchInALockedAccountIsReportedAsSuch() = runBlocking {
        unlockAccountB()
        fixture.replica.put(loginItem("item-a", "user-a", username = "ada@example.com"))
        fixture.replica.index("item-a", "example.com")

        assertEquals(
            PasskeySaveTargetChoice.LockedAccountOwnsMatch,
            vault.passkeySaveTarget("example.com", "ada@example.com"),
        )
    }

    // ---- The queue of writes the server has not taken --------------------

    @Test
    fun queuedWritesAreReadPerAccountAndDroppedWhenAccepted() = runBlocking {
        fixture.replica.pending["m1"] = queuedWrite("m1", "user-a")
        fixture.replica.pending["m2"] = queuedWrite("m2", "user-b")

        assertEquals(listOf("m1"), vault.queuedVaultWrites("user-a").map { it.id })
        assertEquals(listOf("m1", "m2"), vault.queuedVaultWrites(null).map { it.id })
        assertEquals(listOf("m1", "m2"), vault.queuedVaultWrites("").map { it.id })

        vault.forgetQueuedVaultWrites(listOf("m1"))
        assertEquals(listOf("m2"), vault.queuedVaultWrites(null).map { it.id })

        vault.recordQueuedVaultWriteFailure(listOf("m2"), "409")
        val failed = vault.queuedVaultWrites(null).single()
        assertEquals(1, failed.attemptCount)
        assertEquals("409", failed.lastError)
    }

    private fun queuedWrite(id: String, serverUserId: String) = PendingPasskeyMutation(
        id = id,
        serverUserId = serverUserId,
        vaultId = "vault-$serverUserId",
        itemId = "item-$id",
        operation = "update_item",
        encryptedData = "ciphertext",
        encryptionIv = "iv",
        encryptionAlgorithm = "AES-GCM-AAD-V1",
        baseVersion = 1L,
        encryptionVersion = 2L,
        encryptedByServerUserId = serverUserId,
        createdAtMs = 0L,
        attemptCount = 0,
        lastError = null,
    )
}
