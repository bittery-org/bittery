package expo.modules.credentialprovider.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update

/**
 * Data Access Object for authentication data operations.
 */
@Dao
interface AuthDataDao {

    /**
     * Get auth data by email.
     */
    @Query("SELECT * FROM auth_data WHERE email = :email")
    suspend fun getByEmail(email: String): AuthDataEntity?

    /**
     * Get auth data by user ID.
     */
    @Query("SELECT * FROM auth_data WHERE userId = :userId")
    suspend fun getByUserId(userId: String): AuthDataEntity?

    /**
     * Get all accounts.
     */
    @Query("SELECT * FROM auth_data ORDER BY lastActiveAt DESC")
    suspend fun getAll(): List<AuthDataEntity>

    /**
     * Get the most recently active account.
     */
    @Query("SELECT * FROM auth_data ORDER BY lastActiveAt DESC LIMIT 1")
    suspend fun getMostRecentAccount(): AuthDataEntity?

    /**
     * Insert or replace auth data.
     */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(authData: AuthDataEntity)

    /**
     * Update existing auth data.
     */
    @Update
    suspend fun update(authData: AuthDataEntity)

    /**
     * Update the last active timestamp.
     */
    @Query("UPDATE auth_data SET lastActiveAt = :timestamp WHERE email = :email")
    suspend fun updateLastActiveAt(email: String, timestamp: Long)

    /**
     * Update the last master password entry timestamp (for 30-day check).
     */
    @Query("UPDATE auth_data SET lastMasterPasswordEntry = :timestamp WHERE email = :email")
    suspend fun updateLastMasterPasswordEntry(email: String, timestamp: Long)

    /**
     * Update biometric enabled status.
     */
    @Query("UPDATE auth_data SET biometricEnabled = :enabled WHERE email = :email")
    suspend fun updateBiometricEnabled(email: String, enabled: Boolean)

    /**
     * Delete auth data by email.
     */
    @Query("DELETE FROM auth_data WHERE email = :email")
    suspend fun deleteByEmail(email: String)

    /**
     * Delete all auth data.
     */
    @Query("DELETE FROM auth_data")
    suspend fun deleteAll()

    /**
     * Get count of accounts.
     */
    @Query("SELECT COUNT(*) FROM auth_data")
    suspend fun getCount(): Int

    /**
     * Check if an account exists for email.
     */
    @Query("SELECT COUNT(*) > 0 FROM auth_data WHERE email = :email")
    suspend fun existsByEmail(email: String): Boolean
}
