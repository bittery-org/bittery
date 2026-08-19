package com.bittery.mobile.credentialprovider.storage

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

/**
 * Room database for encrypted vault data and the passkey writeback queue.
 */
@Database(
    entities = [
		AuthDataEntity::class,
        VaultKeyEntity::class,
        ItemEntity::class,
        ItemDomainEntity::class,
        PendingPasskeyMutationEntity::class,
        TravelModePolicyEntity::class
    ],
	version = 8,
    exportSchema = false
)
abstract class CredentialDatabase : RoomDatabase() {
    abstract fun authDataDao(): AuthDataDao
    abstract fun vaultKeyDao(): VaultKeyDao
    abstract fun itemDao(): ItemDao
    abstract fun itemDomainDao(): ItemDomainDao
    abstract fun pendingPasskeyMutationDao(): PendingPasskeyMutationDao
    abstract fun passkeyMutationDao(): PasskeyMutationDao
    abstract fun travelModePolicyDao(): TravelModePolicyDao

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
				.fallbackToDestructiveMigration(true)
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
