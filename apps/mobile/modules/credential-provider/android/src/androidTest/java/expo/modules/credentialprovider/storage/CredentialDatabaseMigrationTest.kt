package expo.modules.credentialprovider.storage

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CredentialDatabaseMigrationTest {
    private lateinit var context: Context
    private val databaseName = "credential-migration.db"

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        context.deleteDatabase(databaseName)
    }

    @After
    fun tearDown() {
        context.deleteDatabase(databaseName)
    }

    @Test
    fun pendingPasskeyMutationSurvivesMigrationFromVersion5To6WithSentinelContext() = runBlocking<Unit> {
        openRoomDatabase().let { database ->
            database.openHelper.writableDatabase
            database.close()
        }

        SQLiteDatabase.openDatabase(
            context.getDatabasePath(databaseName).path,
            null,
            SQLiteDatabase.OPEN_READWRITE
        ).use { database ->
            database.execSQL("DROP TABLE pending_passkey_mutations")
            createVersion5PendingTable(database)
            database.execSQL(
                """
                INSERT INTO pending_passkey_mutations (
                    id, userId, vaultId, itemId, operation, encryptedData,
                    encryptionIv, encryptionAlgorithm, createdAt, attemptCount, lastError
                ) VALUES (
                    'pending-1', 'user-1', 'vault-1', 'item-1', 'update_item',
                    'cipher', 'iv', 'AES-GCM-AAD-V1', 1, 0, NULL
                )
                """.trimIndent()
            )
            database.version = 5
        }

        openRoomDatabase().let { migrated ->
            val pending = migrated.pendingPasskeyMutationDao().getAll().single()
            assertEquals("cipher", pending.encryptedData)
            assertEquals(-1L, pending.baseVersion)
            assertEquals(-1L, pending.encryptionVersion)
            assertEquals("", pending.encryptedByUserId)

            val database = migrated.openHelper.writableDatabase
            assertTrue(
                columnNames(database, "items")
                    .containsAll(listOf("encryptionVersion", "encryptedByUserId"))
            )
            migrated.close()
        }
    }

    private fun openRoomDatabase(): CredentialDatabase {
        return Room.databaseBuilder(context, CredentialDatabase::class.java, databaseName)
            .addMigrations(*CredentialDatabaseMigrations.all)
            .fallbackToDestructiveMigrationFrom(true, 1, 2)
            .build()
    }

    private fun createVersion5PendingTable(database: SQLiteDatabase) {
        database.execSQL(
            """
            CREATE TABLE pending_passkey_mutations (
                id TEXT NOT NULL PRIMARY KEY,
                userId TEXT NOT NULL,
                vaultId TEXT NOT NULL,
                itemId TEXT NOT NULL,
                operation TEXT NOT NULL,
                encryptedData TEXT NOT NULL,
                encryptionIv TEXT NOT NULL,
                encryptionAlgorithm TEXT NOT NULL,
                createdAt INTEGER NOT NULL,
                attemptCount INTEGER NOT NULL,
                lastError TEXT
            )
            """.trimIndent()
        )
        database.execSQL(
            "CREATE INDEX index_pending_passkey_mutations_userId ON pending_passkey_mutations(userId)"
        )
        database.execSQL(
            "CREATE INDEX index_pending_passkey_mutations_createdAt ON pending_passkey_mutations(createdAt)"
        )
        database.execSQL(
            "CREATE INDEX index_pending_passkey_mutations_operation ON pending_passkey_mutations(operation)"
        )
    }

    private fun columnNames(database: androidx.sqlite.db.SupportSQLiteDatabase, table: String): Set<String> {
        return database.query("PRAGMA table_info(`$table`)").use { cursor ->
            val nameIndex = cursor.getColumnIndexOrThrow("name")
            buildSet {
                while (cursor.moveToNext()) add(cursor.getString(nameIndex))
            }
        }
    }
}
