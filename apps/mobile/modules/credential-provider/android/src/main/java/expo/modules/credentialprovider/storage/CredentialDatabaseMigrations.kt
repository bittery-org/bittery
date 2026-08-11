package expo.modules.credentialprovider.storage

import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

object CredentialDatabaseMigrations {
    val from3To4 = object : Migration(3, 4) {
        override fun migrate(database: SupportSQLiteDatabase) {
            database.execSQL("ALTER TABLE items ADD COLUMN version INTEGER NOT NULL DEFAULT 1")
            database.execSQL("ALTER TABLE items ADD COLUMN lastModifiedBy TEXT")
            database.execSQL("ALTER TABLE vault_keys ADD COLUMN keyVersion INTEGER NOT NULL DEFAULT 1")
        }
    }

    val from4To5 = object : Migration(4, 5) {
        override fun migrate(database: SupportSQLiteDatabase) {
            database.execSQL("ALTER TABLE auth_data ADD COLUMN kdfSchemaVersion INTEGER")
            database.execSQL("ALTER TABLE auth_data ADD COLUMN kdfAlgorithm TEXT")
            database.execSQL("ALTER TABLE auth_data ADD COLUMN kdfIterations INTEGER")
        }
    }

    val from5To6 = object : Migration(5, 6) {
        override fun migrate(database: SupportSQLiteDatabase) {
            if (!database.hasColumn("items", "encryptionVersion")) {
                database.execSQL("ALTER TABLE items ADD COLUMN encryptionVersion INTEGER")
            }
            if (!database.hasColumn("items", "encryptedByUserId")) {
                database.execSQL("ALTER TABLE items ADD COLUMN encryptedByUserId TEXT")
            }
            database.execSQL(
                """
                CREATE TABLE pending_passkey_mutations_v6 (
                    id TEXT NOT NULL PRIMARY KEY,
                    userId TEXT NOT NULL,
                    vaultId TEXT NOT NULL,
                    itemId TEXT NOT NULL,
                    operation TEXT NOT NULL,
                    encryptedData TEXT NOT NULL,
                    encryptionIv TEXT NOT NULL,
                    encryptionAlgorithm TEXT NOT NULL,
                    baseVersion INTEGER NOT NULL,
                    encryptionVersion INTEGER NOT NULL,
                    encryptedByUserId TEXT NOT NULL,
                    createdAt INTEGER NOT NULL,
                    attemptCount INTEGER NOT NULL,
                    lastError TEXT
                )
                """.trimIndent()
            )
            database.execSQL(
                """
                INSERT INTO pending_passkey_mutations_v6 (
                    id, userId, vaultId, itemId, operation, encryptedData,
                    encryptionIv, encryptionAlgorithm, baseVersion,
                    encryptionVersion, encryptedByUserId, createdAt,
                    attemptCount, lastError
                )
                SELECT id, userId, vaultId, itemId, operation, encryptedData,
                    encryptionIv, encryptionAlgorithm, -1, -1, '', createdAt,
                    attemptCount, lastError
                FROM pending_passkey_mutations
                """.trimIndent()
            )
            database.execSQL("DROP TABLE pending_passkey_mutations")
            database.execSQL("ALTER TABLE pending_passkey_mutations_v6 RENAME TO pending_passkey_mutations")
            database.execSQL("CREATE INDEX index_pending_passkey_mutations_userId ON pending_passkey_mutations(userId)")
            database.execSQL("CREATE INDEX index_pending_passkey_mutations_createdAt ON pending_passkey_mutations(createdAt)")
            database.execSQL("CREATE INDEX index_pending_passkey_mutations_operation ON pending_passkey_mutations(operation)")
        }
    }

    val all = arrayOf(from3To4, from4To5, from5To6)

    private fun SupportSQLiteDatabase.hasColumn(table: String, column: String): Boolean {
        return query("PRAGMA table_info(`$table`)").use { cursor ->
            val nameIndex = cursor.getColumnIndexOrThrow("name")
            generateSequence { if (cursor.moveToNext()) cursor.getString(nameIndex) else null }
                .any { it == column }
        }
    }
}
