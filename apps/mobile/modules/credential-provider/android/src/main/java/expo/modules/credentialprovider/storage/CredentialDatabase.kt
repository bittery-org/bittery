package expo.modules.credentialprovider.storage

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

/**
 * Room database for storing vault data and credentials.
 *
 * Version History:
 * - v1: Original CredentialEntity with double-encryption
 * - v2: Unified storage with AuthDataEntity, VaultKeyEntity, ItemEntity, ItemDomainEntity
 *       Stores encrypted server data directly, decryption on-demand with MUK
 * - v3: Added pending passkey mutation queue for durable writeback
 * - v4: Added version + lastModifiedBy to ItemEntity and keyVersion to VaultKeyEntity
 *       for correct AES-GCM-AAD-V1 context reconstruction during decryption
 *
 * The database uses destructive migration because all data can be re-synced from the server.
 * The MUK is the only critical piece, and it's managed separately in VaultStateManager.
 */
@Database(
    entities = [
        // Legacy entity (kept for migration, will be removed in future)
        CredentialEntity::class,
        // New unified storage entities
        AuthDataEntity::class,
        VaultKeyEntity::class,
        ItemEntity::class,
        ItemDomainEntity::class,
        PendingPasskeyMutationEntity::class
    ],
    version = 5,
    exportSchema = false
)
abstract class CredentialDatabase : RoomDatabase() {
    // Legacy DAO (kept for migration/backwards compatibility)
    abstract fun credentialDao(): CredentialDao

    // New unified storage DAOs
    abstract fun authDataDao(): AuthDataDao
    abstract fun vaultKeyDao(): VaultKeyDao
    abstract fun itemDao(): ItemDao
    abstract fun itemDomainDao(): ItemDomainDao
    abstract fun pendingPasskeyMutationDao(): PendingPasskeyMutationDao

    companion object {
        private const val DATABASE_NAME = "bittery_credentials.db"

        @Volatile
        private var INSTANCE: CredentialDatabase? = null

        fun getInstance(context: Context): CredentialDatabase {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: buildDatabase(context).also { INSTANCE = it }
            }
        }

        private fun buildDatabase(context: Context): CredentialDatabase {
            return Room.databaseBuilder(
                context.applicationContext,
                CredentialDatabase::class.java,
                DATABASE_NAME
            )
                // Use destructive migration since all data can be re-synced from server
                // The MUK and session data are stored separately in VaultStateManager
                .fallbackToDestructiveMigration()
                .build()
        }

        /**
         * Clear the database instance.
         * Useful for testing or when resetting the app.
         */
        fun clearInstance() {
            synchronized(this) {
                INSTANCE?.close()
                INSTANCE = null
            }
        }
    }
}
