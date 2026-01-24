package expo.modules.credentialprovider.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update

/**
 * Data Access Object for credential operations.
 */
@Dao
interface CredentialDao {
    /**
     * Get all stored credentials (ordered by last used, then by display name).
     */
    @Query("SELECT * FROM credentials ORDER BY lastUsedAt DESC, displayName ASC")
    suspend fun getAll(): List<CredentialEntity>

    /**
     * Get a credential by its ID.
     */
    @Query("SELECT * FROM credentials WHERE id = :id")
    suspend fun getById(id: String): CredentialEntity?

    /**
     * Get credentials matching a domain (exact match).
     */
    @Query("SELECT * FROM credentials WHERE domain = :domain ORDER BY lastUsedAt DESC, displayName ASC")
    suspend fun getByDomain(domain: String): List<CredentialEntity>

    /**
     * Get credentials where domain contains the search term.
     * Useful for subdomain matching.
     */
    @Query("SELECT * FROM credentials WHERE domain LIKE '%' || :searchTerm || '%' ORDER BY lastUsedAt DESC, displayName ASC")
    suspend fun searchByDomain(searchTerm: String): List<CredentialEntity>

    /**
     * Get credential by vault ID and item ID (for sync operations).
     */
    @Query("SELECT * FROM credentials WHERE vaultId = :vaultId AND itemId = :itemId")
    suspend fun getByVaultAndItem(vaultId: String, itemId: String): CredentialEntity?

    /**
     * Insert a new credential (or replace if exists).
     */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(credential: CredentialEntity)

    /**
     * Insert multiple credentials (or replace if exists).
     */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(credentials: List<CredentialEntity>)

    /**
     * Update an existing credential.
     */
    @Update
    suspend fun update(credential: CredentialEntity)

    /**
     * Update the last used timestamp for a credential.
     */
    @Query("UPDATE credentials SET lastUsedAt = :timestamp WHERE id = :id")
    suspend fun updateLastUsed(id: String, timestamp: Long)

    /**
     * Delete a credential by ID.
     */
    @Query("DELETE FROM credentials WHERE id = :id")
    suspend fun deleteById(id: String)

    /**
     * Delete credentials by vault ID and item ID.
     */
    @Query("DELETE FROM credentials WHERE vaultId = :vaultId AND itemId = :itemId")
    suspend fun deleteByVaultAndItem(vaultId: String, itemId: String)

    /**
     * Delete all credentials.
     */
    @Query("DELETE FROM credentials")
    suspend fun deleteAll()

    /**
     * Get count of all credentials.
     */
    @Query("SELECT COUNT(*) FROM credentials")
    suspend fun getCount(): Int

    /**
     * Get all item IDs that are currently stored.
     * Used for sync comparison.
     */
    @Query("SELECT itemId FROM credentials")
    suspend fun getAllItemIds(): List<String>
}
