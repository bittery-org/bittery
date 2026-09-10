package com.bittery.mobile.credentialprovider.storage

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PasskeyMutationDaoTest {
    private lateinit var context: Context
    private lateinit var database: CredentialDatabase
    private val databaseName = "passkey-mutation-atomicity.db"

    @Before
    fun setUp() = runBlocking {
        context = ApplicationProvider.getApplicationContext()
        context.deleteDatabase(databaseName)
        database = openDatabase()
        database.authDataDao().insert(authData())
        database.vaultKeyDao().insert(vaultKey())
    }

    @After
    fun tearDown() {
        database.close()
        context.deleteDatabase(databaseName)
    }

    @Test
    fun updateAndHandoffRollbackTogetherAcrossRestart() = runBlocking {
        val original = item(id = "item-1", encryptedData = "old-cipher", version = 1L)
        val duplicate = mutation(id = "duplicate", itemId = original.id)
        database.itemDao().insert(original)
        database.itemDomainDao().insert(
            ItemDomainEntity(
                itemId = original.id,
                domain = "example.com",
                isPrimary = true,
                fullUrl = "https://example.com"
            )
        )
        database.pendingPasskeyMutationDao().insert(duplicate)

        val failure = runCatching {
            database.passkeyMutationDao().updateItemAndQueue(
                original.copy(encryptedData = "new-cipher", version = 2L),
                duplicate.copy(encryptedData = "new-cipher", encryptionVersion = 2L)
            )
        }.exceptionOrNull()
        assertNotNull(failure)

        reopenDatabase()

        assertEquals("old-cipher", database.itemDao().getById(original.id)?.encryptedData)
        assertEquals(1L, database.itemDao().getById(original.id)?.version)
        assertEquals(listOf("example.com"), database.itemDomainDao().getByItemId(original.id).map { it.domain })
        assertEquals(listOf("old-cipher"), database.pendingPasskeyMutationDao().getAll().map { it.encryptedData })
    }

    @Test
    fun createDomainsAndHandoffRollbackTogetherAcrossRestart() = runBlocking {
        val created = item(id = "item-new", encryptedData = "new-cipher", version = 1L)
        val duplicate = mutation(id = "duplicate", itemId = created.id)
        database.pendingPasskeyMutationDao().insert(duplicate.copy(itemId = "other-item"))

        val failure = runCatching {
            database.passkeyMutationDao().createItemAndQueue(
                created,
                listOf(
                    ItemDomainEntity(
                        itemId = created.id,
                        domain = "example.com",
                        isPrimary = true,
                        fullUrl = "https://example.com"
                    )
                ),
                duplicate
            )
        }.exceptionOrNull()
        assertNotNull(failure)

        reopenDatabase()

        assertNull(database.itemDao().getById(created.id))
        assertEquals(emptyList<ItemDomainEntity>(), database.itemDomainDao().getByItemId(created.id))
        assertEquals(listOf("other-item"), database.pendingPasskeyMutationDao().getAll().map { it.itemId })
    }

    private fun openDatabase(): CredentialDatabase =
        Room.databaseBuilder(context, CredentialDatabase::class.java, databaseName)
            .allowMainThreadQueries()
            .build()

    private fun reopenDatabase() {
        database.close()
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
        database = openDatabase()
    }

    private fun authData() = AuthDataEntity(
        email = "alice@example.com",
        userId = "user-1",
        secretKey = "secret-key",
        srpSalt = "salt",
        publicKey = "public-key",
        encryptedPrivateKey = "private-key",
        encryptedPrivateKeyIv = "private-key-iv"
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
        keyVersion = 1L
    )

    private fun item(id: String, encryptedData: String, version: Long) = ItemEntity(
        id = id,
        vaultId = "vault-1",
        userId = "user-1",
        category = "login",
        displayTitle = "Example",
        encryptedData = encryptedData,
        encryptionIv = "item-iv",
        primaryDomain = "example.com",
        username = "alice",
        version = version,
        encryptionVersion = version,
        encryptedByUserId = "user-1"
    )

    private fun mutation(id: String, itemId: String) = PendingPasskeyMutationEntity(
        id = id,
        userId = "user-1",
        vaultId = "vault-1",
        itemId = itemId,
        operation = "update_item",
        encryptedData = "old-cipher",
        encryptionIv = "item-iv",
        baseVersion = 1L,
        encryptionVersion = 2L,
        encryptedByUserId = "user-1"
    )
}
