package com.bittery.mobile.credentialprovider.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

/**
 * Data Access Object for vault key operations.
 */
@Dao
interface VaultKeyDao {

    /**
     * Get all vault keys for a user.
     */
    @Query("SELECT * FROM vault_keys WHERE userId = :userId")
    suspend fun getByUserId(userId: String): List<VaultKeyEntity>

    /**
     * Get a specific vault key.
     */
    @Query("SELECT * FROM vault_keys WHERE vaultId = :vaultId AND userId = :userId")
    suspend fun getVaultKey(vaultId: String, userId: String): VaultKeyEntity?

    /**
     * Get vault key by vault ID only (for single-user scenarios).
     */
    @Query("SELECT * FROM vault_keys WHERE vaultId = :vaultId AND userId = :userId LIMIT 1")
    suspend fun getByVaultId(vaultId: String, userId: String): VaultKeyEntity?

    /**
     * Insert or replace vault keys.
     */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(vaultKey: VaultKeyEntity)

    /**
     * Insert or replace multiple vault keys.
     */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(vaultKeys: List<VaultKeyEntity>)

    /**
     * Delete vault key.
     */
    @Query("DELETE FROM vault_keys WHERE vaultId = :vaultId AND userId = :userId")
    suspend fun delete(vaultId: String, userId: String)

    /**
     * Delete all vault keys for a user.
     */
    @Query("DELETE FROM vault_keys WHERE userId = :userId")
    suspend fun deleteByUserId(userId: String)

    /**
     * Delete all vault keys.
     */
    @Query("DELETE FROM vault_keys")
    suspend fun deleteAll()

    /**
     * Get all vault IDs for a user.
     */
    @Query("SELECT vaultId FROM vault_keys WHERE userId = :userId")
    suspend fun getVaultIdsByUserId(userId: String): List<String>
}
