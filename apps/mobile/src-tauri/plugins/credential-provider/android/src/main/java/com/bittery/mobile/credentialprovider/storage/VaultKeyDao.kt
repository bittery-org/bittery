package com.bittery.mobile.credentialprovider.storage

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert

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
     * Add a vault key, or update the one already there.
     *
     * `@Upsert`, never `@Insert(REPLACE)`. SQLite's `INSERT OR REPLACE` deletes the
     * row it conflicts with, and `items` cascades from `vault_keys`, so one re-sent
     * vault key would take that vault's whole item and domain index with it.
     */
    @Upsert
    suspend fun insert(vaultKey: VaultKeyEntity)

    /** The same, for a whole sync's worth of keys. See [insert] for why upsert. */
    @Upsert
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
