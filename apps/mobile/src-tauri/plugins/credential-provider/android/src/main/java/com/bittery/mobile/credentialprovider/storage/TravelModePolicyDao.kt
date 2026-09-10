package com.bittery.mobile.credentialprovider.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction

/** Reads and writes the travel-mode policy, and the purge that follows one. */
@Dao
interface TravelModePolicyDao {

    @Query("SELECT * FROM travel_mode_policy WHERE userId = :userId")
    suspend fun getByUserId(userId: String): TravelModePolicyEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(policy: TravelModePolicyEntity)

    @Query("DELETE FROM travel_mode_policy WHERE userId = :userId")
    suspend fun deleteByUserId(userId: String)

    /**
     * Erase the named vaults for one account, in one transaction.
     *
     * Items go first so the cascade takes their domain rows with them; a partial
     * purge would leave a hidden vault half on the device.
     */
    @Transaction
    suspend fun eraseVaults(userId: String, vaultIds: List<String>) {
        if (vaultIds.isEmpty()) return
        deleteItemsInVaults(userId, vaultIds)
        deleteVaultKeysInVaults(userId, vaultIds)
        deletePendingMutationsInVaults(userId, vaultIds)
    }

    @Query("DELETE FROM items WHERE userId = :userId AND vaultId IN (:vaultIds)")
    suspend fun deleteItemsInVaults(userId: String, vaultIds: List<String>)

    @Query("DELETE FROM vault_keys WHERE userId = :userId AND vaultId IN (:vaultIds)")
    suspend fun deleteVaultKeysInVaults(userId: String, vaultIds: List<String>)

    @Query(
        "DELETE FROM pending_passkey_mutations WHERE userId = :userId AND vaultId IN (:vaultIds)",
    )
    suspend fun deletePendingMutationsInVaults(userId: String, vaultIds: List<String>)
}
