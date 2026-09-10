package com.bittery.mobile.credentialprovider.vault

import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Travel mode, enforced by the vault itself.
 *
 * The app already filters a hidden vault out before it syncs, so in practice the
 * replica never holds one. These tests remove that assumption: they put a hidden
 * vault's rows in the replica by hand and then ask every question a caller can
 * ask. Each one must come back empty.
 *
 * Keep them. They are the reason a future sync rewrite cannot quietly turn
 * hidden vaults back on: the enforcement they cover lives under
 * [NativeCredentialVault], not in the TypeScript that feeds it.
 */
class NativeCredentialVaultTravelModeTest {

    private val fixture = VaultUnderTest()
    private val vault = fixture.vault

    private companion object {
        const val VISIBLE = "vault-visible"
        const val HIDDEN = "vault-hidden"
    }

    private fun policy(
        enabled: Boolean = true,
        hidden: Set<String> = setOf(HIDDEN),
        updatedAtMs: Long? = 7L,
    ) = NativeTravelModePolicy(
        enabled = enabled,
        hiddenVaultIds = hidden,
        updatedAtMs = updatedAtMs,
    )

    /**
     * Account A, unlocked, with one visible vault and one hidden one — both fully
     * present in the replica, keys and items alike. This is the state travel mode
     * has to survive, not the state the app tries to leave behind.
     */
    private fun unlockAccountAWithBothVaults() {
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1))
        fixture.replica.put(vaultKey("user-a", mukFill = 1, vaultId = VISIBLE, vaultName = "Personal"))
        fixture.replica.put(vaultKey("user-a", mukFill = 1, vaultId = HIDDEN, vaultName = "Work"))
        fixture.replica.put(
            loginItem("item-visible", "user-a", vaultId = VISIBLE, username = "ada@example.com"),
        )
        fixture.replica.index("item-visible", "visible.example.com", "example.com")
        fixture.replica.put(
            loginItem(
                "item-hidden",
                "user-a",
                vaultId = HIDDEN,
                username = "ada@secret.example",
                password = "borderline",
            ) {
                put("passkeys", JSONArray().put(passkeyJson("secret.example")))
            },
        )
        fixture.replica.index("item-hidden", "secret.example")
    }

    private fun passkeyJson(rpId: String) = JSONObject()
        .put("credentialId", "credential-1")
        .put("rpId", rpId)
        .put("rpName", rpId)
        .put("userHandle", "handle-1")
        .put("userName", "ada@secret.example")
        .put("privateKey", "private-key")
        .put("publicKey", "public-key")
        .put("algorithm", -7)
        .put("signCount", 1)

    // ---- The baseline: a visible vault still answers ---------------------

    @Test
    fun aVisibleVaultStillProducesCredentials() = runBlocking {
        unlockAccountAWithBothVaults()
        fixture.replica.setTravelModePolicy("user-a", policy())

        val credentials = vault.credentialsForOrigin("https://visible.example.com/in", limit = 20)

        assertEquals(listOf("item-visible"), credentials.map { it.itemId })
        assertEquals(
            listOf("item-visible"),
            vault.passwordSuggestionsForOrigin("visible.example.com").map { it.itemId },
        )
        assertEquals(
            PasswordReveal.Revealed("ada@example.com", "secret"),
            vault.revealPassword("item-visible"),
        )
    }

    // ---- A hidden vault answers nothing, on every path -------------------

    /**
     * The whole invariant, path by path. Each of these is a place a caller can
     * reach an item, and a hidden vault has to be absent from all of them — not
     * "absent from the list the picker shows".
     */
    @Test
    fun aHiddenVaultProducesNothingOnEveryPath() = runBlocking {
        unlockAccountAWithBothVaults()
        fixture.replica.setTravelModePolicy("user-a", policy())

        // Autofill login suggestions.
        assertTrue(vault.credentialsForOrigin("secret.example", limit = 20).isEmpty())
        // Credential-provider password suggestions.
        assertTrue(vault.passwordSuggestionsForOrigin("secret.example").isEmpty())
        // Passkey suggestions.
        assertTrue(vault.passkeySuggestionsFor("secret.example", emptySet()).isEmpty())
        // Direct item retrieval.
        assertEquals(PasswordReveal.ItemNotFound, vault.revealPassword("item-hidden"))
        // Passkey assertion.
        assertEquals(
            PasskeyAssertionResult.ItemNotFound,
            vault.assertPasskey(
                PasskeyAssertionRequest("item-hidden", "credential-1", "secret.example", "hash"),
            ),
        )
        // Passkey save target, both the indexed path and the decrypted fallback.
        assertEquals(
            PasskeySaveTargetChoice.Resolved(PasskeySaveTarget.NewItem),
            vault.passkeySaveTarget("secret.example", "ada@secret.example"),
        )
        // Passkey save, aimed straight at the hidden item.
        val saved = vault.savePasskey(
            PasskeySaveRequest(
                target = PasskeySaveTarget.ExistingItem("item-hidden"),
                rpId = "secret.example",
                rpName = "Secret",
                userHandle = "handle-1",
                userName = "ada@secret.example",
                userDisplayName = "Ada",
            ),
        )
        assertEquals(PasskeySaveResult.Failed("Item not found"), saved)
    }

    /** A new passkey never lands in a vault the user is hiding. */
    @Test
    fun aHiddenVaultIsNeverAWritableTarget() = runBlocking {
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1))
        fixture.replica.put(vaultKey("user-a", mukFill = 1, vaultId = HIDDEN))
        fixture.replica.setTravelModePolicy("user-a", policy())

        val saved = vault.savePasskey(
            PasskeySaveRequest(
                target = PasskeySaveTarget.NewItem,
                rpId = "secret.example",
                rpName = "Secret",
                userHandle = "handle-1",
                userName = "ada@secret.example",
                userDisplayName = "Ada",
            ),
        )

        assertEquals(PasskeySaveResult.Failed("No writable vault key available"), saved)
    }

    /**
     * The cross-account lookup behind "a match you cannot reach" must not turn
     * into a way to learn that a hidden vault holds one.
     */
    @Test
    fun theLockedAccountProbeCannotSeeAHiddenVault() = runBlocking {
        vault.acceptUnlockedKey("acct_b", "user-b", muk(2))
        fixture.replica.put(vaultKey("user-b", mukFill = 2))
        fixture.replica.put(vaultKey("user-a", mukFill = 1, vaultId = HIDDEN))
        fixture.replica.put(loginItem("item-hidden", "user-a", vaultId = HIDDEN, username = "ada@secret.example"))
        fixture.replica.index("item-hidden", "secret.example")
        fixture.replica.setTravelModePolicy("user-a", policy())
        fixture.replica.setTravelModePolicy("user-b", policy(enabled = false, hidden = emptySet()))

        assertEquals(
            PasskeySaveTargetChoice.Resolved(PasskeySaveTarget.NewItem),
            vault.passkeySaveTarget("secret.example", "ada@secret.example"),
        )
    }

    /**
     * The fallback that opens items and reads their URLs is a lookup like any
     * other. It reaches the replica through the same door.
     */
    @Test
    fun theDecryptedFallbackCannotSeeAHiddenVault() = runBlocking {
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1))
        fixture.replica.put(vaultKey("user-a", mukFill = 1, vaultId = HIDDEN))
        // No domain rows at all, so only the decrypted fallback can find this.
        fixture.replica.put(
            loginItem("item-hidden", "user-a", vaultId = HIDDEN, username = "ada@secret.example") {
                put("url", "https://secret.example")
            },
        )
        fixture.replica.setTravelModePolicy("user-a", policy())

        assertEquals(
            PasskeySaveTargetChoice.Resolved(PasskeySaveTarget.NewItem),
            vault.passkeySaveTarget("secret.example", "ada@secret.example"),
        )
    }

    // ---- Turning it off ---------------------------------------------------

    @Test
    fun disablingTravelModeRestoresTheCredentials() = runBlocking {
        unlockAccountAWithBothVaults()
        fixture.replica.setTravelModePolicy("user-a", policy())
        assertTrue(vault.credentialsForOrigin("secret.example", limit = 20).isEmpty())

        fixture.replica.setTravelModePolicy("user-a", policy(enabled = false))

        assertEquals(
            listOf("item-hidden"),
            vault.credentialsForOrigin("secret.example", limit = 20).map { it.itemId },
        )
        assertEquals(
            PasswordReveal.Revealed("ada@secret.example", "borderline"),
            vault.revealPassword("item-hidden"),
        )
    }

    /** A vault id in a disabled policy hides nothing. Enabled is the switch. */
    @Test
    fun aDisabledPolicyHidesNothingEvenWithNamedVaults() = runBlocking {
        unlockAccountAWithBothVaults()
        fixture.replica.setTravelModePolicy("user-a", policy(enabled = false, hidden = setOf(HIDDEN)))

        assertEquals(
            listOf("item-hidden"),
            vault.credentialsForOrigin("secret.example", limit = 20).map { it.itemId },
        )
    }

    // ---- One account's policy is only its own ----------------------------

    @Test
    fun onePolicyDoesNotReachAnotherAccount() = runBlocking {
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1))
        vault.acceptUnlockedKey("acct_b", "user-b", muk(2))
        // The same vault id under both accounts, hidden for A and not for B.
        fixture.replica.put(vaultKey("user-a", mukFill = 1, vaultId = HIDDEN))
        fixture.replica.put(vaultKey("user-b", mukFill = 2, vaultId = HIDDEN))
        fixture.replica.put(loginItem("item-a", "user-a", vaultId = HIDDEN, username = "ada@example.com"))
        fixture.replica.index("item-a", "example.com")
        fixture.replica.put(loginItem("item-b", "user-b", vaultId = HIDDEN, username = "bob@example.com"))
        fixture.replica.index("item-b", "example.com")
        fixture.replica.setTravelModePolicy("user-a", policy())
        fixture.replica.setTravelModePolicy("user-b", policy(enabled = false, hidden = emptySet()))

        val credentials = vault.credentialsForOrigin("example.com", limit = 20)

        assertEquals(listOf("item-b"), credentials.map { it.itemId })
        assertEquals(PasswordReveal.ItemNotFound, vault.revealPassword("item-a"))
        assertTrue(vault.revealPassword("item-b") is PasswordReveal.Revealed)
    }

    // ---- No verified policy means no answers -----------------------------

    /**
     * Fail closed, the way the TypeScript does. `TravelModeEnforcer.verifyOrClear`
     * answers an unverifiable policy by locking the account and purging the native
     * mirror, so an account whose policy nobody verified offers nothing at all.
     */
    @Test
    fun anAccountWithNoVerifiedPolicyAnswersNothing() = runBlocking {
        unlockAccountAWithBothVaults()
        fixture.replica.setTravelModePolicy("user-a", null)

        assertTrue(vault.credentialsForOrigin("visible.example.com", limit = 20).isEmpty())
        assertTrue(vault.passwordSuggestionsForOrigin("visible.example.com").isEmpty())
        assertTrue(vault.passkeySuggestionsFor("secret.example", emptySet()).isEmpty())
        assertEquals(PasswordReveal.ItemNotFound, vault.revealPassword("item-visible"))
        assertEquals(
            PasskeyAssertionResult.ItemNotFound,
            vault.assertPasskey(
                PasskeyAssertionRequest("item-visible", "credential-1", "example.com", "hash"),
            ),
        )
        assertEquals(
            PasskeySaveTargetChoice.Resolved(PasskeySaveTarget.NewItem),
            vault.passkeySaveTarget("visible.example.com", "ada@example.com"),
        )
    }

    // ---- Reading the policy off the payload ------------------------------

    @Test
    fun aSnapshotCarriesItsPolicy() {
        val snapshot = parse(payload(travelMode = travelModeJson(enabled = true, hidden = listOf(HIDDEN))))

        assertEquals(
            NativeTravelModePolicy(enabled = true, hiddenVaultIds = setOf(HIDDEN), updatedAtMs = 7L),
            snapshot.travelMode,
        )
    }

    /** No policy in the payload is not "travel mode off". It is "nobody verified". */
    @Test
    fun aSnapshotWithNoPolicyCarriesNone() {
        assertNull(parse(payload(travelMode = null)).travelMode)
    }

    @Test
    fun aSnapshotWithAnUnverifiedPolicyCarriesNone() {
        val unverified = travelModeJson(enabled = false, hidden = emptyList())
            .put("verified", false)

        assertNull(parse(payload(travelMode = unverified)).travelMode)
    }

    // ---- Applying a snapshot ---------------------------------------------

    @Test
    fun anUnverifiedSnapshotIsRejectedAndStopsEveryAnswer() = runBlocking {
        unlockAccountAWithBothVaults()
        fixture.replica.setTravelModePolicy("user-a", policy(enabled = false, hidden = emptySet()))
        assertEquals(1, vault.credentialsForOrigin("visible.example.com", limit = 20).size)

        val outcome = vault.replaceReplica(snapshot(travelMode = null))

        assertTrue(outcome is ReplicaUpdateResult.Rejected)
        assertTrue(vault.credentialsForOrigin("visible.example.com", limit = 20).isEmpty())
        assertEquals(PasswordReveal.ItemNotFound, vault.revealPassword("item-visible"))
    }

    /** What the policy hides is never written, however the payload arrived. */
    @Test
    fun aSnapshotNeverWritesAHiddenVault() = runBlocking {
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1))

        val outcome = vault.replaceReplica(
            snapshot(
                travelMode = policy(),
                vaultKeys = listOf(
                    vaultKey("user-a", mukFill = 1, vaultId = VISIBLE),
                    vaultKey("user-a", mukFill = 1, vaultId = HIDDEN),
                ),
                items = listOf(
                    loginItem("item-visible", "user-a", vaultId = VISIBLE),
                    loginItem("item-hidden", "user-a", vaultId = HIDDEN),
                ),
                itemUrls = mapOf(
                    "item-visible" to listOf("https://visible.example.com"),
                    "item-hidden" to listOf("https://secret.example"),
                ),
            ),
        )

        assertEquals(ReplicaUpdateResult.Applied(1, 1, 2, 0, 0), outcome)
        assertEquals(setOf("item-visible"), fixture.replica.items.keys)
        assertNull(fixture.replica.vaultKeys.values.firstOrNull { it.vaultId == HIDDEN })
    }

    /**
     * A hidden vault's keys and items are erased, not merely suppressed — that is
     * what "hidden vault" means in `CONTEXT.md`. Query-time filtering is the second
     * lock, not a reason to keep the material.
     */
    @Test
    fun aSnapshotErasesTheVaultsItsPolicyHides() = runBlocking {
        unlockAccountAWithBothVaults()
        fixture.replica.setTravelModePolicy("user-a", policy(enabled = false, hidden = emptySet()))
        fixture.replica.pending["m1"] = queuedWrite("m1", "user-a", HIDDEN)
        fixture.replica.pending["m2"] = queuedWrite("m2", "user-a", VISIBLE)

        vault.replaceReplica(
            snapshot(
                travelMode = policy(),
                vaultKeys = listOf(vaultKey("user-a", mukFill = 1, vaultId = VISIBLE)),
                items = listOf(loginItem("item-visible", "user-a", vaultId = VISIBLE)),
                itemUrls = mapOf("item-visible" to listOf("https://visible.example.com")),
            ),
        )

        assertEquals(setOf("item-visible"), fixture.replica.items.keys)
        assertTrue(fixture.replica.vaultKeys.values.none { it.vaultId == HIDDEN })
        assertFalse(fixture.replica.domains.containsKey("item-hidden"))
        assertEquals(setOf("m2"), fixture.replica.pending.keys)
    }

    /** The second snapshot filters like the first. There is no cheaper path in. */
    @Test
    fun aRepeatedSnapshotFiltersTheSameWay() = runBlocking {
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1))
        val incoming = snapshot(
            travelMode = policy(),
            vaultKeys = listOf(
                vaultKey("user-a", mukFill = 1, vaultId = VISIBLE),
                vaultKey("user-a", mukFill = 1, vaultId = HIDDEN),
            ),
            items = listOf(
                loginItem("item-visible", "user-a", vaultId = VISIBLE),
                loginItem("item-hidden", "user-a", vaultId = HIDDEN),
            ),
            itemUrls = mapOf(
                "item-visible" to listOf("https://visible.example.com"),
                "item-hidden" to listOf("https://secret.example"),
            ),
        )

        vault.replaceReplica(incoming)
        vault.replaceReplica(incoming)

        assertEquals(setOf("item-visible"), fixture.replica.items.keys)
        assertTrue(vault.credentialsForOrigin("secret.example", limit = 20).isEmpty())
    }

    /**
     * Policy before data, always.
     *
     * The apply commits the new policy first, so the only window it leaves is one
     * where new rows meet the *new* policy. Writing first would leave the opposite
     * window, where a row the new policy hides is queryable under the old one. The
     * hook below asks mid-write and must see nothing hidden.
     */
    @Test
    fun dataIsNeverQueryableUnderAStalePolicy() = runBlocking {
        unlockAccountAWithBothVaults()
        fixture.replica.setTravelModePolicy("user-a", policy(enabled = false, hidden = emptySet()))

        val midWrite = mutableListOf<String>()
        fixture.replica.onPutItems = {
            midWrite += vault.credentialsForOrigin("secret.example", limit = 20).map { it.itemId }
            midWrite += vault.credentialsForOrigin("visible.example.com", limit = 20).map { it.itemId }
            if (vault.revealPassword("item-hidden") is PasswordReveal.Revealed) {
                midWrite += "revealed-hidden"
            }
        }

        vault.replaceReplica(
            snapshot(
                travelMode = policy(),
                vaultKeys = listOf(vaultKey("user-a", mukFill = 1, vaultId = VISIBLE)),
                items = listOf(loginItem("item-visible", "user-a", vaultId = VISIBLE)),
                itemUrls = mapOf("item-visible" to listOf("https://visible.example.com")),
            ),
        )

        assertNotNull(fixture.replica.onPutItems)
        assertFalse(midWrite.contains("item-hidden"))
        assertFalse(midWrite.contains("revealed-hidden"))
    }

    /**
     * Domain-index repair opens an item to find the URLs sync lost. It reads a
     * vault key to do that, and a hidden vault has none to give.
     */
    @Test
    fun domainRepairCannotOpenAHiddenVault() = runBlocking {
        vault.acceptUnlockedKey("acct_a", "user-a", muk(1))
        fixture.replica.put(vaultKey("user-a", mukFill = 1, vaultId = HIDDEN))
        fixture.replica.setTravelModePolicy("user-a", policy())

        // The snapshot carries the item with no URLs, which is what sends the
        // apply down the repair path.
        vault.replaceReplica(
            snapshot(
                travelMode = policy(),
                vaultKeys = listOf(vaultKey("user-a", mukFill = 1, vaultId = HIDDEN)),
                items = listOf(
                    loginItem("item-hidden", "user-a", vaultId = HIDDEN) {
                        put("url", "https://secret.example")
                    },
                ),
                itemUrls = mapOf("item-hidden" to emptyList()),
            ),
        )

        assertTrue(fixture.replica.domains.isEmpty())
        assertTrue(fixture.replica.items.isEmpty())
    }

    // ---- Fixtures ---------------------------------------------------------

    private fun parse(json: JSONObject): CredentialReplicaSnapshot {
        val parsed = CredentialReplicaSnapshots.parse(json.toString())
        assertTrue("Expected the payload to parse: $parsed", parsed is ReplicaSnapshotParse.Parsed)
        return (parsed as ReplicaSnapshotParse.Parsed).snapshot
    }

    private fun travelModeJson(enabled: Boolean, hidden: List<String>) = JSONObject()
        .put("verified", true)
        .put("enabled", enabled)
        .put("hiddenVaultIds", JSONArray(hidden))
        .put("updatedAt", 7L)

    private fun payload(travelMode: JSONObject?) = JSONObject()
        .put("accountId", "acct_a")
        .put("userId", "user-a")
        .put("email", "ada@example.com")
        .put("secretKey", "A3-XXXXXX")
        .put(
            "kdfProfile",
            JSONObject()
                .put("schemaVersion", 1)
                .put("algorithm", "pbkdf2-sha256")
                .put("iterations", 600_000),
        )
        .put("vaultKeys", JSONArray())
        .put("items", JSONArray())
        .apply { if (travelMode != null) put("travelMode", travelMode) }

    private fun snapshot(
        travelMode: NativeTravelModePolicy?,
        vaultKeys: List<ReplicaVaultKey> = emptyList(),
        items: List<ReplicaItem> = emptyList(),
        itemUrls: Map<String, List<String>> = emptyMap(),
    ) = CredentialReplicaSnapshot(
        accountId = "acct_a",
        serverUserId = "user-a",
        email = "ada@example.com",
        secretKey = "A3-XXXXXX",
        kdf = KdfProfile(1, "pbkdf2-sha256", 600_000),
        vaultKeys = vaultKeys,
        items = items,
        itemUrls = itemUrls,
        travelMode = travelMode,
    )

    private fun queuedWrite(id: String, serverUserId: String, vaultId: String) =
        PendingPasskeyMutation(
            id = id,
            serverUserId = serverUserId,
            vaultId = vaultId,
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
