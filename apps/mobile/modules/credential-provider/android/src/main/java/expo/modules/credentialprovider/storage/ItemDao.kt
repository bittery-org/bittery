package expo.modules.credentialprovider.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Update

/**
 * Data Access Object for vault item operations.
 */
@Dao
interface ItemDao {

    /**
     * Get all items for a user.
     */
    @Query("SELECT * FROM items WHERE userId = :userId ORDER BY updatedAt DESC")
    suspend fun getByUserId(userId: String): List<ItemEntity>

    /**
     * Get all items in a vault.
     */
    @Query("SELECT * FROM items WHERE vaultId = :vaultId AND userId = :userId ORDER BY updatedAt DESC")
    suspend fun getByVaultId(vaultId: String, userId: String): List<ItemEntity>

    /**
     * Get an item by ID.
     */
    @Query("SELECT * FROM items WHERE id = :id")
    suspend fun getById(id: String): ItemEntity?

    /**
     * Get all login items for a user (for credential provider).
     */
    @Query("SELECT * FROM items WHERE userId = :userId AND category = 'login' ORDER BY lastUsedAt DESC, displayTitle ASC")
    suspend fun getLoginItemsByUserId(userId: String): List<ItemEntity>

    /**
     * Get login items by domain using the ItemDomainEntity junction table.
     * Returns items that have a matching domain in their associated domains.
     */
    @Query("""
        SELECT DISTINCT i.* FROM items i
        INNER JOIN item_domains d ON i.id = d.itemId
        WHERE d.domain = :domain AND i.category = 'login' AND i.userId = :userId
        ORDER BY i.lastUsedAt DESC, i.displayTitle ASC
    """)
    suspend fun getLoginItemsByDomain(domain: String, userId: String): List<ItemEntity>

    /**
     * Get login items by domain with subdomain matching.
     * Matches both exact domain and parent domain (e.g., "login.example.com" matches "example.com").
     */
    @Query("""
        SELECT DISTINCT i.* FROM items i
        INNER JOIN item_domains d ON i.id = d.itemId
        WHERE (d.domain = :domain OR d.domain = :parentDomain)
          AND i.category = 'login'
          AND i.userId = :userId
        ORDER BY
            CASE WHEN d.domain = :domain THEN 0 ELSE 1 END,
            i.lastUsedAt DESC,
            i.displayTitle ASC
    """)
    suspend fun getLoginItemsByDomainWithFallback(
        domain: String,
        parentDomain: String,
        userId: String
    ): List<ItemEntity>

    /**
     * Insert or replace an item.
     */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(item: ItemEntity)

    /**
     * Insert or replace multiple items.
     */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(items: List<ItemEntity>)

    /**
     * Update an item.
     */
    @Update
    suspend fun update(item: ItemEntity)

    /**
     * Update the last used timestamp (for autofill usage tracking).
     */
    @Query("UPDATE items SET lastUsedAt = :timestamp WHERE id = :id")
    suspend fun updateLastUsed(id: String, timestamp: Long)

    /**
     * Delete an item by ID.
     */
    @Query("DELETE FROM items WHERE id = :id")
    suspend fun deleteById(id: String)

    /**
     * Delete all items for a user.
     */
    @Query("DELETE FROM items WHERE userId = :userId")
    suspend fun deleteByUserId(userId: String)

    /**
     * Delete all items in a vault.
     */
    @Query("DELETE FROM items WHERE vaultId = :vaultId")
    suspend fun deleteByVaultId(vaultId: String)

    /**
     * Delete all items.
     */
    @Query("DELETE FROM items")
    suspend fun deleteAll()

    /**
     * Get all item IDs for a user.
     */
    @Query("SELECT id FROM items WHERE userId = :userId")
    suspend fun getItemIdsByUserId(userId: String): List<String>

    /**
     * Get count of items.
     */
    @Query("SELECT COUNT(*) FROM items")
    suspend fun getCount(): Int

    /**
     * Get count of login items for a user.
     */
    @Query("SELECT COUNT(*) FROM items WHERE userId = :userId AND category = 'login'")
    suspend fun getLoginItemCount(userId: String): Int
}
