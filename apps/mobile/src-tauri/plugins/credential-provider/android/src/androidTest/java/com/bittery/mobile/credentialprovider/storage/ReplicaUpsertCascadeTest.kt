package com.bittery.mobile.credentialprovider.storage

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Re-writing a parent row must not take its children with it.
 *
 * `items` cascades from `vault_keys`, and `item_domains` cascades from `items`.
 * SQLite's `INSERT OR REPLACE` *deletes* the row it conflicts with, so a plain
 * upsert through `@Insert(onConflict = REPLACE)` fires those cascades: one
 * re-sent vault key silently empties the whole vault. Only a real SQLite engine
 * shows this, so these tests are instrumented rather than JVM.
 */
@RunWith(AndroidJUnit4::class)
class ReplicaUpsertCascadeTest {
    private lateinit var context: Context
    private lateinit var database: CredentialDatabase
    private val databaseName = "replica-upsert-cascade.db"

    @Before
    fun setUp() = runBlocking {
        context = ApplicationProvider.getApplicationContext()
        context.deleteDatabase(databaseName)
        database = Room.databaseBuilder(context, CredentialDatabase::class.java, databaseName)
            .allowMainThreadQueries()
            .build()
        database.authDataDao().insert(authData())
        database.vaultKeyDao().insert(vaultKey())
        database.itemDao().insert(item())
        database.itemDomainDao().insert(domain())
    }

    @After
    fun tearDown() {
        database.close()
        context.deleteDatabase(databaseName)
    }

    /** Every sync re-sends the vault keys. That must cost no items. */
    @Test
    fun reWritingAVaultKeyKeepsItsItemsAndDomains() = runBlocking {
        database.vaultKeyDao().insertAll(listOf(vaultKey().copy(vaultName = "Renamed")))

        assertEquals("Renamed", database.vaultKeyDao().getVaultKey("vault-1", "user-1")?.vaultName)
        assertNotNull(database.itemDao().getById("item-1"))
        assertEquals(
            listOf("example.com"),
            database.itemDomainDao().getByItemId("item-1").map { it.domain },
        )
    }

    /** The single-row path too — a passkey assertion re-writes one item in place. */
    @Test
    fun reWritingAVaultKeyOneRowAtATimeKeepsItsItems() = runBlocking {
        database.vaultKeyDao().insert(vaultKey().copy(keyVersion = 2L))

        assertNotNull(database.itemDao().getById("item-1"))
        assertEquals(1, database.itemDomainDao().getByItemId("item-1").size)
    }

    /**
     * A passkey assertion bumps its item's sign counter through `putItem`. The
     * item's domain index is what autofill matches on, so losing it makes the
     * item unofferable until the next full sync.
     */
    @Test
    fun reWritingAnItemKeepsItsDomains() = runBlocking {
        database.itemDao().insert(item().copy(encryptedData = "new-cipher", version = 2L))

        assertEquals("new-cipher", database.itemDao().getById("item-1")?.encryptedData)
        assertEquals(
            listOf("example.com"),
            database.itemDomainDao().getByItemId("item-1").map { it.domain },
        )
    }

    @Test
    fun reWritingItemsInBulkKeepsTheirDomains() = runBlocking {
        database.itemDao().insertAll(listOf(item().copy(displayTitle = "Renamed")))

        assertEquals("Renamed", database.itemDao().getById("item-1")?.displayTitle)
        assertEquals(1, database.itemDomainDao().getByItemId("item-1").size)
    }

    private fun authData() = AuthDataEntity(
        email = "alice@example.com",
        userId = "user-1",
        secretKey = "secret-key",
        srpSalt = "salt",
        publicKey = "public-key",
        encryptedPrivateKey = "private-key",
        encryptedPrivateKeyIv = "private-key-iv",
    )

    private fun vaultKey() = VaultKeyEntity(
        vaultId = "vault-1",
        userId = "user-1",
        vaultName = "Personal",
        vaultType = "personal",
        encryptedKey = "vault-key",
        encryptionIv = "vault-key-iv",
        encryptionAlgorithm = "AES-GCM-AAD-V1",
        role = "owner",
        keyVersion = 1L,
    )

    private fun item() = ItemEntity(
        id = "item-1",
        vaultId = "vault-1",
        userId = "user-1",
        category = "login",
        displayTitle = "Example",
        encryptedData = "old-cipher",
        encryptionIv = "item-iv",
        primaryDomain = "example.com",
        username = "alice",
        version = 1L,
        encryptionVersion = 1L,
        encryptedByUserId = "user-1",
    )

    private fun domain() = ItemDomainEntity(
        itemId = "item-1",
        domain = "example.com",
        isPrimary = true,
        fullUrl = "https://example.com",
    )
}
