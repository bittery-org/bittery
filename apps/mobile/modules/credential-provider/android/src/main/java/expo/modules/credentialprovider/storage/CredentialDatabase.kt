package expo.modules.credentialprovider.storage

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

/**
 * Room database for storing encrypted credentials.
 */
@Database(
    entities = [CredentialEntity::class],
    version = 1,
    exportSchema = false
)
abstract class CredentialDatabase : RoomDatabase() {
    abstract fun credentialDao(): CredentialDao

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
                .fallbackToDestructiveMigration()
                .build()
        }
    }
}
