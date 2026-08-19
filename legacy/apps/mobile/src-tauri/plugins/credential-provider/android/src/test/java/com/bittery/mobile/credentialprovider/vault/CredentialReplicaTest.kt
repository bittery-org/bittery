package com.bittery.mobile.credentialprovider.vault

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.json.JSONArray
import org.json.JSONObject

/**
 * The sync payload, and what the vault does with it.
 *
 * The replica is the only thing autofill can answer from, so a payload that is
 * not a complete snapshot must write nothing at all — a half-applied sync is a
 * vault that answers with yesterday's password.
 */
class CredentialReplicaTest {

    private val fixture = VaultUnderTest()
    private val vault = fixture.vault

    // ---- Reading the payload ---------------------------------------------

    @Test
    fun aPayloadMissingAnIdentityIsRejected() {
        assertRejected(payload(accountId = ""), "Complete account and KDF profile data is required")
        assertRejected(payload(userId = ""), "Complete account and KDF profile data is required")
        assertRejected(payload(email = ""), "Complete account and KDF profile data is required")
        assertRejected(payload(secretKey = ""), "Complete account and KDF profile data is required")
    }

    @Test
    fun aPayloadWithNoKdfProfileIsRejected() {
        val json = payload()
        json.remove("kdfProfile")

        assertRejected(json, "Complete account and KDF profile data is required")
    }

    /**
     * The profile decides how the master unlock key was derived. A wrong one
     * derives a key that opens nothing, which reads as a corrupt vault.
     */
    @Test
    fun aKdfProfileOutsideTheSupportedRangeIsRejected() {
        assertRejected(payload(kdfSchemaVersion = 2), "Invalid KDF profile")
        assertRejected(payload(kdfAlgorithm = "scrypt"), "Invalid KDF profile")
        assertRejected(payload(kdfIterations = 599_999), "Invalid KDF profile")
        assertRejected(payload(kdfIterations = 1_200_001), "Invalid KDF profile")
    }

    @Test
    fun onlyLoginItemsAreKept() {
        val json = payload(
            items = listOf(
                itemJson("item-1", urls = listOf("https://example.com")),
                itemJson("item-2", category = "secure-note"),
            ),
        )

        val snapshot = parsed(json)

        assertEquals(listOf("item-1"), snapshot.items.map { it.id })
    }

    /**
     * The label the picker falls back to when an item has no title of its own.
     *
     * `urls` arrives as a `JSONArray`, which is not a Kotlin `List`, so the
     * flattened view of the object cannot see one. Reading it as a list left
     * `primaryDomain` null on every item, and every fallback that names it dead.
     */
    @Test
    fun anItemTakesItsPrimaryDomainFromItsFirstUrl() {
        val json = payload(
            items = listOf(
                itemJson(
                    "item-1",
                    urls = listOf("https://Login.Example.com/in", "https://other.example.com"),
                ),
                itemJson("item-2", urls = emptyList()),
            ),
        )

        val items = parsed(json).items.associateBy { it.id }

        assertEquals("login.example.com", items.getValue("item-1").primaryDomain)
        // No URL, no domain. The vault repairs this one from its own plaintext.
        assertNull(items.getValue("item-2").primaryDomain)
    }

    @Test
    fun anItemMissingItsCiphertextIsSkipped() {
        val incomplete = itemJson("item-2")
        incomplete.remove("encryptedData")
        val json = payload(items = listOf(itemJson("item-1"), incomplete))

        assertEquals(listOf("item-1"), parsed(json).items.map { it.id })
    }

    // ---- Applying it ------------------------------------------------------

    @Test
    fun aSnapshotIsWrittenAndIndexedUnderBothKeys() = runBlocking {
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1))
        val json = payload(
            vaultKeys = listOf(vaultKeyJson("vault-1")),
            items = listOf(itemJson("item-1", urls = listOf("https://login.example.com/in"))),
        )

        val result = vault.replaceReplica(parsed(json)) as ReplicaUpdateResult.Applied

        assertEquals(1, result.vaultKeys)
        assertEquals(1, result.items)
        // The host and its registrable domain, so a sibling subdomain matches too.
        assertEquals(2, result.domains)
        assertEquals(
            listOf("login.example.com", "example.com"),
            fixture.replica.domains.getValue("item-1").map { it.domain },
        )
        assertEquals(setOf("item-1"), fixture.replica.items.keys)
        assertTrue(fixture.replica.accountProfiles.containsKey("user-a"))
    }

    @Test
    fun rowsTheServerNoLongerSendsAreRemoved() = runBlocking {
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1))
        fixture.replica.put(loginItem("stale-item", "user-a"))
        fixture.replica.put(vaultKey("user-a", mukFill = 1, vaultId = "stale-vault"))

        val json = payload(
            vaultKeys = listOf(vaultKeyJson("vault-1")),
            items = listOf(itemJson("item-1", urls = listOf("https://example.com"))),
        )

        val result = vault.replaceReplica(parsed(json)) as ReplicaUpdateResult.Applied

        assertEquals(1, result.deletedVaultKeys)
        assertEquals(1, result.deletedItems)
        assertEquals(setOf("item-1"), fixture.replica.items.keys)
    }

    /**
     * An item that arrives with no URLs is opened with the live key and read for
     * its own. It is a repair, and only a live key can do it — a locked account
     * leaves the item unindexed rather than reaching for the escrow.
     */
    @Test
    fun anItemWithNoUrlsIsRepairedFromItsOwnPlaintext() = runBlocking {
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1))
        fixture.replica.put(vaultKey("user-a", mukFill = 1, vaultId = "vault-1"))

        val item = itemJson("item-1", urls = emptyList())
        item.put("encryptedData", JSONObject().put("url", "https://recovered.example.com").toString())
        val json = payload(vaultKeys = listOf(vaultKeyJson("vault-1")), items = listOf(item))

        val result = vault.replaceReplica(parsed(json)) as ReplicaUpdateResult.Applied

        assertEquals(2, result.domains)
        assertEquals(
            listOf("recovered.example.com", "example.com"),
            fixture.replica.domains.getValue("item-1").map { it.domain },
        )
    }

    /**
     * A locked account's snapshot is refused, and refusing it reaches for nothing.
     *
     * An escrow record is sitting right there. Only [unlockWithBiometric] may unwrap
     * one, and it shows a prompt first — a sync must never stand in for that prompt.
     */
    @Test
    fun aLockedAccountsSnapshotIsRefusedWithoutTouchingTheEscrow() = runBlocking {
        fixture.escrow.record = FakeEscrowVault.Record("acct_a", "user-a")

        val json = payload(
            vaultKeys = listOf(vaultKeyJson("vault-1")),
            items = listOf(itemJson("item-1", urls = emptyList())),
        )

        val outcome = vault.replaceReplica(parsed(json))

        assertTrue("expected a rejection, got $outcome", outcome is ReplicaUpdateResult.Rejected)
        assertNull(fixture.replica.domains["item-1"])
        assertTrue(fixture.replica.items.isEmpty())
        // Nothing unwrapped the escrow to get a key it could have written under.
        assertTrue(vault.unlockedAccountIds().isEmpty())
    }

    /**
     * A snapshot for an account with no live key is refused, rows and all.
     *
     * Locking empties the app's repository, so the pass that follows a lock carries
     * no items. A snapshot is authoritative, so applying that one would delete every
     * row the account serves — and nobody could read the replacement anyway, because
     * the key that opens it is gone. Keep the last good generation.
     */
    @Test
    fun aSnapshotForAnAccountWithNoLiveKeyIsRejected() = runBlocking {
        val item = itemJson("item-1", urls = listOf("https://example.com"))
        item.put(
            "encryptedData",
            JSONObject().put("username", "ada").put("password", "secret").toString(),
        )

        vault.acceptUnlockedKey("acct_a", "user-a", muk(1))
        vault.replaceReplica(
            parsed(payload(vaultKeys = listOf(vaultKeyJson("vault-1")), items = listOf(item))),
        )
        assertEquals(1, vault.credentialsForOrigin("example.com", limit = 20).size)

        // Locking empties the app's repository, so the pass behind it carries none.
        vault.lock("acct_a")
        val outcome = vault.replaceReplica(
            parsed(payload(vaultKeys = listOf(vaultKeyJson("vault-1")), items = emptyList())),
        )

        assertTrue("expected a rejection, got $outcome", outcome is ReplicaUpdateResult.Rejected)
        assertEquals(setOf("item-1"), fixture.replica.items.keys)
        // And it serves again the moment the account is unlocked.
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1))
        assertEquals(1, vault.credentialsForOrigin("example.com", limit = 20).size)
    }

    /** One item that cannot be indexed must not cost the rest of the sync. */
    @Test
    fun anItemThatCannotBeIndexedDoesNotStopTheOthers() = runBlocking {
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1))
        val skipped = itemJson("item-skipped", urls = listOf("https://skipped.example.com"))
        skipped.remove("version")

        val json = payload(
            vaultKeys = listOf(vaultKeyJson("vault-1")),
            items = listOf(skipped, itemJson("item-1", urls = listOf("https://example.com"))),
        )

        val result = vault.replaceReplica(parsed(json)) as ReplicaUpdateResult.Applied

        assertEquals(1, result.items)
        assertEquals(1, result.domains)
        assertEquals(listOf("example.com"), fixture.replica.domains.getValue("item-1").map { it.domain })
    }

    // ---- Payload builders -------------------------------------------------

    private fun parsed(json: JSONObject): CredentialReplicaSnapshot {
        val parse = CredentialReplicaSnapshots.parse(json.toString())
        assertTrue("expected a parsed snapshot, got $parse", parse is ReplicaSnapshotParse.Parsed)
        return (parse as ReplicaSnapshotParse.Parsed).snapshot
    }

    private fun assertRejected(json: JSONObject, reason: String) {
        val parse = CredentialReplicaSnapshots.parse(json.toString())
        assertTrue("expected a rejection, got $parse", parse is ReplicaSnapshotParse.Rejected)
        assertEquals(reason, (parse as ReplicaSnapshotParse.Rejected).reason)
    }

    private fun payload(
        accountId: String = "acct_a",
        userId: String = "user-a",
        email: String = "ada@example.com",
        secretKey: String = "A3-XXXXXX",
        kdfSchemaVersion: Int = 1,
        kdfAlgorithm: String = "pbkdf2-sha256",
        kdfIterations: Int = 650_000,
        vaultKeys: List<JSONObject> = emptyList(),
        items: List<JSONObject> = emptyList(),
    ) = JSONObject()
        .put("accountId", accountId)
        .put("userId", userId)
        .put("email", email)
        .put("secretKey", secretKey)
        .put(
            "kdfProfile",
            JSONObject()
                .put("schemaVersion", kdfSchemaVersion)
                .put("algorithm", kdfAlgorithm)
                .put("iterations", kdfIterations),
        )
        .put("vaultKeys", JSONArray(vaultKeys))
        .put("items", JSONArray(items))
        // Every real payload carries a verified policy. What happens without one is
        // its own subject, in `NativeCredentialVaultTravelModeTest`.
        .put(
            "travelMode",
            JSONObject()
                .put("verified", true)
                .put("enabled", false)
                .put("hiddenVaultIds", JSONArray())
                .put("updatedAt", 1L),
        )

    private fun vaultKeyJson(vaultId: String) = JSONObject()
        .put("vaultId", vaultId)
        .put("vaultName", "Personal")
        .put("vaultType", "personal")
        .put("encryptedKey", "1")
        .put("encryptionIv", "iv")
        .put("encryptionAlgorithm", "AES-GCM-AAD-V1")
        .put("role", "owner")
        .put("keyVersion", 1)

    private fun itemJson(
        id: String,
        category: String = "login",
        urls: List<String> = emptyList(),
    ) = JSONObject()
        .put("id", id)
        .put("vaultId", "vault-1")
        .put("category", category)
        .put("displayTitle", "Example")
        .put("encryptedData", "{}")
        .put("encryptionIv", "iv")
        .put("encryptionAlgorithm", "AES-GCM-AAD-V1")
        .put("version", 1)
        .put("encryptionVersion", 1)
        .put("encryptedByUserId", "user-a")
        .put("urls", JSONArray(urls))
}
