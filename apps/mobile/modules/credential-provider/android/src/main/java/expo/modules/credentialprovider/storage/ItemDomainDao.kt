package expo.modules.credentialprovider.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction

/**
 * Data Access Object for item domain operations.
 */
@Dao
interface ItemDomainDao {

    /**
     * Get all domains for an item.
     */
    @Query("SELECT * FROM item_domains WHERE itemId = :itemId ORDER BY isPrimary DESC")
    suspend fun getByItemId(itemId: String): List<ItemDomainEntity>

    /**
     * Get all item IDs that have a specific domain.
     */
    @Query("SELECT itemId FROM item_domains WHERE domain = :domain")
    suspend fun getItemIdsByDomain(domain: String): List<String>

    /**
     * Get the primary domain for an item.
     */
    @Query("SELECT * FROM item_domains WHERE itemId = :itemId AND isPrimary = 1 LIMIT 1")
    suspend fun getPrimaryDomain(itemId: String): ItemDomainEntity?

    /**
     * Insert a domain entry.
     */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(domain: ItemDomainEntity)

    /**
     * Insert multiple domain entries.
     */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(domains: List<ItemDomainEntity>)

    /**
     * Delete all domains for an item.
     */
    @Query("DELETE FROM item_domains WHERE itemId = :itemId")
    suspend fun deleteByItemId(itemId: String)

    /**
     * Delete all domains.
     */
    @Query("DELETE FROM item_domains")
    suspend fun deleteAll()

    /**
     * Replace all domains for an item.
     * This is a transaction that deletes existing and inserts new.
     */
    @Transaction
    suspend fun replaceDomainsForItem(itemId: String, domains: List<ItemDomainEntity>) {
        deleteByItemId(itemId)
        insertAll(domains)
    }
}
